// Unit tests for src/core/transitions.mjs — the plan 8 table as amended by stage-05 R2 and the
// A-29/C-14 delta. One row per table row including every documented boundary, plus a totality
// test over the whole input domain and an automatic-pass invariant test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGE_SLOW_MS, AGE_STALLED_MS, viewerState } from '../../src/core/liveness.mjs';
import { PANE_MUTATION_ACTIONS, TABLE_IDS, INPUT_DOMAIN, decideOwnerPhase, decideRole,
  decideRoleFromInput, enumerateInputs } from '../../src/core/transitions.mjs';

const RECORD = { state: 'pending', token: 'tok', paneId: 'w1:p5', tabId: 'w1:t1',
  shellPid: 4242, pendingSince: 0 };

const caseOf = (overrides = {}) => {
  const { record, observation, ...rest } = overrides;
  return {
    record: record === undefined ? { ...RECORD } : record,
    observation: { pane: 'absent', O: false, Oplus: false, V: 'none', age: 0, ...observation },
    mode: 'explicit',
    ownerPhase: 'me',
    ...rest,
  };
};

const idsOf = entries => entries.map(entry => entry.id);

// A compact row table: each entry is [label, case, expected id, expected notify].
const ROWS = [
  ['T1 no record', caseOf({ record: null }), 'T1', 'opened'],
  ['T1 auto never creates', caseOf({ record: null, mode: 'auto' }), 'T1', null],
  ['T2 closed record', caseOf({ record: { ...RECORD, state: 'closed' } }), 'T2', 'opened'],
  ['T2 auto leaves it alone', caseOf({ record: { ...RECORD, state: 'closed' }, mode: 'auto' }), 'T2', null],
  ['T3 pane gone with q', caseOf({ observation: { pane: 'absent', V: 'closing-q' } }), 'T3', 'opened'],
  ['T3 auto writes the only automatic closed', caseOf({ observation: { pane: 'absent', V: 'closing-q' }, mode: 'auto' }), 'T3', null],
  ['T4 pane gone, no q', caseOf({ observation: { pane: 'absent', V: 'ready' } }), 'T4', 'opened'],
  ['T4 auto discards the record', caseOf({ observation: { pane: 'absent', V: 'ready' }, mode: 'auto' }), 'T4', null],
  ['T5 pane alive but not ours', caseOf({ observation: { pane: 'present', O: false, V: 'ready' } }), 'T5', 'partial:ownership-unproven'],
  ['T5 auto discards the record', caseOf({ observation: { pane: 'present', O: false }, mode: 'auto' }), 'T5', null],
  ['T6 ready record, ready viewer', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'ready' } }), 'T6', 'ready'],
  ['T6 adopted when this pass did not create it', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'ready' }, ownerPhase: 'prev-dead' }), 'T6', 'adopted'],
  ['T6 auto only refreshes data', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'ready' }, mode: 'auto' }), 'T6', null],
  ['T9 pending, no viewer, fresh', caseOf({ observation: { pane: 'present', O: true, V: 'none', age: AGE_SLOW_MS - 1 } }), 'T9', 'pending'],
  ['T9 boundary 0s', caseOf({ observation: { pane: 'present', O: true, V: 'none', age: 0 } }), 'T9', 'pending'],
  ['T10 boundary exactly 20s', caseOf({ observation: { pane: 'present', O: true, V: 'none', age: AGE_SLOW_MS } }), 'T10', 'pending-slow'],
  ['T10 boundary 119.999s', caseOf({ observation: { pane: 'present', O: true, V: 'none', age: AGE_STALLED_MS - 1 } }), 'T10', 'pending-slow'],
  ['T11 boundary exactly 120s, O+', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'none', age: AGE_STALLED_MS } }), 'T11', 'replaced:stalled'],
  ['T11 auto does not close', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'none', age: AGE_STALLED_MS }, mode: 'auto' }), 'T11', null],
  ['T12 120s but ownership unproven', caseOf({ observation: { pane: 'present', O: true, Oplus: false, V: 'none', age: AGE_STALLED_MS } }), 'T12', 'partial:ownership-unproven'],
  ['T12 auto keeps the orphan', caseOf({ observation: { pane: 'present', O: true, Oplus: false, V: 'none', age: AGE_STALLED_MS }, mode: 'auto' }), 'T12', null],
  ['T13 late viewer promotes a pending record', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'ready' } }), 'T13', 'ready'],
  ['T13 promotes however old the pending record is', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'ready', age: 999999 } }), 'T13', 'ready'],
  ['T13 auto promotes too', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'ready' }, mode: 'auto' }), 'T13', null],
  ['T14 frozen viewer: no action', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'unresponsive' } }), 'T14', 'unresponsive'],
  ['T14 also for a pending record', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'unresponsive' } }), 'T14', 'unresponsive'],
  ['T16 dead viewer with O+', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'dead' } }), 'T16', 'replaced:dead'],
  ['T16 auto does not close', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'dead' }, mode: 'auto' }), 'T16', null],
  ['T17 dead viewer without O+', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: false, V: 'dead' } }), 'T17', 'partial:ownership-unproven'],
  ['T17 auto keeps the orphan', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: false, V: 'dead' }, mode: 'auto' }), 'T17', null],
  ['T18 corrupt slot quarantines then continues', caseOf({ slotStatus: 'corrupt' }), 'T18', 'opened'],
  ['T18 auto quarantines only', caseOf({ slotStatus: 'corrupt', mode: 'auto' }), 'T18', null],
  ['T19 leftover intent continues', caseOf({ intent: true }), 'T19', 'partial:interrupted-launch'],
  ['T19 auto does nothing', caseOf({ intent: true, mode: 'auto' }), 'T19', null],
  ['T20 auto takes zero action', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q' }, mode: 'auto' }), 'T20', null],
  ['T20 auto is still zero action with a pending record', caseOf({ record: { ...RECORD, state: 'pending' }, observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q' }, mode: 'auto' }), 'T20', null],
  ['T20 auto is zero action even without O+', caseOf({ observation: { pane: 'present', O: true, Oplus: false, V: 'closing-q' }, mode: 'auto' }), 'T20', null],
  ['T20 explicit O+ closes and recreates', caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q' } }), 'T20', 'opened'],
  ['T20 explicit not-O+ keeps the orphan', caseOf({ observation: { pane: 'present', O: true, Oplus: false, V: 'closing-q' } }), 'T20', 'partial:ownership-unproven'],
  ['T20 explicit not-O at all keeps the orphan', caseOf({ observation: { pane: 'present', O: false, V: 'closing-q' } }), 'T20', 'partial:ownership-unproven'],
  ['T21 ready record, viewer gone, O+ known', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'none' } }), 'T21', 'unresponsive'],
  ['T21 auto also does nothing', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'none' }, mode: 'auto' }), 'T21', null],
  ['T22 ready record, viewer gone, O not proven', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: false, V: 'none' } }), 'T22', 'partial:ownership-unproven'],
  ['T22 auto keeps the orphan', caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: false, V: 'none' }, mode: 'auto' }), 'T22', null],
  ['T0 another live owner short-circuits everything', caseOf({ ownerPhase: 'prev-live', record: null }), 'T0', 'busy:other-owner'],
  ['T0 also in an automatic pass', caseOf({ ownerPhase: 'prev-live', record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q' }, mode: 'auto' }), 'T0', null],
];

for (const [label, input, id, notify] of ROWS) {
  test(`row ${id}: ${label}`, () => {
    const decision = decideRole(input);
    assert.equal(decision.id, id);
    assert.equal(decision.notify, notify);
    assert.ok(TABLE_IDS.includes(decision.id));
  });
}

test('T14 is never an action row, and every explicit replace row uses the documented actions', () => {
  const byId = new Map();
  for (const [label, input, id] of ROWS) if (!byId.has(id)) byId.set(id, { decision: decideRole(input), label });
  const actionsOf = id => byId.get(id).decision.actions.map(action => action.type);
  // T14 is the "no action" row; it must not carry any pane mutation.
  for (const id of ['T14', 'T21', 'T9', 'T10']) assert.deepEqual(actionsOf(id), [], id);
  // The three replacing rows are asserted from their canonical explicit O+ cases rather than from
  // whichever variant happens to be listed first, since the not-O+ variants are different rows.
  const replaceCases = {
    T11: caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'none', age: AGE_STALLED_MS } }),
    T16: caseOf({ record: { ...RECORD, state: 'ready' }, observation: { pane: 'present', O: true, Oplus: true, V: 'dead' } }),
    T20: caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q' } }),
  };
  for (const [id, input] of Object.entries(replaceCases)) {
    const decision = decideRole(input);
    assert.equal(decision.id, id);
    const actions = decision.actions.map(action => action.type);
    assert.equal(actions[0], 'reconfirm-o-plus', id);
    assert.equal(actions[1], 'close-pane', id);
    assert.equal(actions.filter(type => type === 'close-pane').length, 1, id);
    assert.deepEqual(actions.slice(-2), ['discard-record', 'create'], id);
  }
  // Only T20 additionally records `closed`: A-29/C-14 lists T3 and T20 as the closed writers, and
  // T11/T16 never see a q for a pane they are about to kill.
  const t20 = decideRole(replaceCases.T20);
  assert.deepEqual(t20.actions.map(a => a.type),
    ['reconfirm-o-plus', 'close-pane', 'write-closed', 'discard-record', 'create']);
  assert.equal(t20.actions[2].closedBy, 't20');
  for (const id of ['T11', 'T16']) {
    assert.equal(decideRole(replaceCases[id]).actions.some(a => a.type === 'write-closed'), false, id);
  }
  // T3 writes closed without closing anything, and T4 only discards before creating.
  assert.deepEqual(actionsOf('T3'), ['write-closed', 'create']);
  assert.equal(byId.get('T3').decision.actions[0].closedBy, 't3');
  assert.deepEqual(actionsOf('T4'), ['discard-record', 'create']);
  // The automatic T3 keeps the closed write and drops the create.
  assert.deepEqual(decideRole(caseOf({ observation: { pane: 'absent', V: 'closing-q' }, mode: 'auto' })).actions
    .map(a => a.type), ['write-closed']);
  assert.equal(PANE_MUTATION_ACTIONS.has('close-pane'), true);
  assert.equal(PANE_MUTATION_ACTIONS.has('write-closed'), false);
});

