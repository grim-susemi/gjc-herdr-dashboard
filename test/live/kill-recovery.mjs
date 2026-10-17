// AC1.7 viewer kill + AC1.9 owner kill, live (stage-05 R3 l.165-168; reviewer blockers B3/B6).
//
//   A. open the dashboard, read the viewer pid from roles/todo.ready.json, kill that pid:
//      the shell trailer `; exit` drops the pane (U10), so the next `/dashboard` is T4 (`열림`, a new
//      pane) - or T16 if the pane stayed (the sequence is recorded either way). Exactly one role pane
//      afterwards.
//   B. kill the harness gjc WITHOUT `/exit` (no `stoppedAt`): the viewer's default owner probe must see
//      ESRCH and show `연결 끊김` within ~20 s (heartbeat age gate), and the viewer pane must stay.
//
// Run: node test/live/kill-recovery.mjs
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, runScript, sendSlash, stripAnsi,
  viewerPanes, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-7b';
const CASE = 'lvkill';
const SESSION = 'gjcdash-lvkill';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const OPENED = /열림|opened/;
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

async function until(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw Object.assign(new Error(`timeout waiting for ${what}`), { code: 'live-timeout' });
    await sleep(1_000);
  }
}
const slotDir = (stateDir) => {
  const slots = join(stateDir, 'slots');
  const key = readdirSync(slots)[0];
  return key ? join(slots, key) : null;
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const killPid = (pid) => spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });

await runScript('kill-recovery (AC1.7/AC1.9)', async () => {
  const evidence = evidenceDirFor('L1', LV);
  // A stale state tree would hand this run a previous run's ready.json (and dead pids).
  rmSync(join(SANDBOX, `case-${CASE}`), { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    await launchGjc(fixture, ws.rootPaneId, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
    await fixture.waitIdle(ws.rootPaneId, { timeoutMs: 120_000, quiet: 3 });

    const first = await sendSlash(fixture, ws.rootPaneId, 'dashboard', OPENED, { label: 'open #1' });
    writeEvidence(evidence, 'notify-open-1.txt', first.line);
    const dir = await until(() => slotDir(paths.stateDir), 'slot dir');
    const ready = await until(() => readJson(join(dir, 'roles', 'todo.ready.json')), 'ready.json');
    let firstPane = (await until(() => viewerPanes(fixture)[0], 'viewer pane'))?.pane_id;
    writeEvidenceJson(evidence, 'list-after-open.json', fixture.listPanes());
    assert(Boolean(firstPane), 'a viewer pane exists after the first open', { panes: fixture.listPanes() });

    // ---- A0. AC1.7 external close: the harness closes the viewer pane; the next /dashboard is T4 -------
    const extPane = firstPane;
    const closeBody = fixture.herdr(['pane', 'close', extPane]);
    writeEvidenceJson(evidence, 'external-close-reply.json', closeBody ?? {});
    await sleep(3_000);
    assert(!viewerPanes(fixture).some((pane) => pane.pane_id === extPane), 'the externally closed pane is gone', { panes: fixture.listPanes() });
    const extOpen = await sendSlash(fixture, ws.rootPaneId, 'dashboard', OPENED, { label: 'open after external close' });
    writeEvidence(evidence, 'notify-after-external-close.txt', extOpen.line);
    firstPane = (await until(() => viewerPanes(fixture)[0], 'viewer pane after external close')).pane_id;
    assert(viewerPanes(fixture).length === 1, 'exactly one role pane after the external-close recovery', { panes: fixture.listPanes() });
    fixture.record('assertion', `ac1.7 external-close: T4 -> ${extOpen.line}`);
    const ready0 = await until(() => { const r = readJson(join(dir, 'roles', 'todo.ready.json')); return r.pid !== ready.pid ? r : null; }, 'new ready after external close');

    // ---- A. AC1.7 viewer kill --------------------------------------------------------------
    const killResult = killPid(ready0.pid);
    writeEvidence(evidence, 'kill-viewer.txt', `pid=${ready0.pid} pane=${firstPane}\n${killResult.stdout}${killResult.stderr}`);
    await sleep(6_000);
    const afterKill = viewerPanes(fixture);
    const paneStayed = afterKill.some((pane) => pane.pane_id === firstPane);
    writeEvidenceJson(evidence, 'list-after-viewer-kill.json', fixture.listPanes());
    const second = await sendSlash(fixture, ws.rootPaneId, 'dashboard', /열림|opened|정상|ok/,
      { label: 'open #2 after viewer kill' });
    writeEvidence(evidence, 'notify-open-2.txt', second.line);
    await sleep(8_000);
    const panes = viewerPanes(fixture);
    assert(panes.length === 1, `exactly one role pane after recovery, got ${panes.length}`, { panes });
    const recovery = paneStayed ? 'T16 (pane stayed, relaunched in place)' : 'T4 (pane gone, new pane)';
    const newReady = readJson(join(dir, 'roles', 'todo.ready.json'));
    assert(newReady.pid !== ready0.pid, 'a new viewer process is ready', { old: ready0.pid, newReady });
    fixture.record('assertion', `ac1.7 viewer-kill: ${recovery}; notify ${second.line}`);

    // ---- B. AC1.9 owner kill (no /exit) ----------------------------------------------------
    const owner = readJson(join(dir, 'owner.json'));
    assert(!Number.isFinite(owner.stoppedAt), 'owner has no stoppedAt before the kill', { owner });
    const ownerKill = killPid(owner.pid);
    writeEvidence(evidence, 'kill-owner.txt', `pid=${owner.pid}\n${ownerKill.stdout}${ownerKill.stderr}`);
    const killedAt = Date.now();
    let label = null;
    let frame = '';
    while (Date.now() - killedAt < 60_000) {
      await sleep(500);
      const pane = viewerPanes(fixture)[0];
      if (!pane) break;
      frame = stripAnsi(fixture.readPane(pane.pane_id));
      if (/연결 끊김/.test(frame)) { label = Date.now() - killedAt; break; }
    }
    writeEvidence(evidence, 'viewer-after-owner-kill.txt', frame);
    writeEvidenceJson(evidence, 'list-after-owner-kill.json', fixture.listPanes());
    assert(label !== null, 'the viewer shows 연결 끊김 after the owner was killed', { frame });
    // AC1.9: kill -> label within 20 s (plan gate, measured from the kill). The heartbeat-anchored span is
    // recorded as well because the 20 s liveness gate counts from the last owner heartbeat.
    const freshOwner = readJson(join(dir, 'owner.json'));
    writeEvidenceJson(evidence, 'ac1-9-timing.json', { killedAt, killToLabelMs: label, ownerHeartbeatAt: freshOwner.heartbeatAt, lastHeartbeatToLabelMs: killedAt + label - freshOwner.heartbeatAt });
    assert(label <= 20_000, `AC1.9: 연결 끊김 within 20 s of the kill (took ${label} ms)`, { frame, freshOwner });
    assert(viewerPanes(fixture).length === 1, 'the viewer pane stays after the owner dies');
    const afterOwner = readJson(join(dir, 'owner.json'));
    assert(!Number.isFinite(afterOwner.stoppedAt), 'no stoppedAt: this was a kill, not an exit');
    fixture.record('assertion', `ac1.9 owner-kill: 연결 끊김 after ${label} ms, pane stayed`);
    return { recovery, disconnectMs: label };
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
    assert(cleanup.verifiedAbsent, 'every harness resource was verified absent', cleanup);
  }
});
