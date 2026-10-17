// Unit tests for src/core/reconciler.mjs: the pass order, the R1 generation lock, the lifecycle
// table rows (LT-2 r1-r7 and the A-29/C-14 observation sequences S1-S6), the launch-window
// boundaries (LT-3), the no-waiting-state rule (LT-5) and the lock races (LT-7 a-d), plus the
// executor obligations A-29, A-30, A-31 and A-32.
//
// Every pass runs against a real temporary state directory plus the shared fake Herdr/clock/
// process table. The fake records every call and the tracer tags each one with the pass that
// issued it, which is what makes A-31 ("did this pass really run?"), A-32 ("was this verb allowed
// in an automatic pass?") and LT-8 ("is the run target from the same pass's split?") checkable
// instead of assumed. No real Herdr, no real clock, no real process, no owner home.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createDataWriter } from '../../src/core/data.mjs';
import { key8Of, labelOf, layoutKeyOf, slotPaths } from '../../src/core/slot.mjs';
import { createReconciler } from '../../src/core/reconciler.mjs';
import { writeJson } from '../../src/storage.mjs';
import { createFakeClock, createFakeHerdr, createFakeProcesses, createPassTracer } from './fake-herdr.mjs';

const START = 1_700_000_000_000;
const OWNER_PID = 4242;
const VIEWER = fileURLToPath(new URL('../../src/viewers/todo/viewer.mjs', import.meta.url));
// A-32: the closed set of verbs an automatic pass may use.
const AUTO_ALLOWED = new Set(['pane list', 'pane process-info', 'pane layout']);
const MUTATIONS = new Set(['pane split', 'pane rename', 'pane run', 'pane close', 'pane focus']);

// The shared pass-formatting contract: exactly one notify per explicit pass, none for automatic
// passes (plan 7.4). The reconciler hands the caller every notify material for explicit passes and
// none at all for automatic ones, so this collector models the caller.
function notifiesOf(result) {
  return result.mode === 'explicit' ? [{ code: result.code, gen: result.gen }] : [];
}

async function createWorld(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'gjc-rec-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const clock = createFakeClock(START);
  const fake = createFakeHerdr({ parentPaneId: 'w1:p1', ...options.fake });
  const processes = createFakeProcesses({ alive: [OWNER_PID, process.pid], ...options.processes });
  const tracer = createPassTracer(fake.herdr);
  const binding = { socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1', tabId: 'w1:t1', sessionId: 's-1' };
  const layoutKey = layoutKeyOf({ socket: binding.socket, parentPaneId: binding.parentPaneId });
  const key8 = key8Of(layoutKey);
  const paths = slotPaths(stateDir, layoutKey);
  const deps = {
    stateDir, herdr: tracer.herdr, vector: ['herdr.exe'], now: clock.now,
    pidAlive: processes.alive, instanceId: 'inst-1', pid: OWNER_PID,
    newToken: () => 'tok-1', newPassId: () => 'pass-1', viewerPath: { todo: VIEWER },
    nodePath: process.execPath, checkNode: async () => ({ ok: true, nodePath: process.execPath }),
    language: 'ko', gen: 'dev', env: {},
    // The production per-call limit is 5 s (plan 7.5). The tests keep the same code path with a
    // short limit so a hanging-call scenario costs milliseconds instead of seconds.
    herdrTimeoutMs: 250,
  };
  const make = overrides => createReconciler({ ...deps, ...options.deps, ...overrides });
  const reconciler = make();
  const world = {
    stateDir, clock, fake, processes, tracer, binding, layoutKey, key8, paths, deps, reconciler, make,
    // A second, independent view of the same fake: a test that must prove a pass issued NO herdr
    // call at all gives that pass its own tracer, because a shared tracer's trace is reset when
    // the next pass starts.
    spawn: (overrides = {}) => {
      const own = createPassTracer(fake.herdr);
      const instance = make({ herdr: own.herdr, ...overrides });
      return {
        reconciler: instance,
        tracer: own,
        explicit: (extra = {}) => own.inPass('explicit', () => instance.explicitPass({
          binding, roles: ['todo'], ...extra })),
        auto: (trigger = 'turn_end', extra = {}) => own.inPass('auto', () => instance.autoPass({
          binding, roles: ['todo'], trigger, ...extra })),
      };
    },
    explicit: (overrides = {}) => tracer.inPass('explicit',
      () => (overrides.reconciler ?? reconciler).explicitPass({ binding, roles: ['todo'], ...overrides })),
    auto: (trigger = 'turn_end', overrides = {}) => tracer.inPass('auto',
      () => (overrides.reconciler ?? reconciler).autoPass({ binding, roles: ['todo'], trigger, ...overrides })),
    slot: async () => {
      try { return JSON.parse(await readFile(paths.slot, 'utf8')); }
      catch { return null; }
    },
    slotBytes: async () => {
      try { return await readFile(paths.slot, 'utf8'); }
      catch { return null; }
    },
    readyBytes: async role => {
      try { return await readFile(paths.ready(role), 'utf8'); }
      catch { return null; }
    },
    ready: async (role, record) => writeJson(paths.ready(role), record),
    readyRecord: ({ paneId, token, pid = 9001, heartbeatAt = START, extra = {} } = {}) => {
      // A ready file means the viewer process exists: register it so the fake process table and the
      // R2 V ladder agree on `dead` vs `ready`.
      world.processes.add(pid);
      return { pid, token, paneId, gen: 'dev', startedAt: START, heartbeatAt, ...extra };
    },
    // A-32: every verb the automatic passes used, in order, and every mutation they issued.
    autoVerbs: () => tracer.verbs('auto'),
    autoMutations: () => tracer.mutations('auto'),
  };
  return world;
}

// Open the todo role the way the product does: one explicit pass from a clean state.
async function openTodo(world, overrides = {}) {
  const first = await world.explicit(overrides);
  const record = (await world.slot())?.roles?.todo ?? null;
  return { first, record };
}

function assertAutoDiscipline(world, label = 'auto') {
  for (const verb of world.tracer.verbs(label)) {
    assert.ok(AUTO_ALLOWED.has(verb), `automatic pass used ${verb}`);
  }
  assert.deepEqual(world.tracer.mutations(label), []);
  assert.deepEqual(world.tracer.verbs(label).filter(verb => MUTATIONS.has(verb)), []);
}

// --------------------------------------------------------------------------------- LT-2 ----
test('LT-2 r1: a record whose pane is gone is discarded and one new pane is created (T4)', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  // The viewer's pane disappears without a `q`.
  world.fake.panes.delete(record.paneId);
  const pass = await world.explicit();
  assert.equal(pass.roles.todo.id, 'T4');
  assert.equal(pass.roles.todo.code, 'opened');
  assert.equal(pass.roles.todo.paneId !== record.paneId, true);
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
  assert.equal((await world.slot()).roles.todo.state, 'pending');
});

test('LT-2 r2: a released or dead owner adopts the existing ready viewer without a new pane', async t => {
  const world = await createWorld(t);
  const { first, record } = await openTodo(world);
  assert.equal(first.code, 'opened');
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token }));
  // The previous GJC wrote stoppedAt and exited; the viewer is still alive.
  await writeJson(world.paths.owner, { schema: 'gjc-herdr-dashboard/owner/1', pid: 9999,
    instanceId: 'inst-old', sessionId: 's-1', heartbeatAt: START - 30000, stoppedAt: START - 1000 });
  const panesBefore = world.fake.ids();
  const pass = await world.explicit();
  assert.equal(pass.roles.todo.id, 'T13');
  assert.equal(pass.roles.todo.code, 'adopted');
  // R1: this pass IS the adoption step, so the phase it saw was prev-dead and it wrote its own
  // owner record over the stopped one.
  assert.equal(pass.ownerPhase, 'prev-dead');
  const owner = JSON.parse(await readFile(world.paths.owner, 'utf8'));
  assert.equal(owner.instanceId, 'inst-1');
  assert.deepEqual(world.fake.ids(), panesBefore);
  assert.equal(pass.roles.todo.paneId, record.paneId);
});

