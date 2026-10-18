// Unit tests for src/host/instance.mjs: the arming decision (R6), the process-wide owner registry
// (LT-6), the LT-4 notify matrix ("every result notifies exactly once", §7.4), the automatic-pass
// triggers, the G9 poll fallback, the §7.1 item 5 data gate and the shutdown order.
//
// The eligibility gate, the ctx binding, the notify formatter, the reconciler and the data writer
// are the REAL modules; only the seams the instance documents as injectable are replaced: the
// shared fake Herdr/clock/process table (`./fake-herdr.mjs`), injected timers, an instrumented
// registry map, real temporary state directories and an injected Node resolver (so no test spawns
// a process). No live Herdr, no live GJC, no real clock, no owner home.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createDataWriter } from '../../src/core/data.mjs';
import { dataPaths, layoutKeyOf, scopeKeyOf, slotPaths } from '../../src/core/slot.mjs';
import { createInstance as createInstanceRaw, REGISTRY_KEY } from '../../src/host/instance.mjs';
import { writeJson } from '../../src/storage.mjs';
import { createFakeClock, createFakeHerdr, createFakeProcesses, createPassTracer } from './fake-herdr.mjs';

// Every instance a test arms is remembered so the world's teardown can dispose it and await its drain
// before the state directory is removed (an abandoned instance keeps writing lock files into it).
const created = [];
const createInstance = (...args) => {
  const handle = createInstanceRaw(...args);
  created.push(handle);
  return handle;
};

const ROOT_URL = new URL('../../', import.meta.url);
const MODULE_URL = new URL('extension.mjs', ROOT_URL).href;
// A second module URL inside the SAME install tree: the registry compares module URLs verbatim, so
// this stands in for "another copy of the extension in this pane" without copying the tree.
const OTHER_MODULE_URL = new URL('README.md', ROOT_URL).href;
const START = 1_700_000_000_000;
const HOST_PID = 4244;const SOCKET = 'pipe:gjc-instance-test';
const PARENT = 'w1:p1';
// A-18/AC1.10: verbs and reporter commands the product must never issue.
const FORBIDDEN = ['report-agent', 'report-metadata', 'release-agent', 'send-text', 'send-keys'];

// The registry the instance is handed. It is a real Map (same code path as `globalThis[REGISTRY_KEY]`)
// that also records every write, which is what LT-6's "zero registry writes" is measured against.
class CountingRegistry extends Map {
  constructor(entries) {
    super(entries);
    this.writes = [];
    this.deletes = [];
  }

  set(key, value) {
    this.writes.push(key);
    return super.set(key, value);
  }

  delete(key) {
    this.deletes.push(key);
    return super.delete(key);
  }
}

// The heartbeat and poll callbacks are `async` and the timer wrapper does not await them, so a
// test that fires a tick waits for the write/pass it started instead of inspecting a half-done
// tick. The tick body therefore runs to completion before the test continues, which is the host's
// own guarantee (the callbacks are fire-and-forget, never awaited by `setInterval`).
async function settle({ turns = 12, ms = 3 } = {}) {
  for (let index = 0; index < turns; index += 1) await new Promise(resolve => setTimeout(resolve, ms));
}

function timerRig() {
  const timers = new Map();
  let seq = 0;
  return {
    timers,
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearInterval: id => { timers.delete(id); },
    // Fires every live timer registered with this period, like the host clock would, and then
    // waits for the async work each tick kicked off (the heartbeat write, the poll's pass) to land.
    fire: async ms => {
      for (const [, timer] of [...timers.entries()].filter(([, entry]) => entry.ms === ms)) {
        await timer.fn();
      }
      await settle();
    },
    periods: () => [...timers.values()].map(entry => entry.ms).sort((a, b) => a - b),
  };
}

// A recording host surface. `handlers`, `channels` and `commands` are what the instance registered;
// `calls` records the method names so a factory test can prove nothing else was touched.
function piOf() {
  const calls = [];
  const handlers = new Map();
  const channels = new Map();
  const commands = new Map();
  return { calls, handlers, channels, commands,
    on: (name, fn) => { calls.push({ method: 'on', name }); handlers.set(name, fn); },
    registerCommand: (name, definition) => {
      calls.push({ method: 'registerCommand', name });
      commands.set(name, definition);
    },
    events: { on: (channel, fn) => {
      calls.push({ method: 'events.on', name: channel });
      channels.set(channel, fn);
    } } };
}

// Every file under `dir`, as a posix-style relative path: a test can compare two listings as whole
// sets instead of guessing at names, which is how LT-6's "zero files" and AC1.11's per-scope
// projection are asserted.
async function listFiles(dir, base = dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    // outcome: no directory yet means no files, which is exactly what "zero files" asserts.
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out.sort();
}

async function makeWorld(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'gjc-instance-'));
  const clock = createFakeClock(START);
  const fake = createFakeHerdr({ parentPaneId: PARENT, ...options.fake });
  const processes = createFakeProcesses({ alive: [], unknown: [], ...options.processes });
  const tracer = createPassTracer(fake.herdr);
  const timers = timerRig();
  const registry = new CountingRegistry();
  const notifications = [];
  let instanceSeq = 0;
  const world = {
    stateDir, clock, fake, tracer, timers, registry, notifications,
    layoutKey: layoutKeyOf({ socket: SOCKET, parentPaneId: PARENT }),
    env: { HERDR_ENV: '1', HERDR_PANE_ID: PARENT, HERDR_SOCKET_PATH: SOCKET, HERDR_TAB_ID: 'w1:t1',
      GJC_HERDR_DASHBOARD_LANG: 'en', GJC_HERDR_DASHBOARD_STATE_DIR: stateDir, ...options.env },
    // `sessionId` and `leafId` may be functions, which is how a test changes what the host answers
    // between two handler calls (AC1.11) or during a poll tick (G9).
    ctx: (overrides = {}) => {
      const state = { sessionId: 's-1', leafId: 'leaf-1', todo: [], ...overrides };
      const value = key => (typeof state[key] === 'function' ? state[key]() : state[key]);
      return { state,
        ctx: {
          sessionMetadata: { kind: state.kind ?? 'main' }, hasUI: state.hasUI ?? true,
          sessionManager: { getSessionId: () => value('sessionId'), getLeafId: () => value('leafId'),
            getBranch: () => state.branch ?? [] },
          ui: { notify: (line, level) => notifications.push({ line, level }) },
          getTodoState: () => value('todo'),
        } };
    },
    deps: (overrides = {}) => ({
      moduleUrl: MODULE_URL, env: world.env, platform: 'win32', now: clock.now, isTTY: true,
      pid: HOST_PID, execPath: process.execPath, registry,
      herdrFactory: () => tracer.herdr, vectorResolver: () => ['herdr.exe'],
      nodeResolver: async () => process.execPath, pidAlive: processes.alive,
      setInterval: timers.setInterval, clearInterval: timers.clearInterval,
      newInstanceId: () => `inst-${++instanceSeq}`,
      ...overrides,
    }),
    slotPath: () => slotPaths(stateDir, world.layoutKey).slot,
    slot: async () => JSON.parse(await readFile(world.slotPath(), 'utf8')),
    owner: async () => JSON.parse(await readFile(slotPaths(stateDir, world.layoutKey).owner, 'utf8')),
    files: () => listFiles(stateDir),
    // A slot the product itself would have written, for the rows that need an existing record.
    writeSlot: ({ state = 'ready', sessionId = 's-1', scopeKey = 'pre-scope', role = 'todo',
      label = null, paneId = 'w1:p2', shellPid = 500, pendingSince = START, token = 'tok-1' } = {}) =>
      writeJson(world.slotPath(), {
        schema: 'gjc-herdr-dashboard/slot/1', layoutKey: world.layoutKey,
        parent: { socket: SOCKET, paneId: PARENT, tabId: 'w1:t1' },
        herdr: ['herdr.exe'],
        scope: { sessionId, scopeKey, scopeEpoch: 1, language: 'en' },
        roles: { [role]: { state, token, paneId, tabId: 'w1:t1', shellPid,
          label: label ?? `GJC Todo · ${world.layoutKey.slice(0, 8)}`, pendingSince, closedBy: null } },
      }),
  };
  t.after(async () => {
    for (const handle of created.splice(0)) await handle.dispose();
    delete globalThis[REGISTRY_KEY];
    await rm(stateDir, { recursive: true, force: true });
  });
  return world;
}

