// Retention of derived per-scope state (plan 6 row R, A-15). Only `data/<scopeKey>/` and
// `prefs/<scopeKey>/` are pruned; `slots/` is never touched. Adapted from the pinned copy
// source (see .sandbox/provenance-A.md).
//
// Exports:
//   retentionDaysFromEnv(env)  -> retention window in days. `GJC_HERDR_DASHBOARD_RETENTION_DAYS`
//                                 override; default 14. Missing/blank -> 14. Non-numeric or
//                                 <= 0 -> 0, which DISABLES pruning (it never deletes
//                                 everything).
//   pruneExpiredScopes(stateDir, {activeScopeKeys, now, days, notify}) -> Promise<{removed,
//                                 kept, failed}>.
//     A scope directory is removed only when (a) its scope key is not in `activeScopeKeys` and
//     (b) its newest entry mtime is older than `now - days * 86400000`. A missing state
//     directory is a no-op. Removal failures are reported through `notify(message,
//     {scopeKey, directory})` and never stop the remaining scopes.
//     Active means: a slot whose viewer heartbeat is at most 15 s old, plus the scope of the
//     current owner. A disconnected viewer whose slot still exists keeps its scope (A-15), so
//     callers must pass every slot-derived scope key, not only the heartbeat-fresh ones.
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_RETENTION_DAYS = 14;
export const DAY_MS = 86400000;
export const SCOPE_KINDS = ['data', 'prefs'];

export function retentionDaysFromEnv(env = process.env) {
  const raw = env.GJC_HERDR_DASHBOARD_RETENTION_DAYS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  // Zero, negative and non-numeric values disable pruning instead of deleting everything.
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days;
}

async function newestMtime(directory) {
  let entries;
  try { entries = await readdir(directory); }
  catch (error) {
    // outcome: a directory that vanished under us is treated as having no content.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let newest = null;
  const paths = entries.map(name => join(directory, name));
  if (paths.length === 0) {
    const info = await stat(directory);
    return info.mtimeMs;
  }
  for (const path of paths) {
    try {
      const info = await stat(path);
      const value = info.mtimeMs;
      if (newest === null || value > newest) newest = value;
    } catch (error) {
      // outcome: an entry that disappears mid-scan cannot extend the scope's lifetime.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return newest;
}

export async function pruneExpiredScopes(stateDir, { activeScopeKeys = new Set(), now = Date.now(),
  days, notify = () => {} } = {}) {
  const result = { removed: [], kept: [], failed: [] };
  if (!(days > 0)) return result;
  const deadline = now - days * DAY_MS;
  const active = activeScopeKeys instanceof Set ? activeScopeKeys : new Set(activeScopeKeys);
  for (const kind of SCOPE_KINDS) {
    const root = join(stateDir, kind);
    let names;
    try { names = await readdir(root); }
    catch (error) {
      // outcome: no data/ or prefs/ directory yet means nothing to prune.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const scopeKey of names) {
      const directory = join(root, scopeKey);
      if (active.has(scopeKey)) { result.kept.push(scopeKey); continue; }
      let newest;
      try {
        const info = await stat(directory);
        if (!info.isDirectory()) { result.kept.push(scopeKey); continue; }
        newest = await newestMtime(directory);
      } catch (error) {
        // outcome: the scope disappeared between listing and inspection; nothing to prune.
        if (error.code === 'ENOENT') continue;
        result.failed.push(scopeKey);
        notify(`${error.message}`, { scopeKey, directory });
        continue;
      }
      if (newest === null || newest > deadline) { result.kept.push(scopeKey); continue; }
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
        result.removed.push(scopeKey);
      } catch (error) {
        result.failed.push(scopeKey);
        notify(`${error.message}`, { scopeKey, directory });
      }
    }
  }
  return result;
}
