// Pure lifecycle decision function: plan 8's single transition table as amended by stage-05 R2
// and by the A-29/C-14 delta.
//
// A-29/C-14 summary (see herdr-dash-a29-fix-01/stage-01-planner.md section 2):
//   * automatic T20 takes ZERO action while the role pane still exists: no slot record change,
//     no ready.json change, no Herdr mutation, no notify; the viewer's closing:'q' evidence is
//     left in place.
//   * `closed` is written only by (a) T3 after a successful `pane list` shows the pane gone,
//     (b) explicit T20 O+ after close success or not-found plus a confirming absent list, and
//     (c) explicit T20 not-O+ (accepted orphan, pane kept, partial notify carrying the paneId).
//   * automatic T20 is not an action row, and T2 therefore keeps its original precondition.
//
// Exports:
//   decideRole({record, observation, mode, ownerPhase, slotStatus, intent}) -> decision
//     record:      {state:'pending'|'ready'|'closed', token, paneId, tabId, shellPid,
//                   pendingSince, closedBy?} | null
//     observation: {O, Oplus, V, age, pane?}
//                   O      owner evidence: pane in the parent tab's pane list with the same
//                          paneId and matching tabId
//                   Oplus  O and (process-info shell_pid === record.shellPid, or no shell)
//                   V      'none' | 'closing-q' | 'ready' | 'unresponsive' | 'dead'
//                   age    ms since record.pendingSince (clamped to >= 0 by the caller or here)
//                   pane   OPTIONAL 'absent' | 'present'. O alone cannot express "present but not
//                          ours" (the T5/T12/T17/T22 rows), so a caller that knows pane presence
//                          passes it. Default: 'present' when O, else 'absent'.
//     mode:        'explicit' | 'auto'
//     ownerPhase:  'me' | 'prev-dead' | 'reload' | 'prev-live'
//     slotStatus:  'ok' | 'corrupt'    (slot-level rows T18; 'absent' behaves like 'ok' + no record)
//     intent:      boolean             (interrupted launch, row T19)
//   -> {id, actions, notify, failureNotify, ownerPhase, mode}
//     `id` is always exactly one member of TABLE_IDS for every combination of INPUT_DOMAIN.
//     `notify` is null for automatic passes: automatic passes never notify (plan 7.4).
//     Automatic passes never contain a PANE_MUTATION_ACTIONS entry, and never `create`.
//   decideOwnerPhase({owner, instanceId, pid, registryOwnerInstanceId, pidAlive, now, corrupt})
//   TABLE_IDS, ACTION_TYPES, PANE_MUTATION_ACTIONS, INPUT_DOMAIN, enumerateInputs(),
//   decideRoleFromInput(input)
//
// Row order is the table's priority order (first match wins): slot rows, then record rows, then
// pane/V rows, then age rows. `ownerPhase === 'prev-live'` short-circuits to T0 before every role
// row: another live owner means zero mutation and `busy:other-owner` (R1 owner step 5).
import { AGE_SLOW_MS, AGE_STALLED_MS } from './liveness.mjs';

export const TABLE_IDS = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T9', 'T10', 'T11', 'T12',
  'T13', 'T14', 'T16', 'T17', 'T18', 'T19', 'T20', 'T21', 'T22'];

export const ACTION_TYPES = ['create', 'discard-record', 'write-closed', 'promote-ready',
  'write-data', 'close-pane', 'quarantine-slot', 'clear-intent', 'reconfirm-o-plus'];

// Everything here changes Herdr state or the pane set. Automatic passes must never contain one.
export const PANE_MUTATION_ACTIONS = new Set(['create', 'close-pane', 'rename-pane',
  'run-viewer', 'focus-pane', 'send-text', 'send-keys']);

export const INPUT_DOMAIN = {
  slotStatus: ['ok', 'corrupt'],
  intent: [false, true],
  recordState: [null, 'closed', 'pending', 'ready'],
  pane: ['absent', 'present'],
  O: [false, true],
  Oplus: [false, true],
  V: ['none', 'closing-q', 'ready', 'unresponsive', 'dead'],
  age: [0, 19999, 20000, 119999, 120000],
  mode: ['explicit', 'auto'],
  ownerPhase: ['me', 'prev-dead', 'reload', 'prev-live'],
};

export function enumerateInputs() {
  const out = [];
  for (const slotStatus of INPUT_DOMAIN.slotStatus)
    for (const intent of INPUT_DOMAIN.intent)
      for (const recordState of INPUT_DOMAIN.recordState)
        for (const pane of INPUT_DOMAIN.pane)
          for (const O of INPUT_DOMAIN.O)
            for (const Oplus of INPUT_DOMAIN.Oplus)
              for (const V of INPUT_DOMAIN.V)
                for (const age of INPUT_DOMAIN.age)
                  for (const mode of INPUT_DOMAIN.mode)
                    for (const ownerPhase of INPUT_DOMAIN.ownerPhase) {
                      out.push({ slotStatus, intent, recordState, pane, O, Oplus, V, age, mode,
                        ownerPhase });
                    }
  return out;
}