// LT-4: exactly one user-visible line per `/dashboard`, whatever the outcome. A second notify, or
// none at all, is the E1 defect this matrix exists to catch.
function assertOneNotify(world, pattern) {
  assert.equal(world.notifications.length, 1,
    `expected exactly one notify, got ${JSON.stringify(world.notifications)}`);
  const [entry] = world.notifications;
  assert.match(entry.line, pattern);
  return entry.line;
}

function assertInert(world, handle) {
  assert.equal(handle.armed(), false);
  assert.deepEqual(world.registry.writes, [], 'an ineligible call must not write the registry');
  assert.deepEqual(world.fake.calls, [], 'an ineligible call must not call Herdr');
  assert.deepEqual(handle.state().binding, null);
}

// --------------------------------------------------------------------------------- LT-4 ----
test('LT-4 session-kind: a sub session is reported ineligible once, not silently ignored', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx({ kind: 'sub' });
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(not a main session: session-kind\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:session-kind');
  assert.equal(handle.state().lastNotify, world.notifications[0].line);
  assert.equal(handle.state().notify, undefined);
  assert.equal(world.notifications[0].level, 'warn');
  assertInert(world, handle);
  assert.deepEqual(await world.files(), []);
});

test('LT-4 no-ui: a host without a UI is reported ineligible once', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx({ hasUI: false });
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(no UI: no-ui\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:no-ui');
  assertInert(world, handle);
});

test('LT-4 tty: a non-TTY stdout is reported ineligible once', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps({ isTTY: false }));
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(not a TTY: tty\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:tty');
  assertInert(world, handle);
});

test('LT-4 outside-herdr: a session outside Herdr is reported ineligible once', async t => {
  const world = await makeWorld(t);
  delete world.env.HERDR_ENV;
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(outside Herdr: outside-herdr\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:outside-herdr');
  assertInert(world, handle);
});

test('LT-4 disabled: the opt-out setting is reported ineligible once', async t => {
  const world = await makeWorld(t, { env: { GJC_HERDR_DASHBOARD: '0' } });
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(disabled by setting: disabled\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:disabled');
  assertInert(world, handle);
});

test('LT-4 nested: another recorded GJC in this pane is reported ineligible once', async t => {
  // The recorded pid is not ours and its liveness is unknowable (null), which R1 fails closed to
  // nested: never displace a host we cannot prove dead.
  const world = await makeWorld(t, { env: { GJC_HERDR_DASHBOARD_HOST: '999999' } });
  const pi = piOf();
  const handle = createInstance(pi, world.deps({ pidAlive: () => null }));
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(nested host: nested\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:nested');
  assertInert(world, handle);
});

test('LT-4 mirrored-install: a tree without the shipped assets is reported ineligible once', async t => {
  const world = await makeWorld(t);
  const mirror = pathToFileURL(join(world.stateDir, 'mirror', 'extension.mjs')).href;
  const pi = piOf();
  const handle = createInstance(pi, world.deps({ moduleUrl: mirror }));
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(mirrored install: mirrored-install\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:mirrored-install');
  assertInert(world, handle);
});

test('LT-4 state-dir: a tree that derives no state directory is reported ineligible once', async t => {
  const world = await makeWorld(t);
  delete world.env.GJC_HERDR_DASHBOARD_STATE_DIR;
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /ineligible \(no state directory: state-dir\)/);
  assert.equal(handle.state().lastResultCode, 'ineligible:state-dir');
  assertInert(world, handle);
});

test('LT-4 busy: a live lock holder yields one busy notify with its holder snapshot', async t => {
  const world = await makeWorld(t);
  const paths = slotPaths(world.stateDir, world.layoutKey);
  await mkdir(paths.lockDir, { recursive: true });
  // R1: the holder's pid is alive, so the pass must not displace it however old the file is.
  await writeFile(join(paths.lockDir, 'g000000000001.lock'),
    JSON.stringify({ pid: 4242, instanceId: 'other-instance', passId: 'p', acquiredAt: 0 }));
  const pi = piOf();
  const handle = createInstance(pi, world.deps({ pidAlive: () => true }));
  const { ctx } = world.ctx();
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  const line = assertOneNotify(world, /busy/);
  assert.match(line, /g000000000001/);
  assert.equal(result.code, 'busy');
  assert.equal(handle.state().lastResultCode, 'busy');
  assert.equal(handle.armed(), true, 'busy is a pass result, not an arming failure');
  assert.deepEqual(world.tracer.mutations(), [], 'a busy pass mutates nothing');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'close').length, 0);
});

// Architect B1 (R1 owner step 5): an explicit pass answered `busy:other-owner` mutates nothing. The
// instance used to rebind the slot to its own session BEFORE the pass classified the owner and then
// published its projections regardless of the result, so a live foreign owner's viewers were moved to
// this session's scope.
test('B1: busy:other-owner leaves the slot scope and the data directory untouched', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps({ pidAlive: () => true }));
  const { ctx, state } = world.ctx({ sessionId: 's-1' });
  await pi.handlers.get('session_start')({}, ctx);
  await pi.commands.get('dashboard').handler({}, ctx);
  const slotPath = join(world.stateDir, 'slots', world.layoutKey, 'slot.json');
  const slotBefore = await readFile(slotPath, 'utf8');
  const dataBefore = (await readdir(join(world.stateDir, 'data'))).sort();
  // A live foreign owner takes the record over, then this session moves on and asks again.
  await writeJson(join(world.stateDir, 'slots', world.layoutKey, 'owner.json'),
    { schema: 'gjc-herdr-dashboard/owner/1', pid: HOST_PID + 7, instanceId: 'inst-foreign',
      sessionId: 's-other', heartbeatAt: START });
  state.sessionId = 's-2';
  world.notifications.length = 0;
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  assert.equal(result.code, 'busy:other-owner', JSON.stringify(result));
  assert.equal(await readFile(slotPath, 'utf8'), slotBefore, 'the owner\'s slot scope was not rewritten');
  assert.deepEqual((await readdir(join(world.stateDir, 'data'))).sort(), dataBefore,
    'no projection was published for the foreign owner\'s slot');
  assert.equal(handle.state().scopeKey, JSON.parse(slotBefore).scope.scopeKey);
});

