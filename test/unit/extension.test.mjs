// Unit tests for `extension.mjs`: the §7.1 item 1/2/3 factory contract.
//
// The GJC host calls the default export once per session (main and every sub), so the factory body
// may do exactly one thing: hand the host surface and this module's own URL to `createInstance`.
// It must read no environment value, start no timer, write no file, spawn no process and — the
// property LT-6/AC1.6 turns on — create no registry map. Every side effect belongs to an ARMED
// MAIN instance.
//
// Two classes of effect are observed rather than asserted from prose:
//   * process access -> property descriptors on `process` that RECORD every read for the duration
//     of the factory call (a recording getter, not a throwing one: Node's own internals read
//     `process.env` for colour detection, and a throw would be attributed to the wrong actor),
//   * timers and filesystem writers -> replaced `globalThis.setInterval`/`clearInterval` and
//     wrapped `node:fs`/`node:fs/promises` writers, republished to already-imported ESM consumers
//     with `syncBuiltinESMExports()`.
// The final test proves the traps are non-vacuous: once a handler is allowed to work, the same
// accessors are recorded, so a green run cannot be the result of instrumenting nothing.
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import entry from '../../extension.mjs';
import { DASHBOARD_COMMAND, DASHBOARD_DESCRIPTION, REGISTRY_KEY } from '../../src/host/instance.mjs';

const FsSync = createRequire(import.meta.url)('node:fs');

// Wrap every fs writer a factory body could plausibly reach for and republish the wrapped
// functions to the ESM namespace objects, so a module that imported them at load time observes the
// same call. `stop()` restores the originals and returns what was recorded.
function spyOnFs() {
  const hits = [];
  const restore = [];
  const wrap = (object, name, label) => {
    const original = object[name];
    if (typeof original !== 'function') return;
    object[name] = function wrapped(...args) {
      hits.push(`${label}.${name}`);
      return original.apply(object, args);
    };
    restore.push(() => { object[name] = original; });
  };
  for (const name of ['writeFileSync', 'mkdirSync', 'openSync', 'renameSync', 'rmSync',
    'appendFileSync', 'rmdirSync', 'copyFileSync', 'createWriteStream']) wrap(FsSync, name, 'fs');
  for (const name of ['writeFile', 'mkdir', 'open', 'rename', 'rm', 'rmdir', 'appendFile',
    'copyFile']) wrap(FsSync.promises, name, 'fs.promises');
  syncBuiltinESMExports();
  return () => { for (const undo of restore) undo(); syncBuiltinESMExports(); return hits; };
}

// Record every read AND every write of `process.<key>`: a read is a contract violation too, since
// §7.1 item 1 names both env values and the eligibility inputs (`stdout.isTTY`, `platform`, `pid`).
// The recorded value is still returned, so nothing else in the process changes behaviour.
function recordProcessAccess(keys, hits) {
  const restore = [];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(process, key);
    assert.equal(descriptor?.configurable, true, `process.${key} is not configurable`);
    Object.defineProperty(process, key, { configurable: true, enumerable: descriptor.enumerable,
      get: () => { hits.push(`process.${key}`); return descriptor.get
        ? descriptor.get.call(process) : descriptor.value; },
      set: value => { hits.push(`process.${key}=`); Object.defineProperty(process, key, descriptor);
        process[key] = value; } });
    restore.push(() => Object.defineProperty(process, key, descriptor));
  }
  return () => { for (const undo of restore) undo(); };
}

// A minimal host surface that records exactly what the factory touched. Anything beyond `on` and
// `events.on` (and the single `registerCommand`) would show up in `calls`.
function recordingPi() {
  const calls = [];
  return { calls,
    on: (name, fn) => { calls.push({ method: 'on', name, fn }); },
    registerCommand: (name, definition) => {
      calls.push({ method: 'registerCommand', name, definition });
    },
    events: { on: (channel, fn) => { calls.push({ method: 'events.on', name: channel, fn }); } } };
}

const commandOf = pi => pi.calls.find(call => call.method === 'registerCommand').definition;

test('the default export is a one-argument factory', () => {
  assert.equal(typeof entry, 'function');
  assert.equal(entry.length, 1, 'the host calls it with the host surface and nothing else');
});