test('closed is written only by T3, explicit T20 and explicit T20 not-O+ (A-29/C-14 invariant)', () => {
  const writers = new Map();
  for (const input of enumerateInputs()) {
    const decision = decideRoleFromInput(input);
    if (decision.actions.some(action => action.type === 'write-closed')) {
      if (!writers.has(decision.id)) writers.set(decision.id, { auto: false, explicit: false });
      writers.get(decision.id)[input.mode === 'auto' ? 'auto' : 'explicit'] = true;
    }
  }
  assert.deepEqual([...writers.entries()].map(([id, modes]) =>
    `${id}:${['auto', 'explicit'].filter(mode => modes[mode]).join('+')}`).sort(),
  ['T20:explicit', 'T3:auto+explicit'].sort());
  // And an automatic pass never writes closed outside T3.
  const autoClosers = new Set();
  for (const input of enumerateInputs()) {
    if (input.mode !== 'auto') continue;
    if (decideRoleFromInput(input).actions.some(action => action.type === 'write-closed')) autoClosers.add(decideRoleFromInput(input).id);
  }
  assert.deepEqual([...autoClosers], ['T3']);
});

test('every combination of the input domain yields exactly one defined id and no mutation in auto mode', () => {
  const inputs = enumerateInputs();
  // 2*2*4*2*2*2*5*5*2*4 = 25600 combinations.
  assert.equal(inputs.length, 25600);
  const seen = new Set();
  const autoMutations = [];
  const notifies = [];
  for (const input of inputs) {
    const decision = decideRoleFromInput(input);
    assert.equal(typeof decision.id, 'string', JSON.stringify(input));
    assert.ok(TABLE_IDS.includes(decision.id), `${decision.id} for ${JSON.stringify(input)}`);
    assert.ok(Array.isArray(decision.actions));
    for (const action of decision.actions) {
      assert.ok(typeof action.type === 'string' && action.type.length > 0);
      if (PANE_MUTATION_ACTIONS.has(action.type) && action.type !== 'create') {
        // Only the documented replacing rows may name a pane mutation, and only explicitly.
        assert.equal(input.mode, 'explicit', `${action.type} in auto for ${JSON.stringify(input)}`);
      }
      if (PANE_MUTATION_ACTIONS.has(action.type)) assert.equal(input.mode, 'explicit', JSON.stringify(input));
    }
    if (input.mode === 'auto') {
      if (decision.notify !== null) notifies.push(input);
      for (const action of decision.actions) {
        if (PANE_MUTATION_ACTIONS.has(action.type) && action.type !== 'create') autoMutations.push({ input, action });
      }
    }
    seen.add(decision.id);
  }
  assert.deepEqual(autoMutations, []);
  // An automatic pass never mutates a pane. It also never notifies.
  assert.deepEqual(notifies, []);
  // Every table row is reachable from the enumerated domain, and nothing outside the table is.
  for (const id of seen) assert.ok(TABLE_IDS.includes(id));
  assert.deepEqual([...seen].sort(), [...TABLE_IDS].sort());
});

