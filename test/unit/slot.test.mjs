// Unit tests for src/core/slot.mjs: key derivation, state files, and the R1 generation lock.
// The lock tests drive a real temporary filesystem with an injected process table and clock, and
// audit every unlink so the R1 safety argument (only own files, GC <= own-2) is checked as
// observable behaviour rather than asserted from the implementation.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HEARTBEAT_MS, LOCK_FILE_PATTERN, OWNER_SCHEMA, PANE_LABELS, SLOT_SCHEMA, acquireLock,
  classifyGeneration, clearIntent, dataPaths, generationIsCurrent, intentRecord, key8Of, labelOf,
  layoutKeyOf, lockFileName, maxGeneration, ownerRecord, prefsPaths, quarantineSlot, readIntent,
  readOwner, readSlot, releasedFileName, releaseLock, scopeKeyOf, slotPaths, validateSlot,
  writeIntent, writeOwner, writeSlot } from '../../src/core/slot.mjs';

const KEY = 'a'.repeat(24);
const OTHER_KEY = 'b'.repeat(24);

// Every filesystem call goes through this audit wrapper, so a test can assert exactly which files
// a lock pass created or deleted.
function auditedFs(recorder) {
  const wrap = name => async (...args) => {
    recorder.push([name, ...args.map(String)]);
    return fs[name](...args);
  };
  return {
    ...fs,
    readdir: wrap('readdir'),
    readFile: wrap('readFile'),
    stat: wrap('stat'),
    mkdir: wrap('mkdir'),
    open: async (...args) => {
      recorder.push(['open', ...args.map(String)]);
      const handle = await fs.open(...args);
      return { writeFile: (...rest) => handle.writeFile(...rest), close: () => handle.close() };
    },
    unlink: wrap('unlink'),
  };
}

