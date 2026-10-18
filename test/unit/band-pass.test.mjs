// L2 band-pass suite: the 2-role band (parent + Todo + Workers) driven end to end through the real
// reconciler and the real instance, against the shared fake Herdr/clock/process table.
//
// What this file pins (plan 7.8, contract "Launch parameters"/"Roles/ordering", AC2.1, AC2.7, AC2.8):
//   * an explicit pass opens Todo first and then Workers, and the SECOND split's anchor is the Todo
//     pane this pass created, with `--direction down --ratio 0.35 --no-focus`; the Todo split keeps
//     the L1 argv exactly (parent anchor, `--direction right --no-focus`, no `--ratio`);
//   * a region below a floor lowers the ladder (Todo+Workers -> Todo only -> nothing) and reports
//     `partial:size` with a detail naming Workers;
//   * a foreign sibling in the tab makes the result `partial:shape` while the foreign pane keeps its
//     id, label, shell and command forever (AC2.8);
//   * Workers without a non-closed Todo record creates nothing and reports `partial:no-anchor`;
//   * a throwing bus handler becomes the workers `sourceError` and never escapes into the host (AC2.7);
//   * the 5 s tick promotes a pending WORKERS viewer, the workers projection is gated on a non-closed
//     workers record, and a scope change resets the tracker.
//
// No live Herdr, no live GJC, no real clock, no owner home.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDataWriter } from '../../src/core/data.mjs';
import { BAND_LAYOUT } from '../../src/core/layout.mjs';
import { createReconciler } from '../../src/core/reconciler.mjs';
import { dataPaths, key8Of, labelOf, layoutKeyOf, scopeKeyOf, slotPaths } from '../../src/core/slot.mjs';
import { createInstance, REGISTRY_KEY } from '../../src/host/instance.mjs';
import { createWorkersTracker, WORKERS_SCHEMA } from '../../src/host/sources/workers.mjs';
import { writeJson } from '../../src/storage.mjs';
import { createFakeClock, createFakeHerdr, createFakeProcesses, createPassTracer } from './fake-herdr.mjs';

const ROOT_URL = new URL('../../', import.meta.url);
const MODULE_URL = new URL('extension.mjs', ROOT_URL).href;
const START = 1_700_000_000_000;
const OWNER_PID = 4242;
const HOST_PID = 4244;
const PARENT = 'w1:p1';
const SOCKET = 'pipe:gjc-band-test';
const TODO_VIEWER = fileURLToPath(new URL('../../src/viewers/todo/viewer.mjs', import.meta.url));
const WORKERS_VIEWER = fileURLToPath(new URL('../../src/viewers/workers/viewer.mjs', import.meta.url));
// A-32: the closed set of verbs an automatic pass may use.
const AUTO_ALLOWED = new Set(['pane list', 'pane process-info', 'pane layout']);

const readJsonFile = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return null; }
};

// ------------------------------------------------------------------ reconciler world ----------
// The band needs a real tab: the parent's default 400x80 leaves a 200x80 dashboard region, which is
// 28 Todo rows / 52 Workers rows / 200 columns - comfortably above all three floors.
async function bandWorld(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'gjc-band-'));
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const clock = createFakeClock(START);
  const fake = createFakeHerdr({ parentPaneId: PARENT, ...options.fake });
  const processes = createFakeProcesses({ alive: [OWNER_PID, process.pid], ...options.processes });
  const tracer = createPassTracer(fake.herdr);
  const binding = { socket: SOCKET, parentPaneId: PARENT, tabId: 'w1:t1', sessionId: 's-1' };
  const layoutKey = layoutKeyOf({ socket: binding.socket, parentPaneId: binding.parentPaneId });
  const paths = slotPaths(stateDir, layoutKey);
  const reconciler = createReconciler({
    stateDir, herdr: tracer.herdr, vector: ['herdr.exe'], now: clock.now,
    pidAlive: processes.alive, instanceId: 'inst-1', pid: OWNER_PID,
    newToken: () => 'tok-1', newPassId: () => 'pass-1',
    viewerPath: { todo: TODO_VIEWER, workers: WORKERS_VIEWER },
    nodePath: process.execPath, checkNode: async () => ({ ok: true, nodePath: process.execPath }),
    language: 'ko', gen: 'dev', env: {}, herdrTimeoutMs: 250,
  });
  return {
    stateDir, clock, fake, tracer, binding, layoutKey, paths, reconciler,
    explicit: (overrides = {}) => tracer.inPass('explicit',
      () => reconciler.explicitPass({ binding, roles: ['todo', 'workers'], ...overrides })),
    auto: (trigger = 'turn_end', overrides = {}) => tracer.inPass('auto',
      () => reconciler.autoPass({ binding, roles: ['todo', 'workers'], trigger, ...overrides })),
    slot: async () => readJsonFile(paths.slot),
    splitCalls: () => tracer.trace.filter(entry => entry.argv[1] === 'split').map(entry => entry.argv),
    // Split argv across the whole world lifetime: `inPass` resets the per-pass trace, so a test that
    // compares two passes needs the fake's own permanent call log.
    allSplits: () => fake.calls.filter(call => call.argv[1] === 'split').map(call => call.argv),
    // The label of the pane a role row owns, read from the slot the pass wrote.
    paneOf: async role => (await readJsonFile(paths.slot))?.roles?.[role]?.paneId ?? null,
  };
}

