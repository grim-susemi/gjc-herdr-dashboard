// LV-2 / LT-1: a split failure is reported as a failure, and the NEXT `/dashboard` still opens.
//
// Plan §15.3 LV-2: flag `fail-split-once` + `/dashboard` x2 -> first notify is the split failure,
// second notify says the pane opened, and exactly one role pane exists at the end.
//
// The flag makes the wrapper's FIRST `pane split` fail with a structured Herdr error (exit 1), so
// the launch pass answers `failed:herdr-split` and creates nothing. The second pass splits for real
// and opens the viewer.
//
// Run: node test/live/lt1-fault.mjs      (needs HERDR_BIN_PATH; creates and cleans its own session)
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, runScript, sendSlash, viewerPanes,
  writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-2';
const CASE = 'lt1-fault';
const SESSION = 'gjcdash-lt1';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');

// The catalogue localizes the token (`notify.failure.herdr-split` -> "pane split" in ko/en), so the
// notify carries `실패(pane split)` rather than the raw `herdr-split`; both are accepted, and the
// raw form is what an unreadable catalogue would print.
const SPLIT_FAILURE = /실패\(pane split\)|herdr-split|failed:herdr-split/;
const OPENED = /열림|opened/;

await runScript('lt1-fault (LV-2)', async () => {
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
    writeEvidence(evidence, 'boot-frame.txt', fixture.readPane(ws.rootPaneId));

    // Arm the fault BEFORE the first `/dashboard`: the wrapper consumes it on the first split.
    // The flag file's mtime is what orders it against the wrapper log, so it must be created after
    // the boot frames the script already wrote into the same evidence directory.
    rmSync(join(fixture.logDir, 'wrapper.log.jsonl'), { force: true });
    fixture.armFault('fail-split-once');
    const first = await sendSlash(fixture, ws.rootPaneId, 'dashboard', SPLIT_FAILURE,
      { label: 'the split-failure notify' });
    assert(SPLIT_FAILURE.test(first.line), `first notify is the split failure, got: ${first.line}`);
    assert(viewerPanes(fixture).length === 0,
      'a failed split leaves zero role panes', { panes: fixture.listPanes() });
    writeEvidence(evidence, 'notify-1.txt', first.line);
    fixture.snapshot(evidence, 'frame-after-failure', ws.rootPaneId);

    // The flag is consumed, so the second `/dashboard` splits, renames and runs for real.
    const second = await sendSlash(fixture, ws.rootPaneId, 'dashboard', OPENED,
      { label: 'the opened notify', since: () => first.all.length });
    const panes = viewerPanes(fixture);
    assert(panes.length === 1, `exactly one role pane after the second call, got ${panes.length}`,
      { panes: fixture.listPanes() });
    writeEvidence(evidence, 'notify-2.txt', second.line);
    fixture.snapshot(evidence, 'frame-after-open', ws.rootPaneId);
    fixture.snapshotLayout(evidence, 'layout', ws.rootPaneId);
    writeEvidenceJson(evidence, 'list.json', fixture.listPanes());
    writeEvidence(evidence, 'wrapper.log.jsonl', fixture.rawLog());

    fixture.record('assertion', `lt1: ${first.line} -> ${second.line}`);
    return { first: first.line, second: second.line, pane: panes[0].pane_id };
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
    assert(cleanup.verifiedAbsent, 'every harness resource was verified absent', cleanup);
  }
});