async function scratch(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'gjc-slot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const alive = alivePids => pid => (alivePids.has(pid) ? true : false);

test('keys are the first 24 hex chars of sha256 over the JSON tuple, and labels are invisible role markers', () => {
  const layout = layoutKeyOf({ socket: '/tmp/h.sock', parentPaneId: 'w1:p1' });
  const scope = scopeKeyOf({ socket: '/tmp/h.sock', parentPaneId: 'w1:p1', sessionId: 's-1' });
  const same = layoutKeyOf({ socket: '/tmp/h.sock', parentPaneId: 'w1:p1' });
  // Stable, 24 hex chars, and the socket/pane tuple is what distinguishes slots.
  assert.equal(layout, same);
  assert.match(layout, /^[0-9a-f]{24}$/);
  assert.match(scope, /^[0-9a-f]{24}$/);
  assert.notEqual(layout, scope);
  assert.notEqual(layout, layoutKeyOf({ socket: '/tmp/h.sock', parentPaneId: 'w1:p2' }));
  assert.notEqual(scope, scopeKeyOf({ socket: '/tmp/h.sock', parentPaneId: 'w1:p1', sessionId: 's-2' }));
  assert.equal(key8Of(layout), layout.slice(0, 8));
  // The pane label is a real, exact string (identity), but no longer embeds key8: it is a
  // zero-width character that Herdr's border renderer draws as nothing.
  assert.equal(labelOf('todo', key8Of(layout)), PANE_LABELS.todo);
  assert.equal(labelOf('workers', 'deadbeef'), PANE_LABELS.workers);
  assert.equal(labelOf('progress', 'deadbeef'), PANE_LABELS.progress);
  assert.equal(PANE_LABELS.todo, '\u200b');
  assert.equal(PANE_LABELS.workers, '\u200c');
  assert.equal(PANE_LABELS.progress, '\u200d');
  for (const role of ['todo', 'workers', 'progress']) {
    const label = labelOf(role, key8Of(layout));
    assert.equal(label.trim(), label, "survives Herdr's whitespace trim");
    assert.equal(label.isWellFormed(), true);
  }
  assert.equal(new Set(Object.values(PANE_LABELS)).size, 3, 'the three roles stay distinguishable');
  // The label never looks like an Omo dashboard pane (plan 7.10 coexistence).
  const omoPredicate = name => typeof name === 'string' &&
    (name.startsWith('DAG · ') || name === 'OmO DAG');
  for (const role of ['todo', 'workers', 'progress']) {
    assert.equal(omoPredicate(labelOf(role, key8Of(layout))), false);
  }
  assert.throws(() => labelOf('dag', 'deadbeef'), { code: 'role' });
});

test('path helpers place every state file exactly where plan 7.9 puts it', () => {
  const state = join('C:', 'state');
  const paths = slotPaths(state, KEY);
  assert.equal(paths.dir, join(state, 'slots', KEY));
  assert.equal(paths.slot, join(state, 'slots', KEY, 'slot.json'));
  assert.equal(paths.owner, join(state, 'slots', KEY, 'owner.json'));
  assert.equal(paths.intent, join(state, 'slots', KEY, 'intent.json'));
  assert.equal(paths.lockDir, join(state, 'slots', KEY, 'lock'));
  assert.equal(paths.ready('todo'), join(state, 'slots', KEY, 'roles', 'todo.ready.json'));
  assert.equal(paths.ready('workers'), join(state, 'slots', KEY, 'roles', 'workers.ready.json'));
  const data = dataPaths(state, OTHER_KEY);
  assert.equal(data.todo, join(state, 'data', OTHER_KEY, 'todo.json'));
  assert.equal(data.workers, join(state, 'data', OTHER_KEY, 'workers.json'));
  assert.equal(data.goal, join(state, 'data', OTHER_KEY, 'goal.json'));
  assert.equal(data.progress, join(state, 'data', OTHER_KEY, 'progress.json'));
  const prefs = prefsPaths(state, OTHER_KEY);
  assert.equal(prefs.file('todo'), join(state, 'prefs', OTHER_KEY, 'todo.json'));
});

test('readSlot distinguishes ok, absent and corrupt, and an unknown schema is corrupt', async t => {
  const state = await scratch(t);
  const { slot } = slotPaths(state, KEY);
  assert.deepEqual(await readSlot(slot), { status: 'absent' });
  const record = { state: 'pending', token: 't', paneId: 'w1:p5', tabId: 'w1:t1',
    label: 'GJC Todo · aaaaaaaa', shellPid: 42, pendingSince: 1 };
  const good = { schema: SLOT_SCHEMA, layoutKey: KEY, parent: { socket: '/s', paneId: 'w1:p1', tabId: 'w1:t1' },
    herdr: ['herdr'], scope: { sessionId: 's', scopeKey: 'k'.repeat(24), scopeEpoch: 1, language: 'ko' },
    roles: { todo: record } };
  assert.equal(validateSlot(good), null);
  assert.equal((await writeSlot(slot, good), (await readSlot(slot)).status), 'ok');
  // An unknown schema major is corrupt, never "maybe compatible".
  const future = { ...good, schema: 'gjc-herdr-dashboard/slot/2' };
  await fs.writeFile(slot, JSON.stringify(future));
  assert.deepEqual(await readSlot(slot), { status: 'corrupt', reason: 'unknown-schema:gjc-herdr-dashboard/slot/2', slot: future });
  assert.equal(validateSlot(future), 'unknown-schema:gjc-herdr-dashboard/slot/2');
  await fs.writeFile(slot, '{ truncated');
  const parsed = await readSlot(slot);
  assert.equal(parsed.status, 'corrupt');
  assert.match(parsed.reason, /^parse:/);
  await fs.rm(slot);
  await fs.mkdir(slot);
  // An unreadable file (here: a directory) is corrupt too, but for the read reason.
  const unreadable = await readSlot(slot);
  assert.equal(unreadable.status, 'corrupt');
  assert.match(unreadable.reason, /^read:/);
});

test('writeSlot refuses an invalid record and quarantineSlot renames with a timestamp', async t => {
  const state = await scratch(t);
  const { slot, dir } = slotPaths(state, KEY);
  const broken = { schema: SLOT_SCHEMA, layoutKey: KEY };
  await assert.rejects(writeSlot(slot, broken), { code: 'slot-shape' });
  // validateSlot names the first offending field so T18 can report it.
  assert.equal(validateSlot(broken), 'parent');
  assert.equal(validateSlot(null), 'not-an-object');
  assert.equal(validateSlot({ ...broken, parent: {}, scope: {} }), 'scope.scopeKey');
  assert.equal(validateSlot({ ...broken, parent: {}, scope: { scopeKey: 'k' }, roles: { todo: { state: 'weird' } } }),
    'roles.todo.shape');
  // Quarantine keeps the bytes and reports the rename target.
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(slot, '{"schema":"unknown"}');
  const result = await quarantineSlot(slot, { now: 1750000000000 });
  assert.equal(result.reason, 'quarantined');
  assert.equal(result.path, `${slot}.corrupt-1750000000000`);
  assert.equal(await fs.readFile(result.path, 'utf8'), '{"schema":"unknown"}');
  assert.equal((await readSlot(slot)).status, 'absent');
  // Quarantining nothing is reported rather than thrown.
  const absent = await quarantineSlot(slot, { now: 42 });
  assert.equal(absent.reason, 'absent');
  assert.equal(absent.path, `${slot}.corrupt-42`);
});

test('owner, intent and heartbeat records carry the documented fields', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  assert.equal(await readOwner(paths.owner), null);
  const owner = ownerRecord({ pid: 1234, instanceId: 'i-1', sessionId: 's-1', now: 1000 });
  assert.deepEqual(owner, { schema: OWNER_SCHEMA, pid: 1234, instanceId: 'i-1', sessionId: 's-1', heartbeatAt: 1000 });
  await writeOwner(paths.owner, owner);
  assert.deepEqual(await readOwner(paths.owner), owner);
  // stoppedAt appears only when the owner deliberately stopped.
  const stopped = ownerRecord({ pid: 1, instanceId: 'i', sessionId: 's', now: 5, stoppedAt: 9 });
  assert.equal(stopped.stoppedAt, 9);
  assert.equal('stoppedAt' in ownerRecord({ pid: 1, instanceId: 'i', sessionId: 's', now: 5 }), false);
  assert.equal(HEARTBEAT_MS, 5000);
  const intent = intentRecord({ role: 'todo', label: 'GJC Todo · aaaaaaaa', tabId: 'w1:t1', now: 7 });
  assert.deepEqual(intent, { role: 'todo', label: 'GJC Todo · aaaaaaaa', tabId: 'w1:t1', at: 7 });
  assert.equal(await readIntent(paths.intent), null);
  await writeIntent(paths.intent, intent);
  assert.deepEqual(await readIntent(paths.intent), intent);
  assert.deepEqual(await clearIntent(paths.intent), { ok: true });
  assert.equal(await readIntent(paths.intent), null);
  // Clearing an already-clear intent is still ok.
  assert.deepEqual(await clearIntent(paths.intent), { ok: true });
});