// --------------------------------------------------------------------------------- AC2.1 -----
test('AC2.1: an explicit pass opens Todo then Workers, anchored on the Todo pane at 0.35 down', async t => {
  const world = await bandWorld(t);
  const pass = await world.explicit();
  assert.deepEqual(Object.keys(pass.roles), ['todo', 'workers']);
  assert.equal(pass.roles.todo.code, 'opened', JSON.stringify(pass.roles));
  assert.equal(pass.roles.workers.code, 'opened', JSON.stringify(pass.roles));
  const splits = world.splitCalls();
  assert.equal(splits.length, 2, JSON.stringify(splits));
  // 1. Todo keeps the L1 argv byte for byte: the parent as anchor, `right`, and NO `--ratio` flag
  // (Herdr's own default is 0.5; adding the flag would be a second spelling of the same geometry).
  assert.deepEqual(splits[0], ['pane', 'split', PARENT, '--direction', 'right', '--no-focus']);
  // 2. Workers anchors on the Todo pane this pass created, and states `down` + the plan's 0.35.
  const todoPaneId = await world.paneOf('todo');
  assert.equal(pass.roles.todo.paneId, todoPaneId);
  assert.deepEqual(splits[1].map(String), ['pane', 'split', todoPaneId, '--direction', 'down',
    '--ratio', '0.35', '--no-focus']);
  assert.equal(BAND_LAYOUT.todoHeight, 0.35);

  // The band really is a band in the tab the fixture models. The fixture halves every split and
  // ignores `--ratio` (it models Herdr's pane table, not its rounding), so its Todo row is 40 of 80;
  // the ratio itself is asserted on the argv above, and `isBandShape` deliberately checks geometry
  // only, never ratios. On a real Herdr the same two calls produce 28/52 because 0.35 is passed.
  const layout = world.fake.layout();
  assert.equal(layout.panes.length, 3, JSON.stringify(layout.panes));
  const rectOf = id => layout.panes.find(pane => pane.pane_id === id)?.rect ?? null;
  const [parent, todo, workers] = [rectOf(PARENT), rectOf(todoPaneId), rectOf(pass.roles.workers.paneId)];
  assert.deepEqual(parent, { x: 0, y: 0, width: 200, height: 80 });
  assert.deepEqual(todo, { x: 200, y: 0, width: 200, height: 40 });
  assert.deepEqual(workers, { x: 200, y: 40, width: 200, height: 40 });

  // Both records are pending in the slot, with the labels the contract names.
  const slot = await world.slot();
  assert.equal(slot.roles.todo.state, 'pending');
  assert.equal(slot.roles.workers.state, 'pending');
  assert.equal(slot.roles.todo.label, labelOf('todo', key8Of(world.layoutKey)));
  assert.equal(slot.roles.workers.label, labelOf('workers', key8Of(world.layoutKey)));
  assert.equal(slot.roles.workers.label, `GJC Workers · ${world.layoutKey.slice(0, 8)}`);
  // The run target of each split is that split's own pane (LT-8), and nothing foreign was touched.
  assert.deepEqual(world.tracer.record.runTargets, world.tracer.record.splitPaneIds);
  assert.deepEqual(world.fake.paneIds().sort(), [PARENT, todoPaneId, pass.roles.workers.paneId].sort());

  // Every later explicit pass adopts both pending records without a third split (LT-3 for L2).
  const settled = await world.explicit();
  assert.equal(settled.roles.todo.code, 'pending');
  assert.equal(settled.roles.workers.code, 'pending');
  assert.equal(world.splitCalls().length, 0, 'the settling pass split nothing');
  assert.equal(world.allSplits().length, 2, 'two splits in total for the whole session');
});

