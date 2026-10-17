// Unit tests for src/core/data.mjs — the `<state>/data/<scopeKey>/<kind>.json` projection writer
// (plan 7.9: writer is the owner, 200 ms merge; plan 7.1 item 5: only written while the slot still
// carries a non-closed record).
//
// Real temporary directory, injected clock, injected writer. No Herdr, no real clock.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DATA_SCHEMA, createDataWriter } from '../../src/core/data.mjs';
import { dataPaths } from '../../src/core/slot.mjs';

const SCOPE = 'a'.repeat(24);
const OTHER = 'b'.repeat(24);

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gjc-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const projection = extra => ({ schema: 'gjc-herdr-dashboard/todo/1', phases: [],
  empty: false, sourceError: '', ...extra });

async function readTarget(stateDir, scopeKey, kind) {
  try { return JSON.parse(await readFile(join(stateDir, 'data', scopeKey, `${kind}.json`), 'utf8')); }
  catch { return null; }
}

test('a publish lands at <state>/data/<scopeKey>/<kind>.json with the schema and a generatedAt stamp', async t => {
  const stateDir = await scratch(t);
  let clock = 1000;
  const writer = createDataWriter({ stateDir, now: () => clock, delayMs: 0 });
  const outcome = await writer.publish(SCOPE, 'todo', projection());
  assert.deepEqual(outcome, { wrote: true, path: dataPaths(stateDir, SCOPE).todo });
  const stored = await readTarget(stateDir, SCOPE, 'todo');
  assert.equal(stored.schema, 'gjc-herdr-dashboard/todo/1');
  assert.equal(stored.generatedAt, 1000);
  // The caller's own fields survive untouched, and the writer adds no schema of its own choosing.
  assert.deepEqual(stored.phases, []);
  assert.equal(stored.empty, false);
  assert.equal(DATA_SCHEMA, 'gjc-herdr-dashboard/data/1');
  // A different scopeKey is a different file; the projection is never shared across scopes.
  await writer.publish(OTHER, 'todo', projection({ empty: true }));
  assert.equal(await readTarget(stateDir, OTHER, 'todo').then(value => value.empty), true);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo').then(value => value.empty), false);
  // The kind selects the file name (plan 7.9 lists todo/workers/goal/progress).
  await writer.publish(SCOPE, 'goal', projection());
  const paths = dataPaths(stateDir, SCOPE);
  assert.deepEqual((await readdir(paths.dir)).sort(), ['goal.json', 'todo.json']);
  clock = 2000;
  await writer.publish(SCOPE, 'todo', projection());
  assert.equal(await readTarget(stateDir, SCOPE, 'todo').then(value => value.generatedAt), 2000);
});

test('a burst of publishes for one target merges into a single write and the newest value wins', async t => {
  const stateDir = await scratch(t);
  const writer = createDataWriter({ stateDir, now: () => 1, delayMs: 20 });
  const first = writer.publish(SCOPE, 'todo', projection({ empty: true }));
  const second = writer.publish(SCOPE, 'todo', projection({ empty: false }));
  assert.equal(writer.pending(), 1, 'the merge keeps one scheduled write, not two');
  await Promise.all([first, second]);
  assert.equal(await writer.flush(), 1);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo').then(value => value.empty), false);
  // A write that already started is not merged with the next publish: the second one is its own
  // write, so a caller's flush always reports a truthful count.
  await writer.publish(SCOPE, 'todo', projection({ empty: true }));
  assert.equal(await writer.flush(), 2);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo').then(value => value.empty), true);
});

