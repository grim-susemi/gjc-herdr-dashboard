// Shared case setup for the live L1 scripts (plan §15.3): a sandbox case with its own dev shim,
// a gjc launched inside a harness-owned pane with the wrapper as its Herdr vector, and the
// notify parser the assertions read.
//
// The launch is typed into the pane (never run as a child process of this script): L1 LV-1/LV-4
// measured that the pane shell is PowerShell, that the pane inherits HERDR_ENV / HERDR_SESSION /
// HERDR_SOCKET_PATH / HERDR_PANE_ID / HERDR_TAB_ID / HERDR_WORKSPACE_ID from its own session, and
// that a typed `$env:NAME='value'` prefix reaches gjc. GJC_HERDR_PANE_OWNER is REMOVED first: this
// script's own environment carries the owner process's marker, and a harness pane must not claim
// it.
//
// Exported signatures
//   LAUNCH_CLEAR_ENV
//   casePaths({caseId, root})                  -> {dir, stateDir, shimPath, evidenceDir}
//   createCase({caseId, root, state, herdr})   -> casePaths + {shim: <stdout of dev-shim>}
//   launchCommand({dir, herdr, args})          -> single-line PowerShell command
//   launchGjc(fixture, paneId, options)        -> the typed command string
//   notifyLines(frame)                         -> ['ext dev · …', …]
//   waitForNotify(fixture, paneId, pattern, options) -> {frame, line, all}
//   viewerPanes(fixture, role = 'todo')       -> panes labelled `GJC <Role> ·` (role null = every GJC pane)
//   assert(condition, message, details?)
//   evidenceDirFor(level, lv)
//   runScript(name, fn)                        -> never returns; exits 0 or 1
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EVIDENCE, REPO, SANDBOX } from './fixture.mjs';

export const LAUNCH_CLEAR_ENV = ['GJC_HERDR_PANE_OWNER', 'GJC_SESSION_CWD', 'HERDR_CONFIG_PATH'];
export const DEFAULT_ARGS = ['--no-session', '--no-title'];

const coded = (code, message, details = null) =>
  Object.assign(new Error(message ?? code), { code, details });

export function casePaths({ caseId, root = SANDBOX, state = null }) {
  const dir = join(root, `case-${caseId}`);
  return { dir, stateDir: state ?? join(dir, '.gjc', 'herdr-dashboard', 'state'),
    shimPath: join(dir, '.gjc', 'extensions', 'gjc-herdr-dashboard.js') };
}

export function evidenceDirFor(level, lv) {
  return join(EVIDENCE, level, lv);
}

// `node scripts/dev-shim.mjs --case <id> --state <abs> --herdr <json argv>` writes
// `<case>/.gjc/extensions/gjc-herdr-dashboard.js`, which is the project-scope extension the pane's
// gjc loads (its cwd is the case dir).
export function createCase({ caseId, root = SANDBOX, state = null, herdr, viewerFailpoint = null }) {
  const paths = casePaths({ caseId, root, state });
  const argv = ['scripts/dev-shim.mjs', '--case', caseId, '--state', paths.stateDir];
  if (herdr) argv.push('--herdr', JSON.stringify(herdr));
  if (viewerFailpoint) argv.push('--viewer-failpoint', viewerFailpoint);
  const shim = spawnSync(process.execPath, argv, { cwd: REPO, encoding: 'utf8', windowsHide: true });
  if (shim.status !== 0) {
    throw coded('live-case', `dev-shim failed (${shim.status}): ${shim.stdout}${shim.stderr}`);
  }
  return { ...paths, shim: shim.stdout.trim() };
}

const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export function launchCommand({ dir, herdr, args = DEFAULT_ARGS, clearEnv = LAUNCH_CLEAR_ENV,
  extra = [] } = {}) {
  const parts = [`Set-Location -LiteralPath ${psQuote(resolve(dir))}`];
  for (const key of clearEnv) parts.push(`Remove-Item -ErrorAction SilentlyContinue Env:${key}`);
  if (herdr) parts.push(`$env:GJC_HERDR_DASHBOARD_HERDR = ${psQuote(JSON.stringify(herdr))}`);
  for (const [key, value] of extra) parts.push(`$env:${key} = ${psQuote(value)}`);
  parts.push(['gjc', ...args].join(' '));
  return parts.join('; ');
}

// A long single `send-text` is dropped by the gjc input box (measured: 90 characters in one call
// produced no turn), while 12-character chunks arrive intact. Enter follows after a short settle.
export async function sendPrompt(fixture, paneId, text, { chunk = 12, gapMs = 150, settleMs = 1_500 } = {}) {
  for (let at = 0; at < text.length; at += chunk) {
    fixture.sendText(paneId, text.slice(at, at + chunk));
    await new Promise((done) => { setTimeout(done, gapMs); });
  }
  await new Promise((done) => { setTimeout(done, settleMs); });
  fixture.sendKeys(paneId, 'enter');
}

