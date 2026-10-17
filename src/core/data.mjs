// Projection writer for `<state>/data/<scopeKey>/<kind>.json` (plan 7.9 row
// "data/<scopeKey>/{todo,workers,goal,progress}.json", writer: the owner, 200 ms merge).
//
// The writer is deliberately dumb: it holds no ctx, knows no data source and formats nothing. The
// projection object it stores is whatever the caller already computed (for Todo, lane D's
// `projectTodo(ctx)` plus the caller's `schema`/`empty`/`sourceError` wrapper). It only adds the
// plan's write policy:
//   * writes go through `writeJson` (temp file + rename, Windows sharing retry);
//   * `delayMs` (200 ms default) merges a burst of publishes for one target into a single write,
//     and the newest projection wins;
//   * `flush()` waits for every scheduled AND in-flight write and returns the writer's lifetime
//     write count, so a caller can keep the pass budget honest instead of ending with a half-written
//     projection. A failed write is rethrown by `flush` after the rest drained, never swallowed;
//   * `shouldWrite` gates the write (plan 7.1 item 5): data files are written only while the slot
//     still carries a non-closed record for that role. The caller passes the gate; the writer never
//     reads the slot itself. A skipped publish resolves `{wrote:false, skipped:true}`.
//
// `now` is injected so tests can drive a fake clock; it is only used as the `generatedAt` stamp.
//
// Exported signatures
//   DATA_SCHEMA
//   createDataWriter({ stateDir, now, delayMs = 200, shouldWrite, io }) -> Writer
//   Writer = { publish(scopeKey, kind, projection, { shouldWrite } = {}) -> Promise<{wrote, path, skipped?}>,
//              flush() -> Promise<number>, pending() -> number, writes() -> number }
import { join } from 'node:path';
import { writeJson } from '../storage.mjs';

export const DATA_SCHEMA = 'gjc-herdr-dashboard/data/1';

// A publish promise is handed to the caller AND awaited by `flush()`. Attaching a second, no-op
// observer keeps an unhandled rejection from escaping when the caller only ever calls `flush()`;
// `flush` still rethrows the stored failure, so nothing is swallowed (SR1).
function noteFailureOfWrite() {}

export function createDataWriter({ stateDir, now = () => Date.now(), delayMs = 200,
  shouldWrite = null, io = null } = {}) {
  const scheduled = new Map();
  const active = new Set();
  const failures = [];
  const write = io && typeof io.writeJson === 'function' ? io.writeJson : writeJson;
  const pathOf = (scopeKey, kind) => join(stateDir, 'data', String(scopeKey), `${kind}.json`);
  let writes = 0;

  function gateAllows(gate, scopeKey, kind, projection) {
    if (gate === null || gate === undefined) return true;
    if (typeof gate === 'function') return gate({ scopeKey, kind, projection }) === true;
    return gate === true;
  }

  function schedule(path, value) {
    const entry = { path, value, timer: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.timer = setTimeout(() => {
        scheduled.delete(path);
        const projection = entry.value;
        // The stamp is added here, not by the caller, so a merged publish carries the time of the
        // write that actually landed.
        const stamped = projection && typeof projection === 'object' && !Array.isArray(projection)
          ? { ...projection, generatedAt: now() } : projection;
        let job;
        try {
          job = Promise.resolve(write(path, stamped));
        } catch (error) {
          job = Promise.reject(error);
        }
        active.add(job);
        job.then(() => { writes++; active.delete(job); resolve({ wrote: true, path }); },
          error => { active.delete(job); failures.push(error); reject(error); });
      }, delayMs);
    });
    scheduled.set(path, entry);
    return entry.promise;
  }

  function publish(scopeKey, kind, projection, { shouldWrite: perCall = undefined } = {}) {
    if (typeof scopeKey !== 'string' || scopeKey === '') {
      return Promise.reject(Object.assign(new Error('data publish needs a scopeKey'), { code: 'scope-key' }));
    }
    if (typeof kind !== 'string' || kind === '') {
      return Promise.reject(Object.assign(new Error('data publish needs a kind'), { code: 'data-kind' }));
    }
    const path = pathOf(scopeKey, kind);
    const gate = perCall === undefined ? shouldWrite : perCall;
    if (!gateAllows(gate, scopeKey, kind, projection)) {
      return Promise.resolve({ wrote: false, path, skipped: true });
    }
    const existing = scheduled.get(path);
    if (existing) {
      // Merge: the newest projection wins and the first timer performs the single write.
      existing.value = projection;
      return existing.promise;
    }
    return schedule(path, projection);
  }

  async function flush() {
    while (scheduled.size > 0 || active.size > 0) {
      const jobs = [...scheduled.values()].map(entry => entry.promise);
      jobs.push(...active);
      // The individual promises are also handed to the caller; observing them here must not turn
      // an unhandled rejection into a process-level failure.
      for (const job of jobs) job.then(noteFailureOfWrite, noteFailureOfWrite);
      await Promise.allSettled(jobs);
    }
    // A failed write is reported, never swallowed (SR1). The queue is drained so a caller that
    // retries sees the newer state, not the same error twice.
    if (failures.length > 0) throw failures.shift();
    // The lifetime number of writes this writer completed, so a caller can tell how many writes a
    // burst of publishes actually cost (plan 7.9: the merge is one write, not one per publish).
    return writes;
  }

  return { publish, flush, pending: () => scheduled.size + active.size, writes: () => writes };
}
