// Unit tests for src/core/launch.mjs — the plan 7.3 launch sequence, its preflight failures, the
// FP1/FP2/FP4/FP5 crash failpoints (there is no FP3: the launch never renames a pane), the shell
// quoting/trailer and the LT-8 run-target rule.
//
// Every test drives a real temporary state directory plus the shared fake Herdr/clock/process
// table from ./fake-herdr.mjs. No real Herdr, no real clock, no real pane, no owner home.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSlot, slotPaths } from '../../src/core/slot.mjs';
import { CRASH_FAIL_POINTS, directionBetween, launchRole, preflight, readFailpoints,
  resolveRoleViewerPath, shellTrailer, viewerArgs, viewerCommand } from '../../src/core/launch.mjs';
import { createFakeClock, createFakeHerdr, createPassTracer } from './fake-herdr.mjs';

const KEY = 'a'.repeat(24);
const VIEWER = fileURLToPath(new URL('../../src/viewers/todo/viewer.mjs', import.meta.url));
const NODE = process.execPath;

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'gjc-launch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function fixture({ stateDir, clock = createFakeClock(), fake = null, failpoint = undefined } = {}) {
  const fakeHerdr = fake ?? createFakeHerdr({ parentPaneId: 'w1:p1' });
  const tracer = createPassTracer(fakeHerdr.herdr);
  const paths = slotPaths(stateDir, KEY);
  const binding = { socket: '/tmp/h.sock', parentPaneId: 'w1:p1', tabId: 'w1:t1', sessionId: 's-1' };
  const launch = overrides => tracer.inPass('current', () => launchRole({
    herdr: tracer.herdr,
    paths,
    layoutKey: KEY,
    stateDir,
    role: 'todo',
    token: 'tok-1',
    parent: { socket: binding.socket, paneId: binding.parentPaneId, tabId: binding.tabId },
    scope: { sessionId: 's-1', scopeKey: 'k'.repeat(24), scopeEpoch: 1, language: 'ko' },
    viewerPath: VIEWER,
    nodePath: NODE,
    vector: ['herdr.exe'],
    now: clock.now,
    failpoint,
    env: {},
    ...overrides,
  }));
  return { fake: fakeHerdr, tracer, paths, binding, launch };
}

// ---------------------------------------------------------------------------- preflight ----
test('preflight resolves node, viewer and the herdr vector and fails coded with zero panes', async t => {
  const stateDir = await scratch(t);
  const fake = createFakeHerdr();
  const ok = await preflight({
    env: {},
    checkNode: async () => ({ ok: true, nodePath: NODE }),
    nodePath: null,
    viewerPath: VIEWER,
    resolveVector: () => ['herdr.exe'],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.nodePath, NODE);
  assert.deepEqual(ok.vector, ['herdr.exe']);
  assert.equal(ok.crash, null);

  // Nothing is created for any preflight failure (plan 7.3 item 1).
  const before = fake.paneIds();
  const base = { env: {}, viewerPath: VIEWER, resolveVector: () => ['herdr.exe'] };
  const node = async () => ({ ok: true, nodePath: NODE });
  const cases = [
    [{ ...base, checkNode: async () => ({ ok: false, reason: 'no-node' }) }, 'failed:node'],
    [{ ...base, checkNode: async () => ({ ok: true, nodePath: 'relative/node' }) }, 'failed:node'],
    [{ ...base, checkNode: async () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); } },
      'failed:node'],
    [{ ...base, checkNode: node, viewerPath: 'viewer.mjs' }, 'failed:viewer'],
    [{ ...base, checkNode: node, viewerAccess: () => null }, 'failed:viewer'],
    [{ ...base, checkNode: node,
      resolveVector: () => { throw Object.assign(new Error('missing'), { code: 'herdr-missing' }); } },
    'failed:herdr'],
    [{ ...base, checkNode: node, resolveVector: () => [] }, 'failed:herdr'],
  ];
  for (const [options, code] of cases) {
    const result = await preflight(options);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.code, code, `${code}: ${JSON.stringify(result)}`);
  }
  // The failpoint check comes first of all: an unknown value never even resolves node or viewer.
  assert.equal((await preflight({ ...base, checkNode: node,
    env: { GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT: 'nope' } })).code, 'failed:failpoint');
  assert.deepEqual(fake.paneIds(), before);
  // A preflight failure through the real entry point leaves the state directory empty too.
  const fx = fixture({ stateDir, fake });
  const failed = await fx.launch({ checkNode: async () => ({ ok: false, reason: 'x' }) });
  assert.equal(failed.code, 'failed:node');
  assert.equal(await readFilePath(fx.paths.slot), null);
});