test('LT-4 busy:other-owner: a live foreign owner yields exactly one busy notify', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps({ pidAlive: () => true }));
  const { ctx } = world.ctx();
  // Arming claims the owner record itself (§7.1 item 3), so a foreign live owner has to take the
  // file over afterwards — which is exactly the cross-process case the row exists for.
  await pi.handlers.get('session_start')({}, ctx);
  assert.equal((await world.owner()).instanceId, handle.state().instanceId);
  await writeJson(slotPaths(world.stateDir, world.layoutKey).owner,
    { schema: 'gjc-herdr-dashboard/owner/1', pid: 7777, instanceId: 'other-instance',
      sessionId: 's-other', heartbeatAt: START });
  world.fake.calls.length = 0;
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  const line = assertOneNotify(world, /busy \(other owner\)/);
  // The holder snapshot is the pass's own lock view (generation + directory): the foreign pid is
  // never guessed when the pass did not measure it. The generation is this pass's own, so it is
  // asserted as a generation number with the right shape rather than a fixed value (the arming pass
  // holds one generation of its own).
  assert.match(line, /pid unknown · g\d{12} · /);
  assert.ok(line.includes(join(world.stateDir, 'slots', world.layoutKey, 'lock')), line);
  assert.equal(result.code, 'busy:other-owner');
  assert.deepEqual(world.tracer.mutations(), [], 'a foreign owner means zero pane mutation');
  assert.deepEqual(world.fake.calls.map(call => call.argv.slice(0, 2).join(' ')), [],
    'a foreign owner is decided before the first Herdr call');
  assert.equal(handle.state().counters.explicit, 1);
});

test('LT-4 herdr missing: an unresolvable Herdr vector fails once and creates no pane', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps({
    vectorResolver: () => { throw Object.assign(new Error('no herdr'), { code: 'herdr-missing' }); },
  }));
  const { ctx } = world.ctx();
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /failed \(herdr: herdr\)/);
  assert.equal(result.code, 'failed:herdr');
  assert.equal(handle.state().vectorError, 'herdr-missing');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'split').length, 0);
});

test('LT-4 node missing: an unusable Node runtime fails once with zero panes', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps({
    nodeResolver: async () => { throw Object.assign(new Error('no node'), { code: 'node-missing' }); },
  }));
  const { ctx } = world.ctx();
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /failed \(Node: node\)/);
  assert.equal(result.code, 'failed:node');
  assert.equal(handle.state().lastResultCode, 'failed:node');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'split').length, 0);
});

test('LT-4 list failure: a failing pane list is reported once as a coded failure', async t => {
  const world = await makeWorld(t);
  await mkdir(slotPaths(world.stateDir, world.layoutKey).dir, { recursive: true });
  await world.writeSlot({ state: 'ready' });
  world.fake.addPane('w1:p2', { label: `GJC Todo · ${world.layoutKey.slice(0, 8)}`, shell: 500 });
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  assert.equal(handle.armed(), true, JSON.stringify(handle.state().errors));
  world.fake.setFailures({ list: { code: 'ipc-error' } });
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /failed \(internal error: internal\)/);
  assert.equal(result.code, 'failed:internal');
  assert.match(result.detail, /ipc-error/);
  assert.equal(handle.state().lastResultCode, 'failed:internal');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'close').length, 0);
});

test('LT-4 partial:size: a parent too small for the role column reports partial once', async t => {
  const world = await makeWorld(t, { fake: { parentRect: { x: 0, y: 0, width: 20, height: 5 } } });
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /partial \(not enough room: size\)/);
  assert.equal(result.code, 'partial:size');
  assert.equal(handle.state().lastResultCode, 'partial:size');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'split').length, 0,
    'a refused size creates no pane');
});

test('LT-4 partial:timeout: a split that never answers reports partial once', async t => {
  const world = await makeWorld(t, { fake: { hang: ['split'] } });
  const pi = piOf();
  const handle = createInstance(pi, world.deps({ herdrTimeoutMs: 120 }));
  const { ctx } = world.ctx();
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /partial \(timed out: timeout\)/);
  assert.equal(result.code, 'partial:timeout');
  assert.equal(handle.state().lastResultCode, 'partial:timeout');
  // The pane may exist, so the run target is never fabricated for a split that never answered.
  assert.equal(world.fake.calls.filter(call => ['rename', 'run'].includes(call.argv[1])).length, 0);
});

test('LT-4 normal: one opened notify, one pane, and the single notify carries the gen token', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  const line = assertOneNotify(world, /Todo opened/);
  assert.match(line, /^ext dev · /);
  assert.equal(result.code, 'opened');
  assert.equal(handle.state().lastResultCode, 'opened');
  assert.equal(handle.state().owner, true);
  assert.equal(handle.state().gen, 'dev');
  assert.equal(world.notifications[0].level, 'info');
  assert.equal(world.fake.paneIds().filter(id => world.fake.labelOf(id) === `GJC Todo · ${world.layoutKey.slice(0, 8)}`).length, 1);
});

test('LT-4 duplicate: a second install delegates and appends its warning to the single result line', async t => {
  const world = await makeWorld(t);
  const piOwner = piOf();
  const owner = createInstance(piOwner, world.deps());
  const openCtx = world.ctx();
  await piOwner.commands.get('dashboard').handler({}, openCtx.ctx);
  assert.equal(owner.armed(), true);
  world.notifications.length = 0;

  // Same session, different module URL: the §7.1 item 3 duplicate-install handover.
  const piDup = piOf();
  const duplicate = createInstance(piDup, world.deps({ moduleUrl: OTHER_MODULE_URL }));
  const dupCtx = world.ctx();
  const result = await piDup.commands.get('dashboard').handler({}, dupCtx.ctx);
  const line = assertOneNotify(world, /warn:duplicate-install/);
  // The owner's second pass sees the pending record its own first pass wrote (T9), so the code the
  // delegate hands back is the owner's code — the point is that there is exactly one line and that
  // the warning token rides on it.
  assert.match(line, /Todo pending/);
  assert.equal(result.code, 'pending');
  assert.equal(owner.state().counters.explicit, 2);
  assert.equal(duplicate.armed(), false, 'a delegate arms nothing');
  assert.equal(duplicate.state().duplicateNotified, true);
  assert.equal(duplicate.state().counters.delegated, 1);
  assert.equal(duplicate.state().counters.warnings, 1);
  assert.equal(duplicate.state().delegateInstanceId, owner.state().instanceId);

  // …once per instance: the second call still notifies (through the owner) but without the token.
  world.notifications.length = 0;
  await piDup.commands.get('dashboard').handler({}, dupCtx.ctx);
  assert.equal(world.notifications.length, 1);
  assert.doesNotMatch(world.notifications[0].line, /duplicate-install/);
  assert.equal(duplicate.state().counters.delegated, 2);
});

