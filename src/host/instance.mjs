// The GJC instance: arming, the process-wide owner registry, delegation, the automatic pass
// triggers and the only user-visible notify. Plan §7.1/§7.2/§7.4, as amended by stage-05 R1
// (owner/lock), R5 (generation token) and R6 (arming entry points).
//
// One `createInstance` call per GJC session factory call: main and every sub session get their own
// instance object, and only an armed main instance ever touches the registry, the state files or
// Herdr. A sub session fails eligibility reason #1 (`session-kind`) and is therefore fully inert:
// zero registry writes, zero files, zero Herdr calls (LT-6).
//
// WHAT THIS MODULE OWNS
//   * the process-wide registry `globalThis[Symbol.for('gjc.herdr.dashboard/1')]`, created lazily
//     at ARM time and never by the factory body (§7.1 item 3);
//   * the arming decision, reached only from `session_start` and `/dashboard` (R6);
//   * the 5 s owner heartbeat (`reconciler.writeOwner`) and the 1 s `getLeafId()` poll that turns a
//     `/todo` edit into an automatic pass (G9 measured that the retained ctx keeps answering; if it
//     ever throws, polling is disabled for good and the instance stays event-only);
//   * the data publish: `projectTodo(ctx)` -> `data/<scopeKey>/todo.json` and the Workers tracker's
//     `snapshot()` -> `data/<scopeKey>/workers.json`, each only while the slot still carries a
//     non-closed record for ITS role (§7.1 item 5). The writer merges a burst of publishes into one
//     200 ms write; the explicit path flushes so `/dashboard` never returns before its own
//     projection is on disk.
//   * the workers bus subscription (L2 §7.6): `createWorkersTracker` is built at ARM time, the three
//     BUS_CHANNELS feed it, `ctx.getJobs()` fills the background rows, and every handler is wrapped
//     so a throw becomes `sourceError` instead of escaping into the host (AC2.7, LT-1);
//   * the 5 s tick that promotes a LATE-ready viewer of ANY role in `ROLES`, not just Todo (R3).
// WHAT IT DELIBERATELY DOES NOT OWN
//   * panes, focus, records and lock files: `src/core/reconciler.mjs`;
//   * eligibility, binding and message wording: `src/host/gjc-adapter.mjs`;
//   * any pane input, any reporter command, any CLI (§7.10 A-18).
//
// Exported signatures
//   REGISTRY_KEY, HOST_ENV, LANG_ENV, OWNER_HEARTBEAT_MS, POLL_MS, ROLES, DASHBOARD_COMMAND,
//   DASHBOARD_DESCRIPTION, BUS_CHANNELS
//   scanScopeKeys(stateDir)      -> Promise<string[]>   // slot-derived active scope keys (A-15)
//   createInstance(pi, deps)     -> handle
//   handle = { armed()  -> boolean,
//              dispose()   -> void      // full teardown: timers, entry disposed, `stoppedAt`
//              state()     -> plain serializable snapshot }
//   The registry entry additionally carries `runExplicit(ctx, notice?)` (what a delegate calls) and
//   `disposeLocal()` (the timers-only cooperative handover of §7.1 item 3).
//   `state()` carries: armed, disposed, instanceId, moduleUrl, rootUrl, rootPath, stateDir, gen,
//   language, rawLanguage, invalidLanguage, pollMode ('poll'|'event-only'), binding, layoutKey,
//   scopeKey, owner, delegate, delegateInstanceId, duplicateNotified, vector, vectorError,
//   lastOwnerPath, heartbeatAt, lastLeaf, lastResultCode, lastNotify, superseded, counters, errors,
//   pruneFailures, workers.
//   `workers` is the tracker's reporting view for a drill: `{ sourceError, ignored, cards }`.
//
// `deps` (every key optional; the real default is named in parentheses). The factory body only
// registers handlers and closes over these: it reads no environment value, starts no timer,
// touches no file and does not create the registry map.
//   moduleUrl           (none)                      the entry module's `import.meta.url`
//   env                 (process.env)              read lazily, only inside handlers/arm
//   platform            (process.platform)
//   now                 (Date.now)
//   isTTY               (Boolean(process.stdout?.isTTY))  boolean or `() => boolean`
//   pid                 (process.pid)              used for the host marker and owner records
//   execPath            (process.execPath)         passed to the Node resolver
//   registry            (globalThis[REGISTRY_KEY], lazily at arm time)
//   herdrFactory        (createHerdr)
//   reconcilerFactory   (createReconciler)
//   dataWriterFactory   (createDataWriter)
//   nodeResolver        (resolveViewerNode)
//   vectorResolver      (resolveHerdrVector)
//   generationOf        (views/common generationOf)  `config.json.generation`, else 'dev'
//   checkEligibility    (gjc-adapter checkEligibility)
//   bindingOf           (gjc-adapter bindingOf)
//   notifyText          (gjc-adapter notifyText)
//   projectTodo         (sources/todo projectTodo)
//   workersTrackerFactory (sources/workers createWorkersTracker)
//   pruneScopes         (retention pruneExpiredScopes)
//   retentionDays       (retention retentionDaysFromEnv)
//   scanScopes          (scanScopeKeys)
//   setInterval         (global setInterval) / clearInterval (global clearInterval)
//   newInstanceId       (crypto.randomUUID)
//   failpoint           (undefined)                forwarded to the reconciler's pass input (the R3
//                                                 crash fixture); production leaves it unset and the
//                                                 env-based failpoints inside `launch.mjs` still apply
//   heartbeatMs         (OWNER_HEARTBEAT_MS) / pollMs (POLL_MS) / herdrTimeoutMs (5000)
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createDataWriter } from '../core/data.mjs';
import { pidAlive as probePid } from '../core/liveness.mjs';
import { createReconciler } from '../core/reconciler.mjs';
import { layoutKeyOf, readSlot, slotPaths } from '../core/slot.mjs';
import { createHerdr, resolveHerdrVector } from '../herdr.mjs';
import { i18n } from '../i18n.mjs';
import { pruneExpiredScopes, retentionDaysFromEnv } from '../retention.mjs';
import { resolveViewerNode } from '../runtime.mjs';
import { generationOf } from '../viewers/common.mjs';
import { bindingOf, checkEligibility, notifyText } from './gjc-adapter.mjs';
import { projectTodo } from './sources/todo.mjs';
import { createWorkersTracker } from './sources/workers.mjs';