const readFilePath = async path => {
  try { return await readFile(path, 'utf8'); }
  catch { return null; }
};

test('readFailpoints rejects unknown values before the split (stage-05 R3) and accepts fp5', () => {
  assert.deepEqual(readFailpoints({}), { ok: true, crash: null, viewerFailpoint: null });
  assert.deepEqual(readFailpoints({ GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT: 'fp2' }),
    { ok: true, crash: 'fp2', viewerFailpoint: null });
  assert.deepEqual(readFailpoints({ GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT: 'ready-delay-25s' }),
    { ok: true, crash: null, viewerFailpoint: 'ready-delay-25s' });
  // fp5 is spelled as a crash name in the task text and as a viewer failpoint in R3; both work.
  assert.deepEqual(readFailpoints({ GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT: 'fp5' }),
    { ok: true, crash: 'fp5', viewerFailpoint: 'ready-delay-25s' });
  const bad = readFailpoints({ GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT: 'fp9' });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /fp9/);
  assert.equal(readFailpoints({ GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT: 'nope' }).ok, false);
  // The rename step is gone, so the crash list has no point after it any more.
  assert.deepEqual(CRASH_FAIL_POINTS, ['fp1', 'fp2', 'fp4', 'fp5']);
});

test('viewer args, quoting and trailer cover the required flags and a Korean path with spaces', () => {
  const args = viewerArgs({ stateDir: 'C:/한글 공백/state', layoutKey: KEY, role: 'todo',
    token: 'tok', paneId: 'w1:p9', language: 'ko' });
  assert.deepEqual(args, ['--state', 'C:/한글 공백/state', '--layout', KEY, '--role', 'todo',
    '--token', 'tok', '--pane', 'w1:p9', '--lang', 'ko']);
  assert.deepEqual(viewerArgs({ stateDir: 's', layoutKey: KEY, role: 'todo', token: 't',
    paneId: 'p' }), ['--state', 's', '--layout', KEY, '--role', 'todo', '--token', 't', '--pane', 'p']);
  assert.deepEqual(viewerArgs({ stateDir: 's', layoutKey: KEY, role: 'todo', token: 't',
    paneId: 'p', failpoint: 'ready-delay-25s' }).slice(-2), ['--failpoint', 'ready-delay-25s']);
  assert.equal(shellTrailer('powershell'), '; exit');
  assert.equal(shellTrailer('cmd'), '& exit');
  const command = viewerCommand({ nodePath: NODE, viewerPath: 'C:/한글 공백/viewer.mjs',
    stateDir: 'C:/한글 공백/state', layoutKey: KEY, role: 'todo', token: 't', paneId: 'w1:p9',
    language: 'ko' }, 'win32');
  assert.match(command, /^& '/);
  assert.match(command, /; exit$/);
  assert.ok(command.includes("'C:/한글 공백/viewer.mjs'"));
  const posix = viewerCommand({ nodePath: '/usr/bin/node', viewerPath: "/tmp/it's/v.mjs",
    stateDir: '/tmp/s', layoutKey: KEY, role: 'todo', token: 't', paneId: 'w1:p9' }, 'linux');
  assert.ok(posix.endsWith('; exit'));
  assert.ok(posix.includes("'/tmp/it'\\''s/v.mjs'"));
  // The run target may never be anything but the absolute viewer entry point.
  assert.throws(() => resolveRoleViewerPath({ viewerPath: { todo: 'relative.mjs' }, role: 'todo' }),
    { code: 'viewer' });
  assert.throws(() => resolveRoleViewerPath({ viewerPath: {}, role: 'todo' }), { code: 'viewer' });
  assert.equal(resolveRoleViewerPath({ viewerPath: { todo: VIEWER }, role: 'todo' }), VIEWER);
});

test('directionBetween reads the axis that actually differs and stays silent when it does not', () => {
  const here = { x: 10, y: 0, width: 20, height: 10 };
  assert.equal(directionBetween(here, { ...here, x: 0 }), 'left');
  assert.equal(directionBetween(here, { ...here, x: 30 }), 'right');
  assert.equal(directionBetween(here, { ...here, y: 0, x: 10 }), null);
  assert.equal(directionBetween(null, here), null);
});

// ---------------------------------------------------------------------- happy path ---------
test('the launch sequence issues split, process-info and run in plan 7.3 order', async t => {
  const stateDir = await scratch(t);
  const clock = createFakeClock();
  const fx = fixture({ stateDir, clock });
  const result = await fx.launch();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.code, 'opened');
  assert.deepEqual(result.splitPaneIds, [result.paneId]);
  const verbs = fx.tracer.verbs();
  const order = verbs.map((verb, index) => ({ verb, index }));
  const at = verb => order.find(entry => entry.verb === verb)?.index;
  assert.ok(at('pane split') < at('pane process-info'));
  assert.ok(at('pane process-info') < at('pane run'));
  // No manual pane label: Herdr would draw it on the border and leave a gap, so the launch never
  // issues `pane rename` and the pane keeps Herdr's own null label.
  assert.equal(verbs.includes('pane rename'), false);
  assert.equal(fx.fake.paneLabel(result.paneId), null);
  // --no-focus is mandatory (plan 7.3 item 8) and the run target is the split's pane.
  const splitCall = fx.tracer.trace.find(entry => entry.argv[1] === 'split');
  assert.ok(splitCall.argv.includes('--no-focus'));
  const runCall = fx.tracer.trace.find(entry => entry.argv[1] === 'run');
  assert.equal(runCall.argv[2], result.paneId);
  assert.deepEqual(fx.tracer.record.runTargets, fx.tracer.record.splitPaneIds);
  // The command carries the node, the viewer and the required flags, and no send-text/send-keys.
  assert.ok(runCall.argv[3].includes(NODE));
  assert.ok(runCall.argv[3].includes('--role'));
  assert.ok(runCall.argv[3].includes('--token'));
  assert.ok(runCall.argv[3].includes('--pane'));
  assert.ok(runCall.argv[3].endsWith('; exit'));
  assert.deepEqual(fx.tracer.verbs().filter(verb => /send-text|send-keys/.test(verb)), []);
  // The pending record landed in slot.json, the intent file is gone (step 6 before step 7).
  const stored = await readSlot(fx.paths.slot);
  assert.equal(stored.status, 'ok');
  const record = stored.slot.roles.todo;
  assert.equal(record.state, 'pending');
  assert.equal(record.paneId, result.paneId);
  assert.equal(record.shellPid, fx.fake.shellOf(result.paneId));
  assert.equal(record.token, 'tok-1');
  assert.equal(record.pendingSince, clock.now());
  assert.equal(await readFilePath(fx.paths.intent), null);
  // The parent pane was never renamed, never closed and never had a command run in it.
  assert.equal(fx.fake.paneLabel('w1:p1'), 'shell');
  assert.equal(fx.fake.commandOf('w1:p1'), null);
  // The record is the whole identity: paneId + tabId (+ shellPid for O+), no label field.
  assert.deepEqual(Object.keys(record).sort(),
    ['paneId', 'pendingSince', 'shellPid', 'state', 'tabId', 'token']);
  assert.equal(record.tabId, 'w1:t1');
  assert.equal('label' in result.record, false, 'the record carries no label field');
});