// --------------------------------------------------------------------------------- AC2.1 -----
test('AC2.1 existing-Todo case: a missing Workers pane is added below the live Todo pane', async t => {
  const world = await bandWorld(t);
  // Todo is already open (its record is pending and its pane is in the layout); workers is missing.
  // `w1:p7` is deliberately outside the id range the fixture generates for splits.
  const todoPaneId = world.fake.addPane('w1:p7', { label: labelOf('todo', key8Of(world.layoutKey)),
    shell: 500, rect: { x: 200, y: 0, width: 200, height: 80 } });
  world.fake.setPaneRect(PARENT, { x: 0, y: 0, width: 200, height: 80 });
  await writeJson(world.paths.slot, {
    schema: 'gjc-herdr-dashboard/slot/1', layoutKey: world.layoutKey,
    parent: { socket: SOCKET, paneId: PARENT, tabId: 'w1:t1' }, herdr: ['herdr.exe'],
    scope: { sessionId: 's-1', scopeKey: 'pre-scope', scopeEpoch: 1, language: 'ko' },
    roles: { todo: { state: 'pending', token: 'tok-t', paneId: todoPaneId, tabId: 'w1:t1',
      shellPid: 500, label: labelOf('todo', key8Of(world.layoutKey)), pendingSince: START } },
  });
  const pass = await world.explicit();
  // Todo is adopted untouched (T9), Workers is created where the floors allow it.
  assert.equal(pass.roles.todo.code, 'pending', JSON.stringify(pass.roles.todo));
  assert.equal(pass.roles.todo.paneId, todoPaneId);
  assert.equal(pass.roles.workers.code, 'opened', JSON.stringify(pass.roles.workers));
  assert.deepEqual(world.allSplits(), [['pane', 'split', todoPaneId, '--direction', 'down',
    '--ratio', '0.35', '--no-focus']], 'the only split anchors on the EXISTING Todo pane');
  // No pane was closed or renamed: the existing Todo pane is left exactly as it was.
  assert.equal(world.fake.labelOf(todoPaneId), labelOf('todo', key8Of(world.layoutKey)));
  assert.deepEqual(world.tracer.verbs('explicit').filter(verb => ['pane close'].includes(verb)), []);
  const slot = await world.slot();
  assert.equal(slot.roles.todo.state, 'pending');
  assert.equal(slot.roles.workers.state, 'pending');
});

// --------------------------------------------------------------------------------- AC2.1 -----
test('AC2.1: a Workers create whose Todo anchor has no measured rect creates nothing', async t => {
  const world = await bandWorld(t);
  // A non-closed Todo record whose pane is NOT in the layout the pass just read: there is no region to
  // split down, so the split is never attempted and the row reports the ladder's size step.
  await writeJson(world.paths.slot, {
    schema: 'gjc-herdr-dashboard/slot/1', layoutKey: world.layoutKey,
    parent: { socket: SOCKET, paneId: PARENT, tabId: 'w1:t1' }, herdr: ['herdr.exe'],
    scope: { sessionId: 's-1', scopeKey: 'pre-scope', scopeEpoch: 1, language: 'ko' },
    roles: { todo: { state: 'pending', token: 'tok-t', paneId: 'w1:p9', tabId: 'w1:t1',
      shellPid: 550, label: labelOf('todo', key8Of(world.layoutKey)), pendingSince: START } },
  });
  const pass = await world.explicit({ roles: ['workers'] });
  assert.equal(pass.roles.workers.code, 'partial:size', JSON.stringify(pass.roles.workers));
  assert.match(pass.roles.workers.detail, /no-anchor-rect/);
  assert.deepEqual(world.allSplits(), [], 'no split was attempted against an unmeasurable anchor');
  assert.equal((await world.slot()).roles.workers, undefined);
});

// ------------------------------------------------------------------------------ notify ------
test('the partial:no-anchor row has localized wording in all three languages, not a raw token', async t => {
  const { notifyText } = await import('../../src/host/gjc-adapter.mjs');
  for (const language of ['ko', 'en', 'zh-cn']) {
    const line = notifyText({ code: 'partial:no-anchor', roles: {
      workers: { code: 'partial:no-anchor', id: 'T1' } } }, language, 'dev');
    assert.ok(line.includes('no-anchor'), `${language}: the machine token survives: ${line}`);
    assert.ok(!line.includes('why: '), `${language}: no raw fallback: ${line}`);
    assert.ok(line.includes('Workers'), line);
  }
});

