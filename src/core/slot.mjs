// Slot identity, state files and the generation lock.
//
// SCOPE NOTE / PLAN AUTHORITY
//   The task text described base plan 7.5 (a single `slot.lock` file, a >=30 s heartbeat takeover
//   window, and a `fence(lock)` re-read before every mutation). stage-05 R1 explicitly REPLACES
//   7.5 and deletes those concepts, so this module implements R1:
//     * `slots/<layoutKey>/lock/g<12-digit N>.lock` {pid, instanceId, passId} and
//       `g<N>.released`. Both are created with `wx` (O_EXCL) and never modified afterwards;
//       `wx` is the only serialisation point for holders and recoverers alike.
//     * A live holder or an unclassifiable holder is NEVER displaced, however old it is and
//       whatever the heartbeat says. Only cooperative release or proven death (ESRCH) is
//       recovered. `heartbeatAt` is display information on `owner.json`, never a takeover
//       predicate.
//     * There is no `fence()` and no `failed:fenced`. The re-check that R1 does define is step 4
//       of acquire, exported as `generationIsCurrent(lock)`: after creating a generation, list
//       again and step aside if a greater generation exists.
//
// Exports:
//   layoutKeyOf({socket, parentPaneId})          -> 24 hex chars of sha256(JSON([socket, parent]))
//   scopeKeyOf({socket, parentPaneId, sessionId})-> 24 hex chars of sha256(JSON([socket, parent,
//                                                 session]))
//   key8Of(layoutKey)                            -> first 8 chars, the label token
//   labelOf(role, key8)                          -> `GJC Todo · <key8>` / Workers / Progress
//   slotPaths(stateDir, layoutKey)               -> {dir, slot, owner, intent, lockDir, rolesDir,
//                                                   ready(role)}
//   dataPaths(stateDir, scopeKey)                -> {dir, todo, workers, goal, progress}
//   prefsPaths(stateDir, scopeKey)               -> {dir, file(role)}
//   readSlot(path)                              -> {status:'ok', slot} | {status:'absent'} |
//                                                   {status:'corrupt', reason}
//   writeSlot(path, slot)                       -> void
//   quarantineSlot(path, {now})                 -> {path, reason} (renames to slot.json.corrupt-<ts>)
//   readOwner(path) / writeOwner(path, owner)   -> owner.json {schema, pid, instanceId, sessionId,
//                                                   heartbeatAt, stoppedAt?}
//   ownerRecord({pid, instanceId, sessionId, now, stoppedAt})
//   readIntent(path) / writeIntent(path, intent) / clearIntent(path)
//   intentRecord({role, label, tabId, now})      -> {role, label, tabId, at}
//   acquireLock({paths, instanceId, passId, mode, pidAlive, now, io, hooks})
//   releaseLock(lock, {io})
//   generationIsCurrent(lock, {io})
// Constants: SLOT_SCHEMA, OWNER_SCHEMA, HEARTBEAT_MS, LOCK_DIR_NAME, READY_WRITE_MS.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, replaceFile, retryOnWindowsSharing, writeJson } from '../storage.mjs';

export const SLOT_SCHEMA = 'gjc-herdr-dashboard/slot/1';
export const OWNER_SCHEMA = 'gjc-herdr-dashboard/owner/1';
export const HEARTBEAT_MS = 5000;
export const LOCK_DIR_NAME = 'lock';
export const ROLES = ['todo', 'workers', 'progress'];
export const ROLE_LABELS = { todo: 'Todo', workers: 'Workers', progress: 'Progress' };
export const LOCK_FILE_PATTERN = /^g(\d{12})\.(lock|released)$/;

const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

export function layoutKeyOf({ socket, parentPaneId }) {
  return hash([socket, parentPaneId]);
}

export function scopeKeyOf({ socket, parentPaneId, sessionId }) {
  return hash([socket, parentPaneId, sessionId]);
}

export function key8Of(layoutKey) {
  return String(layoutKey).slice(0, 8);
}

export function labelOf(role, key8) {
  const name = ROLE_LABELS[role];
  if (!name) throw Object.assign(new Error(`Unknown dashboard role: ${role}`), { code: 'role' });
  return `GJC ${name} · ${key8}`;
}

