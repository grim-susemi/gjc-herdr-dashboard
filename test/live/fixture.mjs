// Harness-owned live fixture (plan §15.4): the only way a live script touches Herdr.
//
// Resource priority (plan §15.4): (1) a separate Herdr session, (2) an owned tab that never moves
// focus, (3) a tab the owner hands over. This module implements (1) and (2) and NOTHING else -
// there is no API here that can act on a pane the fixture did not create. Every pane id the
// fixture hands out is remembered in `owned`, and `assertOwnedPane` is called by every action
// before any Herdr input verb, so an owner pane (`w1:pT5` and friends) can never be typed into by
// accident: the guard fails closed with `live-pane-not-owned`.
//
// Every resource created is appended to `<evidence>/receipt.json` as
// `{kind, id, createdAt, creator:'harness'}`; cleanup re-reads the current state (session socket,
// workspace, tab, pane label) and only then closes, recording `verifiedAbsent:true` (or the
// mismatch that made it stop). A resource that no longer matches is left alone and recorded.
//
// Herdr subcommands used (measured at L0 G7 / U13 / this module's own smoke pass):
//   herdr --session <name> server                       (detached; the session's server)
//   herdr session list --json                          -> {sessions:[{name,running,socket_path}]}
//   herdr session stop <name> --json
//   herdr --session <name> workspace create --cwd <abs> --label <text> --no-focus
//                                                      -> {workspace:{...},tab:{...},root_pane:{...}}
//   herdr --session <name> pane list                   -> {panes:[{pane_id,tab_id,workspace_id,label,...}]}
//   herdr --session <name> pane layout --pane <id>     -> {layout:{...}}
//   herdr --session <name> pane read <id> --source visible --format ansi
//   herdr --session <name> pane send-text <id> <text>
//   herdr --session <name> pane send-keys <id> <key>
//   herdr --session <name> workspace close <workspace_id>
//   herdr --session <name> pane close <pane_id>
//
// Every CLI call runs with a SCRUBBED environment (all HERDR_* removed) and an explicit
// `--session`, so a live script can never reach the session of the process that launched it.
//
// Exported signatures
//   REPO, SANDBOX, EVIDENCE
//   BUSY_MARKER, PROMPT_MARKER
//   realHerdrBinary(env)                       -> absolute path to the herdr executable
//   createFixture({session, evidenceDir, env, binary, ...seams})
//     herdr(args, {session:true})              -> parsed JSON reply (session-prefixed by default)
//     rawHerdr(args, {session:true})           -> {status, stdout, stderr}
//     sessionRunning()                         -> boolean
//     startSession() / stopSession()
//     createWorkspace({cwd, label})            -> {workspaceId, tabId, rootPaneId}
//     listPanes() / ownedPaneIds() / assertOwnedPane(paneId)
//     readPane(paneId) / layout(paneId) / snapshot(dir, name, paneId) / snapshotLayout(...)
//     sendText(paneId, text) / sendKeys(paneId, ...keys) / slash(paneId, name)
//     waitIdle(paneId, options) / waitFor(paneId, predicate, options)
//     cleanup()                                -> {closed, verifiedAbsent, skipped}
//     receipt()                                -> the live receipt object
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SANDBOX = join(REPO, '.sandbox');
export const EVIDENCE = join(REPO, '.evidence');

// Measured on screen: during `warming workspace` no input box is painted yet and a slash command
// sent then is dropped; `Alt+Q: Queue (busy)` is a keybinding HINT that is painted even when idle.
// `BUSY_MARKER` and `PROMPT_MARKER` are kept as the plan's and the host's tokens for callers that
// want to assert on the raw frame.
export const BUSY_MARKER = 'Queue (busy)';
export const PROMPT_MARKER = 'Type your message';
export const BOOT_MARKER = 'warming workspace';

export function realHerdrBinary(env = process.env) {
  const override = String(env.GJC_LIVE_REAL_HERDR_BIN ?? '').trim();
  if (override !== '') return override;
  const explicit = String(env.HERDR_BIN_PATH ?? '').trim();
  if (explicit !== '') return explicit;
  throw Object.assign(new Error('the live fixture needs HERDR_BIN_PATH (or GJC_LIVE_REAL_HERDR_BIN)'),
    { code: 'herdr-missing' });
}

const coded = (code, message) => Object.assign(new Error(message ?? code), { code });