export async function launchGjc(fixture, paneId, options) {
  const command = launchCommand(options);
  fixture.sendText(paneId, command);
  fixture.sendKeys(paneId, 'enter');
  return command;
}

// The host renders one notify per `/dashboard` call as an ANSI-styled line inside the pane frame:
// ` ext dev · Todo 열림` (L1 LV-1 viewer-frame.txt / LV-4-outside-herdr.txt). The colour codes sit
// inside the line (measured: they break a naive `^\s*ext \S+ · ` match), so they are stripped first.
export const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text) => String(text ?? '').replace(ANSI, '');

export function notifyLines(frame) {
  return stripAnsi(frame).split(/\r?\n/)
    .filter((line) => /^\s*ext \S+ · /.test(line))
    .map((line) => line.trim());
}

export async function waitForNotify(fixture, paneId, pattern, {
  timeoutMs = 60_000, label = null, pollMs = 1_000, since = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let frame = '';
  let all = [];
  while (Date.now() < deadline) {
    frame = fixture.readPane(paneId);
    all = notifyLines(frame).slice(since);
    const line = all.find((entry) => pattern.test(entry));
    if (line !== undefined) return { frame, line, all };
    await new Promise((done) => { setTimeout(done, pollMs); });
  }
  throw coded('live-timeout',
    `${label ?? pattern} did not appear within ${timeoutMs} ms; notifies so far: ${JSON.stringify(all)}`,
    { frame });
}

// Sending is only half of a slash command: Enter is eaten by the completion popup unless the text is
// narrowed first, and the host renders the outcome as a notify line. So a live script does not just
// send and hope - it retries the send until the expected notify appears, then lets the assertion run
// on the notify itself. Without this, a "the second `/dashboard` did nothing" verdict would be a
// harness artefact rather than a product fact.
export async function sendSlash(fixture, paneId, name, pattern, {
  attempts = 3, timeoutMs = 40_000, settleMs = 8_000, label = null, since = () => 0 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = since();
    await fixture.slash(paneId, name);
    try {
      const seen = await waitForNotify(fixture, paneId, pattern,
        { timeoutMs: attempt === attempts ? timeoutMs * 2 : timeoutMs, label, since: before });
      return { ...seen, attempt, line: seen.line, all: seen.all };
    } catch (error) {
      last = error;
      await new Promise((done) => { setTimeout(done, settleMs); });
    }
  }
  throw last;
}

// No notify is itself an assertion for LV-3/LV-10 ("no second `/dashboard`"), so the harness needs a
// way to wait out a quiet window that is long enough to be meaningful. `baseline` is the number of
// notifies already on screen that this window must not grow past.
export async function expectNoNotify(fixture, paneId, pattern, {
  windowMs = 30_000, pollMs = 1_000, baseline = 0 } = {}) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const lines = notifyLines(fixture.readPane(paneId)).slice(baseline);
    const matched = lines.filter((line) => pattern.test(line));
    if (matched.length > 0) {
      throw coded('live-unexpected-notify', `unexpected notify during the quiet window: ${matched[0]}`,
        { matched, lines });
    }
    await new Promise((done) => { setTimeout(done, pollMs); });
  }
  return true;
}

// `role` filters by label (`GJC Todo ·`, `GJC Workers ·`); the default is the Todo pane, which is the
// L1 single-viewer view. Pass `null` for every dashboard pane.
export const viewerPanes = (fixture, role = 'todo') => fixture.listPanes().filter((pane) => {
  const label = String(pane.label ?? '');
  if (role === null) return /^GJC /.test(label);
  return label.startsWith(`GJC ${role[0].toUpperCase()}${role.slice(1)} `);
});

export function assert(condition, message, details = null) {
  if (condition !== true) throw coded('live-assertion', message, details);
}

export function writeEvidence(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

export function writeEvidenceJson(dir, name, value) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// One entry/exit shape for every live script: assertions throw, the fixture is always cleaned up
// by the caller's own `finally`, and the process exit code tells the caller whether the LV passed.
export async function runScript(name, fn) {
  try {
    const result = await fn();
    console.log(`${name}: PASS`);
    return result;
  } catch (error) {
    console.error(`${name}: FAIL ${error.code ?? 'error'}: ${error.message}`);
    if (error.details && !error.details.frame) console.error('--- details ---\n' + JSON.stringify(error.details).slice(0, 1500));
    if (error.details?.frame) {
      console.error('--- last frame ---');
      console.error(String(error.details.frame).slice(0, 4000));
    }
    process.exitCode = 1;
    return null;
  }
}
