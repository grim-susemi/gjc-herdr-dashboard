// The Reconciler: one serial pass queue per GJC instance, one pass at a time, one lock file.
//
// AUTHORITY NOTES (read before changing this file)
//   * stage-05 R1 replaces base 7.5. There is NO mutation-time `fence()` and NO `failed:fenced`
//     code: the durable serialisation point is the `wx` generation file under
//     `slots/<layoutKey>/lock/`, and the equivalent of the fence is
//     `generationIsCurrent(lock)` — a re-read of the highest generation. This module runs that
//     re-check before every Herdr MUTATION and before every `slot.json`/`owner.json` write; a
//     superseded pass stops with code `busy`, `fence:true` and zero further mutation
//     (R1 safety argument (ii)). The task text's `failed:fenced` is therefore reported as
//     `busy`+`fence:true`; see the lane report.
//   * stage-05 R2 + the A-29/C-14 delta own the row table; it lives in `transitions.mjs` as a pure
//     function. This module only observes, applies the decided actions and turns every outcome
//     into a result code (never a swallowed error, SR1).
//   * A-32: an AUTOMATIC pass may only call `pane list`, `pane process-info` and `pane layout`.
//     The only other calls this module makes are mutations, and automatic passes never mutate.
//   * A-29/C-14: an automatic pass performs only data(host lane)/rebind/T3/T4/T13 work. T20 takes
//     zero action; `closed` is written only by T3 (automatic or explicit) and by an explicit T20.
//
// PASS ORDER (plan 7.4 / the task contract): lock -> owner -> rebind -> role rows -> placement ->
// focus -> result. Placement (the band layout of plan 7.8) belongs to L2's `layout.mjs` and is not
// part of this lane; the role rows therefore go straight to focus, and the pass performs no
// geometry work. Nothing in this module reads or writes pane geometry except the pre-split parent
// size guard in `launch.mjs`-style form below.
//
// Exported signatures
//   createReconciler(deps) -> { explicitPass, autoPass, writeOwner, markStopped, rebind }
//   deps: { stateDir, herdr, vector, now, pidAlive, instanceId, pid, newToken, newPassId,
//           viewerPath, nodePath, checkNode, language, gen, sleep, env,
//           // optional, documented extensions of the shared contract
//           registryOwnerInstanceId, herdrTimeoutMs, explicitBudgetMs, autoBudgetMs,
//           minParentSize, platform }
//   `sleep` is accepted for interface compatibility with the shared contract and is deliberately
//   unused: the R1 generation-file protocol needs no timed wait (no heartbeat takeover, no retry
//   loop), so this module never sleeps.
//   explicitPass(input) -> result (see runPass); one notify is formatted by the caller.
//   autoPass(input)     -> result with `mode:'auto'`, no notify anywhere, mutations 0.
//   input: { binding:{socket,parentPaneId,tabId,sessionId}, roles:['todo'],
//            trigger?, failpoint?, hooks? }   // trigger is recorded for A-31 evidence; failpoint
//                                 // injects the R3 crash/ready-delay fixture; hooks drive the lock
//                                 // race tests (afterClassify / afterLastCheck).
//
// Result shape (superset of the shared contract)
//   { ok, mode, code, roles:{ <role>:{code,id,paneId?,keptPaneId?,detail?,failure?,token?} },
//     focus:{before,after,restored}, gen, budgetMs, elapsedMs, lock:{generation,dir}|null,
//     ownerPhase, ownerDetail, rebound, quarantined, interrupted, fence, failure, detail, trigger }
//   `ownerPhase`/`ownerDetail` are the R1 owner step's verdict and reason; `busy` results always
//   carry `lock`, which is what the adapter renders as the holder snapshot.
import { randomUUID } from 'node:crypto';
import { readJson } from '../storage.mjs';
import { launchRole } from './launch.mjs';
import { ageMs, isO, isOPlus, pidAlive as probePid, viewerState } from './liveness.mjs';
import { OWNER_SCHEMA, acquireLock, clearIntent, generationIsCurrent, key8Of, labelOf, layoutKeyOf,
  lockPaths, ownerRecord, quarantineSlot, readIntent, readOwner, readSlot, releaseLock, scopeKeyOf,
  slotPaths, writeIntent, writeOwner as writeOwnerFile, writeSlot } from './slot.mjs';