test('§7.1 item 1: the factory body reads no host value and creates no registry map', t => {
  delete globalThis[REGISTRY_KEY];
  const stopFs = spyOnFs();
  const fsHits = [];
  const timerHits = [];
  const processHits = [];
  const realTimers = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  globalThis.setInterval = (...args) => { timerHits.push('setInterval'); return realTimers.setInterval(...args); };
  globalThis.clearInterval = (...args) => { timerHits.push('clearInterval'); return realTimers.clearInterval(...args); };
  t.after(() => {
    globalThis.setInterval = realTimers.setInterval;
    globalThis.clearInterval = realTimers.clearInterval;
    stopFs();
    delete globalThis[REGISTRY_KEY];
  });

  // The observation window covers exactly the factory call and nothing else.
  const stopProcess = recordProcessAccess(
    ['env', 'pid', 'platform', 'stdout', 'execPath', 'argv', 'title'], processHits);
  let handle;
  try { handle = entry(recordingPi()); } finally { stopProcess(); }

  assert.deepEqual(processHits, [], `the factory read: ${[...new Set(processHits)].join(', ')}`);
  assert.deepEqual(timerHits, [], `the factory started/stopped a timer: ${timerHits}`);
  assert.equal(Object.hasOwn(globalThis, REGISTRY_KEY), false,
    'the registry map must be created at ARM time, never by the factory');

  // The handle is the documented { armed, dispose, state } and everything it reports is still
  // "nothing happened": no instance id is even minted at factory time.
  assert.deepEqual(Object.keys(handle).sort(), ['armed', 'dispose', 'state']);
  assert.equal(handle.armed(), false);
  const snapshot = handle.state();
  assert.equal(snapshot.armed, false);
  assert.equal(snapshot.disposed, false);
  assert.equal(snapshot.instanceId, null);
  assert.equal(snapshot.pollMode, 'event-only');
  assert.equal(snapshot.binding, null);
  assert.equal(snapshot.layoutKey, null);
  assert.equal(snapshot.scopeKey, null);
  assert.equal(snapshot.owner, false);
  assert.equal(snapshot.delegate, false);
  assert.equal(snapshot.superseded, false);
  assert.equal(snapshot.duplicateNotified, false);
  assert.equal(snapshot.stateDir, null);
  // The entry point passes its own `import.meta.url` as a value (never a dynamic import, SR5), and
  // it is this very module: the ROOT the instance resolves its locale/viewers from travels with it.
  assert.equal(snapshot.moduleUrl, import.meta.resolve('../../extension.mjs'));
  assert.deepEqual(snapshot.counters,
    { explicit: 0, auto: 0, delegated: 0, published: 0, pruned: 0, warnings: 0 });
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.pruneFailures, []);
  assert.equal(JSON.parse(JSON.stringify(snapshot)).armed, false, 'state() is plain JSON');
  // Disposing a never-armed instance is a no-op with no registry entry to mark.
  assert.equal(typeof handle.dispose, 'function');
  handle.dispose();
  assert.equal(handle.state().disposed, true);
  assert.equal(Object.hasOwn(globalThis, REGISTRY_KEY), false,
    'dispose of a never-armed instance must not create the registry either');
  assert.deepEqual(fsHits, [], `the factory wrote files: ${fsHits}`);
});

test('the factory registers the six handlers, three bus channels and the one command', () => {
  const pi = recordingPi();
  entry(pi);
  assert.deepEqual(pi.calls.map(call => `${call.method}:${call.name}`), [
    'on:session_start', 'on:session_shutdown', 'on:turn_end', 'on:agent_end',
    'on:tool_execution_end', 'on:goal_updated',
    'events.on:task:subagent:lifecycle', 'events.on:task:subagent:progress',
    'events.on:task:subagent:event',
    `registerCommand:${DASHBOARD_COMMAND}`,
  ]);
  assert.equal(commandOf(pi).description, DASHBOARD_DESCRIPTION);
  assert.equal(typeof commandOf(pi).handler, 'function');
  for (const call of pi.calls.filter(entryCall => entryCall.method !== 'registerCommand')) {
    assert.equal(typeof call.fn, 'function');
  }
});

test('the access traps are non-vacuous: a handler does read the host surface', async t => {
  delete globalThis[REGISTRY_KEY];
  const pi = recordingPi();
  const handle = entry(pi);
  const processHits = [];
  const stopProcess = recordProcessAccess(['env', 'pid', 'platform', 'stdout'], processHits);
  t.after(() => { stopProcess(); delete globalThis[REGISTRY_KEY]; });

  // An ineligible `/dashboard` evaluates eligibility, which reads the environment, the platform
  // and `stdout.isTTY` — the very accessors the factory test above asserted were untouched.
  const result = await commandOf(pi).handler({}, null);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ineligible:session-kind');
  assert.ok(processHits.includes('process.stdout'), `stdout.isTTY is an eligibility input: ${processHits}`);
  assert.ok(processHits.includes('process.env'), `the env is an eligibility input: ${processHits}`);
  assert.equal(handle.armed(), false);
  assert.equal(Object.hasOwn(globalThis, REGISTRY_KEY), false);
});

test('two factories in one process stay independent and create no shared state', () => {
  delete globalThis[REGISTRY_KEY];
  const first = entry(recordingPi());
  const second = entry(recordingPi());
  assert.notEqual(first, second);
  assert.equal(Object.hasOwn(globalThis, REGISTRY_KEY), false);
  assert.equal(first.armed(), false);
  assert.equal(second.armed(), false);
  first.dispose();
  assert.equal(first.state().disposed, true);
  assert.equal(second.state().disposed, false, 'one handle never disposes another');
  assert.equal(Object.hasOwn(globalThis, REGISTRY_KEY), false);
  delete globalThis[REGISTRY_KEY];
});
