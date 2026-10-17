// LV-3 / LT-3: a viewer whose pane run is delayed 25 s is NOT re-launched, and it still opens.
//
// Plan §15.3 LV-3: flag `delay-run-25s` (only for a run on a pane the wrapper itself split this flag
// lifetime) + ONE `/dashboard` -> the viewer pane shows the data frame within 45 s, the pane count
// stays 1, and there is no second `/dashboard`.
//
// What the delay really exercises: the launch pass answers `pending` (the viewer has not written
// ready.json yet) and returns while its own `pane run` is still 25 s from the real herdr. The NEXT
// pass must therefore classify the pane from the record and let the late viewer in rather than
// splitting a second pane. The delayed run is handed to a detached helper by the wrapper, because
// the caller's per-call timeout (5 s) kills a wrapper that is still sleeping.
//
// Run: node test/live/lt3-delay.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, expectNoNotify, launchGjc, runScript, sendSlash,
  stripAnsi, viewerPanes, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-3';
const CASE = 'lt3-delay';
const SESSION = 'gjcdash-lt3';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const OPENED_OR_PENDING = /열림|준비|opened|pending/;
// The viewer's first frame. Measured (L1 LV-1 viewer-frame.txt): the header is
// `Todo [0/0]  완료:0 · 제외:0` and the footer ends in `자동 추적 ON · <source state>`; the "waiting"
// footer the plan contrasts with is `연결 대기` / `원본 Todo 연결을 기다립니다.`
const DATA_FRAME = /Todo \[\d+\/\d+\]/;
const WAITING_FRAME = /연결 대기|기다립니다/;

await runScript('lt3-delay (LV-3)', async () => {
  const evidence = evidenceDirFor('L1', LV);
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  const logDir = fixture.logDir;
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    await launchGjc(fixture, ws.rootPaneId, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
    await fixture.waitIdle(ws.rootPaneId, { timeoutMs: 120_000, quiet: 3 });

    // A stale log would make the delay rule's `atMs >= flag mtime` comparison meaningless.
    rmSync(join(logDir, 'wrapper.log.jsonl'), { force: true });
    fixture.armFault('delay-run-25s');
    const opened = await sendSlash(fixture, ws.rootPaneId, 'dashboard', OPENED_OR_PENDING,
      { label: 'the first /dashboard notify' });
    writeEvidence(evidence, 'notify-1.txt', opened.line);

    // The pass itself must already have answered: the notify proves the launch sequence ran and the
    // delayed `pane run` did not block it.
    const firstSight = Date.now();
    const viewer = await waitForViewer(fixture, { timeoutMs: 45_000 });
    const elapsedMs = Date.now() - firstSight;
    assert(elapsedMs <= 45_000, `the viewer showed itself within 45 s (took ${elapsedMs} ms)`);
    assert(viewerPanes(fixture).length === 1,
      'the role pane count stayed 1 while the run was delayed',
      { panes: fixture.listPanes() });

    const frame = fixture.readPane(viewer.paneId);
    assert(DATA_FRAME.test(stripAnsi(frame)),
      'the viewer paint is the data frame, not the waiting banner', { frame: stripAnsi(frame) });
    assert(!WAITING_FRAME.test(stripAnsi(frame)), 'the viewer is not still waiting for its source',
      { frame: stripAnsi(frame) });
    writeEvidence(evidence, 'viewer-frame.txt', stripAnsi(frame));
    fixture.snapshot(evidence, 'frame-after-open', ws.rootPaneId);
    fixture.snapshotLayout(evidence, 'layout', ws.rootPaneId);
    writeEvidenceJson(evidence, 'list.json', fixture.listPanes());
    writeEvidence(evidence, 'wrapper.log.jsonl', fixture.rawLog());

    // No second `/dashboard` was sent, so nothing but the automatic ticks may have run: a second
    // `split` would show up as a second `GJC ` pane, and a second explicit call as another notify.
    const log = fixture.rawLog();
    const splits = log.split(/\r?\n/).filter((line) => /"split"/.test(line));
    assert(splits.length === 1, `exactly one pane split in this run, got ${splits.length}`, { log });
    // The quiet window must not grow past the OPEN notify that was already on screen: a second
    // explicit call would add another one, and `/dashboard` was sent exactly once.
    await expectNoNotify(fixture, ws.rootPaneId, OPENED_OR_PENDING,
      { windowMs: 20_000, baseline: opened.all.length });

    fixture.record('assertion',
      `lt3: ${opened.line}; viewer ${viewer.paneId} painted its data frame ${elapsedMs} ms after the notify`);
    return { notify: opened.line, viewer: viewer.paneId, elapsedMs };
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
    assert(cleanup.verifiedAbsent, 'every harness resource was verified absent', cleanup);
  }
});

// The viewer pane is the one the product labelled `GJC Todo · <key8>`; its frame is what the LV reads.
async function waitForViewer(fixture, { timeoutMs = 45_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pane = viewerPanes(fixture)
      .find(entry => DATA_FRAME.test(stripAnsi(fixture.readPane(entry.pane_id))));
    if (pane) return { ...pane, paneId: pane.pane_id };
    await new Promise((done) => { setTimeout(done, 1_000); });
  }
  const panes = viewerPanes(fixture);
  const frame = panes[0] ? stripAnsi(fixture.readPane(panes[0].pane_id)) : '(no viewer pane)';
  throw Object.assign(new Error(`the viewer did not paint a data frame within ${timeoutMs} ms`),
    { code: 'live-timeout', details: { frame } });
}