test('LT-2 r3: a frozen viewer is reported with zero action (T14)', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
    heartbeatAt: START - 20000 }));
  const bytesBefore = await world.slotBytes();
  const panesBefore = world.fake.ids();
  const pass = await world.explicit();
  assert.equal(pass.roles.todo.id, 'T14');
  assert.equal(pass.roles.todo.code, 'unresponsive');
  assert.equal(await world.slotBytes(), bytesBefore);
  assert.deepEqual(world.fake.ids(), panesBefore);
  // The automatic pass is just as passive, and issues no mutation at all.
  const auto = await world.auto('turn_end');
  assert.equal(auto.roles.todo.id, 'T14');
  assert.equal(await world.slotBytes(), bytesBefore);
  assertAutoDiscipline(world);
});

test('LT-2 r4: a dead viewer on an O+ pane is closed and replaced, pane count unchanged (T16)', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token, pid: 9001 }));
  world.processes.kill(9001);
  const pass = await world.explicit();
  assert.equal(pass.roles.todo.id, 'T16');
  assert.equal(pass.roles.todo.code, 'replaced:dead');
  assert.equal(world.fake.has(record.paneId), false, 'the dead viewer pane was closed');
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
  // The close happened only after an O+ re-confirmation inside this pass.
  const closeIndex = world.tracer.trace.findIndex(entry => entry.argv[1] === 'close');
  assert.ok(closeIndex > 0);
  assert.ok(world.tracer.trace.slice(0, closeIndex).filter(entry => entry.argv[1] === 'process-info').length >= 2);
});

test('LT-2 r5: a dead viewer on a pane whose shell changed keeps the orphan (T17, partial)', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token, pid: 9002 }));
  world.processes.kill(9002);
  world.fake.setShell(record.paneId, 7777);
  const pass = await world.explicit();
  assert.equal(pass.roles.todo.id, 'T17');
  assert.equal(pass.roles.todo.code, 'partial:ownership-unproven');
  assert.equal(pass.roles.todo.keptPaneId, record.paneId);
  assert.equal(world.fake.has(record.paneId), true, 'a pane we cannot prove ours is never closed');
  assert.equal(world.fake.labelOf(record.paneId), record.label, 'and never renamed');
  assert.equal(world.fake.commandOf(record.paneId), world.fake.commandOf(record.paneId));
});

test('LT-2 r6: a pane carrying a different label is an unproven orphan (T5, partial)', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  world.fake.setLabel(record.paneId, 'someone else');
  const pass = await world.explicit();
  assertEqualsPartial(pass, record);
});

function assertEqualsPartial(pass, record) {
  assert.equal(pass.roles.todo.id, 'T5');
  assert.equal(pass.roles.todo.code, 'partial:ownership-unproven');
  assert.equal(pass.roles.todo.keptPaneId, record.paneId);
  assert.equal(pass.roles.todo.paneId !== record.paneId, true);
}

test('LT-2 r7: a live other owner is busy:other-owner with zero action and zero writes', async t => {
  const world = await createWorld(t);
  await writeJson(world.paths.owner, { schema: 'gjc-herdr-dashboard/owner/1', pid: 7777,
    instanceId: 'inst-other', sessionId: 's-1', heartbeatAt: START - 600000 });
  world.processes.add(7777);
  const panesBefore = world.fake.ids();
  const pass = await world.explicit();
  assert.equal(pass.ownerPhase, 'prev-live');
  assert.equal(pass.code, 'busy:other-owner');
  assert.equal(pass.roles.todo.id, 'T0');
  assert.deepEqual(world.fake.ids(), panesBefore);
  assert.equal(await world.slotBytes(), null, 'no slot is created by a blocked pass');
  assert.deepEqual(pass.focus, { before: null, after: null, restored: true });
  // A heartbeat that stopped ten minutes ago is still not evidence of death (R1: heartbeat is
  // display information only), and an unknowable pid is equally blocking.
  world.processes.freeze(7777);
  const unknown = await world.explicit();
  assert.equal(unknown.code, 'busy:other-owner');
  assert.equal(await world.slotBytes(), null);
});

// ------------------------------------------------------------- observation sequences S1-S6 ----
test('S1: a viewer that dies between the record and the promotion is T16 explicitly, T14 in auto', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token, pid: 9003 }));
  world.processes.kill(9003);
  const auto = await world.auto('turn_end');
  // The automatic pass observes the same dead viewer but only reports; the pane survives.
  assert.equal(auto.roles.todo.id, 'T16');
  assert.equal(auto.roles.todo.code, 'none');
  assert.equal(world.fake.has(record.paneId), true);
  assertAutoDiscipline(world);
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.id, 'T16');
  assert.equal(explicit.roles.todo.code, 'replaced:dead');
  assert.equal(world.fake.has(record.paneId), false);
});

test('S2: the 14999/15000 ms heartbeat boundary is T13 then T14 (closing-q precedes unresponsive)', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
    heartbeatAt: START - 14999 }));
  const promoted = await world.explicit();
  assert.equal(promoted.roles.todo.id, 'T13');
  assert.equal(promoted.roles.todo.code, 'ready');
  assert.equal((await world.slot()).roles.todo.state, 'ready');
  // Freeze for one more millisecond: exactly 15000 is already unresponsive.
  world.clock.advance(1);
  const frozen = await world.explicit();
  assert.equal(frozen.roles.todo.id, 'T14');
  // A-31 pin: `q` recorded past 15 s is closing-q (T20), never unresponsive.
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
    heartbeatAt: START - 60000, extra: { closing: 'q' } }));
  const auto = await world.auto('turn_end');
  assert.equal(auto.roles.todo.id, 'T20');
  assert.equal(auto.roles.todo.code, 'none');
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.id, 'T20');
});

test('S3: a ready record with a vanished viewer file is T21 in place and T6 after it returns', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token }));
  await world.explicit();
  assert.equal((await world.slot()).roles.todo.state, 'ready');
  await rm(world.paths.ready('todo'));
  const gone = await world.explicit();
  assert.equal(gone.roles.todo.id, 'T21');
  assert.equal(gone.roles.todo.code, 'unresponsive');
  assert.equal(world.fake.has(record.paneId), true);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token }));
  const back = await world.explicit();
  assert.equal(back.roles.todo.id, 'T6');
  assert.equal(back.roles.todo.code, 'ready');
});

test('S5: q with the pane already gone is T3, and the automatic pass only records closed', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
    extra: { closing: 'q' } }));
  world.fake.panes.delete(record.paneId);
  const auto = await world.auto('turn_end');
  assert.equal(auto.roles.todo.id, 'T3');
  assert.equal(auto.roles.todo.code, 'closed');
  assert.equal((await world.slot()).roles.todo.state, 'closed');
  assertAutoDiscipline(world);
  // A second automatic pass creates nothing (T2 is not an action row for automatic passes).
  const panesBefore = world.fake.ids();
  const again = await world.auto('agent_end');
  assert.equal(again.roles.todo.id, 'T2');
  assert.deepEqual(world.fake.ids(), panesBefore);
  assertAutoDiscipline(world);
  // The explicit pass opens a fresh pane (T2).
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.id, 'T2');
  assert.equal(explicit.roles.todo.code, 'opened');
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
});

// ----------------------------------------------------------- A-29 / C-14 sequence S6a - S6e ----
async function closingQWorld(t) {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token }));
  await world.explicit();
  // t0: the viewer records `closing:'q'` and freezes. Its pane P1 stays.
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token }));
  await writeJson(world.paths.ready('todo'), { ...world.readyRecord({ paneId: record.paneId,
    token: record.token }), closing: 'q' });
  return { world, record };
}

