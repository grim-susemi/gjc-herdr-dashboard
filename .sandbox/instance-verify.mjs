// Consolidated verification for `extension.mjs` + `src/host/instance.mjs` (lane 13).
// Scratch evidence, NOT a repo test: `.sandbox/` is gitignored and the real unit tests for this
// module are a separate lane. Run: node .sandbox/instance-verify.mjs
//
// It covers, in order:
//   A. factory purity (process/global accessors trapped; the registry map must not exist)
//   B. sub-session inertness (LT-6: 0 registry writes, 0 files, 0 herdr calls)
//   C. arming, heartbeat tick, /dashboard = exactly one notify, delegate token, replace handover
//   D. the poll: leaf seeding, one pass per change, permanent fallback to event-only on a throw
//   E. shutdown order (timers -> markStopped -> disposed) and the §7.1 item 5 data gate
//   F. the REAL defaults (eligibility/binding/notify/projection/generation) with fake seams
//   G. the REAL reconciler behind the instance: split -> rename -> run, slot + data files, no
//      automatic mutation, `stoppedAt` on shutdown
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import entry from '../extension.mjs';
import { createInstance } from '../src/host/instance.mjs';
import { layoutKeyOf } from '../src/core/slot.mjs';
import { writeJson } from '../src/storage.mjs';

const SYMBOL = Symbol.for('gjc.herdr.dashboard/1');
const ROOT = pathToFileURL(join(process.cwd()) + '/').href;
const results = [];
const ok = (...keys) => results.push(...keys);

// ------------------------------------------------------------------ shared fake seams ----------
const notifications = [];
const timers = new Map();
let seq = 0;
const setIntervalFn = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; };
const clearIntervalFn = (id) => { timers.delete(id); };
const fire = async (ms) => { for (const t of [...timers.values()]) if (t.ms === ms) await t.fn(); };
const settle = async (read, { tries = 40, quiet = 3 } = {}) => {
  let last = read(), stable = 0;
  for (let i = 0; i < tries && stable < quiet; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    const now = read();
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  return last;
};
const piOf = () => {
  const handlers = new Map(); const commands = new Map(); const channels = new Map();
  return { handlers, commands, channels,
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, def) => commands.set(name, def),
    events: { on: (channel, fn) => channels.set(channel, fn) } };
};

