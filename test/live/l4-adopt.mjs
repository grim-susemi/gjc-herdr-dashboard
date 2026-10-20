// LV-5 / AC4.1, AC4.4 and AC4.6 live: restart adopt, slot corruption, retention.
//
//   A. `/dashboard` opens the Todo and Workers panes. `/exit` leaves both viewers alive (`OFFLINE`).
//      Before the restart the script seeds three derived-state scopes (one 30 days old, one 1 day old,
//      one unrelated slot file) to measure AC4.6 on the real arm path.
//   B. gjc is started again in the SAME parent pane (same Herdr socket + parent pane id = same layout
//      key). The next `/dashboard` is `adopted`: the pane ids are unchanged, no pane is added, and the
//      `OFFLINE` label of both viewers clears. The old (30 day) scope is gone, the 1 day scope stays,
//      slots/ is untouched (AC4.6).
//   C. The slot file is overwritten with garbage (AC4.4). The next `/dashboard` quarantines it
//      (`slot.json.corrupt-*` exists), the pass finishes, and exactly one Todo and one Workers pane
//      exist afterwards; one more `/dashboard` is normal.
//
// Run: node test/live/l4-adopt.mjs
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, notifyLines, runScript, sendSlash, stripAnsi, viewerPanes,
  writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-5';
const CASE = 'l4adopt';
const SESSION = 'gjcdash-l4adopt';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const OPENED = /열림|opened/;
const ADOPTED = /인계|adopted/;
const DAY = 86_400_000;
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const OLD = 'a'.repeat(24);
const RECENT = 'b'.repeat(24);

async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    let value = null;
    try { value = fn(); } catch { value = null; } // outcome: the file is not written yet, retry
    if (value) return value;
    if (Date.now() > end) throw Object.assign(new Error(`timeout waiting for ${what}`), { code: 'live-timeout' });
    await sleep(1_000);
  }
}

function seedScope(stateDir, key, ageDays) {
  const when = new Date(Date.now() - ageDays * DAY);
  for (const kind of ['data', 'prefs']) {
    const dir = join(stateDir, kind, key);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, kind === 'data' ? 'todo.json' : 'todo.json');
    writeFileSync(file, '{}');
    utimesSync(file, when, when);
    utimesSync(dir, when, when);
  }
}

const roleIds = (fixture) => ({
  todo: viewerPanes(fixture, 'todo').map((p) => p.pane_id),
  workers: viewerPanes(fixture, 'workers').map((p) => p.pane_id),
});