// §7.1 item 3: one registry per process, keyed by the layout key (pane owner unit).
export const REGISTRY_KEY = Symbol.for('gjc.herdr.dashboard/1');
// Read by `gjc-adapter.isNested`: a recorded pid that is not provably dead means another GJC
// already owns this pane.
export const HOST_ENV = 'GJC_HERDR_DASHBOARD_HOST';
export const LANG_ENV = 'GJC_HERDR_DASHBOARD_LANG';
export const OWNER_HEARTBEAT_MS = 5000;
export const POLL_MS = 1000;
// The dashboard's roles, in the order a pass opens them: Todo is the band's anchor, so Workers can
// only be split after Todo exists (contract "Roles/ordering").
export const ROLES = Object.freeze(['todo', 'workers']);
export const DASHBOARD_COMMAND = 'dashboard';
export const DASHBOARD_DESCRIPTION = 'Open the Herdr dashboard for this session';
// The subagent telemetry channels G5 measured (`VERIFICATION.md`). Plan §7.4 lists "bus" as an
// automatic-pass trigger: a bus event feeds the workers tracker AND re-runs the automatic pass
// (data write + rebind), never a pane mutation and never a notify. `task:subagent:event` carries
// raw child events and is deliberately not consumed - it is subscribed only so the subscription set
// matches the measured host surface.
export const BUS_CHANNELS = Object.freeze(['task:subagent:lifecycle', 'task:subagent:progress',
  'task:subagent:event']);

const message = (cause) => String(cause?.message ?? cause ?? 'error');
const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