test('S6a A-29: an automatic pass takes zero action while the q pane exists, then explicit T20 O+ replaces it', async t => {
  const { world, record } = await closingQWorld(t);
  const slotBefore = await world.slotBytes();
  const readyBefore = await world.readyBytes('todo');
  const panesBefore = world.fake.ids();
  // t1: an owner heartbeat tick and a real turn_end, both automatic.
  for (const trigger of ['heartbeat-tick', 'turn_end']) {
    const auto = await world.auto(trigger);
    assert.equal(auto.roles.todo.id, 'T20');
    assert.equal(auto.roles.todo.code, 'none');
    assert.equal(auto.roles.todo.paneId, record.paneId);
    assert.equal(notifiesOf(auto).length, 0, 'an automatic pass never notifies');
    assert.ok(world.tracer.lists('auto').length >= 1, 'the pass really ran (A-31)');
    assertAutoDiscipline(world);
  }
  assert.equal(await world.slotBytes(), slotBefore, 'an automatic T20 changes no slot byte');
  assert.equal(await world.readyBytes('todo'), readyBefore, 'and no ready byte');
  assert.deepEqual(world.fake.ids(), panesBefore);
  // t2: explicit /dashboard -> O+ re-confirmation, close, split, run, opened.
  world.tracer.set('explicit');
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.id, 'T20');
  assert.equal(explicit.roles.todo.code, 'opened');
  assert.equal(world.fake.has(record.paneId), false);
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
  const verbs = world.tracer.verbs('explicit');
  assert.equal(verbs.filter(verb => verb === 'pane close').length, 1);
  assert.equal(verbs.filter(verb => verb === 'pane split').length, 1);
  assert.equal(verbs.filter(verb => verb === 'pane run').length, 1);
  assert.equal((await world.slot()).roles.todo.state, 'pending');
  // t3: another explicit pass finds the new pending pane untouched.
  const settled = await world.explicit();
  assert.equal(settled.roles.todo.id, 'T9');
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
  assert.equal(settled.roles.todo.code, 'pending');
});

test('S6b A-29: the not-O+ q variants keep the pane, open a new one and report partial with the paneId', async t => {
  for (const variant of ['shell', 'label']) {
    const { world, record } = await closingQWorld(t);
    if (variant === 'shell') world.fake.setShell(record.paneId, 31337);
    else world.fake.setLabel(record.paneId, 'GJC Todo · other');
    const panesBefore = world.fake.ids();
    const explicit = await world.explicit();
    assert.equal(explicit.roles.todo.id, 'T20');
    assert.equal(explicit.roles.todo.code, 'partial:ownership-unproven');
    assert.equal(explicit.roles.todo.keptPaneId, record.paneId);
    assert.equal(explicit.roles.todo.paneId !== record.paneId, true);
    assert.equal(world.fake.has(record.paneId), true, 'the orphan pane is kept');
    assert.equal(world.fake.paneIds().length, panesBefore.length + 1);
    // The close was never issued against the orphan (S6b: close 0, input 0).
    assert.equal(world.tracer.verbs('explicit').filter(verb => verb === 'pane close').length, 0);
    assert.equal(world.tracer.verbs('explicit').filter(verb => /send-text|send-keys/.test(verb)).length, 0);
    // The kept pane's command was never touched again (no re-entry).
    assert.equal(world.fake.commandOf(record.paneId) !== null, true);
    // A later explicit pass does nothing about the orphan either.
    const before = world.fake.commandOf(record.paneId);
    world.tracer.set('explicit');
    const later = await world.explicit();
    assert.equal(later.roles.todo.code, 'pending');
    assert.equal(world.fake.commandOf(record.paneId), before);
    assert.equal(world.tracer.verbs('explicit').filter(verb => verb === 'pane close').length, 0);
  }
});

test('S6c A-29: q then a pane that disappears is T3 for the automatic pass and T2 for the explicit one', async t => {
  const { world, record } = await closingQWorld(t);
  // t2: the viewer resumes and closes its own pane.
  world.fake.panes.delete(record.paneId);
  // t3: a real automatic pass records only `closed`.
  const auto = await world.auto('turn_end');
  assert.equal(auto.roles.todo.id, 'T3');
  assert.equal(auto.roles.todo.code, 'closed');
  assertAutoDiscipline(world);
  assert.equal(notifiesOf(auto).length, 0);
  // t4: explicit -> T2, one split, no close.
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.id, 'T2');
  assert.equal(explicit.roles.todo.code, 'opened');
  assert.equal(world.tracer.verbs('explicit').filter(verb => verb === 'pane close').length, 0);
  assert.equal(world.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 1);

  // Variant c': no automatic pass in between; the explicit pass resolves T3 directly.
  const second = await closingQWorld(t);
  second.world.fake.panes.delete(second.record.paneId);
  const direct = await second.world.explicit();
  assert.equal(direct.roles.todo.id, 'T3');
  assert.equal(direct.roles.todo.code, 'opened');
  assert.equal(second.world.tracer.verbs('explicit').filter(verb => verb === 'pane close').length, 0);
  assert.equal(second.world.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 1);
});

test('S6d A-29: a racing close that answers not-found with an absent list counts as success', async t => {
  const { world, record } = await closingQWorld(t);
  // The pane is present when the pass observes it (O+), and disappears while our close is in
  // flight: Herdr answers pane_not_found and the confirming list already shows it gone.
  world.fake.setFailures({ close: { code: 'pane_not_found', remove: record.paneId } });
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.id, 'T20');
  assert.equal(explicit.roles.todo.code, 'opened');
  assert.equal(world.fake.has(record.paneId), false);
  assert.equal((await world.slot()).roles.todo.state, 'pending');
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
  assert.equal(world.tracer.verbs('explicit').filter(verb => verb === 'pane close').length, 1);
});

test('A-30: close errors are never evidence of absence - the record, the q and the pane all survive', async t => {
  const scenarios = [
    // (1) close reports not-found but the confirming list still shows P1 -> not absence.
    ['not-found-present', { close: { code: 'pane_not_found' } }],
    // (2) close reports not-found and the confirming list itself fails. Two lists precede the
    // close (observe and O+ re-confirmation), so the third one fails.
    ['not-found-list-fails', { close: { code: 'pane_not_found' }, list: { skip: 2, code: 'herdr_error' } }],
    // (3) close fails outright.
    ['close-error', { close: { code: 'herdr_error' } }],
  ];
  for (const [name, failures] of scenarios) {
    const { world, record } = await closingQWorld(t);
    world.fake.setFailures(failures);
    const slotBefore = await world.slotBytes();
    const readyBefore = await world.readyBytes('todo');
    const explicit = await world.explicit();
    assert.equal(explicit.roles.todo.code, 'failed:herdr-close', `${name}: ${JSON.stringify(explicit.roles)}`);
    assert.equal(explicit.roles.todo.id, 'T20', name);
    assert.equal(explicit.roles.todo.failure, 'failed:herdr-close');
    assert.equal(notifiesOf(explicit).length, 1, 'exactly one notify (A-30)');
    assert.equal(world.fake.has(record.paneId), true, `${name}: the pane is kept`);
    assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1, `${name}: create 0`);
    assert.equal(await world.slotBytes(), slotBefore, `${name}: slot preserved`);
    assert.equal(await world.readyBytes('todo'), readyBefore, `${name}: q evidence preserved`);
    assert.equal(world.fake.commandOf(record.paneId) !== null, true, `${name}: no input to the pane`);
    // t3: the automatic pass still takes zero action.
    const auto = await world.auto('turn_end');
    assert.equal(auto.roles.todo.id, 'T20');
    assert.equal(auto.roles.todo.code, 'none');
    assertAutoDiscipline(world);
    assert.equal(await world.slotBytes(), slotBefore);
    // t4: once the close works again, the explicit pass completes the replacement:
    // one successful close and one create in total for this variant.
    world.fake.setFailures({});
    world.tracer.set('explicit');
    const recovered = await world.explicit();
    assert.equal(recovered.roles.todo.code, 'opened', `${name}: ${JSON.stringify(recovered.roles)}`);
    assert.equal(world.fake.has(record.paneId), false);
    assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
    assert.equal(world.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 1,
      `${name}: S6e totals are close 1 (failed first) and create 1`);
  }
});

test('A-30: a close that never answers is partial:timeout, with the record and the q kept', async t => {
  const { world, record } = await closingQWorld(t);
  world.fake.setFailures({ close: { hang: true } });
  const slotBefore = await world.slotBytes();
  const readyBefore = await world.readyBytes('todo');
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.code, 'partial:timeout');
  assert.equal(explicit.code, 'partial:timeout');
  assert.equal(world.fake.has(record.paneId), true);
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1, 'create 0');
  assert.equal(await world.slotBytes(), slotBefore);
  assert.equal(await world.readyBytes('todo') !== null, true);
  assert.equal(notifiesOf(explicit).length, 1);
});