import { decideOwnerPhase, decideRole } from './transitions.mjs';

// Result codes of the role rows. An explicit pass reports the table's `notify` column verbatim;
// an automatic pass never notifies, so it reports what the pass DID, from this diagnostic set
// (plan 7.4: automatic passes only write data, rebind, discard/close records and promote ready).
const AUTO_CODES = { T1: 'none', T2: 'none', T3: 'closed', T4: 'discarded', T5: 'discarded',
  T6: 'ready', T9: 'pending', T10: 'pending-slow', T11: 'none', T12: 'none', T13: 'ready',
  T14: 'unresponsive', T16: 'none', T17: 'none', T18: 'quarantined', T19: 'none', T20: 'none',
  T21: 'unresponsive', T22: 'none', T0: 'none' };
const AUTO_ORDER = ['quarantined', 'closed', 'discarded', 'ready', 'pending-slow', 'pending',
  'unresponsive', 'busy', 'none'];
const DEFAULT_MIN_PARENT_SIZE = { width: 40, height: 8 };
const paneIdOf = pane => pane?.pane_id ?? pane?.paneId ?? null;

// Herdr verbs that change pane or focus state. Read-only classification (`list`, `layout`,
// `process-info`) is not a mutation, which is the same basis base T3/T4 use.
const MUTATION_VERBS = new Set(['split', 'rename', 'run', 'close', 'focus']);

const coded = (code, detail) => Object.assign(new Error(detail ?? code), { code, detail });

