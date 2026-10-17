// Unit tests for src/runtime.mjs. Adapted from the pinned copy source (see
// .sandbox/provenance-A.md), with the env override renamed and the GJC Node floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewerNode, nodeUnavailableText } from '../../src/runtime.mjs';

const reply = (path, version = '24.14.0', bun = false) => ({
  stdout: JSON.stringify({ runtime: 'gjc-herdr-dashboard-node', path, version, bun }),
});

test('a compiled non-Node host uses a probed Node on PATH instead of its own binary', async () => {
  const calls = [];
  const node = await resolveViewerNode({ env: {}, execPath: '/tmp/binary-runtime/gjc/gjc',
    run: async (command, args) => {
      calls.push(command);
      assert.equal(args[0], '--eval');
      return reply('/opt/node/bin/node');
    } });
  assert.deepEqual(calls, ['node']);
  assert.equal(node, '/opt/node/bin/node');
});

test('an ordinary Node host keeps its validated absolute runtime', async () => {
  const calls = [];
  assert.equal(await resolveViewerNode({ env: {}, execPath: '/opt/node/bin/node',
    run: async command => { calls.push(command); return reply(command); } }), '/opt/node/bin/node');
  assert.deepEqual(calls, ['/opt/node/bin/node']);
  // node.exe on win32 is recognised the same way.
  assert.equal(await resolveViewerNode({ env: {}, execPath: 'C:\\nodejs\\node.exe',
    run: async command => reply(command) }), 'C:\\nodejs\\node.exe');
});

test('an explicit GJC node path takes precedence and never silently falls back', async () => {
  const calls = [];
  await assert.rejects(resolveViewerNode({ env: { GJC_HERDR_DASHBOARD_NODE: '/missing/node' },
    execPath: '/usr/bin/node',
    run: async command => { calls.push(command); throw new Error('ENOENT'); } }), /Node\.js 24/);
  assert.deepEqual(calls, ['/missing/node']);
  assert.equal(await resolveViewerNode({ env: { GJC_HERDR_DASHBOARD_NODE: '/opt/Node Runtime/node' },
    run: async command => reply(command) }), '/opt/Node Runtime/node');
});

test('an unsupported host Node falls back to PATH and rejects non-Node probe responses', async () => {
  assert.equal(await resolveViewerNode({ env: {}, execPath: '/old/node',
    run: async command => command === '/old/node' ? reply(command, '22.0.0') : reply('/new/node') }), '/new/node');
  for (const result of [reply('/old/node', '22.0.0'), reply('/bun', '24.0.0', true),
    { stdout: 'gjc dev build' }, reply('node'), { stdout: '{}' }, reply('/opt/node', '24.0')]) {
    await assert.rejects(resolveViewerNode({ env: {}, execPath: '/compiled/gjc', language: 'ko',
      run: async () => result }), /Node\.js 24 이상/);
  }
});

test('the failure text is localised through the injected message hook, defaulting to English', async () => {
  const seen = [];
  await assert.rejects(resolveViewerNode({ env: {}, execPath: '/compiled/gjc', language: 'zh-cn',
    message: language => { seen.push(language); return `ERR:${language}`; },
    run: async () => { throw new Error('ENOENT'); } }), /ERR:zh-cn/);
  assert.deepEqual(seen, ['zh-cn']);
  // No hook: the English default, and no dependency on the i18n module.
  assert.equal(Object.keys(nodeUnavailableText).sort().join(','), 'en,ko,zh-cn');
  await assert.rejects(resolveViewerNode({ env: {}, execPath: '/compiled/gjc', language: 'fr',
    run: async () => { throw new Error('ENOENT'); } }), new RegExp(nodeUnavailableText.en.slice(0, 20)));
});

test('the real Node probe returns an executable runtime', async () => {
  assert.equal(await resolveViewerNode({ env: { ...process.env, GJC_HERDR_DASHBOARD_NODE: process.execPath } }),
    process.execPath);
});