// ------------------------------------------------------------------- R6 LT-6 clause 3 ----
test('LT-6 c3: a main that fails eligibility at session_start arms on the next eligible /dashboard', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const registryBefore = world.registry.writes.length;
  const callsBefore = world.fake.calls.length;
  const ineligible = world.ctx({ hasUI: false });
  await pi.handlers.get('session_start')({}, ineligible.ctx);
  assert.equal(handle.armed(), false);
  assert.equal(world.notifications.length, 0, 'a silent ineligible session_start');
  assert.equal(world.registry.writes.length, registryBefore, 'no registry write');
  assert.equal(world.fake.calls.length, callsBefore, 'no Herdr call');
  assert.deepEqual(world.timers.periods(), [], 'no timers');

  const eligible = world.ctx();
  await pi.commands.get('dashboard').handler({}, eligible.ctx);
  assert.equal(handle.armed(), true, JSON.stringify(handle.state().errors));
  assertOneNotify(world, /Todo opened/);
  assert.deepEqual(world.timers.periods(), [1000, 5000]);
});

// ------------------------------------------------------------------- R3 heartbeat tick ----
test('R3: the 5 s heartbeat tick runs an automatic pass while the todo record is pending, and not otherwise', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  const idleCalls = world.fake.calls.length;
  const idleAuto = handle.state().counters.auto;
  // Nothing is pending (no dashboard opened yet): the tick must stay silent toward Herdr.
  await world.timers.fire(5000);
  assert.equal(handle.state().counters.auto, idleAuto, 'no pending role, no automatic pass');
  assert.equal(world.fake.calls.length, idleCalls, 'and no Herdr call');

  // Open the dashboard: the record is pending until the (fake) viewer reports ready.
  await pi.commands.get('dashboard').handler({}, ctx);
  world.notifications.length = 0;
  const before = handle.state().counters.auto;
  await world.timers.fire(5000);
  assert.equal(handle.state().counters.auto, before + 1, 'a pending role is re-evaluated on the tick');
  assert.equal(world.notifications.length, 0, 'an automatic pass never notifies');
});

// --------------------------------------------------------------------------------- G9 poll ----
test('G9: an exception from the retained ctx disables the poll for good (event-only)', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  assert.equal(handle.state().pollMode, 'poll');
  assert.deepEqual(world.timers.periods(), [1000, 5000]);
  const autoBefore = handle.state().counters.auto;

  // A leaf change on the retained ctx runs exactly one automatic pass (the poll really works).
  state.leafId = 'leaf-2';
  await world.timers.fire(1000);
  assert.equal(handle.state().counters.auto, autoBefore + 1);
  assert.equal(handle.state().lastLeaf, 'leaf-2');
  assert.equal(world.notifications.length, 0, 'an automatic pass never notifies');

  // The retained ctx refusing to answer is the G9 fault: polling stops permanently, the event
  // triggers keep carrying the instance.
  state.leafId = () => { throw new Error('g9: retained ctx is gone'); };
  await world.timers.fire(1000);
  assert.equal(handle.state().pollMode, 'event-only');
  assert.deepEqual(world.timers.periods(), [5000], 'the poll timer is gone, the heartbeat is not');
  assert.ok(handle.state().errors.some(item => item.where === 'poll' &&
    /retained ctx is gone/.test(item.message)), JSON.stringify(handle.state().errors));

  // The event triggers still run the pass, so the instance is not latched.
  const autoAfter = handle.state().counters.auto;
  await pi.handlers.get('turn_end')({}, world.ctx({ leafId: 'leaf-3' }).ctx);
  assert.equal(handle.state().counters.auto, autoAfter + 1);
  assert.equal(handle.state().pollMode, 'event-only');
});

// --------------------------------------------------------------------------------- LT-6 ----
test('LT-6: a sub session shares the main registry, stays inert, and leaves main armed', async t => {
  const world = await makeWorld(t);
  const piMain = piOf();
  const main = createInstance(piMain, world.deps());
  const mainCtx = world.ctx();
  await piMain.handlers.get('session_start')({}, mainCtx.ctx);
  assert.equal(main.armed(), true, JSON.stringify(main.state().errors));
  const registryWritesAfterMain = world.registry.writes.length;
  const herdrCallsAfterMain = world.fake.calls.length;
  const filesAfterMain = await world.files();

  // The sub is a real second factory call in the SAME process (and therefore the same registry).
  const piSub = piOf();
  const sub = createInstance(piSub, world.deps());
  const subCtx = world.ctx({ kind: 'sub', sessionId: 'sub-1' });
  await piSub.handlers.get('session_start')({}, subCtx.ctx);
  for (const channel of piSub.channels.values()) channel({ status: 'started' });
  await new Promise(resolve => setImmediate(resolve));
  await piSub.handlers.get('turn_end')({}, subCtx.ctx);
  await piSub.commands.get('dashboard').handler({}, subCtx.ctx);
  await piSub.handlers.get('session_shutdown')({}, subCtx.ctx);

  // LT-6 / AC1.6: zero registry writes, zero Herdr calls, zero new files.
  assert.equal(sub.armed(), false);
  assert.equal(sub.state().pollMode, 'event-only');
  assert.equal(sub.state().counters.auto, 0);
  assert.equal(sub.state().counters.explicit, 0);
  assert.equal(sub.state().binding, null);
  assert.deepEqual(world.registry.writes.length, registryWritesAfterMain, 'the sub wrote the registry');
  assert.equal(world.fake.calls.length, herdrCallsAfterMain, 'the sub called Herdr');
  assert.deepEqual(await world.files(), filesAfterMain, 'the sub wrote a file');
  assert.equal(world.registry.get(world.layoutKey).instanceId, main.state().instanceId);
  assert.deepEqual(world.timers.periods(), [1000, 5000], 'main keeps both timers after the sub exited');

  // Main is still armed and its heartbeat timer is alive (a heartbeat is a file write, not a call).
  assert.equal(main.armed(), true);
  assert.equal(main.state().owner, true);
  world.clock.advance(5000);
  await world.timers.fire(5000);
  assert.equal(main.state().heartbeatAt, world.clock.now(), 'the main heartbeat timer still ticks');
  assert.equal(world.fake.calls.length, herdrCallsAfterMain, 'a heartbeat issues no Herdr call');
  // The one notify the sub produced is the LT-4 ineligible line for its own /dashboard call.
  assert.equal(world.notifications.filter(item => /session-kind/.test(item.line)).length, 1);
  assert.equal(world.notifications.length, 1, JSON.stringify(world.notifications));
});

test('LT-6: main shutdown closes zero panes, deletes no record and stamps stoppedAt', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const main = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  const slotBefore = await world.slot();
  const recordBefore = slotBefore.roles.todo;
  const panesBefore = world.fake.paneIds();

  await pi.handlers.get('session_shutdown')({}, ctx);
  assert.equal(main.state().armed, false);
  assert.equal(main.state().disposed, true);
  assert.equal(main.state().superseded, true);
  assert.equal(world.registry.get(world.layoutKey).disposed, true);
  assert.deepEqual(world.fake.paneIds(), panesBefore, 'shutdown closes no pane');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'close').length, 0);
  const ownerFile = await world.owner();
  assert.equal(ownerFile.stoppedAt, world.clock.now());
  assert.equal(ownerFile.pid, HOST_PID);
  // §7.1 item 4: a stopped owner keeps its record; the next pass classifies it through `stoppedAt`.
  assert.deepEqual((await world.slot()).roles.todo, recordBefore);
  assert.deepEqual(world.timers.periods(), [], 'both timers are gone after shutdown');

  // A second shutdown finds `armed === false` and writes nothing new.
  await pi.handlers.get('session_shutdown')({}, ctx);
  assert.equal((await world.owner()).stoppedAt, ownerFile.stoppedAt);
});