test('a launch never issues pane rename and leaves the pane label null', async t => {
  const stateDir = await scratch(t);
  const fx = fixture({ stateDir });
  const result = await fx.launch();
  assert.equal(result.ok, true, JSON.stringify(result));
  // Panes carry no manual label: Herdr draws it on the pane border as " " + label + " ", which
  // punches a gap into the border line, so the label is gone and paneId + tabId is the identity.
  assert.deepEqual(fx.tracer.verbs().filter(verb => verb === 'pane rename'), []);
  assert.equal(fx.fake.paneLabel(result.paneId), null, 'Herdr keeps its own (absent) label');
  assert.equal(result.label, undefined, 'the result carries no label field');
  // The pane is still identifiable the way the product now identifies it.
  assert.equal(result.record.paneId, result.paneId);
  assert.equal(result.record.tabId, 'w1:t1');
  const listed = (await fx.fake.herdr('pane', 'list')).panes.find(pane => pane.pane_id === result.paneId);
  assert.equal(listed.tab_id, result.record.tabId);
});

test('a split failure is one failed:herdr-split with no pane and no leftover intent (LT-1)', async t => {
  const stateDir = await scratch(t);
  const fake = createFakeHerdr({ failures: { split: { code: 'herdr_error', times: 1 } } });
  const fx = fixture({ stateDir, fake });
  const first = await fx.launch();
  assert.equal(first.ok, false);
  assert.equal(first.code, 'failed:herdr-split');
  assert.deepEqual(first.splitPaneIds, []);
  assert.equal(await readFilePath(fx.paths.intent), null);
  assert.equal(await readFilePath(fx.paths.slot), null);
  assert.deepEqual(fake.paneIds(), ['w1:p1']);
  // The same process tries again: nothing is latched, so the next pass opens.
  const second = await fx.launch();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.code, 'opened');
  assert.notEqual(second.paneId, 'w1:p1');
});