test('flush waits for an in-flight write and reports a failed write instead of swallowing it', async t => {
  const stateDir = await scratch(t);
  let calls = 0;
  const writer = createDataWriter({ stateDir, now: () => 1, delayMs: 0, io: {
    writeJson: async (path, value) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('disk on fire'), { code: 'EIO' });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value), 'utf8');
    },
  } });
  const failed = writer.publish(SCOPE, 'todo', projection());
  await assert.rejects(() => failed, { code: 'EIO' });
  await assert.rejects(() => writer.flush(), { code: 'EIO' });
  assert.equal(calls, 1);
  // A later publish still works; the writer is not latched by the failure.
  await writer.publish(SCOPE, 'todo', projection());
  assert.equal(await writer.flush(), 1);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo').then(value => value.empty), false);
  assert.equal(calls, 2);
});

test('the shouldWrite gate is the caller policy: a closed record means no file is written at all', async t => {
  const stateDir = await scratch(t);
  const writer = createDataWriter({ stateDir, now: () => 1, delayMs: 0 });
  const seen = [];
  const gate = ({ scopeKey, kind }) => { seen.push([scopeKey, kind]); return kind !== 'todo'; };
  assert.deepEqual(await writer.publish(SCOPE, 'todo', projection(), { shouldWrite: gate }),
    { wrote: false, path: dataPaths(stateDir, SCOPE).todo, skipped: true });
  assert.equal(await writer.flush(), 0);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo'), null, 'the gated target does not exist');
  assert.deepEqual(seen, [[SCOPE, 'todo']]);
  // A factory-level gate applies when the call does not override it, and a boolean gate is allowed.
  const booleanWriter = createDataWriter({ stateDir, now: () => 1, delayMs: 0, shouldWrite: false });
  assert.equal((await booleanWriter.publish(SCOPE, 'todo', projection())).skipped, true);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo'), null);
  const openWriter = createDataWriter({ stateDir, now: () => 1, delayMs: 0,
    shouldWrite: ({ kind }) => kind === 'todo' });
  assert.equal((await openWriter.publish(SCOPE, 'todo', projection())).wrote, true);
  assert.equal((await openWriter.publish(SCOPE, 'workers', projection())).skipped, true);
  await openWriter.flush();
  assert.deepEqual((await readdir(dataPaths(stateDir, SCOPE).dir)).sort(), ['todo.json']);
});

test('a malformed target is reported, and a non-object projection is stored verbatim without a stamp', async t => {
  const stateDir = await scratch(t);
  const writer = createDataWriter({ stateDir, now: () => 7, delayMs: 0 });
  await assert.rejects(() => writer.publish('', 'todo', projection()), { code: 'scope-key' });
  await assert.rejects(() => writer.publish(SCOPE, '', projection()), { code: 'data-kind' });
  await assert.rejects(() => writer.publish(null, 'todo', projection()), { code: 'scope-key' });
  await writer.publish(SCOPE, 'todo', null);
  assert.equal(await writer.flush(), 1);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo'), null, 'a bare null is not a projection');
  await writer.publish(SCOPE, 'todo', [1, 2]);
  await writer.flush();
  assert.deepEqual(await readTarget(stateDir, SCOPE, 'todo'), [1, 2], 'an array is not stamped either');
});

test('a slow write is awaited by flush, so a pass cannot end with a half-written projection', async t => {
  const stateDir = await scratch(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writer = createDataWriter({ stateDir, now: () => 1, delayMs: 10, io: {
    writeJson: async (path, value) => {
      await gate;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(value), 'utf8');
    },
  } });
  const publish = writer.publish(SCOPE, 'todo', projection());
  // The write is in flight and cannot finish until the gate opens; flush must therefore not
  // resolve, and the publish must not be reported as written yet.
  let flushed = false;
  const flush = writer.flush().then(value => { flushed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(flushed, false, 'flush is still waiting for the write');
  assert.equal(await readTarget(stateDir, SCOPE, 'todo'), null);
  release();
  assert.equal(await publish.then(() => flush), 1);
  assert.equal(flushed, true);
  assert.equal(await readTarget(stateDir, SCOPE, 'todo').then(value => value.empty), false);
  assert.equal(writer.pending(), 0);
});