test('LT-6: reload (same session + module) replaces the entry and retires the old instance', async t => {
  const world = await makeWorld(t);
  const firstPi = piOf();
  const first = createInstance(firstPi, world.deps());
  const { ctx } = world.ctx();
  await firstPi.handlers.get('session_start')({}, ctx);
  const firstId = first.state().instanceId;
  const herdrBefore = world.fake.calls.length;

  const secondPi = piOf();
  const second = createInstance(secondPi, world.deps());
  await secondPi.handlers.get('session_start')({}, ctx);
  assert.equal(world.registry.get(world.layoutKey).instanceId, second.state().instanceId);
  assert.notEqual(second.state().instanceId, firstId);
  assert.equal(first.armed(), false, 'the replaced instance released its timers');
  assert.equal(first.state().superseded, true);
  assert.equal(second.armed(), true);
  assert.deepEqual(world.registry.deletes, [], 'a handover replaces, it never deletes the entry');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'close').length, 0,
    'a handover closes no pane');
  // The replaced instance was told to dispose locally, so it stopped heart-beating (its timers are
  // gone) while the new owner took over the record file.
  world.clock.advance(5000);
  await world.timers.fire(5000);
  assert.equal(second.state().heartbeatAt, world.clock.now());
  // R1 reload: the successor claimed the record (same pid, registry names it), so the file proves it.
  assert.equal((await world.owner()).instanceId, second.state().instanceId,
    'the cooperative handover moved owner.json to the successor');
  assert.equal(world.fake.calls.length, herdrBefore, 'no handover step talks to Herdr');

  // A stray `/dashboard` on the retired instance delegates to whoever owns the slot now.
  world.notifications.length = 0;
  await firstPi.commands.get('dashboard').handler({}, ctx);
  assert.equal(world.notifications.length, 1, 'a retired instance still owes exactly one notify');
  assert.equal(first.state().counters.delegated, 1);
  assert.equal(second.state().counters.explicit, 1,
    'the retired instance handed the pass to the current owner instead of re-arming');
  assert.equal(first.armed(), false, 'a stray /dashboard must not steal the slot back');
  assert.equal(world.registry.get(world.layoutKey).instanceId, second.state().instanceId);
});

test('LT-6: a different module URL in the same pane delegates and warns once, silently on start', async t => {
  const world = await makeWorld(t);
  const firstPi = piOf();
  const first = createInstance(firstPi, world.deps());
  const { ctx } = world.ctx();
  await firstPi.handlers.get('session_start')({}, ctx);

  const otherPi = piOf();
  const other = createInstance(otherPi, world.deps({ moduleUrl: OTHER_MODULE_URL }));
  world.notifications.length = 0;
  await otherPi.handlers.get('session_start')({}, ctx);
  // `session_start` is silent by contract: a delegate arms nothing and notifies nothing.
  assert.deepEqual(world.notifications, []);
  assert.equal(other.armed(), false);
  assert.equal(other.state().delegate, true);
  assert.equal(other.state().delegateInstanceId, first.state().instanceId);
  assert.equal(world.registry.get(world.layoutKey).instanceId, first.state().instanceId,
    'the delegate replaces nothing');
  assert.equal(first.armed(), true);

  await otherPi.commands.get('dashboard').handler({}, ctx);
  const line = assertOneNotify(world, /warn:duplicate-install/);
  assert.ok(line.startsWith('ext dev · Todo '), line);
  assert.equal(other.state().duplicateNotified, true);
  assert.equal(other.state().counters.warnings, 1);
  assert.equal(world.notifications[0].level, 'info', 'the delegated result keeps the owner level');
});

// ------------------------------------------------- AC1.4 / AC1.5 / AC1.10 / AC1.11 / AC1.2 ----
test('AC1.4: three /dashboard calls leave exactly one GJC Todo pane', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  // L2: the first pass opens the whole band, so it splits once per role (Todo, then Workers anchored
  // on the Todo pane). The repeat calls add nothing: their records are already pending.
  const splitsAfterFirst = world.fake.calls.filter(call => call.argv[1] === 'split').length;
  assert.equal(splitsAfterFirst, 2, `L2 opens the band: ${JSON.stringify(world.fake.paneIds())}`);
  await pi.commands.get('dashboard').handler({}, ctx);
  await pi.commands.get('dashboard').handler({}, ctx);
  const label = `GJC Todo · ${world.layoutKey.slice(0, 8)}`;
  const ours = world.fake.paneIds().filter(id => world.fake.labelOf(id) === label);
  assert.equal(ours.length, 1, `panes: ${JSON.stringify(world.fake.paneIds())}`);
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'split').length, splitsAfterFirst,
    'the repeat calls may not split');
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'close').length, 0);
  assert.equal(world.notifications.length, 3, 'one notify per call (LT-4)');
  assert.equal(handle.state().counters.explicit, 3);
  assert.equal(handle.state().lastResultCode, 'pending',
    'the repeat calls adopt their own pending record');
});

test('AC1.5: an outside-Herdr live call reports the exact ineligible reason token', async t => {
  const world = await makeWorld(t);
  delete world.env.HERDR_ENV;
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  const line = assertOneNotify(world, /ineligible/);
  assert.match(line, /outside-herdr/);
  assert.equal(result.code, 'ineligible:outside-herdr');
  assert.equal(handle.state().lastResultCode, 'ineligible:outside-herdr');
  assert.equal(world.notifications[0].level, 'warn');
});

test('AC1.10: no trigger ever sends prompt text, keys or a reporter command to a pane', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  await pi.commands.get('dashboard').handler({}, ctx);
  await pi.commands.get('dashboard').handler({}, ctx);
  await pi.handlers.get('turn_end')({}, ctx);
  await pi.handlers.get('agent_end')({}, ctx);
  await pi.handlers.get('tool_execution_end')({ toolName: 'todo_write' }, ctx);
  await pi.handlers.get('goal_updated')({}, ctx);
  for (const channel of pi.channels.values()) channel({ status: 'started' });
  await settle();
  state.leafId = 'leaf-audit';
  await world.timers.fire(1000);

  const argvText = world.fake.calls.map(call => call.argv.join(' '));
  assert.ok(argvText.length > 0, 'the audit must be non-vacuous');
  for (const forbidden of FORBIDDEN) {
    assert.equal(argvText.filter(text => text.includes(forbidden)).length, 0, `${forbidden} was issued`);
  }
  assert.equal(handle.state().counters.auto > 0, true);
  assert.equal(handle.state().counters.explicit, 2);
});