export function slotPaths(stateDir, layoutKey) {
  const dir = join(stateDir, 'slots', layoutKey);
  const rolesDir = join(dir, 'roles');
  return {
    dir,
    slot: join(dir, 'slot.json'),
    owner: join(dir, 'owner.json'),
    intent: join(dir, 'intent.json'),
    lockDir: join(dir, LOCK_DIR_NAME),
    rolesDir,
    ready: role => join(rolesDir, `${role}.ready.json`),
  };
}

export function dataPaths(stateDir, scopeKey) {
  const dir = join(stateDir, 'data', scopeKey);
  return {
    dir,
    todo: join(dir, 'todo.json'),
    workers: join(dir, 'workers.json'),
    goal: join(dir, 'goal.json'),
    progress: join(dir, 'progress.json'),
  };
}

export function prefsPaths(stateDir, scopeKey) {
  const dir = join(stateDir, 'prefs', scopeKey);
  return { dir, file: role => join(dir, `${role}.json`) };
}

function validRoleRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (!['pending', 'ready', 'closed'].includes(record.state)) return false;
  if (typeof record.token !== 'string' || record.token.length === 0) return false;
  if (record.paneId !== null && typeof record.paneId !== 'string') return false;
  return true;
}

// A slot whose schema we do not know is indistinguishable from a corrupt one for our purposes:
// T18 quarantines it rather than guessing at a migration.
export function validateSlot(slot) {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return 'not-an-object';
  if (slot.schema !== SLOT_SCHEMA) return `unknown-schema:${String(slot.schema)}`;
  if (typeof slot.layoutKey !== 'string' || slot.layoutKey.length === 0) return 'layoutKey';
  if (!slot.parent || typeof slot.parent !== 'object') return 'parent';
  if (!slot.scope || typeof slot.scope !== 'object') return 'scope';
  if (typeof slot.scope.scopeKey !== 'string' || slot.scope.scopeKey.length === 0) return 'scope.scopeKey';
  if (!slot.roles || typeof slot.roles !== 'object' || Array.isArray(slot.roles)) return 'roles';
  for (const [role, record] of Object.entries(slot.roles)) {
    if (!ROLES.includes(role)) return `roles.${role}`;
    if (!validRoleRecord(record)) return `roles.${role}.shape`;
  }
  return null;
}

export async function readSlot(path) {
  let text;
  try { text = await fs.readFile(path, 'utf8'); }
  catch (error) {
    // outcome: an absent slot file is the T1 precondition (nothing created yet).
    if (error.code === 'ENOENT') return { status: 'absent' };
    return { status: 'corrupt', reason: `read:${error.code ?? error.message}` };
  }
  let slot;
  try { slot = JSON.parse(text); }
  catch (error) { return { status: 'corrupt', reason: `parse:${error.message}` }; }
  const invalid = validateSlot(slot);
  if (invalid) return { status: 'corrupt', reason: invalid, slot };
  return { status: 'ok', slot };
}

export function writeSlot(path, slot) {
  const invalid = validateSlot(slot);
  if (invalid) return Promise.reject(Object.assign(new Error(`Refusing to write an invalid slot: ${invalid}`), { code: 'slot-shape' }));
  return writeJson(path, slot);
}

export async function quarantineSlot(path, { now = Date.now() } = {}) {
  const target = `${path}.corrupt-${now}`;
  try { await replaceFile(path, target); }
  catch (error) {
    if (error.code === 'ENOENT') return { path: target, reason: 'absent' };
    throw error;
  }
  return { path: target, reason: 'quarantined' };
}

export function ownerRecord({ pid, instanceId, sessionId, now = Date.now(), stoppedAt } = {}) {
  const owner = { schema: OWNER_SCHEMA, pid, instanceId, sessionId, heartbeatAt: now };
  if (Number.isFinite(stoppedAt)) owner.stoppedAt = stoppedAt;
  return owner;
}

export function readOwner(path) {
  return readJson(path);
}

export function writeOwner(path, owner) {
  return writeJson(path, owner);
}