test('an automatic pass never contains a pane mutation action for any row (plan 7.4 invariant)', () => {
  for (const input of enumerateInputs()) {
    if (input.mode !== 'auto') continue;
    const decision = decideRoleFromInput(input);
    const offending = decision.actions.filter(action => PANE_MUTATION_ACTIONS.has(action.type));
    assert.deepEqual(offending, [], `${decision.id} ${JSON.stringify(input)}`);
    assert.equal(decision.notify, null, `${decision.id} ${JSON.stringify(input)}`);
    assert.equal(decision.failureNotify, null);
  }
});

test('closing-q outranks unresponsive at a heartbeat age past the 15 s window (A-31 pin)', () => {
  // A viewer that wrote q and then froze past 15 s must still be classified closing-q, not
  // unresponsive: T20 (not T14) is the explicit row, and the automatic pass stays at zero action.
  const record = { ...RECORD, state: 'ready' };
  const ready = { pid: process.pid, token: RECORD.token, paneId: RECORD.paneId, startedAt: 0,
    heartbeatAt: 1000, closing: 'q' };
  const probe = () => true;
  for (const hbAge of [15000, 60000, 600000]) {
    assert.equal(viewerState({ ready, record, now: 1000 + hbAge, pidAlive: probe }), 'closing-q', `${hbAge}ms`);
    const decision = decideRole(caseOf({ record,
      observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q', age: hbAge } }));
    assert.equal(decision.id, 'T20');
    // ...and the automatic pass still neither mutates nor notifies at that age.
    const auto = decideRole(caseOf({ record,
      observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q', age: hbAge },
      mode: 'auto' }));
    assert.equal(auto.id, 'T20');
    assert.deepEqual(auto.actions, []);
    assert.equal(auto.notify, null);
  }
  // The same fixture without q, at the same age, is the no-action T14/T21 row instead.
  const frozen = { ...ready, closing: undefined };
  assert.equal(viewerState({ ready: frozen, record, now: 1000 + 15000, pidAlive: probe }), 'unresponsive');
  assert.equal(decideRole(caseOf({ record: { ...RECORD, state: 'ready' },
    observation: { pane: 'present', O: true, Oplus: true, V: 'unresponsive' } })).id, 'T14');
});

test('the documented age and heartbeat boundaries map exactly as plan 8 / R2 states', () => {
  const at = (age, V, extra = {}) => decideRole(caseOf({
    observation: { pane: V === 'none' ? 'present' : 'present', O: true, Oplus: true, V, age, ...extra } }));
  // age boundaries for a pending record with no viewer.
  assert.equal(at(19999, 'none').id, 'T9');
  assert.equal(at(20000, 'none').id, 'T10');
  assert.equal(at(119999, 'none').id, 'T10');
  assert.equal(at(120000, 'none').id, 'T11');
  // A negative age is clamped instead of moving the row.
  assert.equal(decideRole(caseOf({ observation: { pane: 'present', O: true, V: 'none', age: -5000 } })).id, 'T9');
  assert.equal(decideRole(caseOf({ observation: { pane: 'present', O: true, V: 'none' } })).id, 'T9');
  // V wins over age: a late ready promotes however old the record is, unresponsive never ages out.
  assert.equal(at(120000, 'ready').id, 'T13');
  assert.equal(at(999999, 'unresponsive').id, 'T14');
  assert.equal(at(999999, 'dead').id, 'T16');
  assert.equal(at(999999, 'closing-q').id, 'T20');
});

test('the failureNotify channel names the launch and close failures for the explicit pass only', () => {
  assert.equal(decideRole(caseOf({ record: null })).failureNotify, 'failed:herdr-split');
  assert.equal(decideRole(caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'closing-q' } })).failureNotify,
    'failed:herdr-close');
  assert.equal(decideRole(caseOf({ observation: { pane: 'present', O: true, Oplus: true, V: 'dead' }, record: { ...RECORD, state: 'ready' } })).failureNotify,
    'failed:herdr-close');
  // A row with nothing to do has no failure channel at all.
  assert.equal(decideRole(caseOf({ observation: { pane: 'present', O: true, V: 'unresponsive' } })).failureNotify, null);
  // Automatic passes do not surface failure codes; they leave the state to the next pass.
  for (const input of enumerateInputs()) {
    if (input.mode === 'auto') assert.equal(decideRoleFromInput(input).failureNotify, null);
  }
});