const stateDir = await mkdtemp(join(tmpdir(), 'gjc-instance-verify-'));
const calls = { explicit: [], auto: [], owner: 0, stopped: 0, rebind: [] };
let clockMs = 1_700_000_000_000;
let leafId = 'leaf-1';
const ctxOf = (kind = 'main', sessionId = 's-1') => ({
  sessionMetadata: { kind }, hasUI: true,
  sessionManager: { getSessionId: () => sessionId, getLeafId: () => leafId },
  ui: { notify: (msg, level) => notifications.push({ msg, level }) },
  getTodoState: () => [{ name: 'today', tasks: [{ content: 'x', status: 'pending' }] }],
});
const fakeReconciler = () => ({
  explicitPass: async (input) => { calls.explicit.push(input);
    return { ok: true, code: 'opened', roles: { todo: { code: 'opened', id: 'T1', paneId: 'w1:p2' } } }; },
  autoPass: async (input) => { calls.auto.push(input); return { ok: true, code: 'none', mode: 'auto' }; },
  writeOwner: async () => { calls.owner++; return { ok: true, path: join(stateDir, 'owner.json') }; },
  markStopped: async () => { calls.stopped++; return { ok: true }; },
  rebind: async (local) => { calls.rebind.push(local.sessionId);
    return { ok: true, code: 'rebound', scopeKey: 'scope-1', scopeEpoch: 1 }; },
});
const deps = (overrides = {}) => ({
  moduleUrl: ROOT, env: {}, platform: 'win32', now: () => clockMs, isTTY: true, pid: 4242,
  execPath: process.execPath,
  herdrFactory: () => async () => ({}), reconcilerFactory: fakeReconciler,
  nodeResolver: async () => process.execPath, generationOf: () => 'dev',
  checkEligibility: (ctx) => (ctx?.sessionMetadata?.kind === 'main'
    ? { ok: true, reason: null, rootUrl: ROOT, rootPath: 'R', stateDir, moduleUrl: ROOT }
    : { ok: false, reason: 'session-kind' }),
  bindingOf: (ctx) => ({ socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1', tabId: 'w1:t1',
    sessionId: ctx.sessionManager.getSessionId() }),
  projectTodo: () => ({ schema: 'gjc-herdr-dashboard/todo/1', updatedAt: 1, phases: [], empty: true,
    sourceError: null }),
  pruneScopes: async () => ({ removed: [], kept: [], failed: [] }),
  retentionDays: () => 14, scanScopes: async () => ['slot-scope-a'],
  setInterval: setIntervalFn, clearInterval: clearIntervalFn,
  newInstanceId: () => 'inst-1', ...overrides,
});
const slotFile = join(stateDir, 'slots', layoutKeyOf({ socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1' }), 'slot.json');
const slotBody = (state, sessionId = 's-1', scopeKey = 'scope-1') => ({
  schema: 'gjc-herdr-dashboard/slot/1',
  layoutKey: layoutKeyOf({ socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1' }),
  parent: { socket: '/tmp/herdr.sock', paneId: 'w1:p1', tabId: 'w1:t1' },
  scope: { sessionId, scopeKey, scopeEpoch: 0, language: 'ko' },
  roles: state === null ? {} : { todo: { state, token: 't', paneId: 'w1:p2', tabId: 'w1:t1',
    shellPid: 5, label: 'GJC Todo · abc', pendingSince: 1, closedBy: null } },
});

try {
  // ---------------------------------------------------------------- A. factory purity
  assert.equal(typeof entry, 'function');
  const traps = [];
  const restore = [];
  for (const key of ['env', 'pid', 'platform', 'stdout', 'execPath']) {
    const descriptor = Object.getOwnPropertyDescriptor(process, key);
    assert.equal(descriptor?.configurable, true, `${key} is not configurable`);
    Object.defineProperty(process, key, { configurable: true, enumerable: descriptor.enumerable,
      get: () => { traps.push(key); throw new Error(`factory read process.${key}`); } });
    restore.push(() => Object.defineProperty(process, key, descriptor));
  }
  const realTimers = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  globalThis.setInterval = () => { traps.push('setInterval'); throw new Error('factory started a timer'); };
  globalThis.clearInterval = () => { traps.push('clearInterval'); throw new Error('factory used a timer'); };
  delete globalThis[SYMBOL];
  const pEntry = piOf();
  const entryHandle = entry(pEntry);
  assert.deepEqual(traps, [], `the factory touched: ${traps.join(', ')}`);
  assert.equal(globalThis[SYMBOL] ?? null, null, 'the registry map must be created at ARM time');
  assert.deepEqual([...pEntry.handlers.keys()], ['session_start', 'session_shutdown', 'turn_end',
    'agent_end', 'tool_execution_end', 'goal_updated']);
  assert.deepEqual([...pEntry.channels.keys()], ['task:subagent:lifecycle', 'task:subagent:progress',
    'task:subagent:event']);
  assert.deepEqual([...pEntry.commands.keys()], ['dashboard']);
  assert.equal(entryHandle.armed(), false);
  assert.equal(entryHandle.state().pollMode, 'event-only');
  assert.equal(JSON.parse(JSON.stringify(entryHandle.state())).armed, false, 'state() is plain JSON');
  // Non-vacuity: the traps DO fire when the module is allowed to work.
  await pEntry.commands.get('dashboard').handler({}, ctxOf('main', 'pur-1'));
  assert.ok(traps.length > 0, 'the guarded accessors were never instrumented');
  globalThis.setInterval = realTimers.setInterval;
  globalThis.clearInterval = realTimers.clearInterval;
  for (const undo of restore) undo();
  ok('A.factory-purity');

  // ---------------------------------------------------------------- B. sub is inert
  assert.equal(globalThis[SYMBOL] ?? null, null);
  const pSub = piOf();
  const instSub = createInstance(pSub, deps());
  await pSub.handlers.get('session_start')({}, ctxOf('sub', 'sub-1'));
  assert.equal(instSub.armed(), false);
  assert.equal(globalThis[SYMBOL] ?? null, null, 'a sub session must not create the registry');
  notifications.length = 0;
  await pSub.commands.get('dashboard').handler({}, ctxOf('sub', 'sub-1'));
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].msg.includes('session-kind'), true, notifications[0].msg);
  await pSub.handlers.get('turn_end')({}, ctxOf('sub', 'sub-1'));
  await pSub.handlers.get('session_shutdown')({}, ctxOf('sub', 'sub-1'));
  assert.equal(calls.auto.length, 0);
  assert.equal(calls.stopped, 0);
  assert.equal(calls.owner, 0);
  assert.equal([...timers.values()].filter((t) => t.ms === 1000 || t.ms === 5000).length, 0);
  assert.equal(instSub.state().counters.auto, 0);
  assert.equal(instSub.state().errors.length, 0, JSON.stringify(instSub.state().errors));
  ok('B.sub-inert');

  // ---------------------------------------------------------------- C. arming + /dashboard
  await mkdir(join(stateDir, 'slots', layoutKeyOf({ socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1' })),
    { recursive: true });
  await writeFile(slotFile, JSON.stringify(slotBody('ready')));
  const p1 = piOf();
  const inst1 = createInstance(p1, deps());
  await p1.handlers.get('session_start')({}, ctxOf());
  assert.equal(inst1.armed(), true, JSON.stringify(inst1.state().errors));
  assert.ok(globalThis[SYMBOL] instanceof Map);
  assert.equal(inst1.state().owner, true);
  assert.equal(inst1.state().pollMode, 'poll');
  assert.equal(inst1.state().heartbeatAt, clockMs);
  assert.equal(globalThis[SYMBOL].get(layoutKeyOf({ socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1' }))
    .instanceId, 'inst-1');
  assert.equal(calls.owner, 1, 'arming writes the owner record once');
  assert.equal(calls.auto.length, 1, 'session_start runs one automatic pass after arming');
  await fire(5000);
  assert.equal(calls.owner, 2, 'the 5 s heartbeat ticks');
  notifications.length = 0;
  const res = await p1.commands.get('dashboard').handler({}, ctxOf());
  assert.equal(notifications.length, 1, 'exactly one notify per /dashboard (LT-4)');
  assert.equal(res.code, 'opened');
  assert.equal(calls.explicit.length, 1);
  assert.deepEqual(calls.explicit[0].roles, ['todo']);
  assert.equal(calls.explicit[0].trigger, 'dashboard');
  assert.equal(inst1.state().counters.published >= 1, true,
    'the explicit path published the projection for the live record');
  assert.equal(inst1.state().scopeKey, 'scope-1');

  const autoBefore = calls.auto.length;
  await p1.handlers.get('turn_end')({}, ctxOf());
  await p1.handlers.get('agent_end')({}, ctxOf());
  await p1.handlers.get('tool_execution_end')({ toolName: 'read' }, ctxOf());
  assert.equal(calls.auto.length, autoBefore + 2, 'tool_execution_end only fires for todo_write');
  await p1.handlers.get('tool_execution_end')({ toolName: 'todo_write' }, ctxOf());
  await p1.handlers.get('goal_updated')({}, ctxOf());
  for (const channel of p1.channels.values()) channel({ status: 'started' });
  await settle(() => calls.auto.length);
  // turn_end + agent_end + todo_write + goal_updated + one per bus channel (3) = 7.
  assert.equal(calls.auto.length, autoBefore + 7);
  assert.equal(calls.auto.at(-1).trigger, 'bus');
  assert.equal(calls.auto.at(-1).binding.sessionId, 's-1');
  ok('C.arming-dashboard');

  // ---------------------------------------------------------------- D. poll
  assert.equal(inst1.state().lastLeaf, 'leaf-1', 'arming seeds the leaf id');
  notifications.length = 0;
  await p1.handlers.get('turn_end')({}, ctxOf('main', 's-2'));
  assert.equal(calls.rebind.at(-1), 's-2', 'a sessionId change rebinds (plan 7.2)');
  assert.equal(inst1.state().scopeKey, 'scope-1');
  const pollBefore = calls.auto.length;
  leafId = 'leaf-2';
  await fire(1000);
  await settle(() => calls.auto.length);
  assert.equal(calls.auto.length, pollBefore + 1, 'a leaf change runs one automatic pass');
  assert.equal(calls.auto.at(-1).trigger, 'poll');
  assert.equal(inst1.state().lastLeaf, 'leaf-2');
  await fire(1000);
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(calls.auto.length, pollBefore + 1, 'an unchanged leaf runs nothing');
  const broken = ctxOf('main', 's-2');
  broken.sessionManager.getLeafId = () => { throw new Error('ctx gone'); };
  await p1.handlers.get('turn_end')({}, broken);
  leafId = 'leaf-9';
  await fire(1000);
  await settle(() => inst1.state().pollMode);
  assert.equal(inst1.state().pollMode, 'event-only', 'G9 fallback: polling is disabled for good');
  assert.equal([...timers.values()].filter((t) => t.ms === 1000).length, 0, 'the poll timer is cleared');
  assert.ok([...timers.values()].some((t) => t.ms === 5000), 'the heartbeat timer survives');
  ok('D.poll');

  // ---------------------------------------------------------------- E. gate + shutdown
  notifications.length = 0;
  // The counters are cumulative and the data writer merges a burst into one 200 ms write, so the
  // earlier triggers' publishes can land up to ~200 ms later; drain that window BEFORE sampling,
  // otherwise this measures the writer's merge delay instead of the §7.1 item 5 gate.
  await new Promise((resolve) => setTimeout(resolve, 350));
  await writeFile(slotFile, JSON.stringify(slotBody('closed', 's-2', 'scope-closed')));
  const publishedBefore = inst1.state().counters.published;
  await p1.commands.get('dashboard').handler({}, ctxOf('main', 's-2'));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(inst1.state().counters.published, publishedBefore,
    'a closed record publishes nothing (plan 7.1 item 5)');
  assert.equal(notifications.length, 1);
  const stoppedBefore = calls.stopped;
  await p1.handlers.get('session_shutdown')({}, ctxOf('main', 's-2'));
  assert.equal(calls.stopped, stoppedBefore + 1, 'shutdown awaits markStopped');
  assert.equal(inst1.state().disposed, true);
  assert.equal(inst1.state().armed, false);
  assert.equal(globalThis[SYMBOL].get(layoutKeyOf({ socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1' }))
    .disposed, true);
  const ownerWrites = calls.owner;
  await fire(5000);
  assert.equal(calls.owner, ownerWrites, 'the heartbeat stops on shutdown');
  const autoAtShutdown = calls.auto.length;
  await p1.handlers.get('turn_end')({}, ctxOf('main', 's-2'));
  await p1.handlers.get('goal_updated')({}, ctxOf('main', 's-2'));
  assert.equal(calls.auto.length, autoAtShutdown, 'a disarmed instance is inert');

  // replace on the same sessionId + moduleUrl, and the retired instance hands /dashboard over.
  await writeFile(slotFile, JSON.stringify(slotBody('ready', 's-2', 'scope-2')));
  const p2 = piOf();
  const inst2 = createInstance(p2, deps({ newInstanceId: () => 'inst-2' }));
  await p2.handlers.get('session_start')({}, ctxOf('main', 's-2'));
  assert.equal(inst1.armed(), false, 'the replaced instance is disarmed by disposeLocal');
  assert.equal(inst1.state().superseded, true);
  assert.equal(inst2.armed(), true);
  notifications.length = 0;
  const handoff = await p1.commands.get('dashboard').handler({}, ctxOf('main', 's-2'));
  assert.equal(inst1.armed(), false, 'the retired instance does not re-arm');
  assert.equal(inst2.armed(), true);
  assert.equal(handoff.code, 'opened');
  assert.equal(notifications.length, 1);
  assert.equal(calls.explicit.at(-1).binding.sessionId, 's-2');

  // delegate: same sessionId, different moduleUrl -> one notify, warning appended as a token.
  notifications.length = 0;
  const p3 = piOf();
  const inst3 = createInstance(p3, deps({ moduleUrl: `${ROOT}other/`,
    newInstanceId: () => 'inst-3' }));
  await p3.handlers.get('session_start')({}, ctxOf('main', 's-2'));
  assert.equal(inst3.armed(), false, 'a duplicate install does not arm');
  assert.equal(inst3.state().delegate, true);
  const explicitBefore = calls.explicit.length;
  const delegated = await p3.commands.get('dashboard').handler({}, ctxOf('main', 's-2'));
  assert.equal(notifications.length, 1, JSON.stringify(notifications.map((n) => n.msg)));
  assert.equal(notifications[0].msg.includes('warn:duplicate-install'), true, notifications[0].msg);
  assert.equal(notifications[0].msg.includes('열림'), true,
    'the localized pass result shares the one line with the warning token');
  assert.equal(delegated.code, 'opened');
  assert.equal(calls.explicit.length, explicitBefore + 1, 'the pass ran in the owner instance');
  assert.equal(calls.explicit.at(-1).trigger, 'delegate');
  assert.equal(inst3.state().counters.warnings, 1);
  await p3.commands.get('dashboard').handler({}, ctxOf('main', 's-2'));
  assert.equal(notifications.length, 2, 'the warning is not repeated');
  assert.equal(notifications.at(-1).msg.includes('duplicate'), false);
  await p2.handlers.get('session_shutdown')({}, ctxOf('main', 's-2'));
  inst3.dispose();
  ok('E.replace-delegate-shutdown');

  // ---------------------------------------------------------------- F. real defaults
  notifications.length = 0;
  const ENV_KEYS = ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_TAB_ID',
    'GJC_HERDR_DASHBOARD_STATE_DIR', 'GJC_HERDR_DASHBOARD_LANG', 'GJC_HERDR_DASHBOARD_HOST'];
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1',
    HERDR_SOCKET_PATH: '/tmp/herdr.sock', HERDR_TAB_ID: 'w1:t1',
    GJC_HERDR_DASHBOARD_STATE_DIR: stateDir, GJC_HERDR_DASHBOARD_LANG: 'en' });
  delete process.env.GJC_HERDR_DASHBOARD_HOST;
  const pReal = piOf();
  // Every host-facing seam is deliberately OMITTED here, so this block exercises the REAL defaults:
  // `process.env`, the eligibility adapter, the binding reader, the notify wording, the Todo
  // projector, the generation reader, the retention scan and the Herdr vector resolver. Only the
  // Herdr client, the reconciler, the Node resolver and the timers stay faked.
  const REAL_DEFAULTS = ['env', 'checkEligibility', 'bindingOf', 'notifyText', 'projectTodo',
    'generationOf', 'pruneScopes', 'retentionDays', 'scanScopes'];
  const realDeps = () => {
    const rest = deps();
    for (const key of REAL_DEFAULTS) delete rest[key];
    return rest;
  };
  const instReal = createInstance(pReal, { ...realDeps(), moduleUrl:
    pathToFileURL(join(process.cwd(), 'extension.mjs')).href, newInstanceId: () => 'real-1' });
  await pReal.handlers.get('session_start')({}, ctxOf('main', 'real-1'));
  assert.equal(instReal.armed(), true, JSON.stringify(instReal.state().errors));
  assert.equal(instReal.state().gen, 'dev');
  assert.equal(instReal.state().rawLanguage, 'en');
  assert.equal(process.env.GJC_HERDR_DASHBOARD_HOST, '4242', 'the nested-host marker is set');
  assert.equal(Array.isArray(instReal.state().vector) && instReal.state().vector.length >= 1, true);
  assert.ok(instReal.state().rootPath.endsWith('gjc-herdr-dashboard'));
  notifications.length = 0;
  await pReal.commands.get('dashboard').handler({}, ctxOf('main', 'real-1'));
  assert.equal(notifications[0].msg, 'ext dev · Todo opened', notifications[0].msg);
  process.env.GJC_HERDR_DASHBOARD_LANG = 'de';
  const pReal2 = piOf();
  const instReal2 = createInstance(pReal2, { ...realDeps(), newInstanceId: () => 'real-2' });
  await pReal2.handlers.get('session_start')({}, ctxOf('main', 'real-2'));
  assert.equal(instReal2.state().language, 'ko', 'an unsupported language falls back to ko');
  assert.equal(instReal2.state().rawLanguage, 'de', 'the raw value reaches the viewer footer');
  notifications.length = 0;
  await pReal2.commands.get('dashboard').handler({}, ctxOf('main', 'real-2'));
  assert.equal(notifications[0].msg, 'ext dev · Todo 열림', notifications[0].msg);
  await pReal2.handlers.get('session_shutdown')({}, ctxOf('main', 'real-2'));
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  ok('F.real-defaults');

  // ---------------------------------------------------------------- G. real reconciler
  const wireDir = await mkdtemp(join(tmpdir(), 'gjc-instance-wire-'));
  const herdrCalls = [];
  const herdr = async (...args) => {
    herdrCalls.push(args);
    if (args[1] === 'list') return { panes: [] };
    if (args[1] === 'layout') {
      return { layout: { panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 200, height: 50 } }] } };
    }
    if (args[1] === 'split') return { pane: { pane_id: 'w1:p2', tab_id: 'w1:t1' } };
    if (args[1] === 'process-info') return { process_info: { pane_id: 'w1:p2', shell_pid: 900 } };
    return {};
  };
  const pWire = piOf();
  const instWire = createInstance(pWire, {
    moduleUrl: pathToFileURL(join(process.cwd(), 'extension.mjs')).href,
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_TAB_ID: 'w1:t1', GJC_HERDR_DASHBOARD_STATE_DIR: wireDir },
    platform: 'win32', isTTY: true, pid: 555, execPath: process.execPath,
    now: () => clockMs, herdrFactory: () => herdr, vectorResolver: () => ['herdr', '--session', 'w'],
    generationOf: () => 'dev', nodeResolver: async () => process.execPath,
    setInterval: setIntervalFn, clearInterval: clearIntervalFn, newInstanceId: () => 'wire-1',
  });
  await pWire.handlers.get('session_start')({}, ctxOf('main', 'w-1'));
  assert.equal(instWire.armed(), true, JSON.stringify(instWire.state().errors));
  notifications.length = 0;
  const wireResult = await pWire.commands.get('dashboard').handler({}, ctxOf('main', 'w-1'));
  assert.equal(wireResult.code, 'opened', JSON.stringify({ code: wireResult.code,
    detail: wireResult.detail, roles: wireResult.roles, errors: instWire.state().errors }));
  assert.equal(notifications[0].msg, 'ext dev · Todo 열림');
  const verbs = herdrCalls.filter((a) => ['split', 'rename', 'run', 'close', 'focus'].includes(a[1]))
    .map((a) => a[1]);
  assert.deepEqual(verbs, ['split', 'rename', 'run']);
  const runCall = herdrCalls.find((a) => a[1] === 'run');
  assert.equal(runCall[2], 'w1:p2', 'pane run targets only this pass own split result (LT-8)');
  assert.equal(/'--lang' 'ko'/.test(runCall[3]), true);
  assert.equal(runCall[3].endsWith('; exit'), true);
  const wireSlotDir = join(wireDir, 'slots', instWire.state().layoutKey);
  const wireSlot = JSON.parse(await readFile(join(wireSlotDir, 'slot.json'), 'utf8'));
  assert.equal(wireSlot.roles.todo.state, 'pending');
  assert.deepEqual(wireSlot.herdr, ['herdr', '--session', 'w']);
  const dataFiles = await readdir(join(wireDir, 'data', wireSlot.scope.scopeKey));
  assert.deepEqual(dataFiles, ['todo.json']);
  const projection = JSON.parse(await readFile(join(wireDir, 'data', wireSlot.scope.scopeKey,
    'todo.json'), 'utf8'));
  assert.equal(projection.schema, 'gjc-herdr-dashboard/todo/1');
  assert.equal(projection.phases[0].tasks[0].content, 'x');
  const ownerWritesWire = instWire.state().heartbeatAt;
  clockMs += 5000;
  await fire(5000);
  await settle(() => instWire.state().heartbeatAt);
  assert.notEqual(instWire.state().heartbeatAt, ownerWritesWire, 'the heartbeat writes through the real reconciler');
  const ownerFile = JSON.parse(await readFile(join(wireSlotDir, 'owner.json'), 'utf8'));
  assert.equal(ownerFile.pid, 555);
  assert.equal(ownerFile.instanceId, 'wire-1');
  notifications.length = 0;
  const herdrBefore = herdrCalls.length;
  await pWire.handlers.get('turn_end')({}, ctxOf('main', 'w-1'));
  assert.equal(notifications.length, 0, 'an automatic pass never notifies');
  const autoMuts = herdrCalls.slice(herdrBefore)
    .filter((a) => ['split', 'rename', 'run', 'close', 'focus'].includes(a[1]));
  assert.deepEqual(autoMuts, [], JSON.stringify(autoMuts));
  await pWire.handlers.get('session_shutdown')({}, ctxOf('main', 'w-1'));
  const stoppedFile = JSON.parse(await readFile(join(wireSlotDir, 'owner.json'), 'utf8'));
  assert.equal(Number.isFinite(stoppedFile.stoppedAt), true, 'shutdown stamps stoppedAt');
  assert.equal(instWire.state().errors.length, 0, JSON.stringify(instWire.state().errors));
  await rm(wireDir, { recursive: true, force: true });
  ok('G.real-reconciler');

  console.log(`VERIFY-OK ${results.join(' ')}`);
} finally {
  await rm(stateDir, { recursive: true, force: true });
}
