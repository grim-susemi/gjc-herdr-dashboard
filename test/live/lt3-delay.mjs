// LV-3 / LT-3 (stage-05 R3): a viewer that is 25 s late is NOT re-launched, and it still opens.
//
// The late viewer is the product's own failpoint: the case's dev shim sets
// GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT=ready-delay-25s, the launcher appends `--failpoint
// ready-delay-25s` to the viewer argv, and the viewer defers its first ready.json write, its heartbeat
// and its first data frame by 25 s. The Herdr wrapper only logs (no run is ever delayed, R3 l.153).
//
// Steps and checks (R3 LV-3):
//   1. one model turn writes Todo rows (todo_write) so the viewer has rows to show;
//   2. ONE `/dashboard`: wrapper log has 1 split and 1 run, the run returns in <5 s, notify `pending`
//      appears within 15 s;
//   3. before 25 s the viewer frame has no data row;
//   4. within 45 s the slot role is `ready` (T13) and the frame has the rows and the live footer;
//   5. every 5 s `pane list` shows exactly one role pane; `/dashboard` was sent once.
//
// Run: node test/live/lt3-delay.mjs
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, expectNoNotify, launchGjc, notifyLines, runScript,
  stripAnsi, viewerPanes, waitForNotify, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-3';
const CASE = 'lv3';
const SESSION = 'gjcdash-lt3';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const PENDING = /열림|준비|opened|pending/;
const ROW = 'lv3-row-alpha';
const LIVE_FOOTER = /실시간/;
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

const slotOf = (stateDir) => {
  try {
    const slots = join(stateDir, 'slots');
    const key = readdirSyncSafe(slots)[0];
    return key ? JSON.parse(readFileSync(join(slots, key, 'slot.json'), 'utf8')) : null;
  } catch { return null; }
};
function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

await runScript('lt3-delay (LV-3)', async () => {
  const evidence = evidenceDirFor('L1', LV);
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER],
    viewerFailpoint: 'ready-delay-25s' });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    const message = `Call the todo_write tool exactly once with one phase named LV3 containing one task "${ROW}" (leave it pending), then reply done.`;
    await launchGjc(fixture, ws.rootPaneId, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      args: ['--no-session', '--no-title', `'${message}'`],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
    // Rows first: the launch message makes the model call todo_write; nothing is shown yet.
    // waitIdle can return before the model starts, so the proof is the row on the parent screen.
    const rowDeadline = Date.now() + 180_000;
    while (!stripAnsi(fixture.readPane(ws.rootPaneId)).includes(ROW)) {
      assert(Date.now() < rowDeadline, "the model wrote the Todo row (todo_write) within 180 s",
        { frame: stripAnsi(fixture.readPane(ws.rootPaneId)) });
      await sleep(2_000);
    }
    await fixture.waitIdle(ws.rootPaneId, { timeoutMs: 120_000, quiet: 4 });

    const parentIdle = async () => (fixture.listPanes().find((p) => p.pane_id === ws.rootPaneId)?.agent_status === 'idle');
    for (let i = 0; i < 90 && !(await parentIdle()); i += 1) await sleep(2_000);
    await sleep(5_000);
    rmSync(join(fixture.logDir, "wrapper.log.jsonl"), { force: true });
    // A keystroke batch that the input popup swallowed (measured race, case.mjs sendSlash) is re-sent;
    // the 15 s notify gate is measured from the batch that was accepted, and every batch is recorded.
    let opened = null;
    let notifyMs = null;
    const batches = [];
    for (let attempt = 1; attempt <= 3 && opened === null; attempt += 1) {
      const sentAt = Date.now();
      await fixture.slash(ws.rootPaneId, "dashboard");
      batches.push(sentAt);
      try {
        opened = await waitForNotify(fixture, ws.rootPaneId, PENDING, { label: "the first /dashboard notify", timeoutMs: 15_000 });
        notifyMs = Date.now() - sentAt;
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(5_000);
      }
    }
    writeEvidence(evidence, 'notify-latency.txt', `${notifyMs} ms from the accepted keystroke batch #${batches.length} (gate: 15 s; R3 text says pending, the first call answers opened (T1))`);
    assert(notifyMs <= 15_000, `the first notify within 15 s (took ${notifyMs} ms)`);
    writeEvidence(evidence, 'notify-1.txt', opened.line);

    // Wrapper log: 1 split, 1 run, run < 5 s.
    const log = fixture.rawLog().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const splits = log.filter((e) => e.argv?.[0] === 'pane' && e.argv?.[1] === 'split');
    const runs = log.filter((e) => e.argv?.[0] === 'pane' && e.argv?.[1] === 'run');
    assert(splits.length === 1, `exactly one split, got ${splits.length}`, { log });
    assert(runs.length === 1, `exactly one run, got ${runs.length}`, { log });
    assert(runs[0].ms < 5_000, `the run returned in <5 s (took ${runs[0].ms} ms)`, { run: runs[0] });

    // Sample every 5 s until the slot role is ready or 45 s passed.
    const samples = [];
    let readyAtMs = null;
    let earlyFrame = null;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 45_000) {
      const elapsed = Date.now() - startedAt;
      const panes = viewerPanes(fixture);
      const frame = panes[0] ? stripAnsi(fixture.readPane(panes[0].pane_id)) : '';
      const slot = slotOf(paths.stateDir);
      const state = slot?.roles?.todo?.state ?? null;
      samples.push({ elapsed, panes: panes.length, state, hasRow: frame.includes(ROW) });
      assert(panes.length === 1, `one role pane at +${elapsed} ms`, { samples });
      if (elapsed < 20_000) {
        assert(!frame.includes(ROW), `no data row before the 25 s delay (+${elapsed} ms)`, { frame });
        earlyFrame = frame;
      }
      if (state === 'ready') { readyAtMs = elapsed; break; }
      await sleep(5_000);
    }
    assert(readyAtMs !== null, 'the slot role became ready within 45 s of the notify', { samples });
    assert(readyAtMs >= 20_000, `ready only after the delay (at +${readyAtMs} ms)`, { samples });

    // Give the viewer one repaint, then read the data frame.
    await sleep(3_000);
    const viewer = viewerPanes(fixture)[0];
    const frame = stripAnsi(fixture.readPane(viewer.pane_id));
    assert(frame.includes(ROW), 'the viewer shows the fixture Todo row', { frame });
    assert(LIVE_FOOTER.test(frame), 'the footer says 실시간', { frame });
    assert(viewerPanes(fixture).length === 1, 'still one role pane');

    writeEvidence(evidence, 'early-frame.txt', earlyFrame ?? '');
    writeEvidence(evidence, 'viewer-frame.txt', frame);
    writeEvidenceJson(evidence, 'samples.json', samples);
    writeEvidence(evidence, 'wrapper.log.jsonl', fixture.rawLog());
    fixture.snapshotLayout(evidence, 'layout', ws.rootPaneId);
    writeEvidenceJson(evidence, 'list.json', fixture.listPanes());

    // `/dashboard` was sent once: no notify beyond the one already on screen.
    await expectNoNotify(fixture, ws.rootPaneId, PENDING,
      { windowMs: 10_000, baseline: notifyLines(fixture.readPane(ws.rootPaneId)).filter((l) => PENDING.test(l)).length });

    fixture.record('assertion', `lv3: ${opened.line}; ready at +${readyAtMs} ms with the row and 실시간`);
    return { notify: opened.line, readyAtMs, samples: samples.length };
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
    assert(cleanup.verifiedAbsent, 'every harness resource was verified absent', cleanup);
  }
});