// --------------------------------------------------------------------------------- AC2.1 -----
test('AC2.1: a region below a floor lowers the ladder and reports partial:size naming Workers', async t => {
  // 46 parent columns leave 23 dashboard columns: Todo fits, Workers' 24-column floor does not.
  const narrow = await bandWorld(t, { fake: { parentRect: { x: 0, y: 0, width: 46, height: 50 } } });
  const lowered = await narrow.explicit();
  assert.equal(lowered.roles.todo.code, 'opened', JSON.stringify(lowered.roles));
  assert.equal(lowered.roles.workers.code, 'partial:size');
  assert.match(lowered.roles.workers.detail, /workers/);
  assert.equal(lowered.code, 'partial:size', 'the aggregate carries the ladder step');
  assert.equal(lowered.detail, 'size:workers', 'the aggregate detail names workers');
  assert.equal(narrow.allSplits().length, 1, 'only the Todo split happened');
  assert.equal((await narrow.slot()).roles.workers, undefined);
  assert.equal((await narrow.slot()).roles.todo.state, 'pending');

  // 200x7 leaves a 7-row region: even Todo is below its 8-row floor, so nothing is created and the
  // pass still reports the ladder's terminal step instead of waiting (LT-5).
  const tiny = await bandWorld(t, { fake: { parentRect: { x: 0, y: 0, width: 200, height: 7 } } });
  const nothing = await tiny.explicit();
  assert.equal(nothing.roles.todo.code, 'partial:size');
  assert.equal(nothing.roles.workers.code, 'partial:no-anchor', 'without Todo there is no anchor');
  assert.equal(nothing.code, 'partial:size');
  assert.deepEqual(tiny.fake.paneIds(), [PARENT]);
  assert.deepEqual(tiny.splitCalls(), []);
  assert.equal(await tiny.slot(), null, 'no slot is written for a pass that created nothing');
  assert.equal(/waiting/.test(JSON.stringify(nothing.roles)), false);

  // A parent-wide-but-short region (20 rows) leaves round(20*0.35) = 7 Todo rows: Todo keeps the
  // whole region (its own row floor passes) and Workers is the role that is dropped.
  const short = await bandWorld(t, { fake: { parentRect: { x: 0, y: 0, width: 200, height: 20 } } });
  const todoOnly = await short.explicit();
  assert.equal(todoOnly.roles.todo.code, 'opened');
  assert.equal(todoOnly.roles.workers.code, 'partial:size');
  assert.equal(short.allSplits().length, 1);
});

// --------------------------------------------------------------------------------- AC2.8 -----
test('AC2.8: a foreign sibling yields partial:shape and is never closed, moved, resized or renamed', async t => {
  const world = await bandWorld(t);
  world.fake.addPane('w1:p9', { label: 'DAG · x', shell: 6060 });
  const before = { label: world.fake.labelOf('w1:p9'), shell: world.fake.shellOf('w1:p9'),
    command: world.fake.commandOf('w1:p9'), rect: world.fake.rects.get('w1:p9') };
  const pass = await world.explicit();
  assert.equal(pass.roles.todo.code, 'partial:shape', JSON.stringify(pass.roles.todo));
  assert.equal(pass.roles.workers.code, 'partial:shape', JSON.stringify(pass.roles.workers));
  assert.match(pass.roles.todo.detail, /shape:foreign:w1:p9/);
  assert.equal(pass.code, 'partial:shape');
  // The floors still allowed both of our panes: the shape is reported, nothing is undone.
  assert.equal(pass.roles.todo.paneId !== null, true);
  assert.equal(pass.roles.workers.paneId !== null, true);
  assert.equal(world.allSplits().length, 2);
  // The foreign pane is byte-identical afterwards, and no mutation verb was ever aimed at it.
  assert.deepEqual({ label: world.fake.labelOf('w1:p9'), shell: world.fake.shellOf('w1:p9'),
    command: world.fake.commandOf('w1:p9'), rect: world.fake.rects.get('w1:p9') }, before);
  for (const entry of world.tracer.trace) {
    if (['split', 'rename', 'run', 'close', 'focus'].includes(entry.argv[1])) {
      assert.notEqual(entry.argv[2], 'w1:p9', `a mutation was aimed at the foreign pane: ${entry.argv.join(' ')}`);
    }
  }
  // Our own panes are still there and still ours: the pass did not close them either.
  assert.deepEqual(world.fake.paneIds().sort(),
    [PARENT, 'w1:p9', pass.roles.todo.paneId, pass.roles.workers.paneId].sort());
  assert.equal((await world.slot()).roles.workers.state, 'pending');
});

