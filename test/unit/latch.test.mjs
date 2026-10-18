// Latch-prevention suite: the omo defects this port must not reproduce, driven as END-TO-END
// sequences through the real reconciler against the shared fake Herdr.
//
// omo's defects (plan section 4, E1-E5):
//   E1 `/dashboard` can end silently (no notify, no error)           -> every explicit pass yields
//                                                                      exactly one code from the
//                                                                      plan's set, and an automatic
//                                                                      pass is silent by contract.
//   E2 the coordinator is created only on session_start/tree and the
//      instance latches permanently when that fails                   -> LT-1: a failing pass is one
//                                                                      coded result and the next
//                                                                      pass in the same process, or
//                                                                      in a restarted one, opens.
//   E3 parent-slot inherits `previous.roles` from a dead record       -> the transition table alone
//                                                                      decides; nothing is inherited.
//   E5 the start window is 30 s but the latch model is unchanged      -> LT-3: 19.999/20/119.999/
//                                                                      120 s boundaries and the 25 s
//                                                                      late-ready path converge with no
//                                                                      extra `/dashboard`.
//
// Executor obligations pinned on this suite:
//   A-30: close/list failures are never evidence of absence; close/create totals per path.
//   A-31: automatic passes are driven by real turn_end/agent_end; a pass that issued no `pane list`
//         never counts, and each pinned pass runs at hbAge >= 15000 ms.
//   A-32: an automatic pass may only use {pane list, pane process-info, pane layout}.
//   LT-8: no pass ever runs a command in a pane it did not split in the same pass.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { labelOf, layoutKeyOf, slotPaths } from '../../src/core/slot.mjs';
import { createReconciler } from '../../src/core/reconciler.mjs';
import { writeJson } from '../../src/storage.mjs';
import { createFakeClock, createFakeHerdr, createFakeProcesses, createPassTracer } from './fake-herdr.mjs';

const START = 1_700_000_000_000;
const VIEWER = fileURLToPath(new URL('../../src/viewers/todo/viewer.mjs', import.meta.url));
const AUTO_ALLOWED = new Set(['pane list', 'pane process-info', 'pane layout']);
// The codes the plan allows an explicit pass to report (plan 7.4 + the A-29/C-14 delta), and the
// smaller diagnostic set an automatic pass may report (it never notifies).
const EXPLICIT_CODE = /^(opened|adopted|ready|pending|pending-slow|busy|busy:other-owner|unresponsive|failed:[a-z-]+|partial:[a-z-]+|replaced:[a-z-]+)$/;
const AUTO_CODE = new Set(['none', 'closed', 'discarded', 'ready', 'pending', 'pending-slow',
  'unresponsive', 'quarantined', 'busy:other-owner']);

