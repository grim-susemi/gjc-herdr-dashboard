// LV-7 (L2): the two-role band, parallel + background subagents and the Workers pane in a
// harness-owned Herdr session.
//   AC2.1  Todo to the right of the parent, Workers below Todo (35 % Todo rows), layout proven by
//          `pane layout`; the parent keeps focus; floors respected.
//   AC2.2  two parallel `task` subagents appear as cards: running, then completed (auto-folded);
//          `c` shows them again.
//   AC2.3  cost 0 is shown as unknown (K1).
//   AC2.5  the assignment sentinel never appears in the Workers frame or in any state file.
//   AC2.6  a background task card is visible.
//   AC-F4  card title and status are readable at the real Workers pane width.
//   AC1.4  /dashboard x3 leaves exactly 2 role panes.
//
// Run: node test/live/l2-workers.mjs
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, runScript, sendPrompt, sendSlash,
  stripAnsi, viewerPanes, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-7';
const CASE = 'lvw';
const SESSION = 'gjcdash-lvw';
const SENTINEL = 'SENTINEL-ASSIGNMENT-7c1';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const walkFiles = (root) => {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; } // outcome: a vanished directory has no files to scan
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(full);
    }
  };
  walk(root);
  return out;
};

await runScript('l2-workers (LV-7)', async () => {
  const evidence = evidenceDirFor('L2', LV);
  rmSync(join(SANDBOX, `case-${CASE}`), { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  const result = {};
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    const parent = ws.rootPaneId;
    const status = () => fixture.listPanes().find((p) => p.pane_id === parent)?.agent_status ?? null;
    const waitIdle = async (label) => {
      for (let i = 0; i < 90 && status() !== 'idle'; i += 1) await sleep(2_000);
      assert(status() === 'idle', `the parent returned to idle (${label})`, { status: status() });
      await sleep(2_000);
    };
    await launchGjc(fixture, parent, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });

    // ---- AC2.1 / AC1.4: the band ---------------------------------------------------------------
    const focusBefore = fixture.listPanes().find((p) => p.focused)?.pane_id ?? null;
    const opened = await sendSlash(fixture, parent, 'dashboard', /열림|opened/, { label: 'open #1' });
    writeEvidence(evidence, 'notify-open-1.txt', opened.line);
    for (const n of [2, 3]) {
      const again = await sendSlash(fixture, parent, 'dashboard', /열림|opened|정상|ok/, { label: `open #${n}` });
      writeEvidence(evidence, `notify-open-${n}.txt`, again.line);
    }
    await sleep(8_000);
    const todo = viewerPanes(fixture, 'todo');
    const workers = viewerPanes(fixture, 'workers');
    writeEvidenceJson(evidence, 'list-after-open.json', fixture.listPanes());
    assert(todo.length === 1 && workers.length === 1,
      'exactly one Todo and one Workers pane after three /dashboard calls',
      { todo: todo.length, workers: workers.length });
    fixture.adoptPane(todo[0].pane_id, { role: 'viewer', label: todo[0].label });
    fixture.adoptPane(workers[0].pane_id, { role: 'viewer', label: workers[0].label });
    const layout = fixture.layout(parent);
    writeEvidenceJson(evidence, 'layout.json', layout);
    const rect = (id) => layout.panes.find((p) => p.pane_id === id)?.rect;
    const rp = rect(parent); const rt = rect(todo[0].pane_id); const rw = rect(workers[0].pane_id);
    assert(Boolean(rp && rt && rw), 'all three panes are in the layout', { rp, rt, rw });
    assert(rt.x === rp.x + rp.width && rt.y === layout.area.y, 'Todo is right of the parent at the top', { rp, rt });
    assert(rw.x === rt.x && rw.width === rt.width && rw.y === rt.y + rt.height,
      'Workers is directly below Todo with the same width', { rt, rw });
    assert(rt.height + rw.height === layout.area.height, 'Todo + Workers fill the dashboard column', { rt, rw });
    const dashShare = rt.width / layout.area.width;
    assert(Math.abs(dashShare - 1 / 3) < 0.03,
      `the dashboard column is about one third of the tab width (${dashShare.toFixed(3)})`,
      { area: layout.area, rt, rw });
    const todoShare = rt.height / layout.area.height;
    assert(Math.abs(todoShare - 0.35) < 0.08, `Todo holds about 35 % of the rows (${todoShare.toFixed(2)})`, { rt, rw });
    assert(rt.height >= 8 && rw.height >= 12 && rw.width >= 24, 'band floors hold', { rt, rw });
    const focusAfter = fixture.listPanes().find((p) => p.focused)?.pane_id ?? null;
    assert(focusAfter === focusBefore, 'the parent kept focus', { focusBefore, focusAfter });
    result.ac21 = { parent: rp, todo: rt, workers: rw, todoShare, dashShare };

    const workersPane = workers[0].pane_id;
    const readWorkers = () => stripAnsi(fixture.readPane(workersPane));
    writeEvidence(evidence, 'workers-frame-empty.txt', readWorkers());

    // ---- AC2.2 / AC2.3 / AC2.5: two parallel subagents ----------------------------------------
    await waitIdle('before subagents');
    await sendPrompt(fixture, parent,
      `Use the task tool ONCE with two tasks in parallel using the executor agent. Task ids lvwa and lvwb with descriptions lvwa and lvwb, ` +
      `each assignment: "run the bash command sleep 12, then reply with the word pong. ${SENTINEL}". Then reply done.`);
    const frames = [];
    let sawRunning = false; let sawBothDone = false; let runningFrame = '';
    // Q3=A: running cards carry the spinner glyph, not a word (the header says `run N`).
    const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
    const runningCard = (frame, id) => frame.split(/\r?\n/).some((line) =>
      line.includes(id) && SPINNER.test(line));
    const begin = Date.now();
    while (Date.now() - begin < 240_000) {
      await sleep(500);
      const frame = readWorkers();
      frames.push({ ms: Date.now() - begin, frame });
      if (runningCard(frame, 'lvwa') || runningCard(frame, 'lvwb')) {
        sawRunning = true;
        if (runningCard(frame, 'lvwa') && runningCard(frame, 'lvwb')) runningFrame = frame;
      }
      let data = null;
      try {
        const file = walkFiles(join(paths.stateDir, 'data')).find((f) => f.endsWith('workers.json'));
        data = file ? readJson(file) : null;
      } catch { data = null; } // outcome: a half-renamed file is re-read on the next sample
      const cards = data?.cards ?? [];
      if (cards.length >= 2 && cards.every((c) => ['completed', 'failed', 'aborted'].includes(c.status))) {
        sawBothDone = true;
        break;
      }
    }
    writeEvidenceJson(evidence, 'workers-frames.json', frames.filter((f, i) => i % 6 === 0 || /lvw[ab]/.test(f.frame)).slice(0, 40));
    writeEvidence(evidence, 'workers-frame-running.txt', runningFrame);
    assert(runningFrame !== '', 'AC2.2: both parallel cards were shown running at the same time', {});
    assert(!/background/.test(runningFrame), 'AC2.2: parallel cards fed by the bus are not marked background', { runningFrame });
    assert(sawRunning === true, 'a subagent card appeared while the run was in flight', {});
    assert(sawBothDone, 'both subagents reached a terminal state in workers.json', {});
    await sleep(3_000);
    const dataFile = walkFiles(join(paths.stateDir, 'data')).find((f) => f.endsWith('workers.json'));
    const data = readJson(dataFile);
    writeEvidenceJson(evidence, 'workers.json.snapshot.json', data);
    const statuses = data.cards.map((c) => c.status);
    assert(data.cards.length >= 2, 'at least two cards', { statuses });
    assert(data.cards.every((c) => c.cost === null || c.cost > 0), 'cost 0 is reported as unknown (null)',
      { costs: data.cards.map((c) => c.cost) });
    assert(data.cards.some((c) => c.tokens > 0), 'tokens are reported', {});
    const frameDone = readWorkers();
    writeEvidence(evidence, 'workers-frame-done.txt', frameDone);
    assert(!frameDone.includes(SENTINEL), 'AC2.5: the assignment sentinel is not in the Workers frame', {});
    const leaked = walkFiles(paths.stateDir).filter((f) => {
      try { return readFileSync(f, 'utf8').includes(SENTINEL); } catch { return false; } // outcome: unreadable file cannot leak
    });
    assert(leaked.length === 0, 'AC2.5: the assignment sentinel is in no state file', { leaked });
    // AC-F4: title + status visible at the real pane width. Completed cards are folded by
    // default, so the `c` frame (done cards shown) is the one that carries the titles.
    // c shows the completed cards (auto-folded cards are one line; the toggle must change the frame).
    fixture.sendKeys(workersPane, 'c');
    await sleep(1_500);
    const frameC = readWorkers();
    writeEvidence(evidence, 'workers-frame-c.txt', frameC);
    assert(frameC !== frameDone, 'c changes the Workers frame', {});
    const widest = frameC.split(/\r?\n/).reduce((m, l) => Math.max(m, [...l].length), 0);
    writeEvidenceJson(evidence, 'af4.json', { paneColumns: rw.width, widestLine: widest });
    assert(/lvwa|lvwb|executor/.test(frameC), 'AC-F4: a card title is visible at the real width',
      { width: rw.width, frameC });
    fixture.sendKeys(workersPane, 'c');
    result.ac22 = { statuses };

    // ---- AC2.6: a background task ---------------------------------------------------------------
    await waitIdle('before background');
    await sendPrompt(fixture, parent,
      'Use the task tool once, running in the background, one executor task id lvwbg with assignment ' +
      '"run the bash command sleep 20 and reply done". Do not wait for it; reply started right away.');
    let bgSeen = false;
    const bgBegin = Date.now();
    while (Date.now() - bgBegin < 120_000) {
      await sleep(2_000);
      if (/lvwbg/.test(readWorkers())) { bgSeen = true; break; }
    }
    writeEvidence(evidence, 'workers-frame-background.txt', readWorkers());
    assert(bgSeen, 'AC2.6: the background task card is visible', {});
    result.ac26 = { bgSeen };

    // ---- the parent is still idle/usable and the panes are intact --------------------------------
    await waitIdle('end');
    assert(viewerPanes(fixture, 'todo').length === 1 && viewerPanes(fixture, 'workers').length === 1,
      'both role panes survived the subagent runs', {});
    writeEvidenceJson(evidence, 'result.json', result);
    return result;
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
  }
});