test('generation file names are zero padded to 12 digits and classify back', () => {
  assert.equal(lockFileName(1), 'g000000000001.lock');
  assert.equal(releasedFileName(42), 'g000000000042.released');
  assert.equal(LOCK_FILE_PATTERN.exec('g000000000042.lock').slice(1).join(','), '000000000042,lock');
  assert.equal(LOCK_FILE_PATTERN.exec('g000000000042.released').slice(1).join(','), '000000000042,released');
  for (const name of ['slot.lock', 'g42.lock', 'g000000000042.json', 'released']) {
    assert.equal(LOCK_FILE_PATTERN.test(name), false, name);
  }
});

test('classifyGeneration returns none/released/dead/live and unknown when liveness is unknowable', async t => {
  const state = await scratch(t);
  const { lockDir } = slotPaths(state, KEY);
  await fs.mkdir(lockDir, { recursive: true });
  assert.deepEqual(await classifyGeneration(fs, lockDir, 0, alive(new Set())), { state: 'none', generation: 0 });
  // released wins over everything else at the same generation.
  await fs.writeFile(join(lockDir, lockFileName(1)), JSON.stringify({ pid: 200, instanceId: 'i', passId: 'p' }));
  await fs.writeFile(join(lockDir, releasedFileName(1)), '');
  assert.equal((await classifyGeneration(fs, lockDir, 1, alive(new Set([200])))).state, 'released');
  // live: the pid answers the liveness probe.
  await fs.rm(join(lockDir, releasedFileName(1)));
  assert.deepEqual(await classifyGeneration(fs, lockDir, 1, alive(new Set([200]))),
    { state: 'live', generation: 1, holder: { pid: 200, instanceId: 'i', passId: 'p' } });
  // dead: the pid is provably gone (ESRCH).
  assert.equal((await classifyGeneration(fs, lockDir, 1, alive(new Set()))).state, 'dead');
  // unknown: an empty file, a non-JSON body, a missing pid, and a probe that cannot decide.
  await fs.writeFile(join(lockDir, lockFileName(2)), '');
  assert.equal((await classifyGeneration(fs, lockDir, 2, alive(new Set()))).state, 'unknown');
  await fs.writeFile(join(lockDir, lockFileName(2)), 'not json');
  assert.match((await classifyGeneration(fs, lockDir, 2, alive(new Set()))).detail, /^parse:/);
  await fs.writeFile(join(lockDir, lockFileName(2)), JSON.stringify({ instanceId: 'i' }));
  assert.equal((await classifyGeneration(fs, lockDir, 2, alive(new Set()))).detail, 'pid');
  await fs.writeFile(join(lockDir, lockFileName(2)), JSON.stringify({ pid: 9 }));
  assert.equal((await classifyGeneration(fs, lockDir, 2, () => null)).state, 'unknown');
  assert.equal((await classifyGeneration(fs, lockDir, 2, () => { throw Object.assign(new Error('boom'), { code: 'EPERM' }); })).state, 'unknown');
  // A generation whose lock file is missing entirely also proves nothing.
  await fs.rm(join(lockDir, lockFileName(2)));
  assert.equal((await classifyGeneration(fs, lockDir, 3, alive(new Set()))).state, 'unknown');
});