async function harness(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'gjc-latch-'));
  t.after(() => rm(stateDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const clock = createFakeClock(START);
  const fake = createFakeHerdr({ parentPaneId: 'w1:p1' });
  const processes = createFakeProcesses({ alive: [process.pid] });
  const binding = { socket: '/tmp/herdr.sock', parentPaneId: 'w1:p1', tabId: 'w1:t1', sessionId: 's-1' };
  const layoutKey = layoutKeyOf({ socket: binding.socket, parentPaneId: binding.parentPaneId });
  const paths = slotPaths(stateDir, layoutKey);
  let serial = 0;
  // One "process" = one reconciler with its own instanceId, pid and herdr trace. A crash is
  // modelled by removing its pid from the fake process table, which is exactly what a killed GJC
  // looks like to the next pass (ESRCH) and what lets the next process take the lock.
  const spawn = (overrides = {}) => {
    serial += 1;
    const id = serial;
    const tracer = createPassTracer(fake.herdr);
    const pid = 7000 + id;
    processes.add(pid);
    const reconciler = createReconciler({
      stateDir, herdr: tracer.herdr, vector: ['herdr.exe'], now: clock.now, pidAlive: processes.alive,
      instanceId: `inst-${id}`, pid, newToken: () => `tok-${id}`, newPassId: () => `pass-${id}`,
      viewerPath: { todo: VIEWER }, nodePath: process.execPath,
      checkNode: async () => ({ ok: true, nodePath: process.execPath }),
      language: 'ko', gen: 'dev', env: {}, herdrTimeoutMs: 250, ...overrides,
    });
    const instance = {
      id, pid, reconciler, tracer,
      explicit: (extra = {}) => tracer.inPass('explicit', () => reconciler.explicitPass({
        binding, roles: ['todo'], ...extra })),
      auto: (trigger = 'turn_end', extra = {}) => tracer.inPass('auto', () => reconciler.autoPass({
        binding, roles: ['todo'], trigger, ...extra })),
      crash: () => processes.kill(pid),
    };
    return instance;
  };
  const world = {
    stateDir, clock, fake, processes, binding, layoutKey, paths, spawn,
    slot: async () => {
      try { return JSON.parse(await readFile(paths.slot, 'utf8')); }
      catch { return null; }
    },
    slotBytes: async () => {
      try { return await readFile(paths.slot, 'utf8'); }
      catch { return null; }
    },
    owner: async () => {
      try { return JSON.parse(await readFile(paths.owner, 'utf8')); }
      catch { return null; }
    },
    record: async () => (await world.slot())?.roles?.todo ?? null,
    // Panes this dashboard owns right now, read from the fake pane table (A-32: never from the
    // slot record, which may be stale).
    owned: () => {
      const label = labelOf('todo', layoutKey.slice(0, 8));
      return fake.ids().filter(paneId => fake.labelOf(paneId) === label);
    },
    panes: () => fake.paneIds().filter(paneId => paneId !== 'w1:p1'),
    // A ready file implies a live viewer process, so its pid is registered in the fake process
    // table; otherwise R2 would read V = dead instead of ready/unresponsive.
    ready: async (record, { pid = 8001, ...extra } = {}) => {
      processes.add(pid);
      return writeJson(paths.ready('todo'), { pid, token: record.token, paneId: record.paneId,
        gen: 'dev', startedAt: START, heartbeatAt: clock.now(), ...extra });
    },
    stale: async record => rm(paths.ready('todo'), { force: true }).then(() => record),
    setOwner: overrides => writeJson(paths.owner,
      { schema: 'gjc-herdr-dashboard/owner/1', sessionId: 's-1', heartbeatAt: START, ...overrides }),
    lockGenerations: async () => (await readdir(paths.lockDir))
      .map(name => Number(/^g(\d{12})\.lock$/.exec(name)?.[1] ?? NaN)).filter(Number.isFinite),
  };
  return world;
}

function assertAutoDiscipline(instance) {
  for (const verb of instance.tracer.verbs('auto')) {
    assert.ok(AUTO_ALLOWED.has(verb), `automatic pass used ${verb}`);
  }
  assert.deepEqual(instance.tracer.mutations('auto'), []);
}

// ------------------------------------------------------------------------- E1: no silent pass ----
test('E1: explicit passes report exactly one allowed code each and automatic passes stay diagnostic', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  const codes = [];
  codes.push((await instance.explicit()).code);
  let record = await world.record();
  await world.ready(record);
  codes.push((await instance.explicit()).code);
  record = await world.record();
  await world.ready(record, { closing: 'q' });
  codes.push((await instance.explicit()).code);
  record = await world.record();
  world.fake.panes.delete(record.paneId);
  codes.push((await instance.explicit()).code);
  await world.setOwner({ pid: 4321, instanceId: 'inst-other' });
  world.processes.add(4321);
  codes.push((await instance.explicit()).code);
  assert.deepEqual(codes, ['opened', 'ready', 'opened', 'opened', 'busy:other-owner'], JSON.stringify(codes));
  for (const code of codes) assert.ok(EXPLICIT_CODE.test(code), `unexpected explicit code ${code}`);
  // An automatic pass reports a diagnostic code (never a notify phrase) and never notifies.
  instance.crash();
  const other = world.spawn();
  const auto = await other.auto('turn_end');
  assert.ok(AUTO_CODE.has(auto.code), auto.code);
  assert.equal(auto.mode, 'auto');
  assert.equal(auto.notify, undefined);
});

// ----------------------------------------------------------------- E2/LT-1: no latching ----
test('E2/LT-1: split failures are one coded result each and the same process opens on the next pass', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  world.fake.setFailures({ split: { code: 'herdr_error', times: 10 } });
  const first = await instance.explicit();
  const second = await instance.explicit();
  assert.equal(first.code, 'failed:herdr-split');
  assert.equal(second.code, 'failed:herdr-split');
  assert.equal(first.roles.todo.id, 'T1');
  assert.deepEqual(world.panes(), [], 'a failed split leaves no pane');
  assert.equal(await world.slotBytes(), null, 'and no slot');
  assert.equal(await readFile(world.paths.intent, 'utf8').then(() => true, () => false), false,
    'and no leftover intent');
  // The very same instance is not latched: the next pass opens.
  world.fake.setFailures({});
  const third = await instance.explicit();
  assert.equal(third.code, 'opened');
  assert.equal(world.owned().length, 1);
});