test('AC2.8: a layout our panes do not form a band with is reported as partial:shape, never repaired', async t => {
  // A Todo pane that overlaps the parent instead of sitting to its right, and no foreign sibling at
  // all. Its rect still clears every floor, so Workers is created where the floors allow it and the
  // shape check reports what it measured.
  const world = await bandWorld(t);
  await writeJson(world.paths.slot, {
    schema: 'gjc-herdr-dashboard/slot/1', layoutKey: world.layoutKey,
    parent: { socket: SOCKET, paneId: PARENT, tabId: 'w1:t1' }, herdr: ['herdr.exe'],
    scope: { sessionId: 's-1', scopeKey: 'pre-scope', scopeEpoch: 1, language: 'ko' },
    roles: { todo: { state: 'pending', token: 'tok-t', paneId: 'w1:p5', tabId: 'w1:t1',
      shellPid: 550, label: labelOf('todo', key8Of(world.layoutKey)), pendingSince: START } },
  });
  world.fake.addPane('w1:p5', { label: labelOf('todo', key8Of(world.layoutKey)), shell: 550,
    rect: { x: 100, y: 0, width: 200, height: 80 } });
  const pass = await world.explicit({ roles: ['workers'] });
  assert.equal(pass.roles.workers.id, 'T1');
  assert.equal(pass.roles.workers.code, 'partial:shape', JSON.stringify(pass.roles.workers));
  assert.equal(pass.roles.workers.detail, 'shape:not-a-band');
  // Nothing was done TO the mis-shaped pane to make the shape true: no rename, close, focus or run
  // was ever aimed at it, and it keeps its label and shell. (Its rect moves only because it is the
  // split ANCHOR of the Workers create that just happened, which is the documented existing-Todo
  // case - the fixture halves the axis it splits.)
  assert.equal(world.fake.labelOf('w1:p5'), labelOf('todo', key8Of(world.layoutKey)));
  assert.equal(world.fake.shellOf('w1:p5'), 550);
  for (const entry of world.tracer.trace) {
    if (['rename', 'close', 'focus', 'run'].includes(entry.argv[1])) {
      assert.notEqual(entry.argv[2], 'w1:p5', `a repair was attempted: ${entry.argv.join(' ')}`);
    }
  }
  assert.equal(world.fake.rects.get('w1:p5').height, 40,
    'only the anchor split touched it, exactly as the fake models a down split');
  assert.equal(world.splitCalls().length, 1, 'Workers was still created where the floors allowed it');
  assert.equal((await world.slot()).roles.workers.state, 'pending');
});

// ----------------------------------------------------------------------- Roles/ordering ------
test('Roles/ordering: Workers without a non-closed Todo record creates nothing (partial:no-anchor)', async t => {
  const world = await bandWorld(t);
  // The pass is asked for the Workers row alone, from a clean slot: there is no anchor to split.
  const alone = await world.explicit({ roles: ['workers'] });
  assert.equal(alone.roles.workers.code, 'partial:no-anchor');
  assert.match(alone.roles.workers.detail, /no-todo-record/);
  assert.equal(alone.code, 'partial:no-anchor');
  assert.deepEqual(world.splitCalls(), [], 'nothing at all was split');
  assert.deepEqual(world.fake.paneIds(), [PARENT]);
  assert.equal(await world.slot(), null);

  // A `closed` Todo record is not an anchor either: the pane is gone by definition.
  await writeJson(world.paths.slot, {
    schema: 'gjc-herdr-dashboard/slot/1', layoutKey: world.layoutKey,
    parent: { socket: SOCKET, paneId: PARENT, tabId: 'w1:t1' }, herdr: ['herdr.exe'],
    scope: { sessionId: 's-1', scopeKey: 'pre-scope', scopeEpoch: 1, language: 'ko' },
    roles: { todo: { state: 'closed', token: 'tok-0', paneId: 'w1:p2', tabId: 'w1:t1', shellPid: 500,
      label: labelOf('todo', key8Of(world.layoutKey)), pendingSince: START, closedBy: 't20' } },
  });
  const closedAnchor = await world.explicit({ roles: ['workers'] });
  assert.equal(closedAnchor.roles.workers.code, 'partial:no-anchor');
  assert.deepEqual(world.splitCalls(), []);
  // And the automatic pass never creates at all, whatever the anchor says (A-32).
  const auto = await world.auto('turn_end');
  assert.equal(auto.roles.workers.code, 'none');
  assert.deepEqual(world.tracer.mutations('auto'), []);
  for (const verb of world.tracer.verbs('auto')) assert.ok(AUTO_ALLOWED.has(verb), verb);
});

