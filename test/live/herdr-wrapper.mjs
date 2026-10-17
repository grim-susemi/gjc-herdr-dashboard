// Live-test Herdr wrapper (plan §15.4): a pass-through stand-in for the real `herdr` binary that
// logs every call and can inject the two planned defect flags (R3 deleted `delay-run-25s`: the
// 25 s late viewer is now the product's own `--failpoint ready-delay-25s`, started by the dev shim).
//
// Wiring: a live case points GJC_HERDR_DASHBOARD_HERDR at
// `["<node>", "<repo>/test/live/herdr-wrapper.mjs"]`, so `createHerdr` (src/herdr.mjs) spawns THIS
// file and appends the herdr subcommand argv itself (for example `pane list`). The wrapper is one
// process per call, so nothing survives in memory and the flag lifetime is read from the
// filesystem (flag file mtime vs. the log timestamps).
//
// Real binary: `GJC_LIVE_REAL_HERDR` when set (tests / an explicit override), otherwise
// `HERDR_BIN_PATH`. PATH is never consulted and no other binary is ever used. The incoming env is
// forwarded as-is, which is how the session reaches the real binary: a gjc process inside a fixture
// pane carries HERDR_SOCKET_PATH / HERDR_SESSION (measured), and the herdr CLI honours both.
// `GJC_LIVE_HERDR_SESSION` forces `--session <name>` in front of the forwarded argv when the
// environment cannot name the session itself.
//
// Log: one JSON line per call to `<repo>/.sandbox/wrapper.log.jsonl`, `{at, argv, ok, code, ms}`
// plus `paneId` when the reply names a pane. `GJC_LIVE_LOG_DIR` moves the directory.
//
// Flags: plain files in `<repo>/.sandbox/flags/` (`GJC_LIVE_FLAGS_DIR` moves it).
//   fail-split-once  the FIRST `pane split` fails with a structured Herdr error on stdout and
//                    exit 1 without reaching the real binary; the flag file is then deleted.
//   fail-list        every `pane list` fails the same way while the file exists.
//
// The wrapper never edits the caller's argv and never calls herdr for anything the caller did not
// ask for: no probing, no extra subcommands, no retries.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SELF = fileURLToPath(import.meta.url);
export const DEFAULT_LOG_DIR = join(REPO, '.sandbox');
export const DEFAULT_FLAGS_DIR = join(REPO, '.sandbox', 'flags');

export const FLAG_SPLIT = 'fail-split-once';
export const FLAG_LIST = 'fail-list';

export function realBinary(env = process.env) {
  const override = String(env.GJC_LIVE_REAL_HERDR ?? '').trim();
  if (override !== '') return override;
  const explicit = String(env.HERDR_BIN_PATH ?? '').trim();
  return explicit === '' ? null : explicit;
}

// A session prefix, only when the caller's env cannot identify the session by itself (no
// HERDR_SOCKET_PATH) or when a caller pins one explicitly.
export function sessionArgs(env = {}) {
  const forced = String(env.GJC_LIVE_HERDR_SESSION ?? '').trim();
  if (forced !== '') return ['--session', forced];
  if (String(env.HERDR_SOCKET_PATH ?? '').trim() !== '') return [];
  const name = String(env.HERDR_SESSION ?? '').trim();
  return name === '' ? [] : ['--session', name];
}

export const paths = (env = {}, repo = REPO) => {
  const logDir = String(env.GJC_LIVE_LOG_DIR ?? '').trim();
  const flagsDir = String(env.GJC_LIVE_FLAGS_DIR ?? '').trim();
  const base = logDir === '' ? join(repo, '.sandbox') : logDir;
  return { log: join(base, 'wrapper.log.jsonl'), flags: flagsDir === '' ? join(base, 'flags') : flagsDir };
};

const isSplit = (argv) => argv[0] === 'pane' && argv[1] === 'split';
const isList = (argv) => argv[0] === 'pane' && argv[1] === 'list';

// `pane split` answers `{"id":"cli:pane:split","result":{"pane":{"pane_id":"w1:p6",…}}}` (measured,
// `.sandbox/lv4split.json`); the flatter shapes are accepted too, so a CLI change cannot silently
// lose the pane id in the log.
export function paneIdOf(reply) {
  if (reply === null || typeof reply !== 'object') return null;
  const value = reply.result ?? reply;
  const pane = value?.pane ?? null;
  const id = pane?.pane_id ?? pane?.paneId ?? value?.pane_id ?? value?.paneId ?? null;
  return typeof id === 'string' && id !== '' ? id : null;
}