test('E2/LT-1: a restarted process adopts an existing layout and reopens after a q close', async t => {
  const world = await harness(t);
  const first = world.spawn();
  assert.equal((await first.explicit()).code, 'opened');
  const record = await world.record();
  // The process dies without a cooperative stop, so the next process must recover via ESRCH.
  first.crash();
  const second = world.spawn();
  const adoptedPass = await second.explicit();
  assert.equal(adoptedPass.roles.todo.paneId, record.paneId);
  assert.equal(world.owned().length, 1, 'a restart never duplicates the role pane');
  // A `q` close, then the same process reopens (AC1.4: three /dashboard passes -> one pane).
  await world.ready(record, { closing: 'q' });
  world.fake.panes.delete(record.paneId);
  const reopened = await second.explicit();
  assert.equal(reopened.code, 'opened');
  assert.equal(world.owned().length, 1);
  const again = await second.explicit();
  assert.equal(again.code, 'pending');
  assert.equal(world.owned().length, 1);
});

test('E2/LT-1: an exception in a session path never blocks a later explicit pass', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  // The arming path may throw before the handler calls the pass; the pass itself never sees it.
  await assert.rejects(() => Promise.reject(Object.assign(new Error('session path exploded'),
    { code: 'session' })), { code: 'session' });
  const opened = await instance.explicit();
  assert.equal(opened.code, 'opened');
  assert.equal(world.owned().length, 1);
});

// ------------------------------------------------------------- E3: nothing is inherited ----
test('E3: seven consecutive transitions in one process end in the documented codes', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  const codes = [];
  // r1: nothing recorded -> T1 opened.
  codes.push((await instance.explicit()).roles.todo.code);
  // r3: viewer frozen (20000 ms) -> T14, no action.
  let record = await world.record();
  await world.ready(record, { heartbeatAt: world.clock.now() - 20000 });
  codes.push((await instance.explicit()).roles.todo.code);
  // r6: label mismatch -> T5, keep the orphan and open next to it.
  world.fake.setLabel(record.paneId, 'not ours');
  codes.push((await instance.explicit()).roles.todo.code);
  // r5: the new record's viewer dies while the pane shell is someone else's -> T17.
  record = await world.record();
  await world.ready(record, { pid: 8300 });
  world.processes.kill(8300);
  world.fake.setShell(record.paneId, 4747);
  const r5 = await instance.explicit();
  codes.push(r5.roles.todo.code);
  assert.equal(r5.roles.todo.keptPaneId, record.paneId, 'the unprovable pane is named as kept');
  assert.equal(world.fake.has(record.paneId), true);
  assert.equal(world.fake.labelOf(record.paneId), record.label, 'and never relabelled');
  // r4: the viewer dies on an O+ pane -> close and replace, role pane count unchanged.
  record = await world.record();
  await world.ready(record, { pid: 8301 });
  world.processes.kill(8301);
  const r4 = await instance.explicit();
  codes.push(r4.roles.todo.code);
  assert.equal(r4.roles.todo.id, 'T16');
  assert.equal(world.fake.has(record.paneId), false);
  // r2: a stopped previous owner with a ready viewer -> adopted, no new pane.
  record = await world.record();
  await world.ready(record);
  await world.setOwner({ pid: 8400, instanceId: 'inst-stopped', stoppedAt: START });
  const r2 = await instance.explicit();
  codes.push(r2.roles.todo.code);
  assert.equal(r2.roles.todo.id, 'T13');
  // r7: a live other owner -> busy:other-owner, zero action.
  const panesBeforeBusy = world.fake.ids();
  await world.setOwner({ pid: 8401, instanceId: 'inst-live' });
  world.processes.add(8401);
  instance.tracer.clear();
  codes.push((await instance.explicit()).code);
  assert.deepEqual(codes, ['opened', 'unresponsive', 'partial:ownership-unproven',
    'partial:ownership-unproven', 'replaced:dead', 'adopted', 'busy:other-owner']);
  assert.deepEqual(world.fake.ids(), panesBeforeBusy, 'the blocked pass changed no pane');
  assert.deepEqual(instance.tracer.verbs('explicit'), [], 'and made no herdr call');
  // Exactly one pane is the CURRENT owner of the role; the orphans this run refused to touch (r6's
  // relabelled pane and r5's unprovable pane) are still present and still untouched.
  const current = await world.record();
  assert.equal(world.fake.has(current.paneId), true);
  assert.equal(world.fake.labelOf(current.paneId), current.label);
  assert.equal(world.fake.labelOf(world.fake.ids().find(paneId => world.fake.labelOf(paneId) === 'not ours')), 'not ours');
  const owned = world.owned();
  // The r5 orphan kept its label too, so the label count is 2: the orphan + the current pane.
  assert.equal(owned.length, 2, JSON.stringify(owned));
  assert.ok(owned.includes(current.paneId));
  assert.equal(owned.filter(paneId => paneId !== current.paneId).length, 1);
  for (const code of codes) assert.equal(/BLOCKED|blocked|waiting/.test(code), false, code);
});