// ------------------------------------------------------------------ instance world -----------
async function instanceWorld(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'gjc-band-inst-'));
  t.after(async () => {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    delete globalThis[REGISTRY_KEY];
  });
  const clock = createFakeClock(START);
  const fake = createFakeHerdr({ parentPaneId: PARENT, ...options.fake });
  const tracer = createPassTracer(fake.herdr);
  const processes = createFakeProcesses({ alive: [HOST_PID], unknown: [], ...options.processes });
  const registry = new Map();
  const notifications = [];
  const writes = [];
  const timers = new Map();
  let timerSeq = 0;
  let instanceSeq = 0;
  const workersFactory = options.workersTrackerFactory
    ?? (() => createWorkersTracker({ now: () => clock.now() }));
  const world = {
    stateDir, clock, fake, tracer, processes, registry, notifications, writes, timers,
    layoutKey: layoutKeyOf({ socket: SOCKET, parentPaneId: PARENT }),
    env: { HERDR_ENV: '1', HERDR_PANE_ID: PARENT, HERDR_SOCKET_PATH: SOCKET, HERDR_TAB_ID: 'w1:t1',
      GJC_HERDR_DASHBOARD_STATE_DIR: stateDir, ...options.env },
    ctx: (overrides = {}) => {
      const state = { sessionId: 's-1', leafId: 'leaf-1', todo: [], jobs: undefined, ...overrides };
      const value = key => (typeof state[key] === 'function' ? state[key]() : state[key]);
      return { state, ctx: {
        sessionMetadata: { kind: 'main' }, hasUI: true,
        sessionManager: { getSessionId: () => value('sessionId'), getLeafId: () => value('leafId') },
        ui: { notify: (line, level) => notifications.push({ line, level }) },
        getTodoState: () => value('todo'),
        getJobs: () => value('jobs'),
      } };
    },
    deps: (overrides = {}) => ({
      moduleUrl: MODULE_URL, env: world.env, platform: 'win32', now: clock.now, isTTY: true,
      pid: HOST_PID, execPath: process.execPath, registry,
      herdrFactory: () => tracer.herdr, vectorResolver: () => ['herdr.exe'],
      nodeResolver: async () => process.execPath, pidAlive: processes.alive,
      newInstanceId: () => `inst-${++instanceSeq}`,
      workersTrackerFactory: workersFactory,
      dataWriterFactory: () => createDataWriter({ stateDir, now: () => clock.now(), delayMs: 0,
        io: { writeJson: async (path, value) => { writes.push(path); return writeJson(path, value); } } }),
      setInterval: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
      clearInterval: id => { timers.delete(id); },
      ...overrides,
    }),
  };
  const pi = () => {
    const handlers = new Map();
    const channels = new Map();
    const commands = new Map();
    return { handlers, channels, commands,
      on: (name, fn) => handlers.set(name, fn),
      registerCommand: (name, definition) => commands.set(name, definition),
      // The host's `events.on` returns an unsubscribe function (the measured contract), which the
      // instance must call on dispose.
      events: { on: (channel, fn) => {
        channels.set(channel, fn);
        let live = true;
        return () => { if (live) { live = false; channels.delete(channel); } };
      } } };
  };
  world.pi = pi;
  world.fire = async ms => {
    for (const [, timer] of [...timers.entries()].filter(([, entry]) => entry.ms === ms)) {
      await timer.fn();
    }
    for (let index = 0; index < 12; index += 1) await new Promise(resolve => setTimeout(resolve, 3));
  };
  world.slotPath = () => slotPaths(stateDir, world.layoutKey).slot;
  world.slot = async () => readJsonFile(world.slotPath());
  // A slot the product itself would have written, for the rows that need an existing record.
  world.writeSlot = ({ roles = {}, sessionId = 's-1', scopeKey = 'pre-scope' } = {}) =>
    writeJson(world.slotPath(), {
      schema: 'gjc-herdr-dashboard/slot/1', layoutKey: world.layoutKey,
      parent: { socket: SOCKET, paneId: PARENT, tabId: 'w1:t1' }, herdr: ['herdr.exe'],
      scope: { sessionId, scopeKey, scopeEpoch: 1, language: 'ko' }, roles,
    });
  world.workerRecord = ({ state = 'pending', paneId = 'w1:p3', token = 'tok-w' } = {}) => ({
    state, token, paneId, tabId: 'w1:t1', shellPid: 700,
    label: labelOf('workers', key8Of(world.layoutKey)), pendingSince: START, closedBy: null });
  world.workersFile = () => join(stateDir, 'data', world.scopeKeyOf(), 'workers.json');
  world.scopeKeyOf = (sessionId = 's-1') =>
    scopeKeyOf({ socket: SOCKET, parentPaneId: PARENT, sessionId });
  return world;
}

async function armed(world, deps = {}) {
  const pi = world.pi();
  const handle = createInstance(pi, world.deps(deps));
  const { ctx } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  return { pi, handle, ctx };
}

