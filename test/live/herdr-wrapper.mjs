// Live-test Herdr wrapper (plan §15.4): a pass-through stand-in for the real `herdr` binary that
// logs every call and can inject the three planned defect flags.
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
// plus `paneId` when the reply names a pane (the delay flag needs the split result).
// `GJC_LIVE_LOG_DIR` moves the directory. A DELAYED run writes TWO lines, because two things really
// happened: the parent's deferral (`delayed:true` + `deferredPid`, written immediately) and the
// helper's forwarding of the same argv (`delayed:true`, carrying the real `ms`/`ok`). Count real
// executions with the lines that have no `deferredPid`.
//
// Flags: plain files in `<repo>/.sandbox/flags/` (`GJC_LIVE_FLAGS_DIR` moves it).
//   fail-split-once  the FIRST `pane split` fails with a structured Herdr error on stdout and
//                    exit 1 without reaching the real binary; the flag file is then deleted.
//   fail-list        every `pane list` fails the same way while the file exists.
//   delay-run-25s    the next `pane run` whose target pane came from a `pane split` this wrapper
//                    logged AFTER the flag file was created (same flag lifetime) is delayed 25 s
//                    before it is forwarded; the flag is deleted at use. The delay runs in a
//                    DETACHED helper, because the caller (`createHerdr` -> the pass budget, 5 s by
//                    default) kills a wrapper that is still sleeping, and a killed wrapper would
//                    never run the viewer at all. (Two log lines therefore describe a delayed run: the
//                    parent's deferral and the helper's real call.)
//                    A `run` whose pane predates the flag is forwarded untouched and does not
//                    consume the flag.
//
// The wrapper never edits the caller's argv and never calls herdr for anything the caller did not
// ask for: no probing, no extra subcommands, no retries.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SELF = fileURLToPath(import.meta.url);
export const DEFAULT_LOG_DIR = join(REPO, '.sandbox');
export const DEFAULT_FLAGS_DIR = join(REPO, '.sandbox', 'flags');

export const FLAG_SPLIT = 'fail-split-once';
export const FLAG_LIST = 'fail-list';
export const FLAG_DELAY = 'delay-run-25s';
export const RUN_DELAY_MS = 25_000;
// Set on the detached delay helper's own environment. Private markers, never Herdr values.
export const HELPER_ENV = 'GJC_LIVE_DELAY_HELPER';
export const HELPER_DELAY_ENV = 'GJC_LIVE_DELAY_MS';

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
const isRun = (argv) => argv[0] === 'pane' && argv[1] === 'run';

// `pane split` answers `{"id":"cli:pane:split","result":{"pane":{"pane_id":"w1:p6",…}}}` (measured,
// `.sandbox/lv4split.json`); the flatter shapes are accepted too, so a CLI change cannot silently
// disable the delay rule.
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

// The delay applies only to a run whose pane came from a split this wrapper logged after the flag
// file was created: the same flag lifetime, and the same pane the launch pass itself split.
export function delayApplies({ logPath, flagPath, paneId }) {
  if (typeof paneId !== 'string' || paneId === '') return false;
  // File mtimes carry sub-millisecond precision, but the log's `atMs` is an integer millisecond. The
  // flag's instant is therefore floored to the millisecond, so a split logged in the very same
  // millisecond still counts as "after the flag" instead of failing by a fraction.
  let since;
  try { since = Math.floor(statSync(flagPath).mtimeMs); }
  catch {
    // outcome: the flag vanished between existsSync and statSync, i.e. another call consumed it.
    return false;
  }
  return readLog(logPath).some((entry) =>
    entry?.ok === true && entry?.paneId === paneId && Array.isArray(entry?.argv) &&
    isSplit(entry.argv) && Number(entry?.atMs ?? Date.parse(entry?.at ?? '')) >= since);
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
  const plain = { forward: true, reply: null, code: 0, log, paneId: null, delayed: false, delayMs: 0 };
  if (isSplit(argv) && existsSync(join(flags, FLAG_SPLIT))) {
    consume(FLAG_SPLIT);
    return { ...plain, forward: false, reply: injectedError(argv), code: 1 };
  }
  if (isList(argv) && existsSync(join(flags, FLAG_LIST))) {
    return { ...plain, forward: false, reply: injectedError(argv), code: 1 };
  }
  if (isRun(argv) && existsSync(join(flags, FLAG_DELAY))) {
    const paneId = argv[2] ?? null;
    if (delayApplies({ logPath: log, flagPath: join(flags, FLAG_DELAY), paneId })) {
      consume(FLAG_DELAY);
      return { ...plain, delayMs: RUN_DELAY_MS };
    }
  }
  return plain;
}