function toCase(input) {
  const record = input.recordState === null ? null : {
    state: input.recordState,
    token: 'token-A',
    paneId: 'w1:p9',
    tabId: 'w1:t1',
    shellPid: 4242,
    pendingSince: 0,
  };
  return {
    record,
    slotStatus: input.slotStatus,
    intent: input.intent,
    mode: input.mode,
    ownerPhase: input.ownerPhase,
    observation: { pane: input.pane, O: input.O, Oplus: input.Oplus, V: input.V, age: input.age },
  };
}

// Total by construction: every enumerated axis combination maps to exactly one row.
export function decideRoleFromInput(input) {
  return decideRole(toCase(input));
}

const PARTIAL = 'partial:ownership-unproven';
const STALLED = 'replaced:stalled';
const pendingOrReady = state => state === 'pending' || state === 'ready';

export function decideRole({ record, observation, mode = 'explicit', ownerPhase = 'me',
  slotStatus = 'ok', intent = false } = {}) {
  const explicit = mode !== 'auto';
  const O = observation?.O === true;
  const Oplus = observation?.Oplus === true || observation?.OPlus === true;
  // O alone cannot distinguish "gone" from "there but not ours"; an explicit field wins.
  const pane = observation?.pane ?? (O ? 'present' : 'absent');
  const V = observation?.V ?? 'none';
  const age = Number.isFinite(observation?.age) ? Math.max(0, observation.age) : 0;
  const decide = (id, actions, notify, failureNotify = null) => ({
    id,
    actions,
    notify: explicit ? notify : null,
    failureNotify: explicit ? failureNotify : null,
    ownerPhase,
    mode,
  });
  const create = { type: 'create' };
  const discard = { type: 'discard-record' };
  const closed = closedBy => ({ type: 'write-closed', closedBy });
  // A-29/C-14 I-C: only T20 may write `closed` on the replacing paths. T11/T16 close the pane and
  // discard the stale record; writing `closed` there would be a second, unlisted closed writer.
  const replace = (id, notify, closedBy) => decide(id,
    [{ type: 'reconfirm-o-plus' }, { type: 'close-pane' },
      ...(closedBy ? [closed(closedBy)] : []), discard, create], notify, 'failed:herdr-close');
  // T4/T5-style orphan handling: never touch the pane, and report the unproven ownership.
  const orphan = id => decide(id, explicit ? [discard, create] : [discard], PARTIAL,
    explicit ? 'failed:herdr-split' : null);

  // Another live owner pre-empts every role row: no mutation, notify the owner conflict.
  if (ownerPhase === 'prev-live') return decide('T0', [], 'busy:other-owner');

  // T18: an unknown schema is corrupt. Explicit quarantines and continues into T1; automatic
  // quarantines only and neither notifies nor creates.
  if (slotStatus === 'corrupt') {
    return explicit
      ? decide('T18', [{ type: 'quarantine-slot' }, create], 'opened', 'failed:herdr-split')
      : decide('T18', [{ type: 'quarantine-slot' }], 'none');
  }
  // T19: an intent file left behind means an interrupted launch; an orphan pane may exist.
  if (intent) {
    return explicit
      ? decide('T19', [{ type: 'clear-intent' }, create], 'partial:interrupted-launch',
        'failed:herdr-split')
      : decide('T19', [], 'none');
  }
  // T1 / T2: nothing recorded, or a record the table says is already closed.
  if (!record) return explicit ? decide('T1', [create], 'opened', 'failed:herdr-split')
    : decide('T1', [], 'none');
  if (record.state === 'closed') {
    return explicit ? decide('T2', [create], 'opened', 'failed:herdr-split')
      : decide('T2', [], 'none');
  }
  if (!pendingOrReady(record.state)) {
    // Unknown record state is treated as a stale record (T4/T5), never as "nothing to do".
    return pane === 'absent' ? orphan('T4') : orphan('T5');
  }

  // T3 / T4: the pane is gone. Only T3 writes `closed`, and only when the viewer said `q`.
  // T4 is the plain "start over" row: the pane is confirmed absent, so nothing can be orphaned and
  // the notify is `opened` regardless of O (base table T4).
  if (pane === 'absent') {
    if (V === 'closing-q') {
      return explicit ? decide('T3', [closed('t3'), create], 'opened', 'failed:herdr-split')
        : decide('T3', [closed('t3')], 'none');
    }
    return explicit ? decide('T4', [discard, create], 'opened', 'failed:herdr-split')
      : decide('T4', [discard], 'none');
  }

  // T20: `q` recorded while the pane still exists. A-29/C-14: an automatic pass does nothing at
  // all here, preserving both the record and the `closing:'q'` evidence.
  if (V === 'closing-q') {
    if (!explicit) return decide('T20', [], 'none');
    if (Oplus) return replace('T20', 'opened', 't20');
    // Ownership unprovable: keep the orphan pane untouched and open a new pane instead.
    return decide('T20', [closed('t20'), create], PARTIAL, 'failed:herdr-split');
  }

  // T5 and its O-variants: a pane exists but is not ours. Never touch it; never claim ownership.
  if (!O) return orphan('T5');

  if (V === 'ready') {
    // T13 promotes a late viewer; T6 is the steady state and only refreshes data on a tick.
    const notify = ownerPhase === 'me' ? 'ready' : 'adopted';
    return record.state === 'pending'
      ? decide('T13', [{ type: 'promote-ready' }], notify)
      : decide('T6', explicit ? [] : [{ type: 'write-data' }], notify);
  }

  if (V === 'dead') {
    // T16 closes and recreates; T17 cannot prove ownership and keeps the orphan.
    if (Oplus) return explicit ? replace('T16', 'replaced:dead') : decide('T16', [], 'none');
    return explicit ? orphan('T17') : decide('T17', [], 'none');
  }

  if (V === 'unresponsive') {
    // T14 is the "no action at all" row for both passes: a frozen viewer keeps its pane.
    return decide('T14', [], 'unresponsive');
  }

  // V === 'none' by elimination.
  if (record.state === 'ready') {
    // T21: a ready record whose viewer state vanished but whose pane is still provably ours.
    if (Oplus) return decide('T21', [], 'unresponsive');
    return explicit ? orphan('T22') : decide('T22', [], 'none');
  }
  // Pending with no viewer yet: the age ladder. 120 s is the only age-based pane action.
  if (age < AGE_SLOW_MS) return decide('T9', [], 'pending');
  if (age < AGE_STALLED_MS) return decide('T10', [], 'pending-slow');
  if (Oplus) return explicit ? replace('T11', STALLED) : decide('T11', [], 'none');
  return explicit ? orphan('T12') : decide('T12', [], 'none');
}