test('a split that never answers keeps the intent and reports partial:timeout', async t => {
  const stateDir = await scratch(t);
  const fake = createFakeHerdr();
  const fx = fixture({ stateDir, fake });
  // The per-call limit belongs to the caller (the reconciler wraps `herdr`, plan 7.5); this wrapper
  // makes a hanging call fail exactly the way that wrapper does.
  const herdr = fake.herdr;
  const limited = async (...args) => {
    const verb = args[0] === 'pane' ? args[1] : args[0];
    const issued = herdr(...args);
    if (verb !== 'split') return issued;
    // The fake recorded the call and never answers; the caller's per-call limit is what ends it.
    issued.then(() => undefined, () => undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('no reply'), { code: 'timeout' })), 20);
      timer.unref?.();
      void resolve;
    });
  };
  const first = await fx.launch({ herdr: limited });
  assert.equal(first.ok, false);
  assert.equal(first.code, 'partial:timeout');
  assert.equal(first.detail, 'split:timeout');
  assert.deepEqual(first.splitPaneIds, []);
  // The intent survives because Herdr may have created a pane we never learned about; the next
  // pass must be able to say "interrupted launch" rather than silently orphaning it.
  assert.notEqual(await readFilePath(fx.paths.intent), null);
  assert.equal(await readFilePath(fx.paths.slot), null);
  assert.equal(fake.verbsOf(fake.calls).includes('pane split'), true, 'the call was really issued');
  // The fake did create the pane (a real Herdr may or may not have); the point is that this pass
  // never claims it, never labels it and never records it, so the next pass must resolve it from
  // the intent, not from a record.
  assert.equal(fake.paneLabel('w1:p2'), null, 'the unclaimed pane carries no label');
  assert.equal(fake.commandOf('w1:p2'), null, 'and no command');
});

test('a failure after the split keeps the evidence the FP table names and never re-enters a pane', async t => {
  const stateDir = await scratch(t);
  const clock = createFakeClock();
  // fp1: a record-less, label-less pane plus the intent -> the next pass sees T19.
  const fp1 = fixture({ stateDir, clock, failpoint: 'fp1' });
  const one = await fp1.launch();
  assert.equal(one.code, 'failed:failpoint');
  assert.equal(one.detail, 'fp1:after-split');
  assert.notEqual(await readFilePath(fp1.paths.intent), null);
  assert.equal(await readFilePath(fp1.paths.slot), null);
  assert.equal(fp1.fake.paneLabel(one.paneId), null);
  // fp2: the record is written and the intent is gone; the pane still carries no label.
  const fp2 = fixture({ stateDir: await scratch(t), clock, failpoint: 'fp2' });
  const two = await fp2.launch();
  assert.equal(two.detail, 'fp2:after-record');
  assert.equal(fp2.fake.paneLabel(two.paneId), null);
  assert.equal((await readSlot(fp2.paths.slot)).slot.roles.todo.state, 'pending');
  assert.equal(await readFilePath(fp2.paths.intent), null);
  // fp4: the viewer command is in the pane and the pane still carries no label of ours.
  const fp4 = fixture({ stateDir: await scratch(t), clock, failpoint: 'fp4' });
  const four = await fp4.launch();
  assert.equal(four.detail, 'fp4:after-run');
  assert.notEqual(fp4.fake.commandOf(four.paneId), null);
  assert.equal(fp4.fake.paneLabel(four.paneId), null);
  // fp5: a normal launch whose viewer is told to be 25 s late (R3).
  const fp5 = fixture({ stateDir: await scratch(t), clock, failpoint: 'fp5' });
  const five = await fp5.launch();
  assert.equal(five.ok, true);
  const command = fp5.fake.commandOf(five.paneId);
  assert.ok(command.includes('--failpoint'));
  assert.ok(command.includes('ready-delay-25s'));
  // The run target is the same pass's split pane wherever a run happened (LT-8).
  for (const [tracer, result] of [[fp4.tracer, four], [fp5.tracer, five]]) {
    assert.deepEqual(tracer.record.runTargets, tracer.record.splitPaneIds);
    assert.deepEqual(result.splitPaneIds, [result.paneId]);
  }
  // fp1/fp2 crashed before any run, and no pass ever renamed a pane.
  assert.deepEqual(fp1.tracer.record.runTargets, []);
  assert.deepEqual(fp2.tracer.record.runTargets, []);
  assert.deepEqual(one.splitPaneIds, [one.paneId]);
  assert.deepEqual(two.splitPaneIds, [two.paneId]);
});