test('acquireLock takes the next generation, writes released on release, and frees the next pass', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  const audit = [];
  const io = auditedFs(audit);
  const first = await acquireLock({ paths, instanceId: 'i-1', passId: 'p1', mode: 'explicit',
    pidAlive: alive(new Set([process.pid])), io });
  assert.equal(first.ok, true);
  assert.equal(first.generation, 1);
  const body = JSON.parse(await fs.readFile(join(paths.lockDir, lockFileName(1)), 'utf8'));
  assert.equal(body.pid, process.pid);
  assert.equal(body.instanceId, 'i-1');
  assert.equal(body.passId, 'p1');
  assert.equal(Number.isFinite(body.acquiredAt), true);
  // A second pass while we hold generation 1 is busy and writes nothing at all.
  const before = (await fs.readdir(paths.lockDir)).sort();
  const blocked = await acquireLock({ paths, instanceId: 'i-2', passId: 'p2', mode: 'explicit',
    pidAlive: alive(new Set([process.pid])), io: auditedFs([]) });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'busy');
  assert.equal(blocked.state, 'live');
  assert.deepEqual((await fs.readdir(paths.lockDir)).sort(), before);
  // Releasing marks generation 1 released without deleting our own lock file.
  assert.deepEqual(await releaseLock(first.lock, { io }), { ok: true, path: first.lock.releasedPath });
  assert.deepEqual((await fs.readdir(paths.lockDir)).sort(),
    [lockFileName(1), releasedFileName(1)]);
  assert.equal((await releaseLock(first.lock, { io })).ok, true);
  // The next pass takes generation 2 and garbage collects generations at or below 0.
  const second = await acquireLock({ paths, instanceId: 'i-3', passId: 'p3', mode: 'explicit',
    pidAlive: alive(new Set([process.pid])), io });
  assert.equal(second.ok, true);
  assert.equal(second.generation, 2);
  assert.equal(await generationIsCurrent(second.lock, { io }), true);
});

test('a dead holder is recovered but a live holder is never displaced, however old it is', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  const io = fs;
  await fs.mkdir(paths.lockDir, { recursive: true });
  // Given a holder pid that is alive, and any amount of elapsed time.
  await fs.writeFile(join(paths.lockDir, lockFileName(1)),
    JSON.stringify({ pid: 4242, instanceId: 'i-old', passId: 'p-old', acquiredAt: 1 }));
  for (const elapsedMs of [31000, 600000]) {
    const now = 1 + elapsedMs;
    const attempt = await acquireLock({ paths, instanceId: 'i-new', passId: `p-${elapsedMs}`,
      mode: 'explicit', pidAlive: alive(new Set([4242])), now: () => now, io });
    assert.deepEqual({ ok: attempt.ok, reason: attempt.reason, state: attempt.state },
      { ok: false, reason: 'busy', state: 'live' }, `+${elapsedMs}ms`);
    assert.equal(attempt.generation, 1);
    // The busy notify carries the holder identity and the generation, and nothing changed.
    assert.equal(attempt.holder.pid, 4242);
  }
  // Nothing was created or deleted by the blocked attempts.
  assert.deepEqual((await fs.readdir(paths.lockDir)).sort(), [lockFileName(1)].sort());
  // When the holder is provably gone (ESRCH), the next generation is taken.
  const takeover = await acquireLock({ paths, instanceId: 'i-new', passId: 'p-new', mode: 'explicit',
    pidAlive: alive(new Set()), io });
  assert.equal(takeover.ok, true);
  assert.equal(takeover.generation, 2);
  // ...and an unknowable holder (null) is treated exactly like a live one: busy, zero files.
  const undecidable = await acquireLock({ paths, instanceId: 'i-x', passId: 'p-x', mode: 'explicit',
    pidAlive: () => null, io });
  assert.equal(undecidable.reason, 'busy');
  assert.equal(undecidable.state, 'unknown');
  // GC at generation 2 only removes generations <= 0, so the old generation 1 file stays:
  // the highest generation is never collected, which is what makes recovery monotone (R1 (ii)).
  assert.deepEqual((await fs.readdir(paths.lockDir)).sort(),
    [lockFileName(1), lockFileName(2)].sort());
});