const parseMaybe = (text) => {
  try { return text.trim() === '' ? null : JSON.parse(text); }
  catch {
    // outcome: a non-JSON line is plain output, and the caller treats null as "not JSON".
    return null;
  }
};

export function createFixture(options = {}) {
  const {
    session, evidenceDir = join(EVIDENCE, 'L1', 'LV-0'),
    env = process.env, binary = null,
    spawnFn = spawnSync, spawnDetached = spawn,
    now = () => new Date().toISOString(),
    sleepFn = (ms) => new Promise((done) => { setTimeout(done, ms); }),
    pollMs = 500, settleMs = 1_500,
  } = options;
  if (typeof session !== 'string' || session.trim() === '') throw coded('live-session-name', 'session name required');
  const bin = binary ?? realHerdrBinary(env);
  // The wrapper's log directory. It MUST be per-case: two live scripts sharing one log would see
  // each other's splits (the LV-3 and LV-10 "one split" assertions both read it).
  const workDir = options.logDir
    ?? (String(env.GJC_LIVE_LOG_DIR ?? '').trim() === ''
      ? join(SANDBOX, `live-${session}`) : env.GJC_LIVE_LOG_DIR);
  const flagsDir = options.flagsDir ?? (String(env.GJC_LIVE_FLAGS_DIR ?? '').trim() === ''
    ? join(workDir, 'flags') : env.GJC_LIVE_FLAGS_DIR);
  // The wrapper inside the pane reads `GJC_LIVE_FLAGS_DIR`/`GJC_LIVE_LOG_DIR` from ITS environment, so
  // a fixture that armed a flag somewhere else would inject nothing and the LV would fail for the
  // wrong reason. `wrapperEnv()` is the pair a live script must put on the pane's launch command;
  // `armFault` refuses to arm without it.
  const flagsConfigured = options.flagsDir !== undefined || options.logDir !== undefined
    || String(env.GJC_LIVE_FLAGS_DIR ?? '').trim() !== '';
  const owned = new Map();          // paneId -> {paneId, tabId, workspaceId, label, role}
  const observed = new Map();       // panes the product created inside our workspace (read-only)
  const ownedTabs = new Map();      // tabId -> {tabId, workspaceId}
  const ownedWorkspaces = new Map();// workspaceId -> {workspaceId, label, cwd}
  const created = [];
  const closed = [];
  let sessionSocket = null;
  let started = false;

  // All HERDR_* are removed: the CLI is addressed by `--session` only, so the fixture can never
  // act on the session of the process that launched it (the owner's session).
  const clientEnv = () => {
    const copy = {};
    for (const [key, value] of Object.entries(env)) if (!key.startsWith('HERDR_')) copy[key] = value;
    return copy;
  };

  function rawHerdr(args, { withSession = true } = {}) {
    const argv = withSession ? ['--session', session, ...args] : [...args];
    const result = spawnFn(bin, argv, { env: clientEnv(), encoding: 'utf8', windowsHide: true,
      maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
    return { status: result.status ?? (result.error ? 1 : 0),
      stdout: result.stdout ?? '', stderr: result.stderr ?? '', argv,
      error: result.error ?? null };
  }

  function herdr(args, { withSession = true, allowError = false } = {}) {
    const raw = rawHerdr(args, { withSession });
    let body = null;
    try { body = raw.stdout.trim() === '' ? null : JSON.parse(raw.stdout); }
    catch {
      // outcome: a non-JSON reply is a transport failure, and the raw text is the evidence.
      if (!allowError) throw coded('herdr-reply', `herdr ${args.join(' ')}: ${raw.stdout.slice(0, 200)}${raw.stderr.slice(0, 200)}`);
    }
    // Socket commands answer `{id, result: <payload>}`; local commands (`session list --json`)
    // answer the payload itself. Both shapes are normalised to the payload here, and an `error`
    // wrapper is always an error. (Measured: L0 G7 / this module's smoke pass.)
    if (body?.error && !allowError) {
      throw coded(body.error.code ?? 'herdr-error', body.error.message ?? JSON.stringify(body.error));
    }
    if (raw.error && !allowError) throw coded(raw.error.code ?? 'herdr-spawn', raw.error.message);
    if (raw.status !== 0 && !allowError) {
      throw coded('herdr-exit', `herdr ${args.join(' ')} exited ${raw.status}: ${raw.stdout.slice(0, 200)}${raw.stderr.slice(0, 200)}`);
    }
    return body?.result ?? body;
  }

  const record = (kind, id, extra = {}) => {
    const entry = { kind, id, createdAt: now(), creator: 'harness', ...extra };
    created.push(entry);
    writeReceipt();
    return entry;
  };

  function writeReceipt() {
    const payload = { schema: 'gjc-herdr-dashboard/live-receipt/1', session,
      created, observed: [...observed.values()], closed,
      verifiedAbsent: closed.length > 0 && closed.every(entry => entry.verifiedAbsent === true) };
    try {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, 'receipt.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch {
      // outcome: an unwritable evidence directory must not abort a live run; the caller sees the
      // missing file when it reads the evidence.
    }
    return payload;
  }

  // -------------------------------------------------- session -----------------------------------
  function sessionList() {
    // `session list` is a local command (it reads the session registry), so it is issued without
    // a `--session` prefix.
    const body = herdr(['session', 'list', '--json'], { withSession: false });
    return Array.isArray(body?.sessions) ? body.sessions : [];
  }

  function sessionEntry() {
    return sessionList().find(entry => entry?.name === session) ?? null;
  }

  const sessionRunning = () => sessionEntry()?.running === true;

  async function startSession({ timeoutMs = 30_000 } = {}) {
    if (sessionRunning()) {
      throw coded('live-session-exists', `the Herdr session ${session} is already running; pick another name`);
    }
    const child = spawnDetached(bin, ['--session', session, 'server'], { detached: true,
      stdio: 'ignore', windowsHide: true, env: clientEnv() });
    child.unref?.();
    record('session', session, { pid: child.pid ?? null, role: 'herdr session (server)' });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleepFn(pollMs);
      const entry = sessionEntry();
      if (entry?.running === true) {
        started = true;
        sessionSocket = entry.socket_path ?? null;
        return { session, socket: sessionSocket, pid: child.pid ?? null };
      }
    }
    throw coded('live-session-timeout', `the Herdr session ${session} did not start within ${timeoutMs} ms`);
  }

  async function stopSession({ timeoutMs = 20_000 } = {}) {
    const entry = sessionEntry();
    if (!entry || entry.running !== true) {
      closed.push({ kind: 'session', id: session, at: now(), verifiedAbsent: true,
        note: 'already stopped' });
      writeReceipt();
      return true;
    }
    if (sessionSocket !== null && entry.socket_path !== sessionSocket) {
      closed.push({ kind: 'session', id: session, at: now(), verifiedAbsent: false,
        mismatch: `socket ${entry.socket_path} is not the harness socket ${sessionSocket}` });
      writeReceipt();
      return false;
    }
    herdr(['session', 'stop', session, '--json'], { withSession: false, allowError: true });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleepFn(pollMs);
      if (!sessionRunning()) {
        closed.push({ kind: 'session', id: session, at: now(), verifiedAbsent: true });
        writeReceipt();
        return true;
      }
    }
    closed.push({ kind: 'session', id: session, at: now(), verifiedAbsent: false,
      mismatch: 'still running after session stop' });
    writeReceipt();
    return false;
  }

  // -------------------------------------------------- workspace + panes -------------------------
  function createWorkspace({ cwd, label = 'gjc-live' } = {}) {
    if (started !== true) throw coded('live-session-not-started', 'startSession() must run first');
    const body = herdr(['workspace', 'create', '--cwd', cwd, '--label', label, '--no-focus']);
    const workspace = body?.workspace ?? body?.result?.workspace ?? null;
    const tab = body?.tab ?? body?.result?.tab ?? null;
    const root = body?.root_pane ?? body?.result?.root_pane ?? null;
    const workspaceId = workspace?.workspace_id ?? null;
    const tabId = tab?.tab_id ?? null;
    const rootPaneId = root?.pane_id ?? null;
    if (!workspaceId || !rootPaneId) {
      throw coded('live-workspace-shape', `workspace create answered ${JSON.stringify(body).slice(0, 200)}`);
    }
    ownedWorkspaces.set(workspaceId, { workspaceId, label, cwd });
    if (tabId) ownedTabs.set(tabId, { tabId, workspaceId });
    owned.set(rootPaneId, { paneId: rootPaneId, tabId, workspaceId, label, role: 'parent' });
    record('workspace', workspaceId, { cwd, label, focus: 'no-focus' });
    if (tabId) record('tab', tabId, { workspaceId });
    record('pane', rootPaneId, { workspaceId, tabId, role: 'parent', label });
    return { workspaceId, tabId, rootPaneId };
  }

  const listPanes = () => {
    const body = herdr(['pane', 'list']);
    return Array.isArray(body?.panes) ? body.panes : [];
  };

  const ownedPaneIds = () => [...owned.keys()];

  // Fault flags are plain files in the wrapper's flag directory (plan §15.4). Live scripts arm them
  // through this helper, so the directory is spelled in exactly one place.
  const flagPath = (name) => join(flagsDir, name);

  function armFault(name) {
    if (!flagsConfigured) {
      throw coded('live-flags-dir',
        'armFault needs GJC_LIVE_FLAGS_DIR (pass fixture.wrapperEnv() into the pane launch)');
    }
    const path = flagPath(name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', 'utf8');
    record('fault', name, { path });
    return path;
  }

  const disarmFault = (name) => rmSync(flagPath(name), { force: true });

  // The wrapper's own log: the assertions for LV-2/3/10 read it to prove what actually reached the
  // real binary (a `run` that never happened is invisible in the pane frame alone).
  const logPath = join(workDir, 'wrapper.log.jsonl');
  const rawLog = () => {
    try { return readFileSync(logPath, 'utf8'); }
    catch {
      // outcome: no log file means the wrapper was never called, which is itself the evidence.
      return '';
    }
  };

  // The strict guard: every INPUT verb (send-text / send-keys) goes through this, and it only ever
  // accepts a pane this fixture created (or one it explicitly adopted). A pane id that the fixture
  // does not own is refused, so an owner pane such as `w1:pT5` can never be typed into by accident.
  function assertOwnedPane(paneId) {
    if (!owned.has(paneId)) {
      throw coded('live-pane-not-owned',
        `pane ${paneId} was not created by this fixture; refusing to touch it`);
    }
    return checkListed(paneId, owned.get(paneId));
  }

  function checkListed(paneId, pane) {
    const listed = listPanes().find(entry => (entry.pane_id ?? entry.paneId) === paneId) ?? null;
    if (listed === null) throw coded('live-pane-gone', `pane ${paneId} is no longer listed`);
    if (listed.workspace_id !== pane.workspaceId || listed.tab_id !== pane.tabId) {
      throw coded('live-pane-recycled',
        `pane ${paneId} now belongs to ${listed.workspace_id}/${listed.tab_id}, not ${pane.workspaceId}/${pane.tabId}`);
    }
    return { ...pane, listed };
  }

  // READ-ONLY guard. The product creates panes inside the harness workspace (the role viewer), and a
  // live script must be able to read them; what it must never do is read from a pane OUTSIDE the
  // workspaces this fixture created. Discovery is recorded in `observed` (never in `created`, which
  // claims authorship), and the session itself is a separate Herdr session, so an owner pane is not
  // even addressable here.
  function assertVisiblePane(paneId) {
    if (owned.has(paneId)) return checkListed(paneId, owned.get(paneId));
    const listed = listPanes().find(entry => (entry.pane_id ?? entry.paneId) === paneId) ?? null;
    if (listed === null) throw coded('live-pane-gone', `pane ${paneId} is not listed`);
    if (!ownedWorkspaces.has(listed.workspace_id)) {
      throw coded('live-pane-not-owned',
        `pane ${paneId} is outside the harness workspace; refusing to read it`);
    }
    if (!observed.has(paneId)) {
      observed.set(paneId, { paneId, workspaceId: listed.workspace_id, tabId: listed.tab_id,
        label: listed.label ?? null });
      writeReceipt();
    }
    return { paneId, workspaceId: listed.workspace_id, tabId: listed.tab_id, listed };
  }

  function adoptPane(paneId, { role, label = null }) {
    const listed = listPanes().find(entry => (entry.pane_id ?? entry.paneId) === paneId) ?? null;
    if (listed === null) throw coded('live-pane-gone', `pane ${paneId} is not listed`);
    const workspaceId = listed.workspace_id;
    if (!ownedWorkspaces.has(workspaceId)) {
      throw coded('live-pane-not-owned', `pane ${paneId} is outside the harness workspace`);
    }
    const entry = { paneId, tabId: listed.tab_id, workspaceId, label, role };
    owned.set(paneId, entry);
    record('pane', paneId, { workspaceId, tabId: listed.tab_id, role, label });
    return entry;
  }

  // -------------------------------------------------- IO ----------------------------------------
  function readPane(paneId, { source = 'visible', format = 'ansi' } = {}) {
    // Guarding the read is what keeps a stray id from being read out of a foreign pane.
    assertVisiblePane(paneId);
    const raw = rawHerdr(['pane', 'read', paneId, '--source', source, '--format', format]);
    const text = raw.stdout;
    const body = parseMaybe(text);
    const payload = body?.result ?? body;
    for (const key of ['text', 'data', 'output', 'snapshot', 'content']) {
      if (typeof payload?.[key] === 'string') return payload[key];
    }
    if (typeof payload === 'string') return payload;
    if (body?.error) throw coded(body.error.code ?? 'herdr-error', body.error.message);
    // outcome: `pane read` also answers with the terminal text itself; that is the measured
    // fallback, so the raw stdout is the frame.
    return text;
  }

  function layout(paneId) {
    assertVisiblePane(paneId);
    const body = herdr(['pane', 'layout', '--pane', paneId]);
    return body?.layout ?? body?.result?.layout ?? null;
  }

  function snapshot(dir, name, paneId) {
    const text = readPane(paneId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.txt`), `${text}\n`, 'utf8');
    return text;
  }

  function snapshotLayout(dir, name, paneId) {
    const value = layout(paneId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return value;
  }

  const sendText = (paneId, text) => {
    assertOwnedPane(paneId);
    return herdr(['pane', 'send-text', paneId, text]);
  };

  const sendKeys = (paneId, ...keys) => {
    assertOwnedPane(paneId);
    return herdr(['pane', 'send-keys', paneId, ...keys]);
  };

// A slash command needs the completion popup to settle before Enter, otherwise Enter is consumed by
// the popup instead of running the command. Measured in one pane, back to back (`.sandbox/live-head-dbg.mjs`):
//   `/dashboard` in one stroke + Enter  -> dropped (no notify, zero Herdr calls)
//   `/da` + `shboard` + Enter           -> dropped (the popup still lists several candidates)
//   `/dash` + `board` + Enter           -> runs the pass (`ext dev · Todo 열림`, 7 Herdr calls)
// So the head is 5 characters - the length at which the popup narrows to the single command - and the
// caller still waits for the notify instead of trusting the keystrokes (`sendSlash` in case.mjs).
async function slash(paneId, name, { headMs = 700, restMs = 500 } = {}) {
  const text = name.startsWith('/') ? name : `/${name}`;
  const head = text.slice(0, Math.min(5, text.length));
  sendText(paneId, head);
  await sleepFn(headMs);
  if (head.length < text.length) {
    sendText(paneId, text.slice(head.length));
    await sleepFn(restMs);
  }
  sendKeys(paneId, 'enter');
  return text;
}

  // `waitIdle` is the door every send to a gjc pane goes through. Two measured facts shape it:
  //   * the boot banner is STATIC, so a stable frame alone is not proof the app is ready; a slash
  //     command typed while the pane still shows `warming workspace` is dropped (measured: no notify
  //     and not a single Herdr call).
  //   * the input box is NOT in the `visible` snapshot (it sits below the viewport), so the prompt
  //     text cannot be used as the marker; the plan's `Queue (busy)` token is a keybinding HINT that is
  //     painted even when idle, so it must not be used as a hard veto either. `busyMarkers` is an
  //     explicit caller-side tightening for a build where that was measured to hold.
  // A viewer pane never shows the prompt at all; do not call this on one.
  async function waitIdle(paneId, { timeoutMs = 60_000, quiet = 2, busyMarkers = null } = {}) {
    const veto = busyMarkers ?? [];
    const deadline = Date.now() + timeoutMs;
    let previous = null;
    let stable = 0;
    let frame = '';
    while (Date.now() < deadline) {
      frame = readPane(paneId);
      const booting = frame.includes(BOOT_MARKER);
      const busy = veto.some(marker => frame.includes(marker));
      stable = !booting && !busy && frame === previous ? stable + 1 : 0;
      if (stable >= quiet) return frame;
      previous = frame;
      await sleepFn(pollMs);
    }
    throw coded('live-not-idle', `pane ${paneId} was not idle within ${timeoutMs} ms`);
  }

  async function waitFor(paneId, predicate, { timeoutMs = 45_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let frame = '';
    while (Date.now() < deadline) {
      frame = readPane(paneId);
      if (predicate(frame) === true) return frame;
      await sleepFn(pollMs);
    }
    throw coded('live-timeout', `${label} did not happen within ${timeoutMs} ms`);
  }

  const workspaceList = () => {
    const body = herdr(['workspace', 'list'], { allowError: true });
    const value = body?.workspaces ?? body?.result?.workspaces ?? [];
    return Array.isArray(value) ? value : [];
  };
  const tabList = () => {
    const body = herdr(['tab', 'list'], { allowError: true });
    const value = body?.tabs ?? body?.result?.tabs ?? [];
    return Array.isArray(value) ? value : [];
  };

  // `waitForNotify`-style callers read frames through `readPane`, so the fixture also exposes the
  // parsed wrapper log (assertions about what reached the real binary).

  async function cleanup() {
    const skipped = [];
    // Panes first (a workspace close would take the root pane with it, which is fine, but closing
    // what we created is what the receipt must be able to prove).
    for (const [paneId, pane] of [...owned.entries()]) {
      if (pane.role === 'parent') continue; // closed with its workspace
      const listed = listPanes().find(entry => (entry.pane_id ?? entry.paneId) === paneId) ?? null;
      if (listed === null) {
        closed.push({ kind: 'pane', id: paneId, at: now(), verifiedAbsent: true,
          note: 'already gone' });
        continue;
      }
      if (listed.workspace_id !== pane.workspaceId || listed.tab_id !== pane.tabId) {
        closed.push({ kind: 'pane', id: paneId, at: now(), verifiedAbsent: false,
          mismatch: `now ${listed.workspace_id}/${listed.tab_id}, expected ${pane.workspaceId}/${pane.tabId}` });
        skipped.push(paneId);
        continue;
      }
      herdr(['pane', 'close', paneId], { allowError: true });
      await sleepFn(200);
      const after = listPanes().some(entry => (entry.pane_id ?? entry.paneId) === paneId);
      closed.push({ kind: 'pane', id: paneId, at: now(), verifiedAbsent: !after,
        recheck: { workspaceId: listed.workspace_id, tabId: listed.tab_id, label: listed.label ?? null } });
    }
    for (const [workspaceId, workspace] of [...ownedWorkspaces.entries()]) {
      const listed = workspaceList().find(entry => (entry.workspace_id ?? entry.workspaceId) === workspaceId) ?? null;
      if (listed === null) {
        closed.push({ kind: 'workspace', id: workspaceId, at: now(), verifiedAbsent: true,
          note: 'already gone' });
        continue;
      }
      herdr(['workspace', 'close', workspaceId], { allowError: true });
      await sleepFn(300);
      const after = workspaceList().some(entry => (entry.workspace_id ?? entry.workspaceId) === workspaceId);
      closed.push({ kind: 'workspace', id: workspaceId, at: now(), verifiedAbsent: !after,
        recheck: { label: listed.label ?? workspace.label, cwd: listed.cwd ?? workspace.cwd } });
    }
    for (const [tabId, tab] of [...ownedTabs.entries()]) {
      const listed = tabList().find(entry => (entry.tab_id ?? entry.tabId) === tabId) ?? null;
      closed.push({ kind: 'tab', id: tabId, at: now(), verifiedAbsent: listed === null,
        recheck: { workspaceId: tab.workspaceId, label: listed?.label ?? null } });
    }
    await stopSession();
    writeReceipt();
    return { closed: [...closed], skipped, verifiedAbsent: closed.every(entry => entry.verifiedAbsent === true) };
  }

  return { session, binary: bin, herdr, rawHerdr, sessionList, sessionRunning,
    startSession, stopSession, createWorkspace, listPanes, ownedPaneIds, assertOwnedPane,
    assertVisiblePane, observedPanes: () => [...observed.values()],
    adoptPane, readPane, layout, snapshot, snapshotLayout, sendText, sendKeys, slash, waitIdle,
    waitFor, cleanup, armFault, disarmFault, rawLog, flagPath, logDir: workDir, flagsDir, logPath,
    // The [key, value] pairs a live script must put on the pane's environment so the wrapper inside
    // that pane writes to THIS case's log and reads THIS case's flags.
    wrapperEnv: () => [['GJC_LIVE_LOG_DIR', workDir], ['GJC_LIVE_FLAGS_DIR', flagsDir]],
    receipt: () => writeReceipt(), writeReceipt, evidenceDir, record };
}