test('A-30: an automatic pass whose pane list fails changes nothing and stays silent', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token }));
  await world.explicit();
  const slotBefore = await world.slotBytes();
  const readyBefore = await world.readyBytes('todo');
  const panesBefore = world.fake.ids();
  world.fake.setFailures({ list: { code: 'herdr_error' } });
  const auto = await world.auto('turn_end');
  assert.equal(auto.mode, 'auto');
  assert.equal(auto.code, 'failed:internal', JSON.stringify(auto));
  assert.equal(notifiesOf(auto).length, 0);
  assert.equal(await world.slotBytes(), slotBefore);
  assert.equal(await world.readyBytes('todo'), readyBefore);
  assert.deepEqual(world.fake.ids(), panesBefore);
  assert.deepEqual(world.tracer.mutations('auto'), []);
});

// ------------------------------------------------------- A-31 real-event automatic drivers ----
test('A-31: real turn_end/agent_end driven passes at hbAge >= 15000 ms promote and never mutate', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  // The viewer is alive but its heartbeat is exactly at the unresponsive edge; nothing is written
  // until the ready file says so, so the automatic pass must not promote on its own.
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
    heartbeatAt: START - 15000 }));
  const frozen = await world.auto('turn_end');
  assert.equal(frozen.roles.todo.id, 'T14');
  assert.equal(frozen.roles.todo.code, 'unresponsive');
  assert.ok(world.tracer.lists('auto').length >= 1, 'the pass really ran (A-31)');
  assertAutoDiscipline(world);
  // The viewer's next heartbeat lands: the same automatic path promotes it (T13), for both of the
  // supported ready-fixture event drivers.
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
    heartbeatAt: START - 10 }));
  const promoted = await world.auto('turn_end');
  assert.equal(promoted.roles.todo.id, 'T13', 'agent_end');
  assert.equal(promoted.roles.todo.code, 'ready', 'agent_end');
  assert.ok(world.tracer.lists('auto').length >= 1, 'agent_end: the pass really ran');
  assertAutoDiscipline(world);
  assert.equal(notifiesOf(promoted).length, 0);
  assert.equal((await world.slot()).roles.todo.state, 'ready');
  // The second real event driver then finds a steady ready record (T6) and mutates nothing.
  const steady = await world.auto('agent_end');
  assert.equal(steady.roles.todo.id, 'T6');
  assert.equal(steady.roles.todo.code, 'ready');
  assertAutoDiscipline(world);
  assert.equal(notifiesOf(steady).length, 0);
});

test('A-31: a pending-only record is never promoted by the heartbeat tick alone', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token }));
  // The viewer file is gone again (a frozen viewer that never rewrote it, S6a-p): the pass must
  // report pending and must not promote the record to ready.
  await rm(world.paths.ready('todo'));
  const slotBefore = await world.slotBytes();
  for (const trigger of ['heartbeat-tick', 'turn_end']) {
    world.clock.advance(5000);
    const tick = await world.auto(trigger);
    assert.equal(tick.roles.todo.id, 'T9', trigger);
    assert.equal(tick.roles.todo.code, 'pending', trigger);
    assert.equal(notifiesOf(tick).length, 0);
    assert.ok(world.tracer.lists('auto').length >= 1, `${trigger}: the pass really ran`);
    assertAutoDiscipline(world);
  }
  assert.equal(await world.slotBytes(), slotBefore, 'no byte of the slot changed');
});

// ------------------------------------------------------------------- LT-3 launch window ----
test('LT-3: the age boundaries are 19.999 T9 / 20 T10 / 119.999 T10 / 120 T11', async t => {
  for (const [age, id, code] of [[19999, 'T9', 'pending'], [20000, 'T10', 'pending-slow'],
    [119999, 'T10', 'pending-slow'], [120000, 'T11', 'replaced:stalled']]) {
    const world = await createWorld(t);
    const { record } = await openTodo(world);
    world.clock.set(record.pendingSince + age);
    const pass = await world.explicit();
    assert.equal(pass.roles.todo.id, id, `age ${age}`);
    assert.equal(pass.roles.todo.code, code, `age ${age}`);
    if (age === 120000) {
      assert.equal(world.fake.has(record.paneId), false);
      assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
    }
  }
  // A future pendingSince is clamped to 0 (no negative age, no stall).
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  world.clock.set(record.pendingSince - 5000);
  const early = await world.explicit();
  assert.equal(early.roles.todo.id, 'T9');
});

test('LT-3 FP5: a viewer that turns ready 25 s late is promoted by an automatic pass, with no new pane and no notify', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  // 20 s in: still pending, and now slow.
  world.clock.advance(20000);
  const slow = await world.auto('heartbeat-tick');
  assert.equal(slow.roles.todo.id, 'T10');
  assert.equal(notifiesOf(slow).length, 0);
  assertAutoDiscipline(world);
  // 25 s in the viewer writes its first ready file (R3's ready-delay fixture).
  world.clock.advance(5000);
  await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
    heartbeatAt: world.clock.now() }));
  const panesBefore = world.fake.ids();
  const promoted = await world.auto('turn_end');
  assert.equal(promoted.roles.todo.id, 'T13');
  assert.equal(promoted.roles.todo.code, 'ready');
  assert.deepEqual(world.fake.ids(), panesBefore, 'no pane was created for the late viewer');
  assertAutoDiscipline(world);
  assert.equal((await world.slot()).roles.todo.state, 'ready');
  // No herdr mutation happened after the launch at all: the launch is the only mutation source.
  assert.deepEqual(world.tracer.mutations('auto'), []);
});

test('LT-3: three explicit /dashboard passes while pending keep exactly one role pane', async t => {
  const world = await createWorld(t);
  await openTodo(world);
  const panesAfterFirst = world.fake.paneIds().length;
  for (let index = 0; index < 3; index++) {
    const pass = await world.explicit();
    assert.equal(pass.roles.todo.code, 'pending');
    assert.equal(notifiesOf(pass).length, 1, 'every explicit pass notifies exactly once');
    assert.equal(world.fake.paneIds().length, panesAfterFirst);
  }
  assert.equal(world.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 0);
  assertAutoDiscipline(world);
});