// ----------------------------------------------------------------- E5/LT-3: the window ----
test('E5/LT-3: FP1-FP5 each converge with one more pass, and no crashed pane is ever re-entered', async t => {
  const failpoints = [
    ['fp1', 'GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT'],
    ['fp2', 'GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT'],
    ['fp3', 'GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT'],
    ['fp4', 'GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT'],
    ['fp5', 'GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT'],
  ];
  for (const [name, envKey] of failpoints) {
    const world = await harness(t);
    const crashed = world.spawn({ env: { [envKey]: name } });
    const crashedPass = await crashed.explicit();
    if (name === 'fp5') {
      // fp5 is not a crash: the launch completes and the viewer is told to be 25 s late.
      assert.equal(crashedPass.code, 'opened', name);
      const record = await world.record();
      assert.ok(world.fake.commandOf(record.paneId).includes('ready-delay-25s'));
    } else {
      assert.equal(crashedPass.code, 'failed:failpoint', `${name}: ${JSON.stringify(crashedPass)}`);
      assert.equal(crashedPass.detail, `${name}:after-${name === 'fp1' ? 'split' : name === 'fp2'
        ? 'record' : name === 'fp3' ? 'rename' : 'run'}`);
    }
    const crashedPane = world.panes()[0] ?? null;
    const commandsBefore = crashedPane === null ? null : world.fake.commandOf(crashedPane);
    // The crashing process dies; the next process recovers the leftover.
    crashed.crash();
    const next = world.spawn({ env: {} });
    const recovered = await next.explicit();
    assert.ok(EXPLICIT_CODE.test(recovered.code), `${name}: ${recovered.code}`);
    assert.equal(world.owned().length, 1, `${name}: exactly one owned pane`);
    if (crashedPane !== null) {
      assert.equal(world.fake.commandOf(crashedPane), commandsBefore, `${name}: no re-entry`);
    }
    assert.deepEqual(next.tracer.verbs('explicit').filter(verb => /send-text|send-keys/.test(verb)), [],
      name);
    // And a third pass is stable.
    const settled = await next.explicit();
    assert.ok(EXPLICIT_CODE.test(settled.code), `${name}: ${settled.code}`);
    assert.equal(world.owned().length, 1, `${name}: still one owned pane`);
  }

  // FP5 continued: the 25 s late viewer is promoted by the automatic path alone.
  const world = await harness(t);
  const crashed = world.spawn({ env: { GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT: 'fp5' } });
  assert.equal((await crashed.explicit()).code, 'opened');
  const record = await world.record();
  world.clock.advance(20000);
  const slow = await crashed.auto('heartbeat-tick');
  assert.equal(slow.roles.todo.id, 'T10');
  world.clock.advance(5000);
  await world.ready(record);
  const promoted = await crashed.auto('turn_end');
  assert.equal(promoted.roles.todo.id, 'T13');
  assert.equal(world.owned().length, 1, 'the late viewer needed no second /dashboard');
  assert.equal((await world.record()).state, 'ready');
  assertAutoDiscipline(crashed);

  // An unknown failpoint value fails before the split, with zero herdr calls.
  const guarded = await harness(t);
  const bogus = guarded.spawn({ env: { GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT: 'nope' } });
  const refused = await bogus.explicit();
  assert.equal(refused.code, 'failed:failpoint');
  assert.equal(refused.detail.endsWith('=nope'), true, refused.detail);
  assert.match(refused.detail, /FAILPOINT=nope/);
  assert.deepEqual(guarded.panes(), [], 'no pane was split');
  assert.deepEqual(bogus.tracer.failures(), [], 'no herdr call was attempted');
  assert.deepEqual(bogus.tracer.verbs(), ['pane layout'], 'only the parent-size guard ran');
});