// R1 owner steps mapped onto the four names the table's owner-phase precondition uses:
//   me          owner.json records this instance (or does not exist)
//   reload      same pid, but the recorded instance is not the registry's current entry; the
//               registry replaced it synchronously, so this is a cooperative handover
//   prev-dead   `stoppedAt` recorded, or the recorded pid is provably gone (ESRCH)
//   prev-live   anything else: another pid is alive, liveness is unknowable, or the file is
//               unreadable. Fail closed to `busy:other-owner` with zero mutation. Heartbeat age
//               is attached as display information only and never decides the phase.
export function decideOwnerPhase({ owner, instanceId, pid = process.pid, registryOwnerInstanceId,
  pidAlive, now = Date.now(), corrupt = false } = {}) {
  // An unreadable record is reported as owner null + corrupt: it is NOT an absent record (R1 owner step 5).
  if (corrupt) return { phase: 'prev-live', detail: 'owner-unreadable' };
  if (owner === null || owner === undefined) return { phase: 'me', detail: 'no-owner' };
  if (typeof owner !== 'object') return { phase: 'prev-live', detail: 'owner-unreadable' };
  if (owner.instanceId === instanceId) return { phase: 'me', detail: 'same-instance' };
  // `reload` is the cooperative in-process handover: the record names another instance with the SAME
  // pid (the factory ran again in this process) AND the registry's current entry is US. A predecessor
  // whose queued heartbeat runs after the successor claimed ownership must not match here, which is
  // why the caller passes the live registry id and it must equal ours (#2).
  if (owner.pid === pid && registryOwnerInstanceId === instanceId) {
    return { phase: 'reload', detail: 'registry-successor', heartbeatAt: owner.heartbeatAt ?? null };
  }
  if (Number.isFinite(owner.stoppedAt)) {
    return { phase: 'prev-dead', detail: 'stopped', stoppedAt: owner.stoppedAt };
  }
  const alive = typeof pidAlive === 'function' ? pidAlive(owner.pid) : null;
  if (alive === false) return { phase: 'prev-dead', detail: 'esrch', pid: owner.pid };
  // `true` (alive or EPERM) and `null` (unknowable) both block the takeover.
  return { phase: 'prev-live', detail: alive === true ? 'alive' : 'liveness-unavailable',
    pid: owner.pid, heartbeatAt: owner.heartbeatAt ?? null, heartbeatAgeMs: heartbeatAge(owner, now) };
}

function heartbeatAge(owner, now) {
  if (!Number.isFinite(owner.heartbeatAt)) return null;
  return Math.max(0, now - owner.heartbeatAt);
}