test('a frozen holder that resumes finds its generation still current, and no unlink touches other generations', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  // A realistic table: this process is alive, so any generation it created stays live for others.
  const p1 = await acquireLock({ paths, instanceId: 'i-1', passId: 'p1', mode: 'explicit',
    pidAlive: pid => pid === process.pid, io: fs });
  assert.equal(p1.ok, true);
  // P1 is now frozen. P2 sees a live holder and must not displace it, whatever the clock says.
  const p2 = await acquireLock({ paths, instanceId: 'i-2', passId: 'p2', mode: 'explicit',
    pidAlive: () => true, now: () => 1 + 600000, io: fs });
  assert.equal(p2.reason, 'busy');
  assert.equal(p2.state, 'live');
  // P1 resumes: its generation is still the highest, so its own mutations stay protected.
  assert.equal(await generationIsCurrent(p1.lock, { io: fs }), true);
  assert.deepEqual((await fs.readdir(paths.lockDir)).sort(), [lockFileName(1)].sort());
  // After P1 releases, P3 takes generation 2, and P1's late re-check now fails closed.
  await releaseLock(p1.lock, { io: fs });
  const p3 = await acquireLock({ paths, instanceId: 'i-3', passId: 'p3', mode: 'explicit',
    pidAlive: () => true, io: fs });
  assert.equal(p3.generation, 2);
  assert.equal(await generationIsCurrent(p1.lock, { io: fs }), false);
  // P1 must not be able to delete P3's generation: a release only writes P1's own marker.
  await releaseLock(p1.lock, { io: fs });
  assert.deepEqual((await fs.readdir(paths.lockDir)).sort(),
    [lockFileName(1), releasedFileName(1), lockFileName(2)].sort());
});

test('two recoverers racing on the same dead generation produce exactly one holder', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  await fs.mkdir(paths.lockDir, { recursive: true });
  await fs.writeFile(join(paths.lockDir, lockFileName(1)),
    JSON.stringify({ pid: 4242, instanceId: 'i-dead', passId: 'p-dead' }));
  // The process table knows this process is alive; the recorded 4242 is not.
  const pidAlive = pid => pid === process.pid;
  const results = await Promise.all([1, 2].map(n => acquireLock({ paths, instanceId: `i-${n}`,
    passId: `p-${n}`, mode: 'explicit', pidAlive, io: fs })));
  const winners = results.filter(result => result.ok);
  const losers = results.filter(result => !result.ok);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].generation, 2);
  assert.equal(losers.length, 1, JSON.stringify(results));
  assert.equal(losers[0].reason, 'busy');
  assert.equal(losers[0].state, 'live');
  // The loser's dead generation file is untouched; only its own file would ever be removed.
  const remaining = (await fs.readdir(paths.lockDir)).sort();
  assert.deepEqual(remaining, [lockFileName(1), lockFileName(2)].sort());
});

test('a recoverer that is overtaken by a later generation deletes only its own file and reports busy', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  const audit = [];
  const io = auditedFs(audit);
  await fs.mkdir(paths.lockDir, { recursive: true });
  await fs.writeFile(join(paths.lockDir, lockFileName(1)),
    JSON.stringify({ pid: 4242, instanceId: 'i-dead', passId: 'p-dead' }));
  // A later generation appears exactly while our own creation is in flight.
  const stale = await acquireLock({ paths, instanceId: 'i-stale', passId: 'p-stale', mode: 'explicit',
    pidAlive: alive(new Set()), io,
    hooks: { afterLastCheck: async () => {
      await fs.writeFile(join(paths.lockDir, lockFileName(3)),
        JSON.stringify({ pid: 999, instanceId: 'i-later', passId: 'p-later' }));
    } } });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'busy');
  assert.equal(stale.state, 'stale-recoverer');
  assert.equal(stale.generation, 2);
  // Our own generation 2 file is gone; the other writer's generation 3 file is untouched.
  const remaining = (await fs.readdir(paths.lockDir)).sort();
  assert.deepEqual(remaining, [lockFileName(1), lockFileName(3)]);
  const unlinked = audit.filter(entry => entry[0] === 'unlink').map(entry => entry[1]);
  assert.deepEqual(unlinked.map(name => name.split(/[\\/]/).pop()), [lockFileName(2)]);
});