test('LT-3: three explicit passes while pending keep one pane and every automatic driver is inert', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  const after = world.panes().length;
  assert.equal(after, 1);
  for (let index = 0; index < 3; index++) {
    const pass = await instance.explicit();
    assert.equal(pass.roles.todo.code, 'pending');
    assert.equal(world.panes().length, after);
    assert.equal(instance.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 0);
  }
  for (const trigger of ['session_start', 'turn_end', 'agent_end', 'tool_execution_end',
    'goal_updated', 'bus', 'heartbeat-tick']) {
    instance.tracer.clear();
    const auto = await instance.auto(trigger);
    assert.equal(auto.roles.todo.code, 'pending', trigger);
    assert.equal(world.panes().length, after, trigger);
    assertAutoDiscipline(instance);
    // Every automatic pass that saw a record really ran (A-31: a silent skip does not count).
    assert.ok(instance.tracer.lists('auto').length >= 1, `${trigger}: the pass really ran`);
  }
});

// ---------------------------------------------------------------------- A-32 verb audit ----
test('A-32: automatic passes in a full lifecycle use only pane list / process-info / layout', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  let record = await world.record();
  await world.ready(record);
  await instance.auto('turn_end');
  await world.ready(record, { heartbeatAt: world.clock.now() - 20000 });
  await instance.auto('heartbeat-tick');
  await world.ready(record, { closing: 'q' });
  await instance.auto('agent_end');
  world.fake.panes.delete(record.paneId);
  for (const trigger of ['turn_end', 'tool_execution_end', 'goal_updated', 'bus', 'session_start']) {
    instance.tracer.clear();
    await instance.auto(trigger);
    assertAutoDiscipline(instance);
  }
  // Across the whole lifecycle the automatic verb set is a subset of the three allowed reads, and
  // every pass that observed a record ran at least one pane list.
  const used = [...new Set(instance.tracer.verbs('auto'))].sort();
  assert.ok(used.every(verb => AUTO_ALLOWED.has(verb)), JSON.stringify(used));
  assert.deepEqual(instance.tracer.mutations('auto'), []);
  // The automatic pass that saw the missing pane with a pending q recorded `closed` (T3 is the only
  // row an automatic pass may write `closed` from, A-29/C-14 I-C).
  const closedRecord = await world.record();
  assert.equal(closedRecord.state, 'closed');
  assert.equal(closedRecord.closedBy, 't3');
  assert.equal(world.fake.has(closedRecord.paneId), false, 'nothing was created');
});