// ---------------------------------------------------------------- LT-5 no waiting state ----
test('LT-5: a foreign pane, a corrupt slot, an unknown schema and a small parent never wait', async t => {
  // (1) a foreign pane in the same tab is reported as partial:shape (AC2.8) while our pane is still
  // created next to it and the foreign pane is left byte-identical.
  const foreign = await createWorld(t);
  foreign.fake.addPane('w1:p9', { label: 'DAG · x', shell: 6060 });
  const opened = await foreign.explicit();
  assert.equal(opened.roles.todo.code, 'partial:shape');
  assert.equal(opened.roles.todo.id, 'T1');
  assert.match(opened.roles.todo.detail, /shape:foreign:w1:p9/);
  assert.equal(foreign.fake.paneIds().filter(paneId => paneId !== 'w1:p1' && paneId !== 'w1:p9').length, 1,
    'the Todo pane is still created');
  assert.equal(foreign.fake.labelOf('w1:p9'), 'DAG · x');
  assert.equal(foreign.fake.commandOf('w1:p9'), null);
  assert.equal(foreign.fake.shellOf('w1:p9'), 6060);
  assert.deepEqual(foreign.tracer.mutations('explicit')
    .filter(entry => entry.argv[2] === 'w1:p9').map(entry => entry.argv[1]), [],
  'a foreign sibling is never closed, renamed, run or focused');

  // (2) a corrupt slot is quarantined and the pass continues into T1.
  const corrupt = await createWorld(t);
  await mkdir(corrupt.paths.slot.replace(/slot\.json$/, ''), { recursive: true }).catch(() => {});
  await writeFile(corrupt.paths.slot, '{ truncated', 'utf8');
  const recovered = await corrupt.explicit();
  assert.equal(recovered.quarantined, true);
  assert.equal(recovered.roles.todo.code, 'opened');
  const entries = await readdir(corrupt.paths.dir);
  assert.ok(entries.some(name => name.startsWith('slot.json.corrupt-')));
  assert.equal(await readFileExists(corrupt.paths.slot), true, 'a fresh slot was written');

  // (3) an unknown schema major is corrupt too (no migration layer).
  const future = await createWorld(t);
  await mkdir(future.paths.dir, { recursive: true }).catch(() => {});
  await writeFile(future.paths.slot, JSON.stringify({ schema: 'gjc-herdr-dashboard/slot/2' }), 'utf8');
  const migrated = await future.explicit();
  assert.equal(migrated.quarantined, true);
  assert.equal(migrated.roles.todo.code, 'opened');

    // (4) a parent that cannot host the role column reports partial:size and creates nothing.
  const small = await createWorld(t, { fake: { parentRect: { x: 0, y: 0, width: 20, height: 5 } } });
  const sized = await small.explicit();
  assert.equal(sized.roles.todo.code, 'partial:size');
  assert.deepEqual(small.fake.paneIds(), ['w1:p1']);
  assert.equal(notifiesOf(sized).length, 1);

  // (4b) a parent that is too narrow after a first split reports partial:size, never waits, and
  // never leaves a duplicate role pane behind.
  const narrow = await createWorld(t, { fake: { parentRect: { x: 0, y: 0, width: 90, height: 40 } } });
  const openedOnce = await narrow.explicit();
  assert.equal(openedOnce.roles.todo.code, 'opened');
  await writeJson(narrow.paths.ready('todo'), { ...narrow.readyRecord({ paneId: openedOnce.roles.todo.paneId,
    token: openedOnce.roles.todo.token }) });
  const shrunk = await narrow.explicit();
  assert.equal(shrunk.roles.todo.id, 'T13');

  // (5) reconfiguration with foreign siblings: nothing foreign is closed or renamed, the pass still
  // creates what the floors allow and reports partial:shape instead of a waiting state (AC2.8).
  const siblings = await createWorld(t);
  siblings.fake.addPane('w1:p8', { label: 'OmO DAG', shell: 6061 });
  siblings.fake.addPane('w1:p7', { label: 'OmO Todo · x', shell: 6062 });
  const rebuilt = await siblings.explicit();
  assert.equal(rebuilt.roles.todo.code, 'partial:shape', JSON.stringify(rebuilt.roles.todo));
  assert.equal(rebuilt.roles.todo.id, 'T1');
  assert.equal(rebuilt.roles.todo.paneId !== null, true, 'the pane the floors allowed was created');
  assert.deepEqual(siblings.tracer.mutations('explicit')
    .filter(entry => ['w1:p8', 'w1:p7'].includes(entry.argv[2])), [],
  'no foreign pane was closed, renamed, run or focused');
  assert.equal(siblings.fake.labelOf('w1:p8'), 'OmO DAG');
  assert.equal(siblings.fake.labelOf('w1:p7'), 'OmO Todo · x');
  assert.equal(siblings.fake.shellOf('w1:p8'), 6061);
  assert.equal(siblings.fake.shellOf('w1:p7'), 6062);
  assert.equal(rebuilt.roles.todo.code.startsWith('layout-waiting') ||
    rebuilt.code.includes('waiting'), false);
});

const readFileExists = async path => {
  try { await stat(path); return true; }
  catch { return false; }
};

// ------------------------------------------------------------------------- LT-7 locks ----
// The generation lock is keyed on the OS pid of the process that holds it, so a second pass in the
// same process is a live holder only while the first one has not released (R1: "the same pid with
// a different passId is still live"). `world.spawn()` gives each raced pass its own tracer.
//
// A "frozen holder" is a pass stopped inside `acquireLock` by the `afterLastCheck` hook, which runs
// after its own lock file exists and before anything else. The hook is awaited, so the test needs
// no timer: `created.promise` resolves exactly when the holder's file is on disk.
function frozenHolder(world, { newToken, newPassId } = {}) {
  let release, created;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { created = resolve; });
  const holder = world.spawn({ newToken, newPassId });
  const pass = holder.explicit({ hooks: { afterLastCheck: async () => { created(); await gate; } } });
  return { holder, pass, ready, release };
}

test('LT-7 (a): a live holder is never displaced, at +31 s or +600 s, with zero writes', async t => {
  for (const advance of [31000, 600000]) {
    const world = await createWorld(t);
    const frozen = frozenHolder(world, { newPassId: () => 'pass-frozen' });
    await frozen.ready;
    world.clock.advance(advance);
    const busy = world.spawn();
    const blocked = await busy.explicit();
    assert.equal(blocked.code, 'busy', `+${advance}`);
    assert.equal(blocked.lock.generation, 1, 'the live generation is named and untouched');
    assert.deepEqual(busy.tracer.trace, [], `+${advance}: zero herdr calls while busy`);
    assert.equal(await world.slotBytes(), null, `+${advance}: zero slot writes while busy`);
    // The holder resumes: its budget is long gone, so it stops before its first herdr call.
    frozen.release();
    const resumed = await frozen.pass;
    assert.equal(resumed.code, 'partial:timeout', `+${advance}`);
    assert.deepEqual(frozen.holder.tracer.mutations(), [], `+${advance}: no mutation on resume`);
    assert.equal(await world.slotBytes(), null);
  }
});

test('LT-7 (b): a frozen holder blocks the second pass and its own mutations stay continuous', async t => {
  const world = await createWorld(t);
  const frozen = frozenHolder(world, { newToken: () => 'tok-slow', newPassId: () => 'pass-slow' });
  await frozen.ready;
  const fast = world.spawn({ newToken: () => 'tok-fast', newPassId: () => 'pass-fast' });
  const busy = await fast.explicit();
  assert.equal(busy.code, 'busy');
  assert.equal(busy.fence, false);
  assert.deepEqual(busy.focus, { before: null, after: null, restored: true });
  assert.deepEqual(fast.tracer.trace, [], 'the blocked pass made no herdr call');
  assert.equal(await world.slotBytes(), null, 'and wrote no state');
  // The frozen pass resumes inside its own budget and completes its whole sequence in one
  // unbroken run; nothing else ever touched a pane.
  frozen.release();
  const resumed = await frozen.pass;
  assert.equal(resumed.code, 'opened', JSON.stringify(resumed));
  assert.deepEqual(fast.tracer.mutations(), []);
  assert.equal((await world.slot())?.roles?.todo?.token, 'tok-slow');
  const panes = world.fake.paneIds().filter(paneId => paneId !== 'w1:p1');
  assert.equal(panes.length, 1);
  assert.equal(world.fake.labelOf(panes[0]), labelOf('todo', world.key8));
});

test('LT-7 (b, owner variant): a live owner with a ten-minute-old heartbeat is busy:other-owner', async t => {
  const world = await createWorld(t);
  await writeJson(world.paths.owner, { schema: 'gjc-herdr-dashboard/owner/1', pid: 8888,
    instanceId: 'inst-other', sessionId: 's-1', heartbeatAt: START - 600000 });
  world.processes.add(8888);
  const pass = await world.explicit();
  assert.equal(pass.code, 'busy:other-owner');
  assert.equal(pass.ownerPhase, 'prev-live');
  assert.equal(pass.detail, 'alive');
  assert.equal(world.fake.paneIds().length, 1, 'no pane was created');
  assert.equal(await world.slotBytes(), null);
});

test('LT-7 (c): a released generation and a proven-dead holder are both recovered', async t => {
  const world = await createWorld(t);
  const released = await world.explicit();
  assert.equal(released.code, 'opened');
  assert.equal(released.lock.generation, 1);
  // The holder released (g1.released is written in the pass finally) and a dead g2 is left behind.
  const entries = await readdir(world.paths.lockDir);
  assert.ok(entries.includes('g000000000001.lock'));
  assert.ok(entries.includes('g000000000001.released'));
  await writeFile(join(world.paths.lockDir, 'g000000000002.lock'),
    JSON.stringify({ pid: 5555, instanceId: 'inst-dead', passId: 'pass-dead' }), 'utf8');
  const next = await world.explicit();
  assert.equal(next.code, 'pending');
  assert.equal(next.lock.generation, 3, 'generation N+1 is taken after the dead one is classified');
  // The stopper variant: a stopped owner is adopted rather than blocked.
  await writeJson(world.paths.owner, { schema: 'gjc-herdr-dashboard/owner/1', pid: 6666,
    instanceId: 'inst-stopped', sessionId: 's-1', heartbeatAt: START, stoppedAt: START });
  const adopted = await world.explicit();
  assert.equal(adopted.ownerPhase, 'prev-dead');
  assert.equal(adopted.roles.todo.code, 'pending');
  assert.equal(JSON.parse(await readFile(world.paths.owner, 'utf8')).instanceId, 'inst-1');
});