export function logLine({ at, argv, ok, code, ms, paneId = null, delayed = false,
  deferredPid = null }) {
  const line = { at, atMs: Date.parse(at), argv: [...argv], ok, code, ms };
  if (paneId !== null) line.paneId = paneId;
  if (delayed) line.delayed = true;
  if (deferredPid !== null) line.deferredPid = deferredPid;
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

function sleepSync(ms) {
  // The delayed call has nothing else to do, so a synchronous wait is the whole job of that helper.
  const view = new Int32Array(new SharedArrayBuffer(4));
  return Atomics.wait(view, 0, 0, ms);
}

export function main(argv = process.argv.slice(2), {
  env = process.env, now = () => new Date().toISOString(),
  spawnFn = spawnSync, spawnDetached = spawn, sleepFn = sleepSync,
  stdout = process.stdout, stderr = process.stderr, self = SELF,
} = {}) {
  const started = Date.now();
  const helper = String(env[HELPER_ENV] ?? '') === '1';
  // The helper IS the delayed call: it waits first, then does exactly what a normal call does. It
  // must not re-run `planCall`: that would let it consume a flag armed after the parent's decision.
  if (helper) {
    const delayMs = Number(env[HELPER_DELAY_ENV] ?? RUN_DELAY_MS);
    sleepFn(Number.isFinite(delayMs) && delayMs > 0 ? delayMs : RUN_DELAY_MS);
    return forward(argv, { env, logPath: paths(env).log, started, now, spawnFn, stdout, stderr,
      delayed: true });
  }
  const plan = planCall(argv, env);
  if (!plan.forward) {
    stdout.write(structuredBody(plan.reply));
    stderr.write(`${plan.reply.error.message}\n`);
    appendLog(plan.log, logLine({ at: now(), argv, ok: false, code: plan.reply.error.code,
      ms: Date.now() - started }));
    return plan.code;
  }
  if (plan.delayMs > 0) {
    // Detached on purpose: the caller kills this process when its own timeout expires, and the
    // delayed call must still reach the real herdr (and be logged) afterwards.
    const child = spawnDetached(process.execPath, [self, ...argv],
      { detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...env, [HELPER_ENV]: '1', [HELPER_DELAY_ENV]: String(plan.delayMs) } });
    child.unref?.();
    appendLog(plan.log, logLine({ at: now(), argv, ok: true, code: null,
      ms: Date.now() - started, delayed: true, deferredPid: child.pid ?? null }));
    return 0;
  }
  return forward(argv, { env, logPath: plan.log, started, now, spawnFn, stdout, stderr,
    delayed: false });
}

function forward(argv, { env, logPath, started, now, spawnFn, stdout, stderr, delayed }) {
  const bin = realBinary(env);
  if (bin === null) {
    const message = 'the live wrapper has no real herdr binary (HERDR_BIN_PATH/GJC_LIVE_REAL_HERDR)';
    stdout.write(structuredBody({ error: { code: 'herdr_missing', message } }));
    stderr.write(`${message}\n`);
    appendLog(logPath, logLine({ at: now(), argv, ok: false, code: 'herdr_missing',
      ms: Date.now() - started, delayed }));
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
      // outcome: an unparseable split reply simply carries no pane id for the delay rule.
    }
  }
  appendLog(logPath, logLine({ at: now(), argv, ok: code === 0, code: errorCodeOf(result, code),
    ms: Date.now() - started, paneId, delayed }));
  if (result.error && !result.stdout && !result.stderr) stderr.write(`${result.error.message}\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
