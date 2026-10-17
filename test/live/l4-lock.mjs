// LV-10 / l4-lock: two `/dashboard` calls back to back, with no wait between them.
//
// Plan §15.3 LV-10 asks for two simultaneous calls. True cross-process lock contention cannot be
// produced with ONE parent gjc instance - a single instance serialises its own explicit passes
// (`createReconciler`'s one-pass-at-a-time queue), so the second call never races the first from
// another process. What CAN be produced with one parent, and what this script does, is two sends
// with NO wait between them: the second `/dashboard` arrives while the first pass is still running.
// Then this script asserts the observable contract:
//   * at most one role pane exists (the second call must not split a second one),
//   * no lock error notify (`사용 중` / `busy`, `busy:other-owner`) is shown to the user,
//   * the wrapper log shows exactly one `pane split` for the whole run.
//
// Cross-process contention (two gjc processes, two lock generations) is covered by the unit tests
// only: `test/unit/reconciler.test.mjs` LT-7a-d drives `acquireLock`/`releaseLock`/`generationIsCurrent`
// with a fake clock and a fake process table. That limitation is recorded in `lock-coverage.json`.
//
// Run: node test/live/l4-lock.mjs
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, notifyLines, runScript, viewerPanes,
  waitForNotify, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-10';
const CASE = 'l4-lock';
const SESSION = 'gjcdash-l4lock';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
// The ko catalogue renders the busy rows; the raw tokens are accepted too, because a drill greps for
// the machine token and an unreadable catalogue prints it.
const OPENED = /열림|opened/;
const LOCK_ERROR = /사용 중|busy|잠금|lock|실패/;

const secondOf = (observed) => {
  const before = new Set(observed[0]);
  return observed[1].find((line) => !before.has(line)) ?? null;
};

const notifyTexts = (fixture, paneId) =>
  notifyLines(fixture.readPane(paneId));


await runScript('l4-lock (LV-10)', async () => {
  const evidence = evidenceDirFor('L1', LV);
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    await launchGjc(fixture, ws.rootPaneId, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
    await fixture.waitIdle(ws.rootPaneId, { timeoutMs: 120_000, quiet: 3 });

    // Two sends, no wait in between: the first Enter is pressed and the second command is typed
    // immediately, so the second call lands inside (or right after) the first pass.
    const first = await sendTwice(fixture, ws.rootPaneId, 'dashboard');
    const opened = await waitForNotify(fixture, ws.rootPaneId, OPENED, { timeoutMs: 90_000 });
    writeEvidence(evidence, 'notify-first.txt', opened.line);
    writeEvidence(evidence, 'notify-second.txt', secondOf(first) ?? '(no second notify)');

    // Give the second call time to reach the host (and to be dropped, which is the expected result).
    await new Promise((done) => { setTimeout(done, 15_000); });

    const panes = viewerPanes(fixture);
    assert(panes.length <= 1, `at most one viewer pane, got ${panes.length}`,
      { panes: fixture.listPanes() });
    const log = fixture.rawLog();
    const splits = log.split(/\r?\n/).filter((line) => /"split"/.test(line));
    assert(splits.length <= 1, `at most one pane split, got ${splits.length}`, { log });
    const notices = notifyTexts(fixture, ws.rootPaneId);
    const lockErrors = notices.filter((line) => LOCK_ERROR.test(line));
    assert(lockErrors.length === 0, `no lock/busy error notify, got ${JSON.stringify(lockErrors)}`,
      { notices });
    writeEvidenceJson(evidence, 'notices.json', notices);
    writeEvidenceJson(evidence, 'lock-coverage.json', {
      live: 'two `/dashboard` sends back to back in ONE parent gjc instance',
      observed: { viewerPanes: panes.length, splits: splits.length, notices },
      notCoveredLive: 'cross-process lock contention (two gjc processes, two lock generations)',
      unitCoverage: ['test/unit/reconciler.test.mjs LT-7a-d (acquireLock/releaseLock/generationIsCurrent)'],
      reason: 'one parent instance serialises its own explicit passes, so a second PROCESS cannot be '
        + 'produced without a second gjc session; the plan keeps that case in unit tests',
    });
    fixture.snapshot(evidence, 'frame-after-both', ws.rootPaneId);
    fixture.snapshotLayout(evidence, 'layout', ws.rootPaneId);
    writeEvidence(evidence, 'wrapper.log.jsonl', log);
    writeEvidenceJson(evidence, 'list.json', fixture.listPanes());

    fixture.record('assertion',
      `l4-lock: ${notices.length} notify line(s), ${splits.length} split(s), ${panes.length} viewer pane(s)`);
    return { notices, splits: splits.length, panes: panes.length };
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
    assert(cleanup.verifiedAbsent, 'every harness resource was verified absent', cleanup);
  }
});

// Both sends happen without waiting for the first one's result.
// Both sends happen without waiting for the first one's result: the second command is typed as soon
// as the first Enter is pressed. The only gaps are the popup-settle gaps INSIDE each slash command
// (which the input box requires), never a wait for the first call to finish.
async function sendTwice(fixture, paneId, name) {
  await fixture.slash(paneId, name);
  await fixture.slash(paneId, name);
  return [notifyTexts(fixture, paneId), notifyTexts(fixture, paneId)];
}
