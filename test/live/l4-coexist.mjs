// LV-9 / AC4.5: omo-like foreign panes coexist with the dashboard (plan 15.5, A-7, C-7).
//
// No omo process is run. The harness makes three ordinary shell panes in the owned tab and labels
// them like omo's panes would be (`DAG · x`, `OmO DAG`, `OmO Todo · x`). Then `/dashboard` runs.
//
// Two layouts are measured, because the band planner treats them differently:
//   A. foreign panes are in OTHER tabs of the workspace (omo keeps its panes beside the parent):
//      the dashboard opens its two panes and the foreign ones are byte-identical afterwards.
//   B. foreign panes in the SAME tab as the parent: the planner may refuse the band shape
//      (`partial:shape`, AC2.8) but it must never touch, rename, close or move a foreign pane.
// In both, the id, label and shell pid of every foreign pane are compared before and after.
//
// Our own panes are found through the slot records (`viewerPanes`), not through a pane label: the
// dashboard puts no manual label on a pane, because Herdr draws it on the border and leaves a gap.
//
// Run: node test/live/l4-coexist.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, notifyLines,
  runScript, sendSlash, viewerPanes, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-9';
const CASE = 'l4coexist';
const SESSION = 'gjcdash-l4co';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const FOREIGN_LABELS = ['DAG · x', 'OmO DAG', 'OmO Todo · x'];
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

const identity = (fixture, ids) => ids.map((id) => {
  const pane = fixture.listPanes().find((entry) => entry.pane_id === id);
  const info = fixture.herdr(['pane', 'process-info', '--pane', id], { allowError: true });
  return { id, present: pane !== undefined, label: pane?.label ?? null, tab: pane?.tab_id ?? null,
    process: info?.process_info ?? info?.result ?? info ?? null };
});

function makeForeign(fixture, anchor, how) {
  const ids = [];
  for (const label of FOREIGN_LABELS) {
    let paneId;
    if (how === 'other-tab') {
      const created = fixture.herdr(['tab', 'create', '--workspace', anchor.workspaceId, '--label', label, '--no-focus']);
      paneId = created?.root_pane?.pane_id ?? created?.result?.root_pane?.pane_id ?? created?.pane?.pane_id;
    } else {
      const split = fixture.herdr(['pane', 'split', ids.at(-1) ?? anchor.rootPaneId, '--direction', 'down', '--no-focus']);
      paneId = split?.pane?.pane_id ?? split?.result?.pane?.pane_id;
    }
    assert(typeof paneId === 'string', `a foreign pane was created (${how}, ${label})`, { how, label });
    fixture.adoptPane(paneId, { role: 'foreign', label });
    fixture.herdr(['pane', 'rename', paneId, label]);
    ids.push(paneId);
  }
  return ids;
}

async function scenario(how, evidence) {
  rmSync(join(SANDBOX, `case-${CASE}-${how}`), { recursive: true, force: true });
  const paths = createCase({ caseId: `${CASE}-${how}`, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: `${SESSION}${how === 'other-tab' ? 'a' : 'b'}`, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}-${how}`) });
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: `${CASE}-${how}` });
    const parent = ws.rootPaneId;
    await launchGjc(fixture, parent, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', `${SESSION}${how === 'other-tab' ? 'a' : 'b'}`]] });
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });
    const foreign = makeForeign(fixture, ws, how);
    await sleep(2_000);
    const before = identity(fixture, foreign);
    const panesBefore = fixture.listPanes().map((p) => p.pane_id);
    writeEvidenceJson(evidence, `${how}-foreign-before.json`, before);
    assert(before.every((entry) => entry.present && entry.label !== null), `${how}: every foreign pane is listed with its label`, { before });

    const baseline = notifyLines(fixture.readPane(parent)).length;
    const pass = await sendSlash(fixture, parent, 'dashboard', /열림|opened|부분|partial|정상|인계/, { label: `${how} /dashboard`, since: () => baseline });
    writeEvidence(evidence, `${how}-notify.txt`, pass.line);
    await sleep(4_000);
    const after = identity(fixture, foreign);
    writeEvidenceJson(evidence, `${how}-foreign-after.json`, after);
    assert(JSON.stringify(after) === JSON.stringify(before),
      `AC4.5 (${how}): id, label, tab and shell process of the three foreign panes are unchanged`, { before, after });
    const created = fixture.listPanes().map((p) => p.pane_id).filter((id) => !panesBefore.includes(id));
    const ours = viewerPanes(fixture, null, { stateDir: paths.stateDir }).map((pane) => pane.pane_id);
    writeEvidenceJson(evidence, `${how}-created.json`, { created, ours, panes: fixture.listPanes() });
    assert(created.every((id) => ours.includes(id)),
      `AC4.5 (${how}): every pane the pass created is one the slot records name`, { created, ours });
    // No pane of ours carries a manual label: the label is exactly what Herdr would draw on the
    // border, so the dashboard must leave every pane label as Herdr set it.
    const labelled = fixture.listPanes().filter((pane) => ours.includes(pane.pane_id) && pane.label !== null);
    assert(labelled.length === 0, `AC4.5 (${how}): our panes carry no manual label`, { labelled });
    const todo = viewerPanes(fixture, 'todo', { stateDir: paths.stateDir }).length;
    const workers = viewerPanes(fixture, 'workers', { stateDir: paths.stateDir }).length;
    if (how === 'other-tab') {
      assert(todo === 1 && workers === 1, 'other-tab: the band opened (one Todo, one Workers)', { todo, workers });
    } else {
      assert(todo <= 1 && workers <= 1, 'same-tab: at most one pane per role', { todo, workers });
    }
    return { notify: pass.line, todo, workers, created, ours };
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, `${how}-cleanup.json`, cleanup);
    assert(cleanup.verifiedAbsent, `${how}: every harness resource was verified absent`, cleanup);
  }
}

await runScript('l4-coexist (LV-9 / AC4.5)', async () => {
  const evidence = evidenceDirFor('L4', LV);
  const result = {};
  result.otherTab = await scenario('other-tab', evidence);
  result.sameTab = await scenario('same-tab', evidence);
  writeEvidenceJson(evidence, 'result.json', result);
  return result;
});