export function createReconciler(deps = {}) {
  const {
    stateDir, herdr, vector = null, now = () => Date.now(), pidAlive = probePid, instanceId,
    pid = process.pid, newToken = () => randomUUID(), newPassId = () => randomUUID(),
    viewerPath = null, nodePath = null, checkNode = null, language = 'ko', gen = 'dev',
    sleep = null, env = process.env, registryOwnerInstanceId = null, herdrTimeoutMs = 5000,
    explicitBudgetMs = 15000, autoBudgetMs = 5000,
    minParentSize = DEFAULT_MIN_PARENT_SIZE, platform = process.platform,
  } = deps;
  if (typeof stateDir !== 'string' || stateDir === '') throw new TypeError('createReconciler needs stateDir');
  if (typeof herdr !== 'function') throw new TypeError('createReconciler needs a herdr function');
  if (typeof instanceId !== 'string' || instanceId === '') throw new TypeError('createReconciler needs instanceId');

  const registryValue = () => (typeof registryOwnerInstanceId === 'function'
    ? registryOwnerInstanceId() : registryOwnerInstanceId);
  const viewerPathFor = role => (typeof viewerPath === 'string' ? viewerPath : viewerPath?.[role] ?? null);

  // A serial queue per instance (plan 6 row C): passes never interleave inside one process. Two
  // processes are serialised by the generation lock instead.
  let tail = Promise.resolve();
  const enqueue = job => {
    const started = tail.then(job, job);
    tail = started.then(() => undefined, () => undefined);
    return started;
  };

  const layoutKeyFor = binding => layoutKeyOf({ socket: binding.socket, parentPaneId: binding.parentPaneId });
  const pathsFor = binding => slotPaths(stateDir, layoutKeyFor(binding));

  function normalizeBinding(binding) {
    if (!binding || typeof binding !== 'object') throw coded('binding', 'a pass needs a binding');
    for (const field of ['socket', 'parentPaneId', 'sessionId']) {
      if (typeof binding[field] !== 'string' || binding[field] === '') {
        throw coded('binding', `binding.${field} is required`);
      }
    }
    return { socket: binding.socket, parentPaneId: binding.parentPaneId,
      tabId: binding.tabId ?? null, sessionId: binding.sessionId };
  }

  async function readOwnerState(paths) {
    let value;
    try { value = await readOwner(paths.owner); }
    catch (error) {
      // outcome: an unreadable owner.json is classified as corrupt, which fails closed to
      // busy:other-owner rather than adopting someone else's slot (R1 owner step 5).
      return { owner: null, corrupt: true, detail: error.code ?? error.message };
    }
    if (value === null || value === undefined) return { owner: null, corrupt: false, detail: null };
    if (typeof value !== 'object' || value.schema !== OWNER_SCHEMA) {
      return { owner: value, corrupt: true, detail: 'owner-schema' };
    }
    return { owner: value, corrupt: false, detail: null };
  }

  // Plan 7.2 rebinding: the sessionId comparison alone covers /new, /resume, branch, tree and fork.
  // The pane is never touched; only `slot.scope` moves and the epoch increases.
  function applyScope(slot, binding) {
    const epoch = Number.isSafeInteger(slot?.scope?.scopeEpoch) ? slot.scope.scopeEpoch : 0;
    if (slot?.scope?.sessionId === binding.sessionId) {
      return { changed: false, slot, scopeKey: slot.scope.scopeKey, scopeEpoch: epoch };
    }
    const scopeEpoch = epoch + 1;
    const scopeKey = scopeKeyOf({ socket: binding.socket, parentPaneId: binding.parentPaneId,
      sessionId: binding.sessionId });
    return { changed: true, scopeEpoch, scopeKey,
      slot: { ...slot, scope: { sessionId: binding.sessionId, scopeKey, scopeEpoch, language } } };
  }

  function emptyRoles(roles) {
    const out = {};
    for (const role of roles) {
      out[role] = { code: 'pending', id: null, paneId: null, keptPaneId: null, detail: null,
        failure: null };
    }
    return out;
  }

  function aggregate(codes, failure) {
    if (failure) return failure;
    const first = prefix => codes.find(code => code.startsWith(prefix));
    return first('failed:') ?? first('partial:') ?? first('replaced:') ?? codes.find(code => code === 'opened') ??
      codes.find(code => code === 'pending-slow') ?? codes.find(code => code === 'pending') ?? codes[0] ?? 'pending';
  }

  // An automatic pass has no notify, so its aggregate is the strongest thing it actually did.
  function aggregateAuto(codes) {
    if (codes.includes('busy:other-owner')) return 'busy:other-owner';
    for (const code of AUTO_ORDER) {
      if (codes.includes(code)) return code;
    }
    return codes[0] ?? 'none';
  }

  // ---------------------------------------------------------------- one pass -------------------
  async function runPass(mode, input) {
    const explicit = mode === 'explicit';
    const startedAt = now();
    const budgetMs = explicit ? explicitBudgetMs : autoBudgetMs;
    const deadline = startedAt + budgetMs;
    const binding = normalizeBinding(input?.binding);
    const roles = Array.isArray(input?.roles) && input.roles.length > 0 ? [...input.roles] : ['todo'];
    const paths = pathsFor(binding);
    const layoutKey = layoutKeyFor(binding);
    const key8 = key8Of(layoutKey);
    const rolesResult = emptyRoles(roles);
    const focus = { before: null, after: null, restored: true };
    const result = { ok: false, mode, code: 'pending', roles: rolesResult, focus, gen, budgetMs,
      elapsedMs: 0, lock: null, ownerPhase: null, ownerDetail: null, rebound: false, quarantined: false,
      interrupted: false, fence: false, failure: null, detail: null, trigger: input?.trigger ?? null };
    const finish = extra => ({ ...result, ...extra, elapsedMs: Math.max(0, now() - startedAt) });
    // Every role row of a pass that ended before its role loop still has to name an outcome: the
    // caller formats one notify from this result, and a `null` row would render as an unknown code.
    const fillRows = (code, detail, id = null) => {
      for (const role of roles) {
        const out = rolesResult[role];
        if (out.id === null && out.code === 'pending' && !out.failure) {
          out.code = code;
          out.detail = out.detail ?? detail ?? null;
          out.id = id;
        }
      }
    };
    lastBinding = binding;

    const expired = () => now() >= deadline;
    const passId = newPassId();
    const acquired = await acquireLock({ paths: lockPaths(paths), instanceId, passId, mode, pidAlive,
      now, hooks: input?.hooks ?? {} });
    if (!acquired.ok) {
      // R1 step 3/5: a live or unclassifiable holder. Zero herdr calls, zero writes; the owner
      // short-circuit row (T0) is what every role reports.
      const code = acquired.reason === 'busy' ? 'busy' : acquired.reason;
      const detail = acquired.state ?? acquired.detail ?? null;
      fillRows(code, detail, code === 'busy' ? 'T0' : null);
      return finish({ code, detail,
        lock: { generation: acquired.generation ?? 0, dir: paths.lockDir } });
    }
    const lock = acquired.lock;
    result.lock = { generation: lock.generation, dir: lock.lockDir };

    // Every Herdr call of this pass goes through here: budget check, per-call timeout, and the R1
    // generation re-check in front of every mutation.
    const call = async (...args) => {
      if (expired()) throw coded('budget', 'pass budget exhausted');
      if (args[0] === 'pane' && MUTATION_VERBS.has(args[1])) {
        if (!(await generationIsCurrent(lock))) throw coded('fence', 'generation-superseded');
      }
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(coded('timeout', `no reply within ${herdrTimeoutMs}ms`)),
            herdrTimeoutMs);
          timer.unref?.();
          Promise.resolve().then(() => herdr(...args)).then(resolve,
            error => reject(error?.code ? error : coded('herdr', error?.message ?? String(error))));
        });
      } finally { clearTimeout(timer); }
    };
    const guardedWriteSlot = async (path, slot) => {
      if (expired()) throw coded('budget', 'pass budget exhausted');
      if (!(await generationIsCurrent(lock))) throw coded('fence', 'generation-superseded');
      return writeSlot(path, slot);
    };
    const guardedClearIntent = async path => {
      if (expired()) throw coded('budget', 'pass budget exhausted');
      if (!(await generationIsCurrent(lock))) throw coded('fence', 'generation-superseded');
      return clearIntent(path);
    };
    const guardedWriteIntent = async (path, intent) => {
      if (expired()) throw coded('budget', 'pass budget exhausted');
      if (!(await generationIsCurrent(lock))) throw coded('fence', 'generation-superseded');
      return writeIntent(path, intent);
    };

    const readyFor = async role => {
      try { return await readJson(paths.ready(role)); }
      catch (error) {
        // outcome: R2 V step 1 - an unreadable or unparseable ready.json is `none`, never `dead`.
        return { __error: error.code ?? error.message };
      }
    };

    const observeRole = async (role, record) => {
      const listed = await call('pane', 'list');
      const panes = listed?.panes ?? [];
      // Presence is paneId membership in the parent tab's list (R2); O additionally needs the
      // exact label and the matching tab, which is what separates T5 from T4/T20.
      const present = typeof record.paneId === 'string' &&
        panes.some(pane => paneIdOf(pane) === record.paneId);
      const O = isO(record, panes);
      const ready = await readyFor(role);
      const usable = ready && !ready.__error ? ready : null;
      const V = viewerState({ ready: usable, record, now: now(), pidAlive });
      let Oplus = false;
      if (O) {
        let info = null;
        try { info = await call('pane', 'process-info', '--pane', record.paneId); }
        catch (error) {
          // outcome: ownership cannot be proven when the shell identity read fails, so this is the
          // not-O+ branch (T12/T17/T22) and never the close branch.
          info = null;
          result.detail = error.code ?? error.message;
        }
        Oplus = info === null ? false : isOPlus(record, panes, info);
      }
      return { pane: present ? 'present' : 'absent', O, Oplus, V, age: ageMs(record.pendingSince, now()) };
    };

    // The parent must be able to hold the role column at all (plan 7.8 floor: readable 40 columns,
    // minimum 8 rows). The full lowering ladder is L2's layout work; this guard only refuses to
    // create a pane that the measured parent rect cannot host, and reports partial:size instead.
    // An unreadable rect is not a refusal: the split itself is the backstop.
    const parentFits = async () => {
      let layout = null;
      try { layout = await call('pane', 'layout', '--pane', binding.parentPaneId); }
      catch (error) {
        // outcome: without a readable rect the guard abstains and the split decides.
        return { ok: true, detail: error.code ?? error.message };
      }
      const rect = (layout?.layout?.panes ?? []).find(pane => paneIdOf(pane) === binding.parentPaneId)?.rect;
      if (!rect) return { ok: true, detail: 'no-rect' };
      if (Number(rect.width) < minParentSize.width || Number(rect.height) < minParentSize.height) {
        return { ok: false, detail: `parent ${rect.width}x${rect.height} < ${minParentSize.width}x${minParentSize.height}` };
      }
      return { ok: true, detail: null };
    };

    const closePane = async record => {
      // O+ was re-confirmed by the caller immediately before this (reconfirm action). Errors are
      // never evidence of absence (A-30): a failure keeps the record and the closing-q evidence
      // and creates nothing. A close whose Herdr call exceeds the per-call limit is the base
      // plan's `partial:timeout`, everything else is `failed:herdr-close`.
      try { await call('pane', 'close', record.paneId); }
      catch (error) {
        if (error.code === 'timeout' || error.code === 'budget') {
          return { ok: false, code: 'partial:timeout', detail: error.code };
        }
        if (error.code !== 'pane_not_found') return { ok: false, code: 'failed:herdr-close', detail: error.code ?? error.message };
        // Not-found is only success when the absence is confirmed in a fresh list.
        try {
          const listed = await call('pane', 'list');
          const present = (listed?.panes ?? []).some(pane => paneIdOf(pane) === record.paneId);
          if (present) return { ok: false, code: 'failed:herdr-close', detail: 'still-present' };
        } catch (listError) {
          const code = listError.code === 'timeout' || listError.code === 'budget'
            ? 'partial:timeout' : 'failed:herdr-close';
          return { ok: false, code, detail: `confirm:${listError.code ?? listError.message}` };
        }
      }
      return { ok: true, code: null, detail: null };
    };

    try {
      // R1 step 4 equivalent: a pass whose generation is no longer the highest must not mutate.
      if (!(await generationIsCurrent(lock))) {
        fillRows('busy', 'generation-superseded', 'T0');
        return finish({ code: 'busy', fence: true, detail: 'generation-superseded' });
      }

      // ---- owner step (R1), before every role row.
      const ownerState = await readOwnerState(paths);
      const phaseInfo = decideOwnerPhase({ owner: ownerState.owner, instanceId, pid, pidAlive,
        now: now(), corrupt: ownerState.corrupt, registryOwnerInstanceId: registryValue() });
      result.ownerPhase = phaseInfo.phase;
      result.ownerDetail = phaseInfo.detail;
      if (phaseInfo.phase === 'prev-live') {
        // R1 owner step 5: another live (or unclassifiable) owner blocks every explicit pass. Plan
        // 7.4/A-11: an automatic pass additionally requires the owner to be this very instance, so
        // `reload`/`prev-dead` are adoptable by an explicit pass but never by an automatic one.
        for (const role of roles) {
          rolesResult[role] = { code: 'busy:other-owner', id: 'T0', paneId: null, detail: phaseInfo.detail };
        }
        return finish({ code: 'busy:other-owner', detail: phaseInfo.detail });
      }
      if (!explicit && phaseInfo.phase !== 'me') {
        for (const role of roles) {
          rolesResult[role] = { code: 'busy:other-owner', id: 'T0', paneId: null,
            detail: phaseInfo.detail };
        }
        return finish({ code: 'busy:other-owner', detail: phaseInfo.detail });
      }
      if (explicit && phaseInfo.phase !== 'me') {
        // `reload` (cooperative handover), `released` (stoppedAt) and `dead` (ESRCH) are all R1
        // adoption steps: take the owner record over before touching anything else.
        if (expired()) {
          fillRows('partial:timeout', 'owner');
          return finish({ code: 'partial:timeout', detail: 'owner' });
        }
        if (!(await generationIsCurrent(lock))) {
          fillRows('busy', 'generation-superseded', 'T0');
          return finish({ code: 'busy', fence: true, detail: 'generation-superseded' });
        }
        await writeOwnerFile(paths.owner, ownerRecord({ pid, instanceId,
          sessionId: binding.sessionId, now: now() }));
      }
      if (explicit && ownerState.owner === null) {
        if (expired()) {
          fillRows('partial:timeout', 'owner');
          return finish({ code: 'partial:timeout', detail: 'owner' });
        }
        if (!(await generationIsCurrent(lock))) {
          fillRows('busy', 'generation-superseded', 'T0');
          return finish({ code: 'busy', fence: true, detail: 'generation-superseded' });
        }
        await writeOwnerFile(paths.owner, ownerRecord({ pid, instanceId,
          sessionId: binding.sessionId, now: now() }));
      }

      // ---- rebind (plan 7.2). Pane untouched.
      const read = await readSlot(paths.slot);
      let slot = read.status === 'ok' ? read.slot : null;
      const corruptSlot = read.status === 'corrupt';
      if (slot && slot.scope?.sessionId !== binding.sessionId) {
        const scope = applyScope(slot, binding);
        slot = scope.slot;
        result.rebound = true;
        await guardedWriteSlot(paths.slot, slot);
      }

      // ---- T19 precondition: a leftover intent means an interrupted launch.
      let intent = (await readIntent(paths.intent)) !== null;
      result.interrupted = intent;

      // ---- role rows.
      let slotLevel = true;
      for (const role of roles) {
        const roleSlotStatus = slotLevel && corruptSlot ? 'corrupt' : 'ok';
        const roleIntent = slotLevel && intent ? true : false;
        slotLevel = false;
        let record = slot?.roles?.[role] ?? null;
        let observation = { pane: 'absent', O: false, Oplus: false, V: 'none', age: 0 };
        const needsObservation = record !== null && record.state !== 'closed';
        if (!corruptSlot && !intent && needsObservation) {
          observation = await observeRole(role, record);
        }
        const decision = decideRole({ record, observation, mode, ownerPhase: phaseInfo.phase,
          slotStatus: roleSlotStatus, intent: roleIntent });
        const out = rolesResult[role];
        out.id = decision.id;
        out.code = explicit ? (decision.notify ?? AUTO_CODES[decision.id])
          : AUTO_CODES[decision.id] ?? 'none';
        out.paneId = record?.paneId ?? null;
        // An orphan this pass refuses to touch (T5/T12/T17/T22 and the not-O+ T20 branch) is
        // reported by paneId while `paneId` keeps meaning "the pane we now own".
        if (decision.notify?.startsWith('partial:') && observation.pane === 'present' &&
            record?.paneId) out.keptPaneId = record.paneId;

        for (const action of decision.actions) {
          if (action.type === 'quarantine-slot') {
            // T18: rename the unreadable slot aside and continue into T1. Only one role may do it.
            if (!result.quarantined) {
              const moved = await quarantineSlot(paths.slot, { now: now() });
              result.quarantined = moved.reason !== 'absent';
              out.detail = moved.reason;
            }
            slot = null;
            record = null;
            out.paneId = null;
            continue;
          }
          if (action.type === 'clear-intent') {
            await guardedClearIntent(paths.intent);
            intent = false;
            continue;
          }
          if (action.type === 'reconfirm-o-plus') {
            // Read both facts again immediately before the close (plan 8: O+ is not atomic).
            const again = await observeRole(role, record);
            if (!(again.O && again.Oplus)) {
              // Owned-pane evidence vanished: fall back to the T5 family (keep the pane, discard
              // the record, create a fresh pane) instead of closing something we cannot prove.
              out.code = 'partial:ownership-unproven';
              if (slot) {
                const next = { ...slot, roles: { ...slot.roles } };
                delete next.roles[role];
                await guardedWriteSlot(paths.slot, next);
                slot = next;
              }
              record = null;
              out.skippedClose = true;
            }
            continue;
          }
          if (action.type === 'close-pane') {
            if (out.skippedClose || !record) continue;
            const closed = await closePane(record);
            if (!closed.ok) {
              // A-30: keep the record and the q evidence, create nothing, report the failure once.
              out.code = closed.code;
              out.detail = closed.detail;
              out.failure = closed.code;
              break;
            }
            continue;
          }
          if (action.type === 'write-closed') {
            if (out.failure) continue;
            if (!record || !slot) continue;
            const next = { ...slot, roles: { ...slot.roles,
              [role]: { ...record, state: 'closed', closedBy: action.closedBy } } }; 
            await guardedWriteSlot(paths.slot, next);
            slot = next;
            record = next.roles[role];
            continue;
          }
          if (action.type === 'discard-record') {
            if (!slot) continue;
            const next = { ...slot, roles: { ...slot.roles } };
            delete next.roles[role];
            await guardedWriteSlot(paths.slot, next);
            slot = next;
            record = null;
            continue;
          }
          if (action.type === 'promote-ready') {
            if (!record || !slot) continue;
            const next = { ...slot, roles: { ...slot.roles,
              [role]: { ...record, state: 'ready' } } };
            await guardedWriteSlot(paths.slot, next);
            slot = next;
            record = next.roles[role];
            out.paneId = record.paneId;
            continue;
          }
          if (action.type === 'create') {
            if (out.failure) continue;
            if (!explicit) continue;
            const fits = await parentFits();
            if (!fits.ok) {
              out.code = 'partial:size';
              out.detail = fits.detail;
              continue;
            }
            const token = newToken();
            const label = labelOf(role, key8);
            const scope = applyScope(slot ?? { scope: {} }, binding);
            const launch = await launchRole({
              herdr: call, paths, layoutKey, stateDir, role, token, label, language,
              parent: { socket: binding.socket, paneId: binding.parentPaneId, tabId: binding.tabId },
              scope: { sessionId: binding.sessionId, scopeKey: scope.scopeKey,
                scopeEpoch: scope.scopeEpoch, language },
              slot, viewerPath: viewerPathFor(role), nodePath, checkNode, env, now, platform,
              vector, failpoint: input?.failpoint,
              writeSlotFn: guardedWriteSlot, clearIntentFn: guardedClearIntent,
              writeIntentFn: guardedWriteIntent, focusCheck: true,
            });
            if (launch.ok) {
              out.paneId = launch.paneId;
              out.token = token;
              slot = launch.slot;
              record = launch.record;
              focus.before = launch.focus.before;
              focus.after = launch.focus.after;
              focus.restored = launch.focus.restored;
            } else {
              out.code = launch.code;
              out.detail = launch.detail;
              out.failure = launch.code;
              if (launch.paneId) out.keptPaneId = launch.paneId;
              // A launch can fail AFTER it wrote the record (FP2, a failed intent deletion, a
              // failed rename/run). The file on disk is then ahead of this pass's in-memory
              // snapshot, so adopt it: otherwise a later role in the same pass would write the
              // stale snapshot back and silently drop the record.
              if (launch.slot) {
                slot = launch.slot;
                record = launch.record ?? record;
              }
            }
            continue;
          }
          // 'write-data': the projection files are written by the host lane's data writer, gated
          // on this pass's slot state. The reconciler deliberately owns no data file.
        }
        // The orphan we refused to touch is reported through keptPaneId above; nothing to do.
      }

      // ---- focus and result.
      const failure = roles.map(role => rolesResult[role].failure).find(code => typeof code === 'string') ?? null;
      const codes = roles.map(role => rolesResult[role].code);
      const code = explicit ? aggregate(codes, failure) : aggregateAuto(codes);
      // The aggregate detail is the first role detail that explains the aggregate code, so a caller
      // formatting one notify can always name the reason the plan's table gives.
      const roleDetail = roles.map(role => rolesResult[role])
        .find(role => role.detail && (role.code === code || role.failure === failure))?.detail ?? null;
      return finish({ ok: !code.startsWith('busy') && !code.startsWith('failed') && code !== 'partial:timeout',
        code, failure, detail: roleDetail ?? (failure ? null : undefined) });
    } catch (error) {
      // A per-call timeout (plan 7.5: 5 s per herdr call) and a blown pass budget are both
      // `partial:timeout`: the pass may have done some of its work, and the caller must not be
      // told `failed:` for a Herdr that is merely slow. Nothing here is swallowed — the reason
      // travels in `detail`.
      if (error?.code === 'budget' || error?.code === 'timeout') {
        fillRows('partial:timeout', error.detail ?? error.code);
        return finish({ code: 'partial:timeout', detail: error.detail ?? error.code });
      }
      if (error?.code === 'fence') {
        fillRows('busy', 'generation-superseded', 'T0');
        return finish({ code: 'busy', fence: true, detail: 'generation-superseded' });
      }
      // Nothing is swallowed (SR1): an unexpected internal failure still becomes exactly one code
      // the caller can turn into a notify, with the original reason attached, and every role row
      // carries it so a multi-role pass cannot lose the failure in the aggregate.
      const detail = `${error?.code ?? 'error'}: ${error?.message ?? error}`;
      for (const role of roles) {
        const out = rolesResult[role];
        if (out.code === 'pending' && !out.failure) {
          out.code = 'failed:internal';
          out.failure = 'failed:internal';
          out.detail = detail;
        }
      }
      return finish({ code: 'failed:internal', failure: 'failed:internal', detail });
    } finally {
      await releaseLock(lock);
    }
  }

  // ---------------------------------------------------------------- public API ---------------
  let lastBinding = null;

  const explicitPass = input => enqueue(() => runPass('explicit', input));
  const autoPass = input => enqueue(() => runPass('auto', input));

  // Owner record for the instance's 5 s heartbeat and for arming. The pass itself only writes the
  // owner record during the owner step; this is the same file, so it stays one writer at a time.
  async function writeOwner(binding, sessionId = null) {
    const normalized = normalizeBinding(sessionId === null ? binding : { ...binding, sessionId });
    const paths = pathsFor(normalized);
    lastBinding = normalized;
    const owner = ownerRecord({ pid, instanceId, sessionId: normalized.sessionId, now: now() });
    await writeOwnerFile(paths.owner, owner);
    return { ok: true, path: paths.owner, owner };
  }

  // R1 `session_shutdown` order: disposeLocal() first (the caller's job), then this stoppedAt
  // record, then disposed = true. Without a known binding there is nothing to mark.
  async function markStopped() {
    const binding = lastBinding;
    if (!binding) return { ok: false, code: 'no-binding', detail: 'no pass or writeOwner yet' };
    const paths = pathsFor(binding);
    const stoppedAt = now();
    let existing = null;
    try { existing = await readOwner(paths.owner); }
    catch (error) {
      // outcome: an unreadable owner.json is replaced by the stop record; the caller's binding is
      // the strongest identity this process has.
      existing = null;
      void error;
    }
    const owner = ownerRecord({ pid: existing?.pid ?? pid, instanceId: existing?.instanceId ?? instanceId,
      sessionId: existing?.sessionId ?? binding.sessionId, now: existing?.heartbeatAt ?? stoppedAt,
      stoppedAt });
    await writeOwnerFile(paths.owner, owner);
    return { ok: true, path: paths.owner, owner, binding };
  }

  // Plan 7.2: the public, arming-time rebind. It never creates a slot (an absent slot is T1's
  // business) and it never touches a pane.
  function rebind(binding) {
    return enqueue(async () => {
      const normalized = normalizeBinding(binding);
      lastBinding = normalized;
      const paths = pathsFor(normalized);
      const passId = newPassId();
      const acquired = await acquireLock({ paths: lockPaths(paths), instanceId, passId,
        mode: 'explicit', pidAlive, now });
      if (!acquired.ok) {
        return { ok: false, code: acquired.reason === 'busy' ? 'busy' : acquired.reason,
          lock: { generation: acquired.generation ?? 0, dir: paths.lockDir } };
      }
      try {
        const read = await readSlot(paths.slot);
        if (read.status === 'absent') return { ok: true, code: 'no-slot', scopeKey: null, scopeEpoch: 0 };
        if (read.status === 'corrupt') return { ok: true, code: 'corrupt', scopeKey: null, scopeEpoch: 0 };
        const scope = applyScope(read.slot, normalized);
        if (!scope.changed) {
          return { ok: true, code: 'unchanged', scopeKey: scope.scopeKey, scopeEpoch: scope.scopeEpoch };
        }
        await writeSlot(paths.slot, scope.slot);
        return { ok: true, code: 'rebound', scopeKey: scope.scopeKey, scopeEpoch: scope.scopeEpoch };
      } finally {
        await releaseLock(acquired.lock);
      }
    });
  }

  return { explicitPass, autoPass, writeOwner, markStopped, rebind };
}