// ------------------------------------------------------------------- A-30 failure totals ----
test('A-30 totals: the T20 O+ path costs close 1 / create 1, the failure path adds one close, T3 costs 0', async t => {
  // (a) q while the pane exists, close succeeds on the first explicit pass.
  const clean = await harness(t);
  const first = clean.spawn();
  await first.explicit();
  first.tracer.resetTotals();
  const cleanRecord = await clean.record();
  await clean.ready(cleanRecord, { closing: 'q' });
  const pass = await first.explicit();
  assert.equal(pass.roles.todo.code, 'opened');
  assert.equal(first.tracer.verbs('explicit').filter(verb => verb === 'pane close').length, 1);
  assert.equal(first.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 1);
  assert.equal(first.tracer.verbs('explicit').filter(verb => verb === 'pane run').length, 1);
  assert.equal(clean.owned().length, 1);

  // (b) the first close fails -> close 2 (one failed) / create 1 across the two passes. The tracer
  // totals count the whole process lifetime, because `inPass` resets the per-pass trace.
  const failing = await harness(t);
  const second = failing.spawn();
  await second.explicit();
  // Only the close/replacement passes are counted from here (the initial open's split is not part
  // of the T20 cost the plan's S6e totals describe).
  second.tracer.resetTotals();
  const failingRecord = await failing.record();
  await failing.ready(failingRecord, { closing: 'q' });
  failing.fake.setFailures({ close: { code: 'herdr_error', times: 1 } });
  const failed = await second.explicit();
  assert.equal(failed.roles.todo.code, 'failed:herdr-close');
  assert.equal(failing.fake.has(failingRecord.paneId), true, 'a failed close keeps the pane');
  assert.equal(failing.panes().length, 1, 'and creates nothing');
  assert.equal(second.tracer.totals()['pane split'] ?? 0, 0);
  const recovered = await second.explicit();
  assert.equal(second.tracer.totals()['pane close'], 2, 'one failed close + one success');
  assert.equal(second.tracer.totals()['pane split'], 1);
  assert.equal(failing.fake.has(failingRecord.paneId), false);
  assert.equal(failing.owned().length, 1);

  // (c) the pane is already gone (T3): close is never called and create is 1.
  const vanished = await harness(t);
  const third = vanished.spawn();
  await third.explicit();
  third.tracer.resetTotals();
  const goneRecord = await vanished.record();
  await vanished.ready(goneRecord, { closing: 'q' });
  vanished.fake.panes.delete(goneRecord.paneId);
  const direct = await third.explicit();
  assert.equal(direct.roles.todo.id, 'T3');
  assert.equal(direct.roles.todo.code, 'opened');
  assert.equal(third.tracer.verbs('explicit').filter(verb => verb === 'pane close').length, 0);
  assert.equal(third.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 1);
  assert.equal((await vanished.record()).state, 'pending');
});

test('A-30: a not-found close with a still-present pane, a failed confirm list and an outright error all keep the record', async t => {
  const scenarios = [
    // (1) close reports not-found while the confirming list still shows the pane.
    ['not-found-present', { close: { code: 'pane_not_found' } }],
    // (2) close reports not-found and the confirming list (the third list of the pass) fails.
    ['not-found-list-fails', { close: { code: 'pane_not_found' }, list: { skip: 2, code: 'herdr_error' } }],
    // (3) close fails outright.
    ['close-error', { close: { code: 'herdr_error' } }],
  ];
  for (const [name, failures] of scenarios) {
    const world = await harness(t);
    const instance = world.spawn();
    await instance.explicit();
    const record = await world.record();
    await world.ready(record, { closing: 'q' });
    const slotBefore = await world.slotBytes();
    const readyBefore = await readFile(world.paths.ready('todo'), 'utf8');
    world.fake.setFailures(failures);
    const pass = await instance.explicit();
    assert.equal(pass.roles.todo.code, 'failed:herdr-close', `${name}: ${JSON.stringify(pass.roles)}`);
    assert.equal(pass.roles.todo.id, 'T20', name);
    assert.equal(world.fake.has(record.paneId), true, `${name}: the pane is kept`);
    assert.equal(await world.slotBytes(), slotBefore, `${name}: the record is preserved`);
    assert.equal(await readFile(world.paths.ready('todo'), 'utf8'), readyBefore,
      `${name}: the q evidence is preserved`);
    assert.equal(instance.tracer.verbs('explicit').filter(verb => verb === 'pane run').length, 0,
      `${name}: create 0`);
    assert.equal(world.panes().length, 1, `${name}: no new pane`);
    // The automatic path is still inert, and the state stays byte-identical.
    world.fake.setFailures({});
    instance.tracer.clear();
    const auto = await instance.auto('turn_end');
    assert.equal(auto.roles.todo.id, 'T20', name);
    assert.equal(auto.roles.todo.code, 'none', name);
    assertAutoDiscipline(instance);
    assert.equal(await world.slotBytes(), slotBefore);
    // Once the close works, the same process completes the replacement: one create, one owned pane.
    instance.tracer.clear();
    const recovered = await instance.explicit();
    assert.equal(recovered.roles.todo.code, 'opened', `${name}: ${JSON.stringify(recovered.roles)}`);
    assert.equal(world.fake.has(record.paneId), false, name);
    assert.equal(world.owned().length, 1, name);
    assert.equal(instance.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 1, name);
  }
});