// --------------------------------------------------------------------------------- AC2.7 -----
test('AC2.7: a throwing bus handler becomes the workers sourceError and never escapes into the host', async t => {
  const world = await instanceWorld(t, {
    workersTrackerFactory: () => {
      const tracker = createWorkersTracker({ now: () => world.clock.now() });
      return { ...tracker, onProgress: () => { throw new Error('injected bus fault'); } };
    },
  });
  const { pi, handle, ctx } = await armed(world);
  // Open the band so the workers record and its data file exist (the publish is gated on it).
  await pi.commands.get('dashboard').handler({}, ctx);
  assert.equal(world.notifications.length, 1);
  const before = handle.state().workers.sourceError;
  assert.equal(before, null, JSON.stringify(handle.state().workers));

  // The injected fault must not throw out of the host's event dispatch (LT-1/AC2.7) and must show
  // up as the footer's source error, which is what the viewer renders as `원천 오류`.
  assert.doesNotThrow(() => pi.channels.get('task:subagent:progress')({ progress: { id: 'x' } }));
  await world.fire(0);
  assert.equal(handle.state().workers.sourceError, 'injected bus fault');
  assert.deepEqual(handle.state().errors, [], 'a bus fault is a source error, not an instance error');
  // The other roles and `/dashboard` keep working (AC2.7): one more explicit pass, one more notify.
  world.notifications.length = 0;
  const again = await pi.commands.get('dashboard').handler({}, ctx);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(world.notifications.length, 1);
  assert.equal(world.fake.calls.filter(call => call.argv[1] === 'split').length, 2,
    'the second pass adds no pane');

  // The healthy path is not vacuous: a real lifecycle payload lands as a card, and the projection
  // that reaches the disk carries it.
  world.writes.length = 0;
  pi.channels.get('task:subagent:lifecycle')({ id: 'sub-1', agent: 'executor', status: 'started',
    description: 'band-pass lane' });
  pi.channels.get('task:subagent:event')({ ignored: true });
  await world.fire(0);
  assert.equal(handle.state().workers.cards, 1);
  const published = await readJsonFile(world.workersFile());
  assert.equal(published.schema, WORKERS_SCHEMA);
  assert.equal(published.cards[0].id, 'sub-1');
  assert.equal(published.cards[0].title, 'band-pass lane');
  assert.equal(published.cards[0].status, 'running');
  assert.equal(published.sourceError, 'injected bus fault',
    'the footer keeps reporting the last source error until the scope resets');
});

// --------------------------------------------------------------------------------- AC2.6 -----
test('AC2.6: ctx.getJobs() feeds background cards and a task tool_execution_end re-reads them', async t => {
  const world = await instanceWorld(t);
  const { pi, handle, ctx } = await armed(world);
  await pi.commands.get('dashboard').handler({}, ctx);
  world.writes.length = 0;
  // A finished `task` job: no dashboard pass follows, so the tool_execution_end transition is the
  // only chance to publish it.
  await pi.handlers.get('tool_execution_end')({ toolName: 'task' }, world.ctx({
    jobs: { running: [], recent: [{ id: 'job-7', label: 'deep audit', type: 'task',
      status: 'completed', startTime: START - 5000, endTime: START }], delivery: 'queue' } }).ctx);
  await world.fire(0);
  const published = await readJsonFile(world.workersFile());
  assert.equal(published.cards.length, 1, JSON.stringify(published));
  assert.equal(published.cards[0].id, 'job-7');
  assert.equal(published.cards[0].background, true);
  assert.equal(published.cards[0].title, 'deep audit');
  assert.equal(published.cards[0].status, 'completed');
  assert.equal(handle.state().workers.cards, 1);
});

// ------------------------------------------------------------------------------------ R3 ------
test('R3: the 5 s tick promotes a pending WORKERS viewer without a second /dashboard', async t => {
  const world = await instanceWorld(t);
  const { pi, handle, ctx } = await armed(world);
  await pi.commands.get('dashboard').handler({}, ctx);
  const workersRecord = (await world.slot()).roles.workers;
  assert.equal(workersRecord.state, 'pending');
  // Both roles' viewers report ready: the tick then has nothing pending left to do.
  await writeJson(slotPaths(world.stateDir, world.layoutKey).ready('workers'),
    { pid: HOST_PID, token: workersRecord.token, paneId: workersRecord.paneId, gen: 'dev',
      startedAt: START, heartbeatAt: world.clock.now() });
  const autoBefore = handle.state().counters.auto;
  await world.fire(5000);
  assert.equal(handle.state().counters.auto, autoBefore + 1,
    'a pending workers record is enough to re-evaluate on the tick');
  assert.equal((await world.slot()).roles.workers.state, 'ready');
  assert.equal(world.notifications.length, 1, 'the tick never notifies');

  // The Todo record is still pending at this point, so the tick is busy until it is promoted too.
  const todoRecord = (await world.slot()).roles.todo;
  await writeJson(slotPaths(world.stateDir, world.layoutKey).ready('todo'),
    { pid: HOST_PID, token: todoRecord.token, paneId: todoRecord.paneId, gen: 'dev',
      startedAt: START, heartbeatAt: world.clock.now() });
  await world.fire(5000);
  assert.equal((await world.slot()).roles.todo.state, 'ready');
  // Once BOTH roles are ready the tick has nothing left to re-evaluate: no pass, no Herdr call.
  const autoAfter = handle.state().counters.auto;
  const callsAfter = world.fake.calls.length;
  await world.fire(5000);
  assert.equal(handle.state().counters.auto, autoAfter, 'nothing is pending, so the tick is silent');
  assert.equal(world.fake.calls.length, callsAfter, 'and it made no Herdr call while idle');
});