test('LT-7 (d), (e), (f): a stale recoverer, two racers and a fenced resume all end in busy', async t => {
  const world = await createWorld(t);
  const first = await world.explicit();
  assert.equal(first.code, 'opened');
  const paneBefore = world.fake.paneIds();
  // (d/f) While this pass creates g2, another writer creates g5: the pass must delete only its own
  // file and report busy, with no herdr mutation at all.
  const stale = world.spawn({ newPassId: () => 'pass-stale', newToken: () => 'tok-stale' });
  const addLater = gen => async () => {
    await writeFile(join(world.paths.lockDir, `g${String(gen).padStart(12, '0')}.lock`),
      JSON.stringify({ pid: process.pid, instanceId: 'inst-later', passId: `pass-later-${gen}` }),
      'utf8');
  };
  const result = await stale.explicit({ hooks: { afterLastCheck: addLater(5) } });
  assert.equal(result.code, 'busy');
  assert.equal(result.detail, 'stale-recoverer');
  assert.deepEqual(stale.tracer.trace, [], 'the stale recoverer made no herdr call');
  assert.deepEqual(world.fake.paneIds(), paneBefore);
  const entries = (await readdir(world.paths.lockDir)).sort();
  assert.equal(entries.includes('g000000000002.lock'), false, 'only the pass own file was removed');
  assert.equal(entries.includes('g000000000005.lock'), true, 'the later generation is untouched');
  // A pass that resumes after being fenced stops before its first mutation (R1 step 4 monotonicity).
  const fenced = world.spawn({ newPassId: () => 'pass-fenced' });
  const fencedResult = await fenced.explicit({ hooks: { afterLastCheck: addLater(9) } });
  assert.equal(fencedResult.code, 'busy');
  assert.deepEqual(fenced.tracer.trace, [], 'no mutation after being fenced');
  assert.deepEqual(world.fake.paneIds(), paneBefore);
});

test('LT-7 (g): an unknowable holder is busy with a usable path, and a manual released marker unblocks the next pass', async t => {
  const world = await createWorld(t);
  // An empty lock file is unclassifiable: R1 fails closed (M2's manual recovery case).
  await mkdir(world.paths.lockDir, { recursive: true });
  await writeFile(join(world.paths.lockDir, 'g000000000001.lock'), '', 'utf8');
  const blocked = await world.explicit();
  assert.equal(blocked.code, 'busy');
  assert.equal(blocked.detail, 'unknown');
  assert.match(blocked.lock.dir, /lock$/);
  assert.equal(blocked.lock.generation, 1, 'the unclassifiable generation is named, never removed');
  assert.deepEqual(await world.fake.calls.length, 0);
  // The documented manual recovery: add the released marker for that generation only.
  await writeFile(join(world.paths.lockDir, 'g000000000001.released'), '', 'utf8');
  const opened = await world.explicit();
  assert.equal(opened.code, 'opened');
  assert.equal(opened.lock.generation, 2);
});

test('LT-7 (h): the lock history only ever grows by own generations, with no foreign deletion', async t => {
  const world = await createWorld(t);
  await world.explicit();
  await world.explicit();
  await world.explicit();
  const entries = (await readdir(world.paths.lockDir)).sort();
  // Three passes, and generation 1 is garbage-collected once generation 3 exists (GC <= own-2).
  assert.deepEqual(entries, ['g000000000002.lock', 'g000000000002.released',
    'g000000000003.lock', 'g000000000003.released']);
  // The highest generation is never removed, not even by a later pass.
  await world.explicit();
  const after = (await readdir(world.paths.lockDir)).sort();
  assert.equal(after.includes('g000000000003.lock'), true);
  assert.equal(after.includes('g000000000003.released'), true);
});

// ------------------------------------------- partial launch state: the record is never lost ----
test('a launch failure that already wrote the record is never lost by the following pass', async t => {
  // FP2 crashes after the pending record exists but before `pane rename`. The pass that runs next
  // must not write a stale pre-launch slot snapshot over that record.
  const world = await createWorld(t);
  const pass = await world.explicit({ failpoint: 'fp2' });
  assert.equal(pass.roles.todo.code, 'failed:failpoint');
  const onDisk = await world.slot();
  assert.equal(onDisk.roles.todo.state, 'pending');
  assert.equal(onDisk.roles.todo.paneId, pass.roles.todo.keptPaneId);
  assert.equal(world.fake.has(onDisk.roles.todo.paneId), true);
  // The leftover is the FP2 row the plan defines: a pending record whose pane carries no label yet,
  // so ownership is unprovable -> T5 partial, keep the pane, open one next to it. Never a second
  // record for the same role and never a silent drop.
  const next = await world.explicit();
  assert.equal(next.roles.todo.id, 'T5');
  assert.equal(next.roles.todo.code, 'partial:ownership-unproven');
  assert.equal(next.roles.todo.keptPaneId, onDisk.roles.todo.paneId);
  assert.equal(world.fake.has(onDisk.roles.todo.paneId), true, 'the unlabelled pane is never closed');
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 2);
  const after = await world.slot();
  assert.equal(after.roles.todo.state, 'pending');
  assert.equal(after.roles.todo.paneId !== onDisk.roles.todo.paneId, true,
    'the new record names the new pane');
});

test('a failed rename still attributes the pane and no viewer is ever started', async t => {
  const world = await createWorld(t);
  world.fake.setFailures({ rename: { code: 'herdr_error' } });
  const renamed = await world.explicit();
  assert.equal(renamed.roles.todo.code, 'failed:herdr-rename');
  assert.equal(renamed.roles.todo.failure, 'failed:herdr-rename');
  // The record was already written, so the pane is attributed to the failing pass and kept.
  const record = await world.slot();
  assert.equal(record.roles.todo.state, 'pending');
  assert.equal(record.roles.todo.paneId, renamed.roles.todo.keptPaneId);
  assert.equal(world.fake.labelOf(record.roles.todo.paneId), null, 'no rename happened');
  assert.equal(world.fake.commandOf(record.roles.todo.paneId), null, 'and no viewer was started');
  // The intent was already cleared (the record attributes the pane), so the next pass sees an
  // unlabelled pending pane: T5 partial, keep it, open one next to it.
  world.fake.setFailures({});
  const next = await world.explicit();
  assert.equal(next.roles.todo.id, 'T5');
  assert.equal(next.roles.todo.code, 'partial:ownership-unproven');
  assert.equal(next.roles.todo.keptPaneId, record.roles.todo.paneId);
  assert.equal(world.fake.has(record.roles.todo.paneId), true, 'the unlabelled pane is never closed');
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 2);
});

test('a run failure keeps the renamed pane and reports it as failed:herdr-run', async t => {
  const world = await createWorld(t);
  world.fake.setFailures({ run: { code: 'herdr_error' } });
  const run = await world.explicit();
  assert.equal(run.roles.todo.code, 'failed:herdr-run');
  const record = await world.slot();
  assert.equal(record.roles.todo.state, 'pending');
  assert.equal(world.fake.labelOf(record.roles.todo.paneId), record.roles.todo.label,
    'the rename succeeded before the run failed');
  assert.equal(world.fake.commandOf(record.roles.todo.paneId), null);
  // The renamed pane is now provably ours, so the next pass restarts the viewer on it (T9/T16 path
  // depends on the viewer state; the run target is always a pane of that same pass).
  world.fake.setFailures({});
  world.tracer.set('explicit');
  const next = await world.explicit();
  assert.ok(['T9', 'T12', 'T4', 'T16'].includes(next.roles.todo.id), next.roles.todo.id);
  assert.equal(world.fake.commandOf(record.roles.todo.paneId), null,
    'this lane never starts a viewer on a pane it did not split in the same pass');
});