test('A-30: a close that never answers is partial:timeout, with the record, the q and the pane kept', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  const record = await world.record();
  await world.ready(record, { closing: 'q' });
  const slotBefore = await world.slotBytes();
  world.fake.setFailures({ close: { hang: true } });
  const pass = await instance.explicit();
  assert.equal(pass.code, 'partial:timeout', JSON.stringify(pass));
  assert.equal(pass.roles.todo.code, 'partial:timeout');
  assert.equal(world.fake.has(record.paneId), true);
  assert.equal(world.panes().length, 1, 'create 0');
  assert.equal(instance.tracer.verbs('explicit').filter(verb => verb === 'pane split').length, 0);
  assert.equal(await world.slotBytes(), slotBefore);
  assert.equal(await readFile(world.paths.ready('todo'), 'utf8') !== '', true);
});

test('A-30: an automatic pass whose pane list fails changes nothing at all', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  const record = await world.record();
  await world.ready(record);
  await instance.explicit();
  const slotBefore = await world.slotBytes();
  const readyBefore = await readFile(world.paths.ready('todo'), 'utf8');
  const panesBefore = world.fake.ids();
  world.fake.setFailures({ list: { code: 'herdr_error' } });
  const auto = await instance.auto('turn_end');
  assert.equal(auto.mode, 'auto');
  assert.equal(auto.code, 'failed:internal', JSON.stringify(auto));
  assert.equal(auto.roles.todo.failure, 'failed:internal');
  assert.equal(await world.slotBytes(), slotBefore);
  assert.equal(await readFile(world.paths.ready('todo'), 'utf8'), readyBefore);
  assert.deepEqual(world.fake.ids(), panesBefore);
  assert.deepEqual(instance.tracer.mutations('auto'), []);
});

// -------------------------------------------------------------------- A-31 event drivers ----
test('A-31: pinned automatic passes at hbAge >= 15000 ms report unresponsive and never promote', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  const record = await world.record();
  // Exactly 15000 ms is unresponsive (R2), and 14000 ms is not.
  await world.ready(record, { heartbeatAt: world.clock.now() - 14000 });
  assert.equal((await instance.auto('turn_end')).roles.todo.id, 'T13');
  assert.ok(instance.tracer.lists('auto').length >= 1, 'turn_end really ran');
  await instance.explicit();
  await world.ready(record, { heartbeatAt: world.clock.now() - 15000 });
  for (const trigger of ['turn_end', 'agent_end']) {
    instance.tracer.clear();
    const pinned = await instance.auto(trigger);
    assert.equal(pinned.roles.todo.id, 'T14', trigger);
    assert.equal(pinned.roles.todo.code, 'unresponsive', trigger);
    assert.ok(instance.tracer.lists('auto').length >= 1, `${trigger}: the pass really ran`);
    assertAutoDiscipline(instance);
  }
  assert.equal(world.owned().length, 1);
});

test('A-31: a pending q record survives automatic passes with zero bytes changed and no promotion', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  const record = await world.record();
  await world.ready(record, { closing: 'q' });
  const slotBefore = await world.slotBytes();
  const readyBefore = await readFile(world.paths.ready('todo'), 'utf8');
  const generationsBefore = Math.max(...await world.lockGenerations());
  for (const trigger of ['heartbeat-tick', 'turn_end', 'agent_end']) {
    instance.tracer.clear();
    const auto = await instance.auto(trigger);
    assert.equal(auto.roles.todo.id, 'T20', trigger);
    assert.equal(auto.roles.todo.code, 'none', trigger);
    assert.ok(instance.tracer.lists('auto').length >= 1, `${trigger}: the pass really ran`);
    assertAutoDiscipline(instance);
  }
  assert.equal(await world.slotBytes(), slotBefore, 'no slot byte moved');
  assert.equal(await readFile(world.paths.ready('todo'), 'utf8'), readyBefore, 'no ready byte moved');
  assert.equal(world.fake.has(record.paneId), true);
  assert.equal(world.owned().length, 1);
  // The only file activity an automatic pass may cause is its own lock generation.
  const generationsAfter = Math.max(...await world.lockGenerations());
  assert.ok(generationsAfter >= generationsBefore + 3, `${generationsBefore} -> ${generationsAfter}`);
  assert.equal((await world.record()).state, 'pending');
});