export function intentRecord({ role, label, tabId, now = Date.now() } = {}) {
  return { role, label, tabId, at: now };
}

export function readIntent(path) {
  return readJson(path);
}

export function writeIntent(path, intent) {
  return writeJson(path, intent);
}

export async function clearIntent(path) {
  try { await fs.rm(path, { force: true }); }
  catch (error) {
    // outcome: an intent file we cannot delete is reported, never silently ignored.
    return { ok: false, reason: error.code ?? error.message };
  }
  return { ok: true };
}

const generationName = (n, suffix) => `g${String(n).padStart(12, '0')}.${suffix}`;

export function lockFileName(generation) { return generationName(generation, 'lock'); }
export function releasedFileName(generation) { return generationName(generation, 'released'); }

async function readGenerationNames(io, dir) {
  let names;
  try { names = await io.readdir(dir); }
  catch (error) {
    // outcome: no lock directory means generation 0, i.e. nobody ever held this slot.
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const generations = [];
  for (const name of names) {
    const match = LOCK_FILE_PATTERN.exec(name);
    if (match) generations.push({ generation: Number(match[1]), suffix: match[2], name });
  }
  return generations;
}

export async function maxGeneration(io, dir) {
  const entries = await readGenerationNames(io, dir);
  return entries.reduce((max, entry) => Math.max(max, entry.generation), 0);
}

async function fileExists(io, path) {
  try { await io.stat(path); return true; }
  catch (error) {
    // outcome: the "does it exist" question is answered by the stat result alone.
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// R1 step 1: classify the highest generation by first match:
// none -> released -> unknown -> dead -> live. A holder that cannot be classified (empty file,
// unreadable pid state, unknown pid liveness) counts as unknown, and unknown is busy, exactly
// like live: the safe direction is never to displace a holder we cannot prove dead.
export async function classifyGeneration(io, dir, generation, pidAlive = defaultPidAlive) {
  if (generation <= 0) return { state: 'none', generation };
  if (await fileExists(io, join(dir, releasedFileName(generation)))) return { state: 'released', generation };
  let text;
  try { text = await io.readFile(join(dir, lockFileName(generation)), 'utf8'); }
  catch (error) {
    // outcome: a generation with no readable lock file proves nothing, so it is unknown.
    return { state: 'unknown', generation, detail: error.code ?? error.message };
  }
  let body;
  try { body = JSON.parse(text); }
  catch (error) { return { state: 'unknown', generation, detail: `parse:${error.message}` }; }
  if (!body || typeof body !== 'object' || !Number.isSafeInteger(body.pid) || body.pid < 1) {
    return { state: 'unknown', generation, detail: 'pid' };
  }
  let alive;
  try { alive = pidAlive(body.pid); }
  catch (error) {
    // outcome: liveness probing failed, so the holder cannot be proven dead (R1 M3).
    return { state: 'unknown', generation, detail: error.code ?? error.message, holder: body };
  }
  if (alive === true) return { state: 'live', generation, holder: body };
  if (alive === false) return { state: 'dead', generation, holder: body };
  return { state: 'unknown', generation, detail: 'liveness-unavailable', holder: body };
}

// Kept local so this module has no dependency on the liveness module (which owns the exported,
// injectable version). Same contract: true alive/EPERM, false ESRCH, null when unknown.
function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    return null;
  }
}

async function createExclusive(io, path, contents) {
  const handle = await io.open(path, 'wx', 0o600);
  try { await handle.writeFile(contents); }
  finally { await handle.close(); }
}

export function lockPaths(paths) {
  const lockDir = paths.lockDir ?? paths;
  return { lockDir, dir: paths.dir ?? lockDir };
}

export async function acquireLock({ paths, instanceId, passId, mode = 'explicit',
  pidAlive = defaultPidAlive, now = Date.now, io = fs, hooks = {} } = {}) {
  const { lockDir } = lockPaths(paths);
  const call = async name => {
    const hook = hooks[name];
    if (typeof hook === 'function') await hook({ lockDir, mode });
  };
  try { await io.mkdir(lockDir, { recursive: true, mode: 0o700 }); }
  catch (error) {
    // R1 step 3: a pass that cannot even prepare its lock directory must end coded, not throw.
    return { ok: false, reason: 'failed:lock-io', generation: 0, detail: error.code ?? error.message };
  }
  const rounds = mode === 'auto' ? 1 : 2;
  for (let round = 0; round < rounds; round++) {
    const generation = await maxGeneration(io, lockDir);
    const classified = await classifyGeneration(io, lockDir, generation, pidAlive);
    await call('afterClassify');
    if (classified.state === 'live' || classified.state === 'unknown') {
      return { ok: false, reason: 'busy', generation, state: classified.state, detail: classified.detail ?? null, holder: classified.holder ?? null };
    }
    const next = generation + 1;
    const lockPath = join(lockDir, lockFileName(next));
    const releasedPath = join(lockDir, releasedFileName(next));
    const body = JSON.stringify({ pid: process.pid, instanceId, passId, acquiredAt: now() });
    try {
      await createExclusive(io, lockPath, body);
    } catch (error) {
      if (error.code === 'EEXIST') {
        // R1 step 3: an explicit pass retries the whole classification once; an automatic pass
        // steps aside immediately.
        if (mode !== 'auto' && round === 0) continue;
        return { ok: false, reason: 'busy', generation: next, state: 'raced', detail: null };
      }
      // R1 step 3: a write failure after creation leaves a released marker behind so the next
      // pass can move on instead of inheriting an unclassifiable generation.
      try { await createExclusive(io, releasedPath, ''); }
      catch (markerError) {
        return { ok: false, reason: 'failed:lock-io', generation: next, detail: `${error.code ?? error.message}; marker:${markerError.code ?? markerError.message}` };
      }
      return { ok: false, reason: 'failed:lock-io', generation: next, detail: error.code ?? error.message };
    }
    const lock = { generation: next, lockPath, releasedPath, lockDir, instanceId, passId, mode };
    await call('afterLastCheck');
    // R1 step 4: if a greater generation appeared while we were creating ours, we are a stale
    // recoverer. Delete only the file this pass created and step aside with zero mutation.
    const later = await maxGeneration(io, lockDir);
    if (later > next) {
      try { await io.unlink(lockPath); }
      catch (error) {
        // outcome: our own file is already gone; either way we do not own this generation.
        if (error.code !== 'ENOENT') throw error;
      }
      return { ok: false, reason: 'busy', generation: next, state: 'stale-recoverer', detail: null };
    }
    // R1 step 5: collect generations strictly at or below our own minus two.
    const entries = await readGenerationNames(io, lockDir);
    for (const entry of entries) {
      if (entry.generation > next - 2) continue;
      try { await io.unlink(join(lockDir, entry.name)); }
      catch (error) {
        // outcome: a concurrent collector removed it first; nothing else to do for that file.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { ok: true, generation: next, lock };
  }
  return { ok: false, reason: 'busy', generation: 0, state: 'retry-exhausted', detail: null };
}

// R1 step 6: the holder marks its own generation released. Never delete another generation's
// files, never delete our own lock file: an unreleased-but-someone-else's file is the only
// durable evidence a recoverer can classify.
export async function releaseLock(lock, { io = fs } = {}) {
  if (!lock?.releasedPath || !lock.lockDir) return { ok: false, reason: 'no-lock' };
  try {
    await retryOnWindowsSharing(async () => {
      try { await createExclusive(io, lock.releasedPath, ''); }
      catch (error) {
        // outcome: the marker already exists, which is exactly the state we want.
        if (error.code !== 'EEXIST') throw error;
      }
    });
  } catch (error) {
    return { ok: false, reason: 'failed:lock-io', detail: error.code ?? error.message, path: lock.releasedPath };
  }
  return { ok: true, path: lock.releasedPath };
}

// The re-check that R1 defines in place of a mutation-time fence: our generation is still the
// highest one. It is a read, and the safety argument (ii) makes it monotone: once a greater
// generation exists, it stays true, so a false answer never becomes stale.
export async function generationIsCurrent(lock, { io = fs } = {}) {
  if (!lock?.lockDir || !Number.isSafeInteger(lock.generation)) return false;
  return (await maxGeneration(io, lock.lockDir)) <= lock.generation;
}