await runScript('l4-adopt (LV-5 / AC4.1 / AC4.4 / AC4.6)', async () => {
  const evidence = evidenceDirFor('L4', LV);
  rmSync(join(SANDBOX, `case-${CASE}`), { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  const result = {};
  const launch = (parent) => launchGjc(fixture, parent, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
    extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    const parent = ws.rootPaneId;
    await launch(parent);
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });

    // ---- A. open both roles, then exit ------------------------------------------------------------
    const opened = await sendSlash(fixture, parent, 'dashboard', OPENED, { label: 'open' });
    writeEvidence(evidence, 'notify-open.txt', opened.line);
    await until(() => viewerPanes(fixture, 'workers')[0] && viewerPanes(fixture, 'todo')[0], 'both role panes');
    for (const pane of viewerPanes(fixture, null)) fixture.adoptPane(pane.pane_id, { role: 'viewer', label: pane.label });
    const before = roleIds(fixture);
    const slotsDir = join(paths.stateDir, 'slots');
    const slotKey = readdirSync(slotsDir)[0];
    const slotFile = join(slotsDir, slotKey, 'slot.json');
    const ownerFile = join(slotsDir, slotKey, 'owner.json');
    const slotBefore = readJson(slotFile);
    const ownerBefore = readJson(ownerFile);
    writeEvidenceJson(evidence, 'panes-before-exit.json', { before, panes: fixture.listPanes() });
    assert(before.todo.length === 1 && before.workers.length === 1, 'one Todo and one Workers pane are open', { before });

    // The exit sequence is the L1 one: type the head, wait for the popup, finish, Enter.
    await sleep(3_000);
    fixture.sendText(parent, '/exi');
    await sleep(900);
    fixture.sendText(parent, 't');
    await sleep(900);
    fixture.sendKeys(parent, 'enter');
    const stopped = await until(() => { const o = readJson(ownerFile); return Number.isFinite(o.stoppedAt) ? o : null; }, 'owner stoppedAt');
    assert(stopped.pid === ownerBefore.pid, 'the owner record of the exited process is the one that stopped', { stopped });
    const exitedFrame = await until(() => {
      const frame = stripAnsi(fixture.readPane(before.todo[0]));
      return /OFFLINE/.test(frame) ? frame : null;
    }, 'disconnected label after /exit', 30_000);
    writeEvidence(evidence, 'todo-after-exit.txt', exitedFrame);
    await sleep(3_000);

    // ---- AC4.6 seed: an old scope, a recent inactive scope, and the slot tree -----------------------
    seedScope(paths.stateDir, OLD, 30);
    seedScope(paths.stateDir, RECENT, 1);
    const slotsListing = readdirSync(slotsDir).sort();

    // ---- B. restart gjc in the same pane, then /dashboard = adopted ---------------------------------
    await launch(parent);
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });
    const adopted = await sendSlash(fixture, parent, 'dashboard', ADOPTED, { label: 'adopt after restart' });
    writeEvidence(evidence, 'notify-adopted.txt', adopted.line);
    const after = roleIds(fixture);
    writeEvidenceJson(evidence, 'panes-after-restart.json', { after, panes: fixture.listPanes() });
    assert(JSON.stringify(after) === JSON.stringify(before), 'AC4.1: the same pane ids, no new pane', { before, after });
    assert(fixture.listPanes().length === 3, 'AC4.1: the tab still has exactly the parent and two role panes',
      { panes: fixture.listPanes() });
    const labelCleared = {};
    for (const role of ['todo', 'workers']) {
      labelCleared[role] = await until(() => {
        const frame = stripAnsi(fixture.readPane(after[role][0]));
        return /OFFLINE/.test(frame) ? null : frame;
      }, `${role} viewer clears OFFLINE`, 45_000);
      writeEvidence(evidence, `${role}-after-adopt.txt`, labelCleared[role]);
    }
    const ownerAfter = readJson(ownerFile);
    assert(ownerAfter.pid !== ownerBefore.pid && !Number.isFinite(ownerAfter.stoppedAt),
      'the new process owns the slot now', { ownerBefore, ownerAfter });
    const slotAfter = readJson(slotFile);
    assert(slotAfter.roles.todo.paneId === slotBefore.roles.todo.paneId
      && slotAfter.roles.workers.paneId === slotBefore.roles.workers.paneId, 'the slot still names the same panes', { slotBefore, slotAfter });
    result.ac41 = { adopted: adopted.line, paneIds: after };

    // AC4.6: retention ran on arm.
    await until(() => !existsSync(join(paths.stateDir, 'data', OLD)), 'old data scope pruned', 30_000);
    assert(!existsSync(join(paths.stateDir, 'prefs', OLD)), 'AC4.6: the 30 day old prefs scope is pruned');
    assert(existsSync(join(paths.stateDir, 'data', RECENT)) && existsSync(join(paths.stateDir, 'prefs', RECENT)),
      'AC4.6: the 1 day old inactive scope is kept');
    assert(JSON.stringify(readdirSync(slotsDir).sort()) === JSON.stringify(slotsListing), 'AC4.6: slots/ is untouched', { slotsListing });
    const activeData = readdirSync(join(paths.stateDir, 'data'));
    assert(activeData.length >= 2, 'the current scope data is still there', { activeData });
    result.ac46 = { dataScopes: activeData, prefsScopes: readdirSync(join(paths.stateDir, 'prefs')) };

    // ---- C. AC4.4: a corrupt slot is quarantined, the old viewers retire ------------------------------
    writeFileSync(slotFile, '{ this is not json');
    const noticesBefore = () => notifyLines(fixture.readPane(parent)).length;
    const baseline = noticesBefore();
    // T18 quarantines the slot and then opens fresh panes (T1), so the notify names `열림`, not `인계`.
    const recovery = await sendSlash(fixture, parent, 'dashboard', OPENED, { label: 'after corruption', since: () => baseline });
    writeEvidence(evidence, 'notify-after-corruption.txt', recovery.line);
    await sleep(6_000);
    const quarantined = readdirSync(join(slotsDir, slotKey)).filter((name) => name.startsWith('slot.json.corrupt-'));
    assert(quarantined.length >= 1, 'AC4.4: the corrupt slot was renamed aside', { files: readdirSync(join(slotsDir, slotKey)) });
    const baseline2 = noticesBefore();
    const next = await sendSlash(fixture, parent, 'dashboard', /정상|ready|인계|adopted|대기|pending/, { label: 'normal after corruption', since: () => baseline2 });
    writeEvidence(evidence, 'notify-next.txt', next.line);
    await sleep(4_000);
    const settled = roleIds(fixture);
    writeEvidenceJson(evidence, 'panes-after-corruption.json', { settled, panes: fixture.listPanes() });
    assert(settled.todo.length === 1 && settled.workers.length === 1,
      'AC4.4: exactly one Todo and one Workers pane after the recovery', { settled });
    for (const stale of [...after.todo, ...after.workers]) {
      assert(!fixture.listPanes().some((pane) => pane.pane_id === stale), 'AC4.4: the old viewer pane is retired', { stale, panes: fixture.listPanes() });
    }
    const slotRecovered = readJson(slotFile);
    assert(slotRecovered.schema === slotBefore.schema, 'a valid slot was written again', { slotRecovered });
    result.ac44 = { quarantined, recovery: recovery.line, next: next.line };

    writeEvidenceJson(evidence, 'result.json', result);
    fixture.record('assertion', `l4-adopt: ${JSON.stringify(result)}`);
    return result;
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
    assert(cleanup.verifiedAbsent, 'every harness resource was verified absent', cleanup);
  }
});