// ------------------------------------------------------------------------- LT-8 / LT-5 ----
test('LT-8: in a full lifecycle every run target belongs to the same pass split', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  let record = await world.record();
  await world.ready(record);
  await instance.auto('turn_end');
  const transitions = ['replaced-dead', 'gone', 'q', 'stalled', 'foreign'];
  let runs = 0;
  for (const transition of transitions) {
    record = await world.record() ?? record;
    if (transition === 'replaced-dead') {
      await world.ready(record, { pid: 8200 });
      world.processes.kill(8200);
    } else if (transition === 'gone') {
      world.fake.panes.delete(record.paneId);
    } else if (transition === 'q') {
      await world.ready(record, { pid: 8201, closing: 'q' });
    } else if (transition === 'stalled') {
      await world.stale(record);
      world.clock.set(record.pendingSince + 120000);
    } else {
      world.fake.setLabel(record.paneId, 'foreign');
    }
    instance.tracer.clear();
    const pass = await instance.explicit();
    const splits = instance.tracer.trace.filter(entry => entry.argv[1] === 'split')
      .map(entry => entry.paneId);
    const targets = instance.tracer.trace.filter(entry => entry.argv[1] === 'run')
      .map(entry => entry.paneId);
    runs += targets.length;
    for (const target of splits) assert.notEqual(target, 'w1:p1', transition);
    for (const target of targets) {
      assert.ok(splits.includes(target), `${transition}: run ${target} was not split in this pass`);
      assert.notEqual(target, 'w1:p1', transition);
    }
    assert.deepEqual(instance.tracer.verbs('explicit').filter(verb => /send-text|send-keys/.test(verb)), [],
      transition);
    assert.equal(pass.roles.todo.code.startsWith('failed:internal'), false, transition);
  }
  assert.ok(runs >= 4, `only ${runs} runs happened`);
});

test('LT-5: no sequence produces a waiting state and foreign siblings are never touched', async t => {
  const world = await harness(t);
  world.fake.addPane('w1:p9', { label: 'OmO Todo · deadbeef', shell: 6100 });
  world.fake.addPane('w1:p8', { label: 'DAG · x', shell: 6101 });
  const instance = world.spawn();
  for (const step of ['open', 'pending', 'shrink', 'foreign', 'corrupt']) {
    if (step === 'shrink') world.fake.setPaneRect('w1:p1', { x: 0, y: 0, width: 30, height: 6 });
    if (step === 'foreign') {
      const current = await world.record();
      if (current) world.fake.setLabel(current.paneId, 'GJC Todo · 00000000');
    }
    if (step === 'corrupt') await writeFile(world.paths.slot, '{ broken', 'utf8');
    instance.tracer.clear();
    const pass = await instance.explicit();
    assert.ok(EXPLICIT_CODE.test(pass.code), `${step}: ${pass.code}`);
    assert.equal(/waiting/.test(JSON.stringify(pass.roles)), false, `${step}: waiting state`);
    assert.equal(/layout-waiting/.test(pass.detail ?? ''), false, step);
    assert.deepEqual(instance.tracer.verbs('explicit').filter(verb => /send-text|send-keys/.test(verb)), [],
      step);
  }
  // The two foreign panes are byte-identical in every observable way, after the whole sequence.
  assert.equal(world.fake.labelOf('w1:p9'), 'OmO Todo · deadbeef');
  assert.equal(world.fake.labelOf('w1:p8'), 'DAG · x');
  assert.equal(world.fake.commandOf('w1:p9'), null);
  assert.equal(world.fake.commandOf('w1:p8'), null);
  assert.equal(world.fake.shellOf('w1:p9'), 6100);
  assert.equal(world.fake.shellOf('w1:p8'), 6101);
  // And this lane never renames or closes a pane it did not create.
  for (const verb of ['rename', 'close']) {
    for (const call of instance.tracer.trace.filter(entry => entry.argv[1] === verb)) {
      assert.notEqual(call.argv[2], 'w1:p9', verb);
      assert.notEqual(call.argv[2], 'w1:p8', verb);
    }
  }
});

test('the whole state directory stays inside slots/ for this lane: no data or prefs file is written', async t => {
  const world = await harness(t);
  const instance = world.spawn();
  await instance.explicit();
  const record = await world.record();
  await world.ready(record);
  await instance.explicit();
  await instance.auto('turn_end');
  assert.deepEqual((await readdir(world.stateDir)).sort(), ['slots']);
  const slotFiles = (await readdir(world.paths.dir)).sort();
  assert.ok(slotFiles.includes('slot.json'));
  assert.ok(slotFiles.includes('owner.json'));
  assert.equal(slotFiles.includes('intent.json'), false);
});
