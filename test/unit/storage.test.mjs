// Unit tests for src/storage.mjs. Adapted from the pinned copy source (see
// .sandbox/provenance-A.md). Windows-only retry behaviour is asserted on win32; every other
// platform asserts the fail-closed branch.
//
// Monkeypatching is done by direct assignment plus restore rather than `t.mock.method`, because
// the `node:fs/promises` namespace object does not reliably accept `t.mock.method` on this host.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readJson, readJsonOr, replaceFile, writeJson } from '../../src/storage.mjs';

async function scratch(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'gjc-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// Replaces filesystem functions for the duration of `body`, then restores them.
async function withFs(t, overrides, body) {
  const originals = {};
  for (const [name, replacement] of Object.entries(overrides)) {
    originals[name] = fs[name];
    fs[name] = replacement;
  }
  syncBuiltinESMExports();
  try { return await body(); }
  finally {
    for (const [name, original] of Object.entries(originals)) fs[name] = original;
    syncBuiltinESMExports();
    t.diagnostic(`restored: ${Object.keys(originals).join(',')}`);
  }
}

test('readJson treats an absent file as null but never swallows a real read error', async t => {
  const directory = await scratch(t);
  assert.equal(await readJson(join(directory, 'missing.json')), null);
  const directoryPath = join(directory, 'a-directory.json');
  await fs.mkdir(directoryPath);
  // A directory is not "nothing written yet", so reading one must surface instead of returning null.
  await assert.rejects(readJson(directoryPath));
  const corrupt = join(directory, 'corrupt.json');
  await fs.writeFile(corrupt, '{ not json');
  await assert.rejects(readJson(corrupt), SyntaxError);
  await assert.rejects(readJsonOr(corrupt, 'fallback'), SyntaxError);
  assert.equal(await readJsonOr(join(directory, 'missing.json'), { kept: true }).then(v => v.kept), true);
});

test('readJson round-trips a nested Korean value through writeJson without leaking a temp file', async t => {
  const directory = await scratch(t);
  const file = join(directory, 'nested', 'state.json');
  const value = { schema: 'gjc-herdr-dashboard/todo/1', empty: false,
    phases: [{ name: '한글 공백', tasks: [{ content: '작업', status: 'pending' }] }] };
  await writeJson(file, value);
  assert.deepEqual(await readJson(file), value);
  assert.deepEqual(await fs.readdir(join(directory, 'nested')), ['state.json']);
});

test('atomic replacement survives a transient Windows sharing violation', async t => {
  const directory = await scratch(t);
  const file = join(directory, 'state.json');
  await writeJson(file, { generation: 1 });
  const rename = fs.rename;
  let calls = 0;
  await withFs(t, { rename: async (...args) => {
    if (++calls === 1) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    return rename(...args);
  } }, async () => {
    if (process.platform === 'win32') {
      // When the one-shot denial is retried, the snapshot is replaced and no temp file leaks.
      await writeJson(file, { generation: 2 });
      assert.equal(calls, 2);
      assert.deepEqual(await readJson(file), { generation: 2 });
      assert.deepEqual(await fs.readdir(directory), ['state.json']);
    } else {
      // Then off Windows the sharing code is not retried at all, and the old snapshot survives.
      await assert.rejects(writeJson(file, { generation: 2 }), { code: 'EPERM' });
      assert.equal(calls, 1);
      assert.deepEqual(await readJson(file), { generation: 1 });
      assert.deepEqual(await fs.readdir(directory), ['state.json']);
    }
  });
});

test('permanent replacement failures preserve the previous snapshot, surface the error, and bound retries', async t => {
  const directory = await scratch(t);
  const file = join(directory, 'state.json');
  await writeJson(file, { generation: 1 });
  let calls = 0;
  await withFs(t, { rename: async () => {
    calls++;
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  } }, async () => {
    await assert.rejects(writeJson(file, { generation: 2 }), { code: 'EPERM' });
  });
  // Exactly one attempt off Windows; the win32 retry loop is bounded at five retries.
  assert.equal(calls, process.platform === 'win32' ? 6 : 1);
  assert.deepEqual(await readJson(file), { generation: 1 });
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
});

test('a cleanup failure preserves the primary write error and exposes the cleanup cause', async t => {
  const directory = await scratch(t);
  const file = join(directory, 'state.json');
  await writeJson(file, { generation: 1 });
  const primary = Object.assign(new Error('replacement failed'), { code: 'ENOSPC' });
  const cleanup = Object.assign(new Error('temporary file locked'), { code: 'EPERM' });
  await withFs(t, {
    rename: async () => { throw primary; },
    rm: async () => { throw cleanup; },
  }, async () => {
    await assert.rejects(writeJson(file, { generation: 2 }), error => {
      assert.equal(error, primary);
      assert.equal(error.cause, cleanup);
      return true;
    });
  });
  assert.deepEqual(await readJson(file), { generation: 1 });
});

test('replaceFile is the exported retry wrapper and reports a missing source honestly', async t => {
  const directory = await scratch(t);
  const source = join(directory, 'source.tmp');
  const target = join(directory, 'target.json');
  await fs.writeFile(source, '{}');
  await replaceFile(source, target);
  assert.deepEqual(await fs.readdir(directory), ['target.json']);
  await assert.rejects(replaceFile(join(directory, 'gone.tmp'), target), { code: 'ENOENT' });
  // A denied replacement is retried under the same bound as writeJson, then reported.
  let calls = 0;
  await withFs(t, { rename: async () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } },
    async () => { await assert.rejects(replaceFile(target, join(directory, 'other.json')), { code: 'EBUSY' }); });
  assert.equal(calls, process.platform === 'win32' ? 6 : 1);
});