export function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  const entries = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { entries.push(JSON.parse(line)); }
    catch {
      // outcome: a torn line (concurrent append) is not evidence, so it is skipped.
    }
  }
  return entries;
}

export function injectedError(argv) {
  if (isSplit(argv)) {
    return { error: { code: 'pane_split_failed', message: 'injected split failure (fail-split-once)' } };
  }
  if (isList(argv)) {
    return { error: { code: 'server_unavailable', message: 'injected list failure (fail-list)' } };
  }
  return null;
}

export function planCall(argv, env = {}) {
  const { log, flags } = paths(env);
  const consume = (name) => {
    try { rmSync(join(flags, name), { force: true }); }
    catch {
      // outcome: an unconsumable flag file would re-inject forever, so the call continues anyway.
    }
  };
  const plain = { forward: true, reply: null, code: 0, log };
  if (isSplit(argv) && existsSync(join(flags, FLAG_SPLIT))) {
    consume(FLAG_SPLIT);
    return { ...plain, forward: false, reply: injectedError(argv), code: 1 };
  }
  if (isList(argv) && existsSync(join(flags, FLAG_LIST))) {
    return { ...plain, forward: false, reply: injectedError(argv), code: 1 };
  }
  return plain;
}

export function logLine({ at, argv, ok, code, ms, paneId = null }) {
  const line = { at, atMs: Date.parse(at), argv: [...argv], ok, code, ms };
  if (paneId !== null) line.paneId = paneId;
  return `${JSON.stringify(line)}\n`;
}

function appendLog(logPath, line) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line, 'utf8');
  } catch {
    // outcome: a log write failure must not change the wrapper's forwarding behaviour.
  }
}

const structuredBody = (value) => `${JSON.stringify({ id: 'cli:live-wrapper', ...value })}\n`;

function errorCodeOf(result, code) {
  if (code === 0) return null;
  const body = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const match = /"code"\s*:\s*"([^"]+)"/.exec(body);
  return match ? match[1] : (result.error?.code ?? 'exit');
}

export function main(argv = process.argv.slice(2), {
  env = process.env, now = () => new Date().toISOString(),
  spawnFn = spawnSync, stdout = process.stdout, stderr = process.stderr,
} = {}) {
  const started = Date.now();
  const plan = planCall(argv, env);
  if (!plan.forward) {
    stdout.write(structuredBody(plan.reply));
    stderr.write(`${plan.reply.error.message}\n`);
    appendLog(plan.log, logLine({ at: now(), argv, ok: false, code: plan.reply.error.code,
      ms: Date.now() - started }));
    return plan.code;
  }
  return forward(argv, { env, logPath: plan.log, started, now, spawnFn, stdout, stderr });
}

function forward(argv, { env, logPath, started, now, spawnFn, stdout, stderr }) {
  const bin = realBinary(env);
  if (bin === null) {
    const message = 'the live wrapper has no real herdr binary (HERDR_BIN_PATH/GJC_LIVE_REAL_HERDR)';
    stdout.write(structuredBody({ error: { code: 'herdr_missing', message } }));
    stderr.write(`${message}\n`);
    appendLog(logPath, logLine({ at: now(), argv, ok: false, code: 'herdr_missing',
      ms: Date.now() - started }));
    return 1;
  }
  const result = spawnFn(bin, [...sessionArgs(env), ...argv], { env, encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  const code = result.status ?? (result.error ? 1 : 0);
  let paneId = null;
  if (isSplit(argv) && code === 0 && typeof result.stdout === 'string' && result.stdout.trim() !== '') {
    try { paneId = paneIdOf(JSON.parse(result.stdout)); }
    catch {
      // outcome: an unparseable split reply simply carries no pane id in the log.
    }
  }
  appendLog(logPath, logLine({ at: now(), argv, ok: code === 0, code: errorCodeOf(result, code),
    ms: Date.now() - started, paneId }));
  if (result.error && !result.stdout && !result.stderr) stderr.write(`${result.error.message}\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
