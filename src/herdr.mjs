// Herdr invocation: argv vector resolution plus a shell-free `execFile` client, and the
// PowerShell-safe command builder used for the viewer launch trailer.
// Adapted from the pinned copy source (see PROVENANCE.md, "Lane A — core state").
//
// Exports:
//   shellCommand(args, platform)          -> single-line command string. win32 -> PowerShell
//                                            `& 'x' 'y'` form (apostrophes doubled); otherwise
//                                            POSIX single quoting.
//   resolveHerdrVector(env, platform)     -> array of argv strings. Precedence (plan 7.10):
//                                            GJC_HERDR_DASHBOARD_HERDR (JSON argv) ->
//                                            HERDR_BIN_PATH -> herdr/herdr.exe found on PATH.
//                                            Throws when nothing resolves.
//   createHerdr({vector, env, timeoutMs, execute})
//                                         -> `async (...args) => result`. Runs the vector plus
//                                            the caller's args WITHOUT a shell, parses the JSON
//                                            reply {id,result} / {error:{code,message}}, returns
//                                            {} for empty stdout, and throws errors carrying
//                                            `.code` (for example `pane_not_found`).
// The vector is an argv PREFIX: callers append their own subcommand argv themselves. This module
// never decides which subcommand to use, so it contains no subcommand literals (SR7 scopes that
// decision to src/core/launch.mjs).
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function shellCommand(args, platform = process.platform) {
  // Windows Herdr panes run PowerShell, where a quoted executable needs the call operator.
  if (platform === 'win32') return `& ${args.map(value => `'${String(value).replaceAll("'", "''")}'`).join(' ')}`;
  return args.map(quote).join(' ');
}

function executableFile(path) {
  try { return statSync(path).isFile(); }
  catch {
    // outcome: a missing or unreadable candidate is simply not a candidate.
    return false;
  }
}

function onPath(env, name) {
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

export function resolveHerdrVector(env = process.env, platform = process.platform) {
  const configured = env.GJC_HERDR_DASHBOARD_HERDR?.trim();
  if (configured) {
    let parsed;
    try { parsed = JSON.parse(configured); }
    catch (error) { throw Object.assign(new Error(`GJC_HERDR_DASHBOARD_HERDR is not JSON argv: ${error.message}`), { code: 'herdr-vector' }); }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(value => typeof value !== 'string' || value === '')) {
      throw Object.assign(new Error('GJC_HERDR_DASHBOARD_HERDR must be a non-empty array of non-empty strings'), { code: 'herdr-vector' });
    }
    return [...parsed];
  }
  const explicit = env.HERDR_BIN_PATH?.trim();
  if (explicit && executableFile(explicit)) return [explicit];
  const name = platform === 'win32' ? 'herdr.exe' : 'herdr';
  const found = onPath(env, name) ?? (platform === 'win32' ? onPath(env, 'herdr') : null);
  if (found) return [found];
  throw Object.assign(new Error('Herdr is not available in this session'), { code: 'herdr-missing' });
}

function replyError(body) {
  const parsed = JSON.parse(body);
  if (!parsed?.error) return null;
  return Object.assign(new Error(parsed.error.message ?? JSON.stringify(parsed.error)), { code: parsed.error.code });
}

export function createHerdr({ vector, env = process.env, timeoutMs = 5000, execute = run } = {}) {
  return async (...args) => {
    const argv = vector ? [...vector] : resolveHerdrVector(env);
    const bin = argv[0];
    if (!bin) throw Object.assign(new Error('Herdr is not available in this session'), { code: 'herdr-missing' });
    let stdout;
    try {
      ({ stdout } = await execute(bin, [...argv.slice(1), ...args], { env, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }));
    } catch (error) {
      // Herdr exits non-zero with a structured error body; keep its code (pane_not_found) so
      // absence is distinguishable from a transport failure.
      let structured;
      try { structured = replyError(error.stdout || error.stderr); }
      catch {
        // outcome: an unparseable body is not Herdr's structured error, so surface the original.
        structured = null;
      }
      if (structured) throw Object.assign(structured, { cause: error });
      throw error;
    }
    // An empty body acknowledges success in the Herdr protocol, so there is no result to parse.
    if (!stdout.trim()) return {};
    const parsed = JSON.parse(stdout);
    if (parsed.error) throw replyError(stdout);
    return parsed.result;
  };
}

