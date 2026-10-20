// Unit tests for src/core/liveness.mjs: pid liveness (L0 G10 facts), viewer state V, and the
// ownership predicates O and O+, all driven by fake process tables and a fake clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGE_SLOW_MS, AGE_STALLED_MS, HEARTBEAT_READY_MS, ageMs, heartbeatAgeMs, isO, isOPlus,
  pidAlive, viewerState } from '../../src/core/liveness.mjs';
import { PANE_LABELS } from '../../src/core/slot.mjs';

const killOf = table => (pid, signal) => {
  if (signal !== 0) throw Object.assign(new Error(`unexpected signal ${signal}`), { code: 'EINVAL' });
  const entry = table[pid];
  if (entry === 'alive') return true;
  if (entry === 'other-user') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  if (entry === 'gone') throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  throw Object.assign(new Error('cannot probe'), { code: 'EACCES' });
};

test('pidAlive reports the three L0 G10 outcomes plus an explicit unknowable result', () => {
  const table = { 1: 'alive', 2: 'other-user', 3: 'gone', 4: 'weird' };
  const kill = killOf(table);
  // Alive, and a process owned by another user (EPERM) both prove existence.
  assert.equal(pidAlive(1, kill), true);
  assert.equal(pidAlive(2, kill), true);
  // ESRCH proves death.
  assert.equal(pidAlive(3, kill), false);
  // Anything else is unknowable, which R1 turns into busy rather than a takeover.
  assert.equal(pidAlive(4, kill), null);
  // A nonsense pid never reaches the syscall.
  for (const pid of [0, -1, 1.5, Number.NaN, '1234', null, undefined]) {
    assert.equal(pidAlive(pid, () => { throw new Error('must not probe'); }), null, String(pid));
  }
});

test('pidAlive probes the real process table correctly for self and for a dead pid', () => {
  assert.equal(pidAlive(process.pid), true);
  // PID 2^22-1 is above the configured maximum on this host, so it is always free.
  assert.equal(pidAlive(4194303), false);
});

test('heartbeat and age are clamped so a future timestamp never yields a negative age', () => {
  assert.equal(heartbeatAgeMs({ heartbeatAt: 1000 }, 1000), 0);
  assert.equal(heartbeatAgeMs({ heartbeatAt: 1000 }, 15999), 14999);
  assert.equal(heartbeatAgeMs({ heartbeatAt: 2000 }, 1000), 0);
  assert.equal(heartbeatAgeMs({}, 1000), Number.POSITIVE_INFINITY);
  assert.equal(ageMs(0, 19999), 19999);
  assert.equal(ageMs(5000, 1000), 0);
  assert.equal(ageMs(undefined, 1000), 0);
  assert.equal(HEARTBEAT_READY_MS, 15000);
  assert.equal(AGE_SLOW_MS, 20000);
  assert.equal(AGE_STALLED_MS, 120000);
});

test('viewerState follows the R2 first-match order, including the exact 15.000 s boundary', () => {
  const record = { token: 'tok', paneId: 'w1:p5', tabId: 'w1:t1', label: PANE_LABELS.todo };
  const probe = pidAlive;
  const ready = (overrides = {}) => ({ pid: process.pid, token: 'tok', paneId: 'w1:p5',
    startedAt: 0, heartbeatAt: 1000, ...overrides });
  const at = (value, overrides) => viewerState({ ready: ready(overrides), record, now: 1000 + value,
    pidAlive: probe });
  // 1. Unreadable, or token/pane mismatch, is `none` before anything else is considered.
  assert.equal(viewerState({ ready: null, record, now: 1000, pidAlive: probe }), 'none');
  assert.equal(viewerState({ ready: {}, record, now: 1000, pidAlive: probe }), 'none');
  assert.equal(at(0, { token: 'other' }), 'none');
  assert.equal(at(0, { paneId: 'w1:p6' }), 'none');
  assert.equal(viewerState({ ready: ready(), record: { ...record, paneId: null }, now: 1000, pidAlive: probe }), 'none');
  // 2. `closing === 'q'` wins over liveness and age, so no action row can pre-empt it.
  assert.equal(at(0, { closing: 'q' }), 'closing-q');
  assert.equal(at(60000, { closing: 'q' }), 'closing-q');
  assert.equal(at(0, { closing: 'Q' }), 'ready');
  assert.equal(at(0, { closing: false }), 'ready');
  // 3. ESRCH is dead even with a fresh heartbeat.
  assert.equal(viewerState({ ready: ready({ pid: 4194303 }), record, now: 1000, pidAlive: probe }), 'dead');
  assert.equal(viewerState({ ready: ready({ pid: 1 }), record, now: 1000, pidAlive: () => null }), 'ready');
  // 4. The heartbeat window is exactly 15000 ms: 14999 ready, 15000 unresponsive.
  assert.equal(at(14999), 'ready');
  assert.equal(at(15000), 'unresponsive');
  assert.equal(at(600000), 'unresponsive');
  assert.equal(at(0), 'ready');
});