test('an unknown failpoint value fails before the split, with zero pane calls', async t => {
  const stateDir = await scratch(t);
  const fx = fixture({ stateDir });
  const result = await fx.launch({ env: { GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT: 'fpX' } });
  assert.equal(result.code, 'failed:failpoint');
  assert.deepEqual(fx.fake.calls, []);
  assert.equal(await readFilePath(fx.paths.intent), null);
});

test('focus is restored only when it actually moved, and never with tab focus', async t => {
  const stateDir = await scratch(t);
  const moved = fixture({ stateDir, fake: createFakeHerdr({ splitMovesFocus: true }) });
  const result = await moved.launch();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(moved.tracer.record.runTargets, moved.tracer.record.splitPaneIds);
  assert.equal(result.focus.before, 'w1:p1');
  assert.equal(result.focus.after, 'w1:p1');
  assert.equal(result.focus.restored, true);
  const focusCall = moved.tracer.trace.find(entry => entry.argv[1] === 'focus');
  assert.deepEqual(focusCall.argv, ['pane', 'focus', '--pane', result.paneId, '--direction', 'left']);
  assert.equal(moved.tracer.trace.filter(entry => entry.argv[0] === 'tab').length, 0);

  // The default split does not move focus, so no focus command is issued at all.
  const still = fixture({ stateDir: await scratch(t) });
  const quiet = await still.launch();
  assert.equal(quiet.focus.before, 'w1:p1');
  assert.equal(quiet.focus.after, 'w1:p1');
  assert.equal(quiet.focus.restored, true);
  assert.deepEqual(still.tracer.verbs().filter(verb => verb === 'pane focus'), []);

  // focusCheck:false is what an automatic pass uses (no focus work at all).
  const off = fixture({ stateDir: await scratch(t) });
  const skipped = await off.launch({ focusCheck: false });
  assert.deepEqual(skipped.focus, { before: null, after: null, restored: true });
  assert.deepEqual(off.tracer.verbs().filter(verb => verb === 'pane list'), []);
});

test('a pre-existing slot keeps its scope key unless the sessionId differs (plan 7.2 rebind)', async t => {
  const stateDir = await scratch(t);
  const fx = fixture({ stateDir });
  const prior = {
    schema: 'gjc-herdr-dashboard/slot/1',
    layoutKey: KEY,
    parent: { socket: '/tmp/h.sock', paneId: 'w1:p1', tabId: 'w1:t1' },
    herdr: ['C:/herdr.exe'],
    scope: { sessionId: 's-old', scopeKey: 'z'.repeat(24), scopeEpoch: 3, language: 'en' },
    roles: {},
  };
  const result = await fx.launch({
    slot: prior,
    scope: { sessionId: 's-1', scopeKey: 'k'.repeat(24), scopeEpoch: 4, language: 'ko' },
  });
  assert.equal(result.ok, true);
  const stored = (await readSlot(fx.paths.slot)).slot;
  assert.deepEqual(stored.herdr, ['C:/herdr.exe']);
  assert.deepEqual(stored.parent, prior.parent);
  // The caller's scope is only consulted for a rebind; launchRole does not rewrite scope itself,
  // and it never clobbers a scope the pass did not compute.
  assert.equal(stored.scope.scopeKey, 'z'.repeat(24));
  assert.equal(stored.scope.sessionId, 's-old');
  assert.equal(stored.roles.todo.paneId, result.paneId);
});

test('a process-info or run failure leaves the record (or the intent) for the next pass', async t => {
  const stateDir = await scratch(t);
  const info = fixture({ stateDir,
    fake: createFakeHerdr({ failures: { 'process-info': { code: 'herdr_error', times: 1 } } }) });
  const first = await info.launch();
  assert.equal(first.code, 'failed:herdr-process-info');
  assert.equal(await readFilePath(info.paths.slot), null);
  assert.notEqual(await readFilePath(info.paths.intent), null);

  const run = fixture({ stateDir: await scratch(t),
    fake: createFakeHerdr({ failures: { run: { code: 'herdr_error' } } }) });
  const third = await run.launch();
  assert.equal(third.code, 'failed:herdr-run');
  const stored = (await readSlot(run.paths.slot)).slot.roles.todo;
  assert.equal(stored.state, 'pending');
  // The record is the pane's only identity; the pane was never relabelled on the way.
  assert.equal(stored.paneId, third.paneId);
  assert.equal('label' in stored, false);
  assert.equal(run.fake.paneLabel(third.paneId), null);
  assert.equal(run.fake.commandOf(third.paneId), null);
});