test('the automatic pass skips a lock it lost and never retries; the explicit pass retries once', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  await fs.mkdir(paths.lockDir, { recursive: true });
  // The classification keeps showing a dead generation, so every attempt tries to create
  // generation 1 and keeps losing the exclusive creation race.
  await fs.writeFile(join(paths.lockDir, lockFileName(1)), JSON.stringify({ pid: 4242 }));
  let creates = 0;
  const racingIo = {
    ...fs,
    mkdir: (...args) => fs.mkdir(...args),
    open: async () => { creates++; throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
  };
  const auto = await acquireLock({ paths, instanceId: 'i', passId: 'p', mode: 'auto',
    pidAlive: alive(new Set()), io: racingIo });
  assert.deepEqual({ ok: auto.ok, reason: auto.reason, state: auto.state },
    { ok: false, reason: 'busy', state: 'raced' });
  assert.equal(creates, 1, 'an automatic pass must not retry');
  creates = 0;
  const explicit = await acquireLock({ paths, instanceId: 'i', passId: 'p', mode: 'explicit',
    pidAlive: alive(new Set()), io: racingIo });
  assert.equal(explicit.ok, false);
  assert.equal(creates, 2, 'an explicit pass retries the classification exactly once');
});

test('an unreadable lock directory is a coded failure, and maxGeneration reads only real generations', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  await fs.mkdir(paths.lockDir, { recursive: true });
  await fs.writeFile(join(paths.lockDir, 'notes.txt'), 'ignore me');
  await fs.writeFile(join(paths.lockDir, releasedFileName(3)), '');
  assert.equal(await maxGeneration(fs, paths.lockDir), 3);
  assert.equal(await maxGeneration(fs, join(state, 'no-such-dir')), 0);
  // A lock pass whose directory cannot be created reports the failure instead of proceeding.
  const broken = await acquireLock({ paths, instanceId: 'i', passId: 'p', io: {
    ...fs, mkdir: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } } });
  assert.equal(broken.ok, false);
  assert.match(broken.reason ?? '', /EPERM|failed/);
});

test('the unlink audit holds across a full acquire/release/GC cycle', async t => {
  const state = await scratch(t);
  const paths = slotPaths(state, KEY);
  const audit = [];
  const io = auditedFs(audit);
  await fs.mkdir(paths.lockDir, { recursive: true });
  // Pre-existing history: generation 9 live, 8 and 7 dead-and-released.
  await fs.writeFile(join(paths.lockDir, lockFileName(9)), JSON.stringify({ pid: 777 }));
  for (const n of [7, 8]) {
    await fs.writeFile(join(paths.lockDir, lockFileName(n)), JSON.stringify({ pid: 1000 + n }));
    await fs.writeFile(join(paths.lockDir, releasedFileName(n)), '');
  }
  let generation = null;
  const attempt = await acquireLock({ paths, instanceId: 'i', passId: 'p', mode: 'explicit',
    pidAlive: pid => pid === 777, io,
    hooks: { afterClassify: () => { generation = 1; } } });
  assert.equal(attempt.ok, false, 'generation 9 is live, so nobody may recover it');
  assert.equal(generation, 1);
  assert.deepEqual(audit.filter(entry => entry[0] === 'unlink'), []);
  assert.equal((await fs.readdir(paths.lockDir)).length, 5);
  // Once generation 9 is released and provably dead, a pass takes 10 and garbage collects
  // generations 7 and 8 in full (both <= 10-2), keeping the highest generation 9 intact.
  await fs.writeFile(join(paths.lockDir, releasedFileName(9)), '');
  const held = await acquireLock({ paths, instanceId: 'i', passId: 'p', mode: 'explicit',
    pidAlive: () => false, io });
  assert.equal(held.generation, 10);
  const unlinked = audit.filter(entry => entry[0] === 'unlink').map(entry => entry[1].split(/[\\/]/).pop());
  assert.deepEqual(unlinked.sort(), [lockFileName(7), lockFileName(8),
    releasedFileName(7), releasedFileName(8)].sort());
  assert.deepEqual((await fs.readdir(paths.lockDir)).sort(),
    [lockFileName(9), releasedFileName(9), lockFileName(10)].sort());
});