test('isO requires the exact label plus matching pane and tab in the same pane list', () => {
  const record = { paneId: 'w1:p5', tabId: 'w1:t1', label: PANE_LABELS.todo };
  const pane = { pane_id: 'w1:p5', tab_id: 'w1:t1', label: PANE_LABELS.todo };
  assert.equal(isO(record, [pane]), true);
  // Any of the three identifiers disagreeing is not ownership.
  assert.equal(isO(record, [{ ...pane, label: PANE_LABELS.workers }]), false);
  assert.equal(isO(record, [{ ...pane, label: 'DAG · aaaaaaaa' }]), false);
  assert.equal(isO(record, [{ ...pane, label: `${PANE_LABELS.todo} ` }]), false);
  assert.equal(isO(record, [{ ...pane, pane_id: 'w1:p6' }]), false);
  assert.equal(isO(record, [{ ...pane, tab_id: 'w2:t1' }]), false);
  // Another tab's identically labelled pane does not count either.
  assert.equal(isO(record, [{ ...pane, tab_id: 'w2:t9', pane_id: 'w1:p5' }]), false);
  assert.equal(isO(record, []), false);
  assert.equal(isO(record, null), false);
  assert.equal(isO(null, [pane]), false);
  assert.equal(isO({ ...record, label: null }, [pane]), false);
  // camelCase field spellings are accepted for fakes that use them.
  assert.equal(isO(record, [{ paneId: 'w1:p5', tabId: 'w1:t1', label: PANE_LABELS.todo }]), true);
});

test('isOPlus adds the shell identity check and treats a shell-less pane as ours', () => {
  const record = { paneId: 'w1:p5', tabId: 'w1:t1', label: PANE_LABELS.todo, shellPid: 4242 };
  const pane = { pane_id: 'w1:p5', tab_id: 'w1:t1', label: PANE_LABELS.todo };
  const info = shellPid => ({ process_info: { pane_id: 'w1:p5', shell_pid: shellPid } });
  assert.equal(isOPlus(record, [pane], info(4242)), true);
  // A different shell is the T12/T17/T22 branch: ownership cannot be proven.
  assert.equal(isOPlus(record, [pane], info(9999)), false);
  // No shell (or an unfilled field) counts as O+ per plan 8.
  assert.equal(isOPlus(record, [pane], info(null)), true);
  assert.equal(isOPlus(record, [pane], { process_info: { pane_id: 'w1:p5' } }), true);
  assert.equal(isOPlus(record, [pane], {}), true);
  // But a record with no shell pid cannot be matched against a real shell.
  assert.equal(isOPlus({ ...record, shellPid: 0 }, [pane], info(4242)), false);
  assert.equal(isOPlus({ ...record, shellPid: null }, [pane], info(4242)), false);
  // process-info reporting another pane is a mismatch even when the list agrees.
  assert.equal(isOPlus(record, [pane], { process_info: { pane_id: 'w1:p6', shell_pid: 4242 } }), false);
  // O is a precondition: no list match means no O+.
  assert.equal(isOPlus(record, [], info(4242)), false);
  assert.equal(isOPlus(record, [{ ...pane, label: PANE_LABELS.workers }], info(4242)), false);
  // Missing process-info entirely is not ownership evidence.
  assert.equal(isOPlus(record, [pane], null), false);
  assert.equal(isOPlus(record, [pane], {}), true);
});