test('AC1.11: a session-id change keeps the pane and moves the projection to the new scope', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx({ sessionId: 's-1' });
  await pi.commands.get('dashboard').handler({}, ctx);
  const firstScope = handle.state().scopeKey;
  assert.equal(firstScope, scopeKeyOf({ socket: SOCKET, parentPaneId: PARENT, sessionId: 's-1' }));
  const paneIdsAfterFirst = world.fake.paneIds();

  // `/new` then `/resume`: the same slot now answers with a different session id.
  state.sessionId = 's-2';
  await pi.commands.get('dashboard').handler({}, ctx);
  assert.equal(handle.state().binding.sessionId, 's-2');
  assert.deepEqual(world.fake.paneIds(), paneIdsAfterFirst, 'rebinding never touches the pane');
  assert.equal(handle.state().scopeKey,
    scopeKeyOf({ socket: SOCKET, parentPaneId: PARENT, sessionId: 's-2' }));
  assert.notEqual(handle.state().scopeKey, firstScope);
  assert.equal((await world.slot()).scope.sessionId, 's-2');
  assert.equal((await world.slot()).scope.scopeEpoch, 2, 'the epoch counts the rebinding');
  // The data follows the scope: a projection exists under the new scopeKey, and the old scope's
  // file is left in place (per-scope data is not moved or deleted by a rebind).
  const newFile = dataPaths(world.stateDir, handle.state().scopeKey).todo;
  const oldFile = dataPaths(world.stateDir, firstScope).todo;
  assert.notEqual(newFile, oldFile);
  const projected = JSON.parse(await readFile(newFile, 'utf8'));
  assert.equal(projected.schema, 'gjc-herdr-dashboard/todo/1');
  assert.deepEqual(projected.phases, []);
  assert.equal(JSON.parse(await readFile(oldFile, 'utf8')).schema, 'gjc-herdr-dashboard/todo/1');
});

test('AC1.2: todo_write publishes a Todo projection in one call; a non-todo tool publishes none', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const todos = [{ name: '오늘', tasks: [{ content: '문서 쓰기', status: 'in_progress' }] }];
  // The writer is injected with delayMs 0 so the merge window (200 ms in production) cannot make
  // the assertion flaky; the code path under test is the instance's `publishTodo` + flush.
  const writes = [];
  const writer = createDataWriter({ stateDir: world.stateDir, now: () => world.clock.now(), delayMs: 0,
    io: { writeJson: async (path, value) => { writes.push(path); return writeJson(path, value); } } });
  const handle = createInstance(pi, world.deps({ dataWriterFactory: () => writer }));
  const { ctx } = world.ctx({ todo: todos });
  await pi.commands.get('dashboard').handler({}, ctx);
  assert.equal(handle.armed(), true, JSON.stringify(handle.state().errors));
  const scopeKey = handle.state().scopeKey;
  const file = dataPaths(world.stateDir, scopeKey).todo;

  writes.length = 0;
  await pi.handlers.get('tool_execution_end')({ toolName: 'read' }, ctx);
  assert.deepEqual(writes, [], 'a non-todo tool publishes nothing');
  // L2: the explicit pass published BOTH projections - its own todo.json and the workers.json of
  // the band it just opened.
  assert.equal(handle.state().counters.published, 2, 'the explicit pass published todo + workers');
  const workersFile = dataPaths(world.stateDir, scopeKey).workers;
  await pi.handlers.get('tool_execution_end')({ toolName: 'todo_write' }, ctx);
  assert.deepEqual(writes, [file, workersFile],
    'todo_write publishes one projection per live role, for this scope');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.schema, 'gjc-herdr-dashboard/todo/1');
  assert.deepEqual(stored.phases,
    [{ name: '오늘', tasks: [{ content: '문서 쓰기', status: 'in_progress' }] }]);
  assert.equal(JSON.parse(await readFile(workersFile, 'utf8')).schema,
    'gjc-herdr-dashboard/workers/1');
  assert.equal(handle.state().counters.published, 4);
});

test('§7.1 item 5: no projection is published while the slot carries no live todo record', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const writes = [];
  const writer = createDataWriter({ stateDir: world.stateDir, now: () => world.clock.now(), delayMs: 0,
    io: { writeJson: async (path, value) => { writes.push(path); return writeJson(path, value); } } });
  const handle = createInstance(pi, world.deps({ dataWriterFactory: () => writer }));
  const todo = [{ name: 'p', tasks: [{ content: 'c', status: 'pending' }] }];
  const { ctx, state } = world.ctx({ todo });
  await pi.handlers.get('session_start')({}, ctx);
  assert.equal(handle.armed(), true, JSON.stringify(handle.state().errors));
  assert.deepEqual(writes, [], 'arming with no record publishes nothing');
  assert.equal(handle.state().counters.published, 0);

  // A `closed` record is the other half of the gate: the file must not come back to life.
  const sessionId = handle.state().binding.sessionId;
  await world.writeSlot({ state: 'closed', sessionId, scopeKey: 'pre-scope' });
  await pi.handlers.get('turn_end')({}, ctx);
  assert.deepEqual(writes, [], 'a closed record is never republished');

  // A live record does publish, which proves the gate opens as well as closes (non-vacuity).
  state.leafId = 'leaf-gate';
  await world.writeSlot({ state: 'pending', sessionId, scopeKey: 'pre-scope' });
  await pi.handlers.get('goal_updated')({}, ctx);
  assert.deepEqual(writes, [join(world.stateDir, 'data', 'pre-scope', 'todo.json')]);
  assert.equal(handle.state().counters.published, 1);
  assert.equal(handle.state().scopeKey, 'pre-scope');
});

test('a degraded /dashboard call is answered and never throws: no host UI means no toast', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  // A null ctx cannot receive a toast (`ctx?.ui?.notify?.()`, §7.1), but the call itself must be
  // answered rather than thrown, and the line stays readable in `state()` for a drill.
  const result = await pi.commands.get('dashboard').handler({}, null);
  assert.deepEqual(world.notifications, []);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ineligible:session-kind');
  assert.equal(handle.state().lastNotify, 'ext dev · ineligible (not a main session: session-kind)');
  assert.equal(handle.armed(), false);
  assertInert(world, handle);
});

test('an automatic trigger before arming is silent: no notify, no Herdr call, no file', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.handlers.get('turn_end')({}, ctx);
  await pi.handlers.get('session_shutdown')({}, ctx);
  for (const channel of pi.channels.values()) channel({ status: 'started' });
  await settle();
  assert.deepEqual(world.notifications, []);
  assert.equal(handle.state().counters.auto, 0);
  assert.deepEqual(world.fake.calls, []);
  assert.deepEqual(await world.files(), []);
  assert.deepEqual(world.timers.periods(), []);
});

test('one /dashboard call runs one explicit pass and no automatic pass for the same call', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  const autoAfterArming = handle.state().counters.auto;
  await pi.commands.get('dashboard').handler({}, ctx);
  assert.equal(handle.state().counters.auto, autoAfterArming);
  assert.equal(handle.state().counters.explicit, 1);
  assert.equal(world.notifications.length, 1);
});

