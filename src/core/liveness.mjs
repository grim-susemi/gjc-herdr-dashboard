// Observation primitives for the lifecycle table (plan 8, as amended by stage-05 R2):
// pid liveness, viewer presence `V`, ownership `O`, and strong ownership `O+`.
//
// Exports:
//   pidAlive(pid, kill = process.kill) -> true | false | null
//     true: the process exists, or exists for another user (EPERM). L0 G10 measured exactly
//     "self/EPERM -> alive, ESRCH -> dead". false: ESRCH. null: liveness is UNKNOWABLE (any other
//     error), which stage-05 R1 turns into `unknown` -> busy, never into "dead".
//   viewerState({ready, record, now, pidAlive}) -> 'ready' | 'unresponsive' | 'dead' | 'none' |
//     'closing-q'. First match wins, in R2 order: unreadable/mismatched file -> none,
//     closing:'q' -> closing-q, ESRCH -> dead, hbAge >= 15000 -> unresponsive, else ready.
//   isO(record, paneList)               -> boolean. `O` = the recording pane still appears in
//                                          `pane list` with the exact label for its role and
//                                          matching paneId + tabId.
//   isOPlus(record, paneList, processInfo) -> boolean. `O` and the pane shell is the one the
//                                          record was created from, or the pane has no shell.
//   heartbeatAgeMs(record, now) / ageMs(pendingSince, now) -> clamped to >= 0 (future stamps).
// Constants: HEARTBEAT_READY_MS (15000, exact boundary is unresponsive), HEARTBEAT_STALE_MS
// (15000), AGE_SLOW_MS (20000), AGE_STALLED_MS (120000).
export const HEARTBEAT_READY_MS = 15000;
export const AGE_SLOW_MS = 20000;
export const AGE_STALLED_MS = 120000;

export function pidAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // A process owned by someone else answers EPERM, which proves it exists.
    if (error.code === 'EPERM') return true;
    // outcome: any other failure means "cannot tell", and R1 fails closed to busy.
    return null;
  }
}

export function heartbeatAgeMs(record, now = Date.now()) {
  const at = record?.heartbeatAt;
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - at);
}

export function ageMs(pendingSince, now = Date.now()) {
  if (!Number.isFinite(pendingSince)) return 0;
  return Math.max(0, now - pendingSince);
}

// `ready` is the raw parsed roles/<role>.ready.json for this role, or null when unreadable.
export function viewerState({ ready, record, now = Date.now(), pidAlive: probe = pidAlive } = {}) {
  if (!ready || typeof ready !== 'object') return 'none';
  if (typeof record?.token !== 'string' || typeof record?.paneId !== 'string') return 'none';
  if (ready.token !== record.token || ready.paneId !== record.paneId) return 'none';
  if (ready.closing === 'q') return 'closing-q';
  if (probe(ready.pid) === false) return 'dead';
  if (heartbeatAgeMs(ready, now) >= HEARTBEAT_READY_MS) return 'unresponsive';
  return 'ready';
}

const paneIdOf = pane => pane?.pane_id ?? pane?.paneId ?? null;
const tabIdOf = pane => pane?.tab_id ?? pane?.tabId ?? null;
const labelOf = pane => pane?.label ?? null;

export function isO(record, paneList) {
  if (!record || !Array.isArray(paneList)) return false;
  if (typeof record.paneId !== 'string' || typeof record.label !== 'string') return false;
  return paneList.some(pane => paneIdOf(pane) === record.paneId &&
    labelOf(pane) === record.label &&
    tabIdOf(pane) === record.tabId);
}

// O+ adds the shell identity check. "No shell" counts as O+ (plan 8), but a *different* shell pid
// does not: that is the T12/T17/T22 branch where ownership cannot be proven.
export function isOPlus(record, paneList, processInfo) {
  if (!isO(record, paneList)) return false;
  const info = processInfo?.process_info ?? processInfo;
  if (!info || typeof info !== 'object') return false;
  const reported = info.pane_id ?? info.paneId;
  if (typeof reported === 'string' && reported.length > 0 && reported !== record.paneId) return false;
  const shellPid = info.shell_pid ?? info.shellPid;
  if (!Number.isSafeInteger(shellPid) || shellPid < 1) return true;
  if (!Number.isSafeInteger(record.shellPid) || record.shellPid < 1) return false;
  return shellPid === record.shellPid;
}