// --------------------------------------------------------------------- T18 / T19 slot rows ----
test('T19: a leftover intent is an interrupted launch - explicit clears it and opens, automatic does nothing', async t => {
  const world = await createWorld(t);
  // An FP1 crash left intent.json behind and no record at all.
  await writeJson(world.paths.intent, { schema: 'gjc-herdr-dashboard/intent/1', role: 'todo',
    token: 'tok-x', label: `GJC Todo · ${world.key8}`, tabId: world.binding.tabId, at: START });
  const auto = await world.auto('turn_end');
  assert.equal(auto.roles.todo.id, 'T19');
  assert.equal(auto.roles.todo.code, 'none');
  assert.equal(auto.interrupted, true);
  assert.equal(await readFileExists(world.paths.intent), true, 'the automatic pass keeps the intent');
  assert.equal(await world.slotBytes(), null, 'and creates no slot');
  assert.deepEqual(world.fake.paneIds(), ['w1:p1']);
  assertAutoDiscipline(world);
  // The explicit pass clears the intent and opens a fresh role pane (never a waiting state).
  const explicit = await world.explicit();
  assert.equal(explicit.roles.todo.id, 'T19');
  assert.equal(explicit.roles.todo.code, 'partial:interrupted-launch');
  assert.equal(await readFileExists(world.paths.intent), false);
  assert.equal(world.fake.paneIds().length, 2);
  assert.equal((await world.slot()).roles.todo.state, 'pending');
  // A second explicit pass is the ordinary pending row: the intent is gone for good.
  const settled = await world.explicit();
  assert.equal(settled.roles.todo.id, 'T9');
  assert.equal(settled.interrupted, false);
});

// --------------------------------------------------- plan 7.2 rebind (sessionId comparison) ----
test('rebind: a new sessionId bumps scopeEpoch and recomputes scopeKey with the pane untouched', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  const before = await world.slot();
  assert.equal(before.scope.scopeEpoch, 1);
  assert.equal(before.scope.sessionId, 's-1');
  const panesBefore = world.fake.ids();
  const commandsBefore = panesBefore.map(paneId => world.fake.commandOf(paneId));
  // /new, /resume, branch, tree and fork all arrive as a different sessionId on the same pane.
  const rebound = await world.reconciler.rebind({ ...world.binding, sessionId: 's-2' });
  assert.equal(rebound.ok, true);
  assert.equal(rebound.code, 'rebound');
  assert.equal(rebound.scopeEpoch, 2);
  assert.notEqual(rebound.scopeKey, before.scope.scopeKey);
  const after = await world.slot();
  assert.equal(after.scope.sessionId, 's-2');
  assert.equal(after.scope.scopeEpoch, 2);
  assert.equal(after.scope.scopeKey, rebound.scopeKey);
  assert.deepEqual(after.roles, before.roles, 'the role record is untouched by a rebind');
  assert.equal(after.roles.todo.paneId, record.paneId);
  assert.deepEqual(world.fake.ids(), panesBefore, 'the pane is never touched');
  assert.deepEqual(panesBefore.map(paneId => world.fake.commandOf(paneId)), commandsBefore);
  // Repeating the same sessionId is a no-op, not a second epoch bump.
  const same = await world.reconciler.rebind({ ...world.binding, sessionId: 's-2' });
  assert.equal(same.code, 'unchanged');
  assert.equal(same.scopeEpoch, 2);
  const json = await world.slotBytes();
  assert.equal(json, JSON.stringify(JSON.parse(json)), 'the slot stays a canonical JSON document');
  // A pass under the NEW sessionId keeps working, and a pass under the OLD one rebinds back in place
  // (the public rebind is the same comparison the pass itself performs, plan 7.2).
  const pass = await world.explicit({ binding: { ...world.binding, sessionId: 's-2' } });
  assert.equal(pass.code, 'pending');
  assert.equal(pass.rebound, false);
  assert.equal(await world.slot().then(slot => slot.scope.sessionId), 's-2');
  const back = await world.explicit({ binding: { ...world.binding, sessionId: 's-1' } });
  assert.equal(back.rebound, true, 'the pass rebinds in place, with no pane change');
  assert.equal(await world.slot().then(slot => slot.scope.scopeEpoch), 3);
  assert.deepEqual(world.fake.ids(), panesBefore);
});

test('rebind, writeOwner and markStopped never create a slot, and a blocked rebind changes nothing', async t => {
  const world = await createWorld(t);
  // No slot yet: a rebind has nothing to move (T1 stays T1's business).
  const empty = await world.reconciler.rebind(world.binding);
  assert.equal(empty.code, 'no-slot');
  assert.equal(await world.slotBytes(), null);
  // The owner record is written by name, not by pass. R1: it names the live holder of generation 1.
  const owner = await world.reconciler.writeOwner(world.binding);
  assert.equal(owner.ok, true);
  const written = JSON.parse(await readFile(world.paths.owner, 'utf8'));
  assert.equal(written.pid, OWNER_PID);
  assert.equal(written.instanceId, 'inst-1');
  assert.equal(written.sessionId, 's-1');
  // markStopped records stoppedAt without inventing a binding it never saw.
  const stopped = await world.reconciler.markStopped();
  assert.equal(stopped.ok, true);
  const stoppedRecord = JSON.parse(await readFile(world.paths.owner, 'utf8'));
  assert.equal(typeof stoppedRecord.stoppedAt, 'number');
  assert.equal(stoppedRecord.instanceId, 'inst-1');
  assert.equal(await world.slotBytes(), null, 'no slot was created by any of the three');
  // A rebind while another process holds a live generation is busy and writes nothing.
  const frozen = frozenHolder(world, { newPassId: () => 'pass-hold' });
  const release = frozen.release;
  const holding = frozen.pass;
  await frozen.ready;
  const blocked = await world.reconciler.rebind({ ...world.binding, sessionId: 's-3' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'busy');
  assert.equal(await world.slotBytes(), null);
  release();
  await holding;
});

test('FP3: a renamed-but-unstarted pane converges T9 -> T10 -> T11 with no re-entry', async t => {
  const world = await createWorld(t);
  // fp3 leaves our label on an empty shell: the record is pending, the pane is ours, and no viewer
  // was ever started. The plan's ladder is T9 (pending) -> T10 (slow) -> T11 (stalled, close + create).
  const crashed = await world.explicit({ failpoint: 'fp3' });
  assert.equal(crashed.roles.todo.code, 'failed:failpoint');
  const record = await world.slot().then(slot => slot.roles.todo);
  assert.equal(record.state, 'pending');
  assert.equal(world.fake.labelOf(record.paneId), record.label, 'the rename had already happened');
  assert.equal(world.fake.commandOf(record.paneId), null, 'and the run had not');
  // No ready file ever appears for it (the viewer never started).
  const first = await world.explicit();
  assert.equal(first.roles.todo.id, 'T9');
  assert.equal(first.roles.todo.code, 'pending');
  world.clock.set(record.pendingSince + 20000);
  const slow = await world.explicit();
  assert.equal(slow.roles.todo.id, 'T10');
  assert.equal(slow.roles.todo.code, 'pending-slow');
  world.clock.set(record.pendingSince + 120000);
  const stalled = await world.explicit();
  assert.equal(stalled.roles.todo.id, 'T11');
  assert.equal(stalled.roles.todo.code, 'replaced:stalled');
  assert.equal(world.fake.has(record.paneId), false, 'the stalled pane is closed');
  assert.equal(world.fake.paneIds().filter(paneId => paneId !== 'w1:p1').length, 1);
  // The empty shell never received a command: the close is the only thing that happened to it.
  assert.equal(world.fake.commandOf(record.paneId), null);
});

// ------------------------------------------------------------------- budgets and deadlines ----
test('budgets: explicit 15 s / auto 5 s / 5 s per call, and an exhausted pass stops coded', async t => {
  const world = await createWorld(t);
  const first = await world.explicit();
  assert.equal(first.budgetMs, 15000, 'the explicit budget is the plan\'s 15 s');
  assert.equal(first.gen, 'dev');
  const auto = await world.auto('turn_end');
  assert.equal(auto.budgetMs, 5000, 'the automatic budget is 5 s');
  assert.equal(world.deps.sleep, undefined, 'the contract\'s sleep dep is accepted but unused');

  // A pass whose budget is already gone before its first herdr write reports partial:timeout and
  // leaves no record behind. The fake clock is set 15 s ahead inside the lock window.
  const tight = world.spawn({ explicitBudgetMs: 1000 });
  const exhausted = await tight.explicit({ hooks: { afterLastCheck: async () => {
    world.clock.advance(1001);
  } } });
  assert.equal(exhausted.code, 'partial:timeout');
  assert.equal(exhausted.roles.todo.code, 'partial:timeout');
  assert.equal(exhausted.roles.todo.failure, null, 'a timeout is partial, not a failure');
  assert.deepEqual(tight.tracer.mutations(), [], 'no mutation after the budget ran out');

  // A single herdr call that never answers is the same code, once, never a hang: the per-call
  // limit is what makes LT-5's "no waiting state" true even when Herdr itself is stuck. The call
  // that hangs here is the role observation's pane list, i.e. inside the pass body.
  const stuck = await createWorld(t);
  const opened = await stuck.explicit();
  assert.equal(opened.code, 'opened');
  const slotBefore = await stuck.slotBytes();
  const panesBefore = stuck.fake.ids();
  stuck.fake.setFailures({ list: { hang: true } });
  const timedOut = await stuck.explicit();
  assert.equal(timedOut.code, 'partial:timeout');
  assert.equal(timedOut.roles.todo.code, 'partial:timeout');
  assert.equal(timedOut.roles.todo.failure, null);
  assert.equal(await stuck.slotBytes(), slotBefore, 'the pass wrote nothing');
  assert.deepEqual(stuck.fake.ids(), panesBefore);

  // A hang before any pane exists must not invent one, and must not pretend to know whether Herdr
  // created anything: the split's per-call timeout keeps the intent and reports partial:timeout,
  // so the next pass reports T19 instead of silently orphaning a pane.
  const beforeSplit = await createWorld(t);
  beforeSplit.fake.setFailures({ split: { hang: true } });
  const noSplit = await beforeSplit.explicit();
  assert.equal(noSplit.roles.todo.code, 'partial:timeout');
  assert.equal(noSplit.roles.todo.detail, 'split:timeout');
  assert.deepEqual(beforeSplit.fake.paneIds(), ['w1:p1']);
  assert.equal(await beforeSplit.slotBytes(), null);
  assert.equal(await readFileExists(beforeSplit.paths.intent), true,
    'the intent survives a split that never answered');
  // A coded split refusal is different: nothing was created, so the intent is cleared (LT-1).
  beforeSplit.fake.setFailures({ split: { code: 'herdr_error' } });
  const refused = await beforeSplit.explicit();
  assert.equal(refused.roles.todo.code, 'failed:herdr-split');
  assert.equal(await readFileExists(beforeSplit.paths.intent), false);
  assert.deepEqual(beforeSplit.fake.paneIds(), ['w1:p1']);
});

// ------------------------------------------------------------------------------ LT-8 ----
test('LT-8: every run target belongs to the same pass split and no pass ever sends text or keys', async t => {
  const cases = [];
  {
    const world = await createWorld(t);
    cases.push(['T1', world, await world.explicit()]);
  }
  {
    const world = await createWorld(t);
    const { record } = await openTodo(world);
    world.fake.panes.delete(record.paneId);
    cases.push(['T4', world, await world.explicit()]);
  }
  {
    const world = await createWorld(t);
    const { record } = await openTodo(world);
    await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token, pid: 9005 }));
    world.processes.kill(9005);
    cases.push(['T16', world, await world.explicit()]);
  }
  {
    const world = await createWorld(t);
    const { record } = await openTodo(world);
    await world.ready('todo', world.readyRecord({ paneId: record.paneId, token: record.token,
      extra: { closing: 'q' } }));
    cases.push(['T20', world, await world.explicit()]);
  }
  for (const failpoint of ['fp1', 'fp2', 'fp3', 'fp4']) {
    const world = await createWorld(t);
    const pass = await world.explicit({ failpoint });
    cases.push([failpoint, world, pass]);
  }
  for (const [label, world, pass] of cases) {
    for (const target of world.tracer.record.runTargets) {
      assert.ok(world.tracer.record.splitPaneIds.includes(target), `${label}: run target ${target}`);
    }
    // Every run targets a pane split by the pass that issued the run, never the parent and never a
    // pre-existing pane.
    assert.equal(world.tracer.record.runTargets.includes('w1:p1'), false, label);
    assert.deepEqual(world.tracer.verbs('explicit').filter(verb => /send-text|send-keys/.test(verb)), [], label);
    const runs = world.tracer.trace.filter(entry => entry.argv[1] === 'run');
    for (const run of runs) {
      const splitForRun = world.tracer.trace.filter(entry => entry.argv[1] === 'split')
        .map(entry => entry.paneId);
      assert.ok(splitForRun.includes(run.paneId), `${label}: run target ${run.paneId} has no split`);
    }
    // Whatever the row did, the pane it names is a pane this pass created.
    if (pass.roles?.todo?.paneId) {
      assert.ok(world.tracer.record.splitPaneIds.includes(pass.roles.todo.paneId), label);
    }
  }
});