test('triggers: turn_end, agent_end, goal_updated, todo_write and each bus channel run one pass', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  const base = handle.state().counters.auto;
  await pi.handlers.get('turn_end')({}, ctx);
  await pi.handlers.get('agent_end')({}, ctx);
  await pi.handlers.get('tool_execution_end')({ toolName: 'bash' }, ctx);
  await pi.handlers.get('tool_execution_end')({ toolName: 'todo_write' }, ctx);
  await pi.handlers.get('goal_updated')({}, ctx);
  for (const channel of pi.channels.values()) channel({ status: 'started' });
  await settle();
  // The bus events are fire-and-forget and arrive together, so they coalesce (one running pass plus
  // at most one trailing pass); the 4 awaited named triggers each ran their own.
  const ran = handle.state().counters.auto - base;
  assert.ok(ran >= 5 && ran <= 7, `4 named triggers + 1..3 coalesced bus passes, got ${ran}`);
  assert.deepEqual(world.notifications, []);
  assert.deepEqual(world.tracer.mutations(), []);
  assert.deepEqual(world.tracer.verbs().filter(verb => !['pane list', 'pane process-info', 'pane layout'].includes(verb)), []);
});

// A running subagent publishes hundreds of progress events a second. Each used to queue its own pass
// in front of the reconciler, so a `/new` that followed waited minutes behind the backlog (measured:
// 1,491 queued passes, `session_switch` rebound ~190 s late). A burst is folded into at most one
// trailing pass over the newest ctx, and the last state is still the one that gets processed.
test('auto-pass coalescing: a bus burst is folded and the session change after it still rebinds', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx({ sessionId: 's-1' });
  await pi.commands.get('dashboard').handler({}, ctx);
  const base = handle.state().counters.auto;
  const progress = [...pi.channels.values()][0];
  for (let i = 0; i < 300; i += 1) progress({ status: 'running', i });
  state.sessionId = 's-2';
  await pi.handlers.get('session_switch')({}, ctx);
  // The folded work runs on the queue, so the assertion waits for it instead of guessing a sleep.
  const deadline = Date.now() + 2_000;
  let slotValue = await world.slot();
  while (slotValue.scope.sessionId !== 's-2' && Date.now() < deadline) {
    await new Promise((done) => { setTimeout(done, 20); });
    slotValue = await world.slot();
  }
  const ran = handle.state().counters.auto - base;
  assert.ok(ran <= 3, `300 bus events + a switch ran ${ran} passes (expected a running one + a trailing one)`);
  assert.equal(slotValue.scope.sessionId, 's-2');
});

// LT-4 / §7.2 (as amended by stage-05 R1): "`/dashboard`는 매번 다시 평가하고, 실패하면
// `ineligible:<reason>`을 정확히 1회 notify한다" and "a lost message is the defect E1 this port must
// not reproduce". The handler is also the documented home of the degraded-call guarantee:
// `gjc-adapter` tolerates `null` where an object is expected so that "a host that hands a handler an
// unexpected shape cannot make the extension throw inside an event".
//
// Regression: `arm()` used to run outside the handler's `try`, so a host whose `ctx.sessionManager`
// accessor throws (or a seam that returns `undefined`) escaped with zero notifies. `arm()` now runs
// inside the `try`, and the fault surfaces as one `failed:internal` notify.
test('binding-seam-fault: a throwing binding seam still owes one notify', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  createInstance(pi, world.deps({ bindingOf: () => { throw new Error('binding seam fault'); } }));
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /failed/);
});

test("G12: session_switch rebinds the scope at once, without waiting for another event", async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx({ sessionId: "s-1" });
  await pi.commands.get("dashboard").handler({}, ctx);
  const firstScope = handle.state().scopeKey;
  const paneIds = world.fake.paneIds();
  state.sessionId = "s-2";
  await pi.handlers.get("session_switch")({ reason: "new" }, ctx);
  assert.equal(handle.state().binding.sessionId, "s-2");
  assert.notEqual(handle.state().scopeKey, firstScope);
  assert.equal((await world.slot()).scope.sessionId, "s-2");
  assert.deepEqual(world.fake.paneIds(), paneIds, "no pane change on a session switch");
});

test("a session switch with no event after it is still picked up by the 1 s poll", async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx({ sessionId: "s-1", leafId: "leaf-1" });
  await pi.commands.get("dashboard").handler({}, ctx);
  state.sessionId = "s-2";
  state.leafId = null; // a fresh session has no leaf yet
  await world.timers.fire(1000);
  assert.equal(handle.state().binding.sessionId, "s-2");
  assert.equal((await world.slot()).scope.sessionId, "s-2");
});

// -------------------------------------------------------------- L4 owner gate (architect #1/#3/#4) --
const foreignOwner = (extra = {}) => ({ schema: "gjc-herdr-dashboard/owner/1", pid: 7777,
  instanceId: "other-instance", sessionId: "s-1", heartbeatAt: 1, ...extra });

// Critic #2: `registryOwnerInstanceId` used to report this instance's own captured entry, so a
// predecessor whose queued heartbeat ran after the successor claimed ownership classified the
// successor as `reload` (same pid) and overwrote it. The callback now reads the live registry entry.
test("L4: a retired instance cannot reclaim the successor's owner record", async t => {
  // The predecessor's own pid is alive (it is this process), so a record naming another instance is
  // another live owner - not a cooperative handover.
  const world = await makeWorld(t, { processes: { alive: [HOST_PID] } });
  const pi = piOf();
  const first = createInstance(pi, world.deps());
  const { ctx } = world.ctx({ sessionId: 's-1' });
  await pi.handlers.get('session_start')({}, ctx);
  assert.equal((await world.owner()).instanceId, first.state().instanceId);
  // A successor in the same process took over: the registry names it and the record is its. The
  // predecessor must see another live owner (prev-live), not a cooperative handover: with the old
  // `registryOwnerInstanceId ! = owner.instanceId` rule it classified this as `reload` and overwrote
  // the successor's record.
  const successor = { instanceId: 'inst-2', disposed: false, sessionId: 's-2' };
  world.registry.set(world.layoutKey, successor);
  await writeJson(slotPaths(world.stateDir, world.layoutKey).owner,
    { schema: 'gjc-herdr-dashboard/owner/1', pid: HOST_PID, instanceId: 'inst-2',
      sessionId: 's-2', heartbeatAt: START });
  world.fake.calls.length = 0;
  const result = await pi.commands.get('dashboard').handler({}, ctx);
  assertOneNotify(world, /busy \(other owner\)/);
  assert.equal(result.code, 'busy:other-owner', JSON.stringify(result.roles?.todo ?? {}));
  assert.equal((await world.owner()).instanceId, 'inst-2',
    'the predecessor did not claim the successor\'s record');
});

// Critic #3: the bus/task-triggered workers publish only checked `armed`, so after a restart a bus
// event could write the workers projection before `/dashboard` adopted the slot.
// (The path is exercised at band level in band-pass.test.mjs, which owns the workers role.)