// ------------------------------------------------------------------------------ data gate -----
test('§7.1 item 5 for workers: the projection exists only while a non-closed workers record does', async t => {
  const world = await instanceWorld(t);
  const { pi, handle, ctx } = await armed(world);
  // A closed workers record publishes nothing, even with a card already waiting in the tracker.
  pi.channels.get('task:subagent:lifecycle')({ id: 'sub-2', agent: 'executor', status: 'started',
    description: 'gated' });
  await world.fire(0);
  assert.equal(await readJsonFile(join(world.stateDir, 'data', 'pre-scope', 'workers.json')), null,
    'no record, no file');
  assert.equal(handle.state().workers.cards, 1, 'the tracker still holds the card');

  await world.writeSlot({ roles: {
    todo: { state: 'closed', token: 'tok-t', paneId: 'w1:p2', tabId: 'w1:t1', shellPid: 500,
      label: labelOf('todo', key8Of(world.layoutKey)), pendingSince: START, closedBy: 't20' },
    workers: world.workerRecord({ state: 'closed' }),
  } });
  await pi.handlers.get('turn_end')({}, ctx);
  assert.equal(await readJsonFile(join(world.stateDir, 'data', 'pre-scope', 'workers.json')), null,
    'a closed workers record is never republished');

  // A live record opens the gate - the non-vacuous half of the same assertion.
  await world.writeSlot({ roles: { workers: world.workerRecord({ state: 'pending' }) } });
  await pi.handlers.get('goal_updated')({}, ctx);
  const published = await readJsonFile(join(world.stateDir, 'data', 'pre-scope', 'workers.json'));
  assert.equal(published.schema, WORKERS_SCHEMA);
  assert.equal(published.cards.length, 1);
  assert.equal(handle.state().scopeKey, 'pre-scope');
});

// --------------------------------------------------------------------------- scope change -----
test('plan 7.2: a scope change resets the workers tracker instead of leaking the old scope cards', async t => {
  const world = await instanceWorld(t);
  const pi = world.pi();
  const handle = createInstance(pi, world.deps());
  // ONE ctx object for the whole test: `/new` + `/resume` is the same session manager answering
  // with a new session id, not a new host object.
  const { ctx, state } = world.ctx();
  await pi.handlers.get('session_start')({}, ctx);
  await pi.commands.get('dashboard').handler({}, ctx);
  const firstScope = handle.state().scopeKey;
  pi.channels.get('task:subagent:lifecycle')({ id: 'sub-3', agent: 'executor', status: 'started',
    description: 'old scope' });
  await world.fire(0);
  assert.equal(handle.state().workers.cards, 1);
  assert.equal((await readJsonFile(world.workersFile())).cards.length, 1);

  // `/new` then `/resume`: the same slot answers with a different session id.
  state.sessionId = 's-2';
  world.notifications.length = 0;
  await pi.commands.get('dashboard').handler({}, ctx);
  const secondScope = handle.state().scopeKey;
  assert.notEqual(secondScope, firstScope);
  assert.equal(handle.state().workers.cards, 0, 'the old scope cards are gone');
  assert.equal(handle.state().workers.sourceError, null, 'and so is the old source error');
  const published = await readJsonFile(join(world.stateDir, 'data', secondScope, 'workers.json'));
  assert.equal(published.schema, WORKERS_SCHEMA);
  assert.equal(published.empty, true);
  assert.deepEqual(published.cards, []);
});

// ------------------------------------------------------------------------------ dispose -------
test('dispose unsubscribes every bus channel when the host hands back an unsubscribe function', async t => {
  const world = await instanceWorld(t);
  const { pi, handle } = await armed(world);
  assert.deepEqual([...pi.channels.keys()].sort(),
    ['task:subagent:event', 'task:subagent:lifecycle', 'task:subagent:progress']);
  handle.dispose();
  assert.deepEqual([...pi.channels.keys()], [], 'dispose released all three subscriptions');
});