test('decideOwnerPhase implements the R1 owner steps with heartbeat as display information only', () => {
  const me = { pid: process.pid, instanceId: 'me', sessionId: 's', heartbeatAt: 0 };
  assert.deepEqual(decideOwnerPhase({ owner: null, instanceId: 'me' }), { phase: 'me', detail: 'no-owner' });
  assert.equal(decideOwnerPhase({ owner: me, instanceId: 'me' }).phase, 'me');
  // reload: the same process, but the registry has already moved on to a successor instance.
  assert.deepEqual(decideOwnerPhase({ owner: { ...me, instanceId: 'old' }, instanceId: 'new',
    registryOwnerInstanceId: 'new' }),
  { phase: 'reload', detail: 'registry-successor', heartbeatAt: 0 });
  // A cooperative stop is recorded as stoppedAt.
  assert.equal(decideOwnerPhase({ owner: { ...me, instanceId: 'old', stoppedAt: 55 }, instanceId: 'new' }).phase,
    'prev-dead');
  // A provably dead pid is recoverable even without stoppedAt.
  assert.equal(decideOwnerPhase({ owner: { ...me, pid: 4194303 }, instanceId: 'new',
    pidAlive: () => false }).phase, 'prev-dead');
  // A live pid blocks no matter how stale the heartbeat is: 10 minutes of silence changes nothing.
  const stale = decideOwnerPhase({ owner: { pid: 1234, instanceId: 'old', heartbeatAt: 0 },
    instanceId: 'new', pidAlive: () => true, now: 600000 });
  assert.equal(stale.phase, 'prev-live');
  assert.equal(stale.heartbeatAgeMs, 600000);
  assert.equal(stale.detail, 'alive');
  // An unknowable pid blocks too, and a corrupt or unreadable owner file fails closed.
  assert.equal(decideOwnerPhase({ owner: { pid: 1234, instanceId: 'old' }, instanceId: 'new',
    pidAlive: () => null }).phase, 'prev-live');
  assert.equal(decideOwnerPhase({ owner: { pid: 1234, instanceId: 'old' }, instanceId: 'new',
    corrupt: true }).phase, 'prev-live');
  assert.equal(decideOwnerPhase({ owner: 'not-an-object', instanceId: 'new' }).phase, 'prev-live');
  // prev-live short-circuits decideRole to T0 with zero mutation, whatever the role state is.
  const decision = decideRole(caseOf({ ownerPhase: 'prev-live' }));
  assert.equal(decision.id, 'T0');
  assert.deepEqual(decision.actions, []);
  assert.equal(decision.notify, 'busy:other-owner');
});