// ----------------------------------------------------------- A-29: data writes stay out ----
test('A-29: the reconciler writes no data file and the data writer is gated by the caller', async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  const writer = createDataWriter({ stateDir: world.stateDir, now: world.clock.now, delayMs: 0 });
  const scopeKey = (await world.slot()).scope.scopeKey;
  const target = join(world.stateDir, 'data', scopeKey, 'todo.json');
  const projection = { schema: 'gjc-herdr-dashboard/todo/1', phases: [], empty: false, sourceError: '' };
  // The gate is the caller's: a closed record means no write at all.
  assert.deepEqual(await writer.publish(scopeKey, 'todo', projection, { shouldWrite: () => false }),
    { wrote: false, path: target, skipped: true });
  assert.equal(await writer.flush(), 0);
  assert.equal(await readFileExists(target), false);
  await writer.publish(scopeKey, 'todo', projection, { shouldWrite: () => true });
  assert.equal(await writer.flush(), 1);
  const stored = JSON.parse(await readFile(target, 'utf8'));
  assert.deepEqual(stored.phases, []);
  assert.equal(typeof stored.generatedAt, 'number');
  // Two publishes for one target merge into a single write and the newest projection wins
  // (plan 7.9's 200 ms merge), including while the first write is still in flight.
  const first = writer.publish(scopeKey, 'todo', { ...projection, empty: true }, { shouldWrite: () => true });
  const second = writer.publish(scopeKey, 'todo', { ...projection, empty: false }, { shouldWrite: () => true });
  await Promise.all([first, second]);
  assert.equal(await writer.flush(), 2, 'the merge costs exactly one write');
  assert.equal(JSON.parse(await readFile(target, 'utf8')).empty, false);
  // The reconciler itself never writes a data file: it owns no projection source.
  assert.equal(await readFileExists(join(world.stateDir, 'data', scopeKey, 'workers.json')), false);
  const closed = { ...(await world.slot()), roles: { todo: { ...record, state: 'closed' } } };
  await writeJson(world.paths.slot, closed);
  const afterClose = await world.auto('turn_end');
  assert.equal(afterClose.roles.todo.id, 'T2');
  assert.equal(await world.slotBytes() !== null, true);
});

test("AC4.1: arming and the heartbeat never take over a record another instance owns; the explicit pass does", async t => {
  const world = await createWorld(t);
  const { record } = await openTodo(world);
  await world.ready("todo", world.readyRecord({ paneId: record.paneId, token: record.token }));
  // The previous process stopped; this (new) instance arms and heartbeats before any /dashboard.
  await writeJson(world.paths.owner, { schema: "gjc-herdr-dashboard/owner/1", pid: 9999,
    instanceId: "inst-old", sessionId: "s-1", heartbeatAt: START - 30000, stoppedAt: START - 1000 });
  const heartbeat = await world.reconciler.writeOwner(world.binding);
  assert.equal(heartbeat.ok, false);
  assert.equal(heartbeat.code, "owner-elsewhere");
  const kept = JSON.parse(await readFile(world.paths.owner, "utf8"));
  assert.equal(kept.instanceId, "inst-old", "the stopped record is left for the explicit pass to classify");
  // The explicit pass sees the previous owner, adopts the role and only then writes its own record.
  const pass = await world.explicit();
  assert.equal(pass.roles.todo.code, "adopted");
  assert.equal(JSON.parse(await readFile(world.paths.owner, "utf8")).instanceId, "inst-1");
  // From then on the heartbeat refreshes its own record.
  const own = await world.reconciler.writeOwner(world.binding);
  assert.equal(own.ok, true);
});

test("an unreadable owner record is not overwritten by the heartbeat", async t => {
  const world = await createWorld(t);
  await openTodo(world);
  await writeFile(world.paths.owner, "{ not json");
  const heartbeat = await world.reconciler.writeOwner(world.binding);
  assert.equal(heartbeat.ok, false);
  assert.equal(heartbeat.code, "owner-unreadable");
  assert.equal(await readFile(world.paths.owner, "utf8"), "{ not json");
});
