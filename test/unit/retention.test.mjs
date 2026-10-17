// Unit tests for src/retention.mjs. Adapted from the pinned copy source (see
// .sandbox/provenance-A.md) to the scope-directory model of plan 6 row R / A-15.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneExpiredScopes, retentionDaysFromEnv, DAY_MS } from '../../src/retention.mjs';

async function makeStateDir(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'gjc-retention-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const agesAgo = (days, now = Date.now()) => new Date(now - days * DAY_MS);

async function scopeFile(stateDir, kind, scopeKey, name, days, now = Date.now()) {
  const dir = join(stateDir, kind, scopeKey);
  await fs.mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, '{}');
  const at = agesAgo(days, now);
  await utimes(file, at, at);
  return file;
}

test('retention days default to 14 and honor valid overrides', () => {
  assert.equal(retentionDaysFromEnv({}), 14);
  assert.equal(retentionDaysFromEnv({ GJC_HERDR_DASHBOARD_RETENTION_DAYS: ' 7 ' }), 7);
  assert.equal(retentionDaysFromEnv({ GJC_HERDR_DASHBOARD_RETENTION_DAYS: '0.5' }), 0.5);
});

test('zero, negative, blank and non-numeric values disable pruning', () => {
  assert.equal(retentionDaysFromEnv({ GJC_HERDR_DASHBOARD_RETENTION_DAYS: '0' }), 0);
  assert.equal(retentionDaysFromEnv({ GJC_HERDR_DASHBOARD_RETENTION_DAYS: '-3' }), 0);
  assert.equal(retentionDaysFromEnv({ GJC_HERDR_DASHBOARD_RETENTION_DAYS: 'two weeks' }), 0);
  assert.equal(retentionDaysFromEnv({ GJC_HERDR_DASHBOARD_RETENTION_DAYS: '' }), 14);
});

test('pruning removes only expired, inactive scope directories and never touches slots', async t => {
  const stateDir = await makeStateDir(t);
  const now = Date.now();
  // Given four scopes spanning the active/inactive and fresh/expired axes.
  await scopeFile(stateDir, 'data', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'todo.json', 20, now);
  await scopeFile(stateDir, 'data', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'todo.json', 1, now);
  await scopeFile(stateDir, 'data', 'cccccccccccccccccccccccc', 'todo.json', 20, now);
  await scopeFile(stateDir, 'prefs', 'dddddddddddddddddddddddd', 'todo.json', 20, now);
  // A disconnected viewer whose slot still exists keeps its scope: 'dddd' is listed as active
  // exactly because its slot remains on disk even though no heartbeat is fresh (A-15).
  const slotsDir = join(stateDir, 'slots', 'ffffffffffffffffffffffff');
  await fs.mkdir(slotsDir, { recursive: true });
  await writeFile(join(slotsDir, 'slot.json'), '{}');
  const active = new Set(['cccccccccccccccccccccccc', 'dddddddddddddddddddddddd']);
  const result = await pruneExpiredScopes(stateDir, { days: 14, now, activeScopeKeys: active });
  assert.deepEqual(result.removed, ['aaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.deepEqual(new Set(result.kept), new Set(['bbbbbbbbbbbbbbbbbbbbbbbb',
    'cccccccccccccccccccccccc', 'dddddddddddddddddddddddd']));
  assert.deepEqual(await fs.readdir(join(stateDir, 'data')),
    ['bbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccc']);
  assert.deepEqual(await fs.readdir(join(stateDir, 'prefs')), ['dddddddddddddddddddddddd']);
  assert.deepEqual(await fs.readdir(join(stateDir, 'slots')), ['ffffffffffffffffffffffff']);
  assert.deepEqual(JSON.parse(await fs.readFile(join(slotsDir, 'slot.json'), 'utf8')), {});
});

test('each scope directory is decided on its own newest entry, so data and prefs can differ', async t => {
  const stateDir = await makeStateDir(t);
  const now = Date.now();
  // The same scope key: its data projection is stale while its preferences were touched today.
  await scopeFile(stateDir, 'data', 'eeeeeeeeeeeeeeeeeeeeeeee', 'todo.json', 30, now);
  await scopeFile(stateDir, 'prefs', 'eeeeeeeeeeeeeeeeeeeeeeee', 'todo.json', 1, now);
  const result = await pruneExpiredScopes(stateDir, { days: 14, now, activeScopeKeys: new Set() });
  assert.deepEqual(result.removed, ['eeeeeeeeeeeeeeeeeeeeeeee']);
  assert.deepEqual(result.kept, ['eeeeeeeeeeeeeeeeeeeeeeee']);
  assert.deepEqual(await fs.readdir(join(stateDir, 'data')), []);
  assert.deepEqual(await fs.readdir(join(stateDir, 'prefs')), ['eeeeeeeeeeeeeeeeeeeeeeee']);
});

test('the newest entry decides a scope lifetime, and a missing state dir is harmless', async t => {
  const stateDir = await makeStateDir(t);
  const now = Date.now();
  await scopeFile(stateDir, 'data', 'eeeeeeeeeeeeeeeeeeeeeeee', 'todo.json', 30, now);
  await scopeFile(stateDir, 'data', 'eeeeeeeeeeeeeeeeeeeeeeee', 'workers.json', 1, now);
  const result = await pruneExpiredScopes(stateDir, { days: 14, now });
  assert.deepEqual(result.removed, []);
  assert.equal((await fs.readdir(join(stateDir, 'data'))).length, 1);
  // A state dir that does not exist yet is a no-op, not a throw.
  const empty = await pruneExpiredScopes(join(stateDir, 'missing'),
    { days: 14, now, activeScopeKeys: new Set() });
  assert.deepEqual(empty, { removed: [], kept: [], failed: [] });
});

test('pruning is a no-op when retention is disabled', async t => {
  const stateDir = await makeStateDir(t);
  await scopeFile(stateDir, 'data', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'todo.json', 400);
  const disabled = await pruneExpiredScopes(stateDir, { days: 0, now: Date.now() });
  assert.deepEqual(disabled.removed, []);
  const fromEnv = await pruneExpiredScopes(stateDir,
    { days: retentionDaysFromEnv({ GJC_HERDR_DASHBOARD_RETENTION_DAYS: 'nope' }), now: Date.now() });
  assert.deepEqual(fromEnv.removed, []);
  assert.equal((await fs.readdir(join(stateDir, 'data'))).length, 1);
});

test('a failed removal is reported and does not stop other scopes', async t => {
  const stateDir = await makeStateDir(t);
  const now = Date.now();
  const messages = [];
  await scopeFile(stateDir, 'data', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'todo.json', 30, now);
  await scopeFile(stateDir, 'data', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'todo.json', 30, now);
  const rm = fs.rm;
  t.mock.method(fs, 'rm', async (path, ...rest) => {
    if (String(path).includes('aaaaaaaaaaaaaaaaaaaaaaaa')) {
      throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    }
    return rm(path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await pruneExpiredScopes(stateDir,
    { days: 14, now, notify: (message, detail) => messages.push({ message, detail }) });
  assert.deepEqual(result.removed, ['bbbbbbbbbbbbbbbbbbbbbbbb']);
  assert.deepEqual(result.failed, ['aaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.equal(messages.length, 1);
  assert.match(messages[0].message, /EBUSY/);
  assert.equal(messages[0].detail.scopeKey, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  assert.deepEqual(await fs.readdir(join(stateDir, 'data')), ['aaaaaaaaaaaaaaaaaaaaaaaa']);
});