// A-15: a scope stays active while any slot still points at it, even if its viewer went quiet.
// Reading the slots is the only way to know, so it is an injectable seam like every other read.
export async function scanScopeKeys(stateDir) {
  const root = join(stateDir, 'slots');
  let names;
  try { names = await readdir(root); }
  catch (error) {
    // outcome: no `slots/` directory yet means there is no slot-derived scope to protect.
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const keys = [];
  for (const name of names) {
    const read = await readSlot(join(root, name, 'slot.json'));
    if (read.status !== 'ok') continue;
    const key = text(read.slot?.scope?.scopeKey);
    if (key) keys.push(key);
  }
  return keys;
}

export function createInstance(pi, deps = {}) {
  // ------------------------------------------------------------------ seams (lazy defaults) ----
  const envOf = () => deps.env ?? process.env;
  const clock = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const platformOf = () => deps.platform ?? process.platform;
  const pidOf = () => (Number.isSafeInteger(deps.pid) ? deps.pid : process.pid);
  const execPathOf = () => text(deps.execPath) ?? process.execPath;
  const isTTYOf = () => {
    if (deps.isTTY === undefined) return Boolean(process.stdout?.isTTY);
    return typeof deps.isTTY === 'function' ? deps.isTTY() === true : deps.isTTY === true;
  };
  // Created at ARM time only: a sub session or an ineligible main must not even build the map.
  const registryOf = () => {
    if (deps.registry) return deps.registry;
    const scope = globalThis;
    if (!scope[REGISTRY_KEY]) scope[REGISTRY_KEY] = new Map();
    return scope[REGISTRY_KEY];
  };
  // Non-creating read, used by `state()` and by the owner-self check.
  const registryPeek = () => (deps.registry ?? globalThis[REGISTRY_KEY] ?? null);
  const eligibilityOf = () => (typeof deps.checkEligibility === 'function'
    ? deps.checkEligibility : checkEligibility);
  const bindingOfCtx = () => (typeof deps.bindingOf === 'function' ? deps.bindingOf : bindingOf);
  const notifyTextOf = () => (typeof deps.notifyText === 'function' ? deps.notifyText : notifyText);
  const projectTodoOf = () => (typeof deps.projectTodo === 'function' ? deps.projectTodo : projectTodo);
  const workersTrackerOf = () => (typeof deps.workersTrackerFactory === 'function'
    ? deps.workersTrackerFactory : createWorkersTracker);
  // The timer seams stay LAZY functions: naming the global `setInterval` inside a closure body is
  // not an access at factory time (§7.1 item 1), and the injected variant wins when present.
  const armTimer = (fn, ms) => (typeof deps.setInterval === 'function' ? deps.setInterval : setInterval)(fn, ms);
  const disarmTimer = (id) => (typeof deps.clearInterval === 'function'
    ? deps.clearInterval : clearInterval)(id);
  const heartbeatMs = Number.isFinite(deps.heartbeatMs) && deps.heartbeatMs > 0
    ? deps.heartbeatMs : OWNER_HEARTBEAT_MS;
  const pollMs = Number.isFinite(deps.pollMs) && deps.pollMs > 0 ? deps.pollMs : POLL_MS;
  const herdrTimeoutMs = Number.isFinite(deps.herdrTimeoutMs) && deps.herdrTimeoutMs > 0
    ? deps.herdrTimeoutMs : 5000;

  // ------------------------------------------------------------------ instance state ----------
  let armed = false;
  let disposed = false;
  let instanceId = text(deps.instanceId);
  let binding = null;
  let layoutKey = null;
  let scopeKey = null;
  let entry = null;
  let delegateTo = null;
  // Set when this instance is the one BEING replaced (disposeLocal from the registry handover), so
  // a stray `/dashboard` on the retired instance hands the call to the current owner instead of
  // re-arming and stealing the slot back (§7.1 item 3).
  let superseded = false;
  let duplicateNotified = false;
  let language = null;
  let invalidLanguage = null;
  // The raw `GJC_HERDR_DASHBOARD_LANG` value is what the viewer receives: the viewer owns the
  // resolution AND the one-time footer notice for an unsupported value (§6 I row, AC-F2), so the
  // instance must not pre-resolve it away. `language` keeps the resolved value for state().
  let rawLanguage = null;
  let gen = null;
  let rootUrl = null;
  let rootPath = null;
  let stateDir = null;
  let vector = null;
  let vectorError = null;
  let reconciler = null;
  let dataWriter = null;
  // Built at ARM time (a sub session must not even construct one) and reset whenever the scope
  // key changes: the cards, the source error and the ignore counter all belong to one scope.
  let workersTracker = null;
  let busUnsubscribe = null;
  let latestCtx = null;
  let lastLeaf = null;
  let pollMode = 'event-only';
  let heartbeatTimer = null;
  let pollTimer = null;
  let heartbeatAt = null;
  let lastOwnerPath = null;
  let lastNotify = null;
  let lastResultCode = null;
  const errors = [];
  const pruneFailures = [];
  const counters = { explicit: 0, auto: 0, delegated: 0, published: 0, pruned: 0, warnings: 0 };

  const idOf = () => (instanceId ??= (typeof deps.newInstanceId === 'function'
    ? text(deps.newInstanceId()) ?? randomUUID() : randomUUID()));

  // An error is never swallowed: it is kept in the instance state a drill can read, with the
  // place and the code, and the next explicit `/dashboard` reports the pass result again.
  function record(error, where) {
    errors.push({ where, code: error?.code ?? null, message: message(error), at: clock() });
    if (errors.length > 32) errors.shift();
    return error;
  }

  function notify(ctx, result, level = 'info', notice = null) {
    // The one line this call owes the user. `notice` is an extra protocol token appended to the
    // SAME line (never a second notify): the duplicate-install warning is delivered this way so a
    // `/dashboard` call still produces exactly one message (LT-4, owner ruling on §7.1 item 3).
    let line;
    try {
      line = notifyTextOf()(result, activeLanguage(), activeGen(), catalogueRoot());
    } catch (error) {
      // outcome: the adapter is written never to throw, so reaching here means the wording is
      // unavailable; the raw code with the gen token still reaches the user (LT-4).
      record(error, 'notify-text');
      line = `ext ${activeGen()} · ${result?.code ?? 'failed:internal'}`;
    }
    if (notice !== null) line = `${line} · ${notice}`;
    try { ctx?.ui?.notify?.(line, level); }
    catch (error) {
      // outcome: a host whose notify throws cannot be told anything, so the line stays readable
      // in state() for a drill instead of being lost.
      record(error, 'notify');
    }
    lastNotify = line;
    return line;
  }

  const activeLanguage = () => language
    ?? i18n.decision(text(envOf()[LANG_ENV]) ?? null).language;
  // Before arming there is no tree to read a locale from, so the adapter falls back to its own
  // package root; an armed instance always carries the imported ROOT (R4).
  const catalogueRoot = () => (rootUrl ? { rootUrl } : {});
  // Before arming there is no tree to read a generation from, so an ineligible `/dashboard` is
  // reported as `dev`; every armed result carries the generation of the imported ROOT (R5).
  const activeGen = () => gen ?? 'dev';

  function evaluate(ctx) {
    let outcome;
    try {
      outcome = eligibilityOf()(ctx, envOf(), { isTTY: isTTYOf(), hostPid: pidOf(),
        pidAlive: typeof deps.pidAlive === 'function' ? deps.pidAlive : probePid, roles: ROLES,
        ...(text(deps.moduleUrl) ? { moduleUrl: deps.moduleUrl } : {}) });
    } catch (error) {
      // outcome: the adapter is written not to throw; an adapter fault is reported as one
      // ineligible reason rather than escaping into an event handler (LT-1).
      record(error, 'eligibility');
      return { ok: false, reason: 'internal', detail: message(error) };
    }
    if (!outcome || typeof outcome !== 'object') {
      return { ok: false, reason: 'internal', detail: 'eligibility-shape' };
    }
    return outcome;
  }

  const validBinding = (local) => local !== null && text(local.socket) !== null
    && text(local.parentPaneId) !== null && text(local.sessionId) !== null;

  function resolveLanguage() {
    const raw = text(envOf()[LANG_ENV]) ?? null;
    const decision = i18n.decision(raw);
    return { language: decision.language, invalidLanguage: decision.invalidValue, raw };
  }

  function resolveGen() {
    try { return text(deps.generationOf ? deps.generationOf(rootUrl) : generationOf(rootUrl)) ?? 'dev'; }
    catch (error) {
      // outcome: an unreadable generation stamp degrades to `dev`, which is exactly what an
      // uninstalled dev tree reports; the tree itself was already validated by eligibility.
      record(error, 'generation');
      return 'dev';
    }
  }

  function checkNode() {
    const resolve = typeof deps.nodeResolver === 'function' ? deps.nodeResolver : resolveViewerNode;
    return resolve({ env: envOf(), execPath: execPathOf(),
      language: language ?? i18n.decision(null).language })
      .then((nodePath) => ({ ok: true, nodePath }),
        (error) => ({ ok: false, reason: error?.code ?? message(error) }));
  }

  // ------------------------------------------------------------------ arming (R6) --------------
  function registryDecision(local) {
    const registry = registryOf();
    const existing = registry.get(layoutKey) ?? null;
    if (!existing || existing.disposed === true) return { action: 'replace', existing: null };
    const sameSession = existing.sessionId === local.sessionId;
    const sameModule = String(existing.moduleUrl ?? '') === String(deps.moduleUrl ?? '');
    if (sameSession && !sameModule) return { action: 'delegate', existing };
    // Same session + same module is a `/reload` handover; a different session replaces outright.
    return { action: 'replace', existing };
  }

  // Builds the reconciler and the data writer. Every Herdr verb, every lock file and every record
  // belongs to the reconciler; this function only hands it the seams §7.5 lists.
  function wire(environment) {
    // The Herdr client is rebuilt per arm so it sees the environment this instance armed with; the
    // vector is the one resolved above (§7.10: the same argv is recorded in `slot.json.herdr`).
    const herdrClient = (typeof deps.herdrFactory === 'function' ? deps.herdrFactory : createHerdr)({
      vector, env: environment, timeoutMs: herdrTimeoutMs });
    const reconcilerDeps = {
      stateDir, herdr: herdrClient, vector, now: () => clock(),
      pidAlive: typeof deps.pidAlive === 'function' ? deps.pidAlive : probePid,
      instanceId: idOf(), pid: pidOf(),
      // R4/§7.3 item 1: every role's viewer resolves inside the SAME tree as the entry module, so a
      // generation tree never borrows a viewer from another install.
      viewerPath: Object.fromEntries(ROLES.map(role =>
        [role, join(rootPath, 'src', 'viewers', role, 'viewer.mjs')])),
      checkNode, language: rawLanguage ?? language ?? 'ko', gen, env: environment,
      platform: platformOf(), herdrTimeoutMs,
      registryOwnerInstanceId: () => (entry && entry.disposed !== true ? entry.instanceId : null),
    };
    reconciler = (typeof deps.reconcilerFactory === 'function'
      ? deps.reconcilerFactory : createReconciler)(reconcilerDeps);
    dataWriter = (typeof deps.dataWriterFactory === 'function'
      ? deps.dataWriterFactory : createDataWriter)({ stateDir, now: () => clock() });
    // §7.6: the workers tracker is pure state; this instance is its only feeder. Rebuilt on every
    // arm so a re-armed instance never inherits another scope's cards.
    workersTracker = workersTrackerOf()({ now: () => clock() });
  }

  async function heartbeatOnce() {
    if (!armed || !reconciler || !validBinding(binding)) return null;
    try {
      const outcome = await reconciler.writeOwner(binding);
      heartbeatAt = clock();
      lastOwnerPath = outcome?.path ?? null;
      return outcome;
    } catch (error) {
      // outcome: the owner record is display + adoption information; a failed heartbeat is
      // recorded and the next tick retries (the pass writes the same file during its owner step).
      record(error, 'heartbeat');
      return null;
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = armTimer(() => {
      if (!armed) return;
      heartbeatOnce();
      // R3 / LT-3: the same 5 s tick promotes a late-ready viewer (T13) without a second
      // `/dashboard`. Only a pending role needs it, so an idle dashboard makes no Herdr call.
      tickPendingPass().catch(error => record(error, 'heartbeat-tick'));
    }, heartbeatMs);
    heartbeatTimer?.unref?.();
  }

  async function tickPendingPass() {
    if (!latestCtx || !stateDir || layoutKey === null) return;
    let read;
    try { read = await readSlot(paths().slot); }
    catch (error) {
      // outcome: no readable slot means nothing is pending; the next tick looks again.
      record(error, 'heartbeat-slot');
      return;
    }
    if (read.status !== 'ok') return;
    // R3 / LT-3: EVERY role in ROLES can be the one a late viewer left pending, so the tick must
    // check each of them - a workers viewer that missed the ready window would otherwise stay
    // pending until the next user call.
    const pending = ROLES.some(role => read.slot?.roles?.[role]?.state === 'pending');
    if (!pending) return;
    await runAutoPass(latestCtx, 'heartbeat-tick');
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) { disarmTimer(heartbeatTimer); heartbeatTimer = null; }
  }

  // A scheduled workers publish: the bus handlers may only enqueue (AC2.7), so this is the one place
  // a payload becomes a file. It never rejects into the caller - a failed publish is recorded in
  // state() and the next trigger retries.
  function scheduleWorkersPublish() {
    if (!armed || !workersTracker) return null;
    return Promise.resolve().then(() => publishWorkers())
      .catch(error => {
        // outcome: a workers publish that could not run is kept in state(); the bus burst it came
        // from is already in the tracker and the next trigger writes it.
        record(error, 'workers-publish');
      });
  }

  // §7.6 + AC2.7. Every channel gets the same shape: feed the tracker (synchronous, pure state),
  // schedule the publish, then let the retained ctx carry the automatic pass exactly as L1 did. A
  // throw from the feed is the workers footer's source error (미표시가 아니라 '원천 오류') and is never
  // rethrown into the host's event dispatch.
  function attachWorkersBus() {
    const offs = [];
    const subscribe = (channel, feed) => {
      const off = pi?.events?.on?.(channel, payload => {
        if (!armed) return;
        try { feed(payload); }
        catch (error) {
          // outcome: a payload the tracker could not absorb becomes the workers source error; the
          // host event dispatch never sees the throw (AC2.7, LT-1).
          workersTracker?.fail(error, 'bus');
        }
        scheduleWorkersPublish();
        if (!latestCtx) return;
        runAutoPass(latestCtx, 'bus');
      });
      if (typeof off === 'function') offs.push(off);
    };
    subscribe('task:subagent:lifecycle', payload => workersTracker?.onLifecycle(payload));
    subscribe('task:subagent:progress', payload => workersTracker?.onProgress(payload));
    // `task:subagent:event` carries raw child events and is deliberately NOT consumed (§7.6); it is
    // subscribed so the trigger set matches the measured host surface.
    subscribe('task:subagent:event', () => {});
    busUnsubscribe = offs;
  }

  function detachWorkersBus() {
    for (const off of busUnsubscribe ?? []) {
      try { off(); }
      catch (error) {
        // outcome: a subscription the host refuses to release is recorded; the instance is being
        // torn down either way and nothing else depends on the release succeeding.
        record(error, 'bus-unsubscribe');
      }
    }
    busUnsubscribe = null;
  }

  function disablePoll(error) {
    pollMode = 'event-only';
    if (pollTimer !== null) { disarmTimer(pollTimer); pollTimer = null; }
    record(error, 'poll');
  }

  async function pollTick() {
    if (!armed || !reconciler) return;
    // Every exception in this tick - the retained ctx refusing to answer (G9) or the pass itself
    // throwing - disables polling permanently (`pollMode: 'event-only'`); the event triggers then
    // carry the instance. That is why this variant of the auto pass rethrows instead of recording.
    try {
      // A new session (`/new`, `/resume`, fork) has no leaf yet, so the leaf alone would leave the
      // scope bound to the old session until the next event; the session id is the rebind key.
      const current = bindingOfCtx()(latestCtx, envOf());
      const sessionMoved = validBinding(current) && binding !== null && current.sessionId !== binding.sessionId;
      const leaf = latestCtx?.sessionManager?.getLeafId?.();
      const leafOk = typeof leaf === 'string' && leaf !== '';
      if (!sessionMoved) {
        if (!leafOk) return;
        if (lastLeaf === null) { lastLeaf = leaf; return; }
        if (leaf === lastLeaf) return;
      }
      if (leafOk) lastLeaf = leaf;
      await runAutoPass(latestCtx, 'poll', { strict: true });
    } catch (error) {
      // outcome: reported through `disablePoll`, which records it once and stops the timer.
      disablePoll(error);
    }
  }

  function startPoll() {
    if (pollTimer !== null) return;
    pollMode = 'poll';
    pollTimer = armTimer(() => {
      if (!armed) return;
      pollTick();
    }, pollMs);
    pollTimer?.unref?.();
  }

  // Seed the leaf id at arm time so the very first tick compares instead of seeding: an edit made
  // between `/dashboard` and the first tick would otherwise be invisible for a second. A ctx that
  // refuses to answer here is the same G9 fault the tick reports, so polling is disabled.
  function seedLeaf(ctx) {
    try {
      const leaf = ctx?.sessionManager?.getLeafId?.();
      if (typeof leaf === 'string' && leaf !== '') lastLeaf = leaf;
    } catch (error) {
      // outcome: the same G9 fault the tick reports, so the timer never starts (`pollMode` stays
      // 'event-only') and the event triggers carry the instance instead.
      disablePoll(error);
    }
  }

  async function pruneOnce() {
    if (!stateDir) return null;
    const active = new Set();
    if (text(scopeKey)) active.add(scopeKey);
    try {
      const scan = typeof deps.scanScopes === 'function' ? deps.scanScopes : scanScopeKeys;
      for (const key of await scan(stateDir)) if (text(key)) active.add(key);
    } catch (error) {
      // outcome: the scan is an optimisation for A-15; an unreadable `slots/` leaves this
      // instance's own scope as the only active one and the rest of the prune still runs.
      record(error, 'prune-scan');
    }
    const days = (typeof deps.retentionDays === 'function'
      ? deps.retentionDays : retentionDaysFromEnv)(envOf());
    try {
      const result = await (typeof deps.pruneScopes === 'function'
        ? deps.pruneScopes : pruneExpiredScopes)(stateDir, {
        activeScopeKeys: active, now: clock(), days,
        notify: (detail, info) => pruneFailures.push({ detail, scopeKey: info?.scopeKey ?? null }),
      });
      counters.pruned += result?.removed?.length ?? 0;
      return result ?? null;
    } catch (error) {
      // outcome: retention is housekeeping, not a pass result; a failure is kept in state() and
      // never turns into a second notify (LT-4 allows exactly one message per `/dashboard`).
      record(error, 'prune');
      return null;
    }
  }

  // R6: only this function turns an instance into an armed owner, and only `session_start` and
  // `/dashboard` call it.
  async function arm(ctx, eligibility) {
    if (armed) return { kind: 'owner' };
    const environment = envOf();
    const local = bindingOfCtx()(ctx, environment);
    if (!validBinding(local)) {
      // outcome: without a session id there is no scope to bind, no owner record to adopt and no
      // pass to run; the instance stays inert and `/dashboard` reports it once.
      record({ code: 'binding', message: 'binding.sessionId' }, 'arm');
      return { kind: 'invalid', detail: 'binding.sessionId' };
    }
    rootUrl = eligibility.rootUrl ?? null;
    rootPath = eligibility.rootPath ?? null;
    stateDir = eligibility.stateDir;
    const decision = resolveLanguage();
    language = decision.language;
    invalidLanguage = decision.invalidLanguage;
    rawLanguage = decision.raw;
    layoutKey = layoutKeyOf({ socket: local.socket, parentPaneId: local.parentPaneId });

    const choice = registryDecision(local);
    if (choice.action === 'delegate') {
      delegateTo = choice.existing;
      binding = { ...local };
      return { kind: 'delegate', entry: choice.existing };
    }
    if (choice.existing && typeof choice.existing.disposeLocal === 'function') {
      try { choice.existing.disposeLocal(); }
      catch (error) {
        // outcome: the outgoing instance refused to release its timers, so it is abandoned and
        // this instance takes the slot anyway; the registry no longer points at it.
        record(error, 'dispose-local');
      }
    }

    gen = resolveGen();
    try { vector = (typeof deps.vectorResolver === 'function'
      ? deps.vectorResolver : resolveHerdrVector)(environment, platformOf()); }
    catch (error) {
      // outcome: an unresolvable Herdr vector is not an arming failure - `createHerdr` resolves it
      // again per call and the pass reports `failed:herdr`, which is where the user sees it.
      vector = null;
      vectorError = error?.code ?? message(error);
    }
    binding = { ...local };
    scopeKey = null;
    wire(environment);
    entry = { instanceId: idOf(), moduleUrl: deps.moduleUrl ?? null, sessionId: local.sessionId,
      disposed: false, runExplicit: (ctx, notice = null) => runExplicit(ctx, 'delegate', notice),
      disposeLocal };
    armed = true;
    disposed = false;
    superseded = false;
    registryOf().set(layoutKey, entry);
    try { environment[HOST_ENV] = String(pidOf()); }
    catch (error) {
      // outcome: a host that froze its environment object cannot carry the nested marker, so a
      // second GJC in this pane would not see it; the arming itself stands (the marker is only a
      // courtesy for a nested host, and `isNested` already answers false for our own pid).
      record(error, 'host-marker');
    }
    await heartbeatOnce();
    startHeartbeat();
    startPoll();
    seedLeaf(ctx);
    await pruneOnce();
    return { kind: 'owner' };
  }

  // ------------------------------------------------------------------ binding + data -----------
  async function syncBinding(local) {
    const same = binding !== null && binding.sessionId === local.sessionId;
    binding = { ...local };
    if (same) return { ok: true, code: 'unchanged' };
    let outcome;
    try { outcome = await reconciler.rebind(local); }
    catch (error) {
      // outcome: a failed rebind leaves the previous scope in place; the caller reports the pass
      // result and the next trigger retries (the reconciler never latches).
      record(error, 'rebind');
      return { ok: false, code: 'failed:internal' };
    }
    // A scope change starts the workers projection over: the cards, the source error and the ignore
    // counter describe the scope that just ended and none of them may leak into the next one.
    if (outcome?.ok === true && text(outcome.scopeKey) && outcome.scopeKey !== scopeKey) {
      workersTracker?.reset?.();
    }
    if (outcome?.ok === true && text(outcome.scopeKey)) scopeKey = outcome.scopeKey;
    return outcome ?? { ok: false, code: 'failed:internal' };
  }

  // §7.1 item 5: data files exist only while the slot carries a non-closed record for the role.
  // This function is that gate: it reads the slot, decides, and only then publishes. The data
  // writer itself owns no gate here (it is a dumb projection writer, plan §7.9 row
  // `data/<scopeKey>/todo.json`), so the rule lives in one place instead of two. The caller owns the
  // flush (`runExplicit` drains the writer once for every role it published).
  async function publishTodo(ctx) {
    if (!dataWriter || !stateDir || layoutKey === null) return { published: false, reason: 'no-writer' };
    let read;
    try { read = await readSlot(paths().slot); }
    catch (error) {
      // outcome: an unreadable slot means the projection has no home yet; the next trigger retries.
      record(error, 'data-slot');
      return { published: false, reason: 'slot-read' };
    }
    if (read.status !== 'ok') return { published: false, reason: read.status };
    const key = text(read.slot?.scope?.scopeKey);
    if (!key) return { published: false, reason: 'no-scope' };
    scopeKey = key;
    const todoRecord = read.slot?.roles?.todo ?? null;
    if (!todoRecord || todoRecord.state === 'closed') return { published: false, reason: 'closed' };
    let projection;
    try { projection = projectTodoOf()(ctx, { now: clock() }); }
    catch (error) {
      // outcome: the projector is written never to throw; if it does, the stale projection stays
      // on disk and the viewer shows its own source-error label rather than an empty pane.
      record(error, 'project-todo');
      return { published: false, reason: 'projection' };
    }
    // This instance is the gate: the slot read above already proved the slot carries a non-closed
    // todo record, which is what §7.1 item 5 requires of a data write. The writer never reads a
    // slot, so no `shouldWrite` override is passed.
    let handle;
    try { handle = dataWriter.publish(key, 'todo', projection); }
    catch (error) {
      // outcome: a publish that throws synchronously wrote nothing; the previous projection stays
      // on disk for the viewer and the reason is kept in state().
      record(error, 'data-publish');
      return { published: false, reason: 'publish' };
    }
    // The promise is also handed to `flush()`; this observer only keeps a rejected publish from
    // escaping as an unhandled rejection when the auto path never flushes.
    handle.then(() => { counters.published++; }, error => record(error, 'data-write'));
    return { published: true, scopeKey: key };
  }

  // §7.1 item 5 for the workers role: same gate as Todo, one slot read for both projections. The
  // tracker already holds the state the bus fed it, so this function only decides whether the slot
  // still carries a non-closed workers record and then publishes `snapshot()`. The caller owns the
  // flush (`runExplicit` drains the writer once for both roles).
  async function publishWorkers({ slot: known = undefined } = {}) {
    if (!dataWriter || !workersTracker || !stateDir || layoutKey === null) {
      return { published: false, reason: 'no-writer' };
    }
    let slotValue = known ?? null;
    if (slotValue === null) {
      let read;
      try { read = await readSlot(paths().slot); }
      catch (error) {
        // outcome: an unreadable slot means the projection has no home yet; the next trigger retries.
        record(error, 'data-slot');
        return { published: false, reason: 'slot-read' };
      }
      if (read.status !== 'ok') return { published: false, reason: read.status };
      slotValue = read.slot;
    }
    const key = text(slotValue?.scope?.scopeKey);
    if (!key) return { published: false, reason: 'no-scope' };
    scopeKey = key;
    const workersRecord = slotValue?.roles?.workers ?? null;
    if (!workersRecord || workersRecord.state === 'closed') return { published: false, reason: 'closed' };
    let projection;
    try { projection = workersTracker.snapshot(); }
    catch (error) {
      // outcome: the tracker is written never to throw; if it does, the stale projection stays on
      // disk and the viewer shows its own source-error label rather than losing the pane.
      record(error, 'project-workers');
      return { published: false, reason: 'projection' };
    }
    let handle;
    try { handle = dataWriter.publish(key, 'workers', projection); }
    catch (error) {
      // outcome: a publish that throws synchronously wrote nothing; the previous projection stays
      // on disk for the viewer and the reason is kept in state().
      record(error, 'data-publish');
      return { published: false, reason: 'publish' };
    }
    handle.then(() => { counters.published++; }, error => record(error, 'data-write'));
    return { published: true, scopeKey: key };
  }

  // ------------------------------------------------------------------ passes -------------------
  const isSelfOwner = () => armed && entry !== null && entry.disposed !== true
    && registryPeek()?.get(layoutKey) === entry;
  const paths = () => slotPaths(stateDir, layoutKey);

  async function currentBinding(ctx) {
    const local = bindingOfCtx()(ctx, envOf());
    if (!validBinding(local)) return null;
    await syncBinding(local);
    return binding;
  }

  // The explicit pass: exactly one notify, always, and never a throw (the caller is a command
  // handler and a lost message is the defect E1 this port must not reproduce). `trigger` is the
  // A-31 evidence field: 'dashboard' for a user call, 'delegate' for a pass handed to the registry
  // owner, 'runExplicit' for a test/drill call. `notice` is the one extra token a delegate call
  // adds to its single line (see `notify`).
  async function runExplicit(ctx, trigger = 'dashboard', notice = null) {
    const local = bindingOfCtx()(ctx, envOf());
    if (!reconciler || !validBinding(local)) {
      lastResultCode = 'failed:internal';
      const result = { ok: false, code: 'failed:internal',
        detail: reconciler ? 'binding.sessionId' : 'not-armed' };
      notify(ctx, result, 'warn', notice);
      return result;
    }
    latestCtx = ctx;
    await syncBinding(local);
    let result;
    try {
      counters.explicit++;
      // The 15 s explicit budget and the 5 s per-call Herdr timeout are the reconciler's (§7.5);
      // this handler only awaits that pass and renders its result. The pass gets the SYNCED
      // binding, so a sessionId that changed mid-call cannot drive a pass for the old scope.
      result = await reconciler.explicitPass({ binding, roles: [...ROLES], trigger,
        ...(deps.failpoint === undefined ? {} : { failpoint: deps.failpoint }) });
    } catch (error) {
      // outcome: the reconciler turns its own faults into result codes; reaching here means the
      // call itself rejected, which is reported as one `failed:internal` line (never swallowed).
      record(error, 'explicit');
      result = { ok: false, code: 'failed:internal', detail: message(error),
        roles: Object.fromEntries(ROLES.map(role => [role, { code: 'failed:internal', id: null,
          detail: message(error), failure: 'failed:internal' }])) };
    }
    lastResultCode = result?.code ?? 'failed:internal';
    // Every pass refreshes the background half of the workers projection before publishing, so a
    // job the bus can never see still appears (AC2.6).
    syncJobsFromCtx(ctx);
    // Both projections are flushed together, so `/dashboard` never returns before its own data is
    // on disk - for either role.
    await publishTodo(ctx);
    await publishWorkers();
    try { await dataWriter?.flush(); }
    catch (error) {
      // outcome: a projection that could not be written is reported in state() and the explicit
      // pass still notifies its own result, which is the one message the user is owed.
      record(error, 'data-flush');
    }
    notify(ctx, result ?? { code: 'failed:internal' }, result?.ok === true ? 'info' : 'warn', notice);
    return result;
  }

  // The automatic pass: silent by contract, owner-self only, no pane mutation anywhere (the
  // reconciler enforces that). Plan §7.4 order: data write, then rebind, then the reconciler's
  // record cleanup/promotion. Triggered by bus events, so by default it must not throw; the poll
  // passes `strict` so an exception can disable polling (see `pollTick`).
  async function runAutoPass(ctx, trigger, { strict = false } = {}) {
    if (!armed || !reconciler || !isSelfOwner()) return null;
    latestCtx = ctx;
    try {
      const local = await currentBinding(ctx);
      if (!local) return null;
      counters.auto++;
      // Rebind first (the target scope must be the one the slot now points at), then publish the
      // projection, then let the reconciler do its record work (T3/T4 discard, T13 promotion):
      // that order is plan §7.4's "data write, rebind, record cleanup" with the rebind hoisted, and
      // it means a record about to be discarded still gets its last fresh picture.
      syncJobsFromCtx(ctx);
      await publishTodo(ctx);
      await publishWorkers();
      return await reconciler.autoPass({ binding: local, roles: [...ROLES], trigger,
        ...(deps.failpoint === undefined ? {} : { failpoint: deps.failpoint }) });
    } catch (error) {
      // outcome: an event handler must not throw (LT-1), so the failure is kept in state() and the
      // next trigger or `/dashboard` runs again - nothing is latched. A `strict` caller owns the
      // recording (and the consequence) instead, so one fault is never reported twice.
      if (strict) throw error;
      record(error, `auto:${trigger}`);
      return null;
    }
  }

  // §7.6: `ctx.getJobs()` is the background supplement to the bus. The host surface is optional
  // (an older build has no job manager), so an absent accessor is not an error - but a throwing one
  // is reported and never escapes.
  function syncJobsFromCtx(ctx) {
    if (!workersTracker) return;
    try { workersTracker.syncJobs(ctx?.getJobs?.()); }
    catch (error) {
      // outcome: a broken jobs surface is a source error for the workers footer, never a throw into
      // the host and never a lost pass (AC2.7).
      workersTracker.fail(error, 'jobs');
      scheduleWorkersPublish();
    }
  }

  // ------------------------------------------------------------------ shutdown -----------------
  // R1: `disposeLocal()` releases the TIMERS (and, in the full product, watchers and subscriptions)
  // and nothing else, because the registry uses it as the cooperative handover to the instance
  // that replaces this one. `dispose()` is the full teardown a caller or test wants: the same
  // release, this instance's registry entry marked `disposed`, and the owner record stamped with
  // `stoppedAt` (awaited by `session_shutdown`, fired here). Panes are never closed and records are
  // never deleted by either (§7.1 item 4).
  function disposeLocal() {
    if (armed) superseded = true;
    stopHeartbeat();
    if (pollTimer !== null) { disarmTimer(pollTimer); pollTimer = null; }
    detachWorkersBus();
    armed = false;
  }

  function dispose() {
    const wasArmed = armed;
    disposeLocal();
    // The flag is local bookkeeping, so it is set for every caller; the registry entry and the
    // owner record are only touched by an instance that actually armed (§7.1 item 4: a sub or
    // non-armed instance performs no side effect).
    disposed = true;
    if (entry) entry.disposed = true;
    if (wasArmed && reconciler !== null && validBinding(binding)) {
      // The failure is recorded instead of escaping as an unhandled rejection; `session_shutdown`
      // awaits the same call so its ordering stays deterministic.
      reconciler.markStopped().catch(error => record(error, 'shutdown'));
    }
  }

  pi?.on?.('session_start', async (_event, ctx) => {
    // R6: an arming entry point, so it may not guard-return on `!armed`.
    const eligibility = evaluate(ctx);
    if (!eligibility.ok) return; // §7.2: a sub session and an ineligible main stay silent here.
    if (!armed) {
      const outcome = await arm(ctx, eligibility);
      if (outcome.kind !== 'owner') return; // a delegate arms nothing and touches nothing.
    }
    await runAutoPass(ctx, 'session_start');
  });

  // G12: `/new`, `/resume` and fork arrive as `session_switch` in the same process (the factory is not
  // called again), with the new session already on the ctx. The scope follows it at once instead of
  // at the next unrelated event.
  pi?.on?.('session_switch', async (_event, ctx) => {
    if (!armed) return;
    await runAutoPass(ctx, 'session_switch');
  });

  pi?.on?.('session_shutdown', async () => {
    if (!armed) return;
    // R1 order: disposeLocal() (timers and watchers only) -> the `stoppedAt` record -> `disposed`.
    // Panes are never closed and records are never deleted here (§7.1 item 4: pane close 0).
    disposeLocal();
    try { await reconciler?.markStopped(); }
    catch (error) {
      // outcome: without a `stoppedAt` marker the next pass recovers through ESRCH, which is the
      // documented M4 boundary; the failure is kept in state().
      record(error, 'shutdown');
    }
    if (entry) entry.disposed = true;
    disposed = true;
    // outcome: a second `session_shutdown` (or a later `dispose()`) finds `armed === false` and
    // stops at the guard line; the marker is written once with the first stamp.
  });

  pi?.on?.('turn_end', async (_event, ctx) => {
    if (!armed) return;
    await runAutoPass(ctx, 'turn_end');
  });

  pi?.on?.('agent_end', async (_event, ctx) => {
    if (!armed) return;
    await runAutoPass(ctx, 'agent_end');
  });

  pi?.on?.('tool_execution_end', async (event, ctx) => {
    if (!armed) return;
    // A finished `task` job is exactly the background card the bus cannot see (§7.6), so the jobs
    // surface is re-read on that transition even when no dashboard pass follows it.
    if (event?.toolName === 'task') {
      syncJobsFromCtx(ctx);
      scheduleWorkersPublish();
      return;
    }
    if (event?.toolName !== 'todo_write') return;
    await runAutoPass(ctx, 'tool_execution_end');
  });

  pi?.on?.('goal_updated', async (_event, ctx) => {
    if (!armed) return;
    await runAutoPass(ctx, 'goal_updated');
  });

  // The bus carries no ctx, so it drives the retained one (G9). One subscription per measured
  // channel: the workers tracker consumes lifecycle/progress, the retained ctx carries the
  // automatic pass, and every handler is wrapped so a fault becomes a source error, never a throw.
  attachWorkersBus();

  pi?.registerCommand?.(DASHBOARD_COMMAND, {
    description: DASHBOARD_DESCRIPTION,
    handler: async (_args, ctx) => {
      // Arming entry point (R6): eligibility is re-evaluated on every call, exactly one notify
      // follows, and a delegate hands the pass to the registry owner.
      const eligibility = evaluate(ctx);
      if (!eligibility.ok) {
        lastResultCode = `ineligible:${eligibility.reason}`;
        const result = { ok: false, code: lastResultCode, detail: eligibility.detail ?? null };
        notify(ctx, result, 'warn');
        return result;
      }
      // A retired instance answers a stray `/dashboard` by handing it to whoever owns the slot now;
      // it must not re-arm, which would evict a live owner for no reason. When the entry it was
      // replaced by is itself gone (`disposed`), falling through to `arm` is the right answer: the
      // slot is now unowned and this instance is a legitimate candidate again (§7.1 item 3).
      if (!armed && superseded && layoutKey !== null) {
        const current = registryPeek()?.get(layoutKey) ?? null;
        if (current && current !== entry && current.disposed !== true
            && typeof current.runExplicit === 'function') {
          counters.delegated++;
          try { return await current.runExplicit(ctx, null); }
          catch (error) {
            record(error, 'delegate');
            const result = { ok: false, code: 'failed:internal', detail: message(error) };
            notify(ctx, result, 'warn');
            return result;
          }
        }
      }
      let outcome;
      try { outcome = armed ? { kind: 'owner' } : await arm(ctx, eligibility); }
      catch (error) {
        // outcome: a fault while arming (binding seam, registry) is still owed exactly one notify.
        record(error, 'arm');
        lastResultCode = 'failed:internal';
        const result = { ok: false, code: 'failed:internal', detail: message(error) };
        notify(ctx, result, 'warn');
        return result;
      }
      if (outcome.kind === 'invalid') {
        lastResultCode = 'failed:internal';
        const result = { ok: false, code: 'failed:internal', detail: outcome.detail };
        notify(ctx, result, 'warn');
        return result;
      }
      if (outcome.kind === 'delegate') {
        // §7.1 item 3 + LT-4: the delegate runs no pass of its own, hands the call to the registry
        // owner, and warns about the duplicate install ONCE per instance - as a token appended to
        // that single result line, never as a second notify.
        let notice = null;
        if (!duplicateNotified) {
          duplicateNotified = true;
          counters.warnings++;
          notice = 'warn:duplicate-install';
        }
        counters.delegated++;
        try { return await outcome.entry.runExplicit(ctx, notice); }
        catch (error) {
          // outcome: the delegate cannot run the pass either (the owner is gone), so its own
          // result is reported once instead of leaving the command silent.
          record(error, 'delegate');
          const result = { ok: false, code: 'failed:internal', detail: message(error) };
          notify(ctx, result, 'warn', notice);
          return result;
        }
      }
      try { return await runExplicit(ctx); }
      catch (error) {
        // outcome: runExplicit notifies its own result; this is the last resort for a fault in the
        // steps before it (binding, rebind) and it is still one message for this call.
        record(error, 'dashboard');
        const result = { ok: false, code: 'failed:internal', detail: message(error) };
        notify(ctx, result, 'warn');
        return result;
      }
    },
  });

  // ------------------------------------------------------------------ test handle --------------
  // Exactly the agreed shape (the registry entry carries the two extra methods a handover needs).
  return {
    armed: () => armed,
    dispose,
    state: () => ({
      armed, disposed, instanceId, moduleUrl: deps.moduleUrl ?? null,
      rootUrl: rootUrl?.href ?? null, rootPath, stateDir, gen: gen ?? 'dev', language,
      rawLanguage, invalidLanguage, pollMode, binding: binding ? { ...binding } : null, layoutKey,
      scopeKey,
      owner: isSelfOwner(), delegate: delegateTo !== null,
      delegateInstanceId: delegateTo?.instanceId ?? null, duplicateNotified,
      vector: vector ? [...vector] : null, vectorError, lastOwnerPath, heartbeatAt, lastLeaf,
      lastResultCode, lastNotify, superseded,
      // §7.6 for a drill: the workers tracker's own counts, not a copy of the projection file. One
      // `snapshot()` call feeds all three fields so they describe the same instant.
      workers: workersTracker === null ? null : (() => {
        const view = workersTracker.snapshot();
        return { sourceError: view.sourceError, ignored: view.ignored, cards: view.cards.length };
      })(),
      counters: { ...counters }, errors: errors.map((item) => ({ ...item })),
      pruneFailures: pruneFailures.map((item) => ({ ...item })),
    }),
  };
}