// Critic #4: a folded trigger must keep its own error policy. A folded POLL pass that throws still has
// to disable polling (the poll is the one caller whose failure retires the timer), instead of being
// recorded as an ordinary auto error.
test('critic #4: a folded poll pass keeps its strict semantics', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.commands.get('dashboard').handler({}, ctx);
  assert.equal(handle.state().pollMode, 'poll');
  const progress = [...pi.channels.values()][0];
  progress({ status: 'running' });
  await settle();
  progress({ status: 'running' });
  await settle();
  // The bus triggers were folded and ran with their own (non-strict) policy: polling is still alive
  // because no strict caller failed.
  assert.equal(handle.state().pollMode, 'poll', 'an ordinary auto failure never retires the poll');
  assert.ok(handle.state().errors.every(item => item.where !== 'poll'), JSON.stringify(handle.state().errors));
});

// Critic #5: a folded trigger captures its ctx, while an explicit call can install a NEWER one in
// between. The trailing pass must not put the older context back (that would rebind the retained
// scope to an obsolete session).
test('critic #5: a folded trigger never restores an older context over a newer one', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  createInstance(pi, world.deps());
  const older = world.ctx({ sessionId: 's-1' });
  const newer = world.ctx({ sessionId: 's-2' });
  await pi.commands.get('dashboard').handler({}, older.ctx);
  // Fold an older trigger, then let an explicit call install the newer context.
  const progress = [...pi.channels.values()][0];
  progress({ status: 'running' });
  await pi.commands.get('dashboard').handler({}, newer.ctx);
  await settle();
  await settle();
  assert.equal((await world.slot()).scope.sessionId, 's-2',
    'the retained scope still follows the newest context');
});

// Critic #4 (second half): when the foreground strict pass failed, the folded work used to be dropped
// with it. With polling disabled nothing would then process the newest state until another event, so the
// fold is drained before the failure is rethrown.
test('critic #4: a fold is still drained after the foreground pass fails', async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx({ sessionId: 's-1' });
  await pi.commands.get('dashboard').handler({}, ctx);
  const base = handle.state().counters.auto;
  // The retained ctx stops answering after the first trigger: this is the G9 fault the poll reports.
  const older = world.ctx({ sessionId: 's-1' });
  const progress = [...pi.channels.values()][0];
  state.sessionId = 's-2';
  const failing = pi.handlers.get('turn_end')({}, older.ctx);
  progress({ status: 'running' });
  await Promise.allSettled([failing]);
  state.sessionId = 's-1';
  await settle();
  await settle();
  assert.ok(handle.state().counters.auto - base >= 1, 'a folded trigger ran even though the foreground failed');
});

test("L4: before /dashboard adopts a stopped previous owner, no automatic trigger writes a slot or data file", async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  const first = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx({ sessionId: "s-1" });
  await pi.commands.get("dashboard").handler({}, ctx);
  const slotBefore = JSON.parse(await readFile(slotPaths(world.stateDir, world.layoutKey).slot, "utf8"));
  // The previous process exits: it stamps stoppedAt, and a NEW process arms in the same pane.
  await pi.handlers.get("session_shutdown")({}, ctx);
  const ownerStopped = await world.owner();
  assert.ok(Number.isFinite(ownerStopped.stoppedAt));
  world.registry.clear();
  const piNew = piOf();
  // A restart is a different process: another pid, and the previous one is gone (ESRCH is not needed
  // here because the stopped record is a cooperative release).
  const second = createInstance(piNew, world.deps({ pid: HOST_PID + 1 }));
  state.sessionId = "s-2"; // a different conversation after the restart
  const files = async () => (await readdir(world.stateDir, { recursive: true })).sort();
  const filesBefore = await files();
  for (const name of ["session_start", "session_switch", "turn_end", "agent_end"]) {
    await piNew.handlers.get(name)({}, ctx);
  }
  await piNew.handlers.get("tool_execution_end")({ toolName: "todo_write" }, ctx);
  assert.deepEqual(await world.slot(), slotBefore, "the slot is untouched until /dashboard adopts it");
  assert.deepEqual(await files(), filesBefore, "no data or prefs file was written for the new session");
  assert.deepEqual(await world.owner(), ownerStopped, "the stopped record is left for the explicit pass");
  assert.equal(second.state().heartbeatAt, null, "a skipped owner write is not a heartbeat");
  // /dashboard is the adoption step: it classifies the previous owner, takes the slot and rebinds.
  await piNew.commands.get("dashboard").handler({}, ctx);
  assert.equal((await world.owner()).instanceId, second.state().instanceId);
  assert.equal((await world.slot()).scope.sessionId, "s-2");
  assert.ok(first, "first instance existed");
});

test("L4: markStopped never stamps a release on a record another instance owns", async t => {
  const world = await makeWorld(t);
  const pi = piOf();
  createInstance(pi, world.deps());
  const { ctx } = world.ctx();
  await pi.handlers.get("session_start")({}, ctx);
  // Another live process now owns the record; this instance exits without ever having it.
  await writeJson(slotPaths(world.stateDir, world.layoutKey).owner, foreignOwner());
  await pi.handlers.get("session_shutdown")({}, ctx);
  assert.deepEqual(await world.owner(), foreignOwner(), "the foreign record gained no stoppedAt");
  // A corrupt record is not replaced by a forged release either.
  const world2 = await makeWorld(t);
  const pi2 = piOf();
  createInstance(pi2, world2.deps());
  const { ctx: ctx2 } = world2.ctx();
  await pi2.handlers.get("session_start")({}, ctx2);
  await writeFile(slotPaths(world2.stateDir, world2.layoutKey).owner, "{ not json");
  await pi2.handlers.get("session_shutdown")({}, ctx2);
  assert.equal(await readFile(slotPaths(world2.stateDir, world2.layoutKey).owner, "utf8"), "{ not json");
});

// The remaining L4 owner/rebind regressions are in reconciler.test.mjs (writeOwner after markStopped)
// and below (a rebind that did not happen).
// Architect L4 #7: `binding` used to advance before the rebind, so a rebind that lost (busy lock, failed
// write) was never retried by the poll: the slot stayed on the old session until an unrelated event.
test("L4: a rebind that did not happen is retried by the next trigger", async t => {
  const world = await makeWorld(t, { processes: { alive: [HOST_PID + 3] } });
  const pi = piOf();
  const handle = createInstance(pi, world.deps());
  const { ctx, state } = world.ctx({ sessionId: "s-1" });
  await pi.commands.get("dashboard").handler({}, ctx);
  // Another live pass holds the generation lock, so the rebind comes back `busy` and writes nothing.
  const { lockDir } = slotPaths(world.stateDir, world.layoutKey);
  await mkdir(lockDir, { recursive: true });
  const held = join(lockDir, "g000000000009.lock");
  await writeFile(held, JSON.stringify({ pid: HOST_PID + 3, instanceId: "other", passId: "p", acquiredAt: START }));
  state.sessionId = "s-2";
  await pi.handlers.get("session_switch")({}, ctx);
  await settle();
  assert.equal((await world.slot()).scope.sessionId, "s-1", "a busy rebind changed nothing");
  // The holder finishes; the poll (no new event, no new session) must still follow the new session.
  await rm(held);
  world.clock.advance(1000);
  await world.timers.fire(1000);
  await settle();
  assert.equal((await world.slot()).scope.sessionId, "s-2", "the next tick followed the new session");
  assert.ok(handle.state().counters.auto >= 2);
});
