// Atomic JSON state files (plan 7.9: "write to tmp, then rename; retry on EPERM").
// Adapted from the pinned copy source (see PROVENANCE.md, "Lane A — core state").
//
// Exports:
//   readJson(path)             -> parsed value; null when the file does not exist. Other read or
//                                 parse errors are rethrown unchanged.
//   readJsonOr(path, fallback) -> parsed value, or `fallback` when the file does not exist.
//   writeJson(path, value)     -> void. Creates parent directories (0700), writes a sibling
//                                 temp file (0600) and renames it over the target.
//   replaceFile(source, target)-> void. Bounded retry of a rename that Windows denies while a
//                                 reader/watcher holds the target (EPERM/EACCES/EBUSY).
//   retryOnWindowsSharing(op)  -> result of `op()`; same bounded retry for any filesystem
//                                 operation that can lose a Windows sharing race.
// Every other error escapes after the temp file is removed, so the previous snapshot stays
// intact and no temp file leaks.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const WINDOWS_SHARING_CODES = ['EPERM', 'EACCES', 'EBUSY'];
const REPLACE_ATTEMPTS = 5;

export async function retryOnWindowsSharing(operation, { attempts = REPLACE_ATTEMPTS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      // Windows can deny a file operation while a watcher or reader holds the target. Keep the
      // previous snapshot intact, bound the retries, and let permanent errors escape.
      if (process.platform !== 'win32' || !WINDOWS_SHARING_CODES.includes(error.code) ||
          attempt === attempts) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}

export async function replaceFile(source, target) {
  await retryOnWindowsSharing(() => rename(source, target));
}

export async function readJson(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    // outcome: an absent state file is a normal "nothing written yet" answer.
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

export async function readJsonOr(path, fallback) {
  const value = await readJson(path);
  return value === null ? fallback : value;
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await replaceFile(temporary, path);
  } catch (error) {
    try { await rm(temporary, { force: true }); }
    catch (cleanupError) {
      // outcome: the temp file leaks, but the primary write error must stay the surfaced one.
      error.cause = cleanupError;
    }
    throw error;
  }
}
