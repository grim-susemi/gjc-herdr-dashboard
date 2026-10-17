// L1 live behaviours in one harness-owned session (critic round 1 evidence gaps):
//   AC1.10 / LV-13  parent agent_status working -> idle sampled while the dashboard is open
//   AC1.2           `/todo append` is reflected in data/<scopeKey>/todo.json within 2 s of its event, and a
//                   model-driven todo_write is reflected within 2 s of the tool finishing (file mtime vs
//                   the first sample that shows the row)
//   LV-6            a task subagent run: wrapper-log Herdr call count before/after, state-dir file diff
//   AC1.11 / LV-11  `/new` then a Todo row then the old scope is not mixed: scopeKey changes, pane id stays
//   AC1.9 (exit)    `/exit` -> the viewer shows `연결 끊김` within 5 s, pane stays
//
// Run: node test/live/l1-behaviour.mjs
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, runScript, sendPrompt, sendSlash,
  stripAnsi, viewerPanes, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-13b';
const CASE = 'lvbeh';
const SESSION = 'gjcdash-lvbeh';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const tree = (root) => {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(full.slice(root.length + 1).replaceAll('\\', '/'));
    }
  };
  try { walk(root); } catch { /* absent */ }
  return out.sort();
};
const herdrCalls = (fixture) => fixture.rawLog().split(/\r?\n/).filter(Boolean).length;

await runScript('l1-behaviour (LV-13/LV-6/LV-11/AC1.2/AC1.9)', async () => {
  const evidence = evidenceDirFor('L1', LV);
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
    await launchGjc(fixture, parent, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });

    const opened = await sendSlash(fixture, parent, 'dashboard', /열림|opened/);
    writeEvidence(evidence, 'notify-open.txt', opened.line);
    const slotsDir = join(paths.stateDir, 'slots');
    const slotKey = readdirSync(slotsDir)[0];
    const dataDir = () => join(paths.stateDir, 'data');
    const todoFiles = () => tree(dataDir()).filter((f) => f.endsWith('/todo.json'));
    await sleep(8_000);

    // ---- AC1.10 / LV-13: working -> idle while the dashboard is open ------------------------
    const idleBefore = status();
    await sendPrompt(fixture, parent, 'Run the bash command: sleep 15. Then reply done.');
    const samples = [];
    const begin = Date.now();
    while (Date.now() - begin < 70_000) {
      samples.push({ ms: Date.now() - begin, status: status(), panes: viewerPanes(fixture).length });
      if (samples.some((s) => s.status === 'working') && samples.at(-1).status === 'idle') break;
      await sleep(2_000);
    }
    writeEvidenceJson(evidence, 'agent-status-samples.json', { idleBefore, samples });
    assert(idleBefore === 'idle', 'the parent was idle before the prompt', { idleBefore });
    assert(samples.some((s) => s.status === 'working'), 'the parent reached working', { samples });
    assert(samples.at(-1).status === 'idle', 'the parent returned to idle', { samples });
    assert(samples.every((s) => s.panes === 1), 'the dashboard pane stayed while the prompt ran', { samples });
    result.ac110 = `idle -> working -> idle over ${samples.at(-1).ms} ms`;

    // ---- AC1.2: todo_write is reflected within 2 s of the tool finishing ---------------------------
    // The model-driven path (tool_execution_end event). The data file mtime is compared with the first
    // sample that shows the row; the tool result itself is stamped by the file the host writes.
    const dataFile = () => { const f = todoFiles()[0]; return f ? join(dataDir(), ...f.split("/")) : null; };
    let firstSeen = null;
    const rowSeen = () => { try { const d = readJson(dataFile()); if (JSON.stringify(d.phases).includes("lv13-row")) { firstSeen = d; return true; } } catch { /* not yet */ } return false; };
    await sendPrompt(fixture, parent, "Call the todo_write tool once with a phase LV13 and one pending task lv13-row. Then reply done.");
    const promptAt = Date.now();
    let rowAt = null;
    let screenAt = null;
    let idleAfter = null;
    while (Date.now() - promptAt < 150_000) {
      await sleep(250);
      if (rowAt === null && rowSeen()) rowAt = Date.now();
      if (rowAt !== null && screenAt === null) {
        const pane = viewerPanes(fixture)[0];
        if (pane && stripAnsi(fixture.readPane(pane.pane_id)).includes("lv13-row")) screenAt = Date.now();
      }
      if (screenAt !== null) break;
    }
    assert(rowAt !== null, "a model-driven todo_write reached the data file", {});
    // updatedAt is the host clock when the projection was taken (right after tool_execution_end);
    // generatedAt adds the writer merge. rowAt is the first poll (<=250 ms) that saw the row on disk.
    assert(screenAt !== null, "the todo_write row appeared on the viewer screen", {});
    const eventToDiskMs = rowAt - firstSeen.updatedAt;
    // updatedAt is the host clock right after tool_execution_end: event -> viewer screen is the AC1.2 span.
    const eventToScreenMs = screenAt - firstSeen.updatedAt;
    writeEvidence(evidence, "ac1-2-todo-write.txt",
      "first_seen_at=" + rowAt + " projection_updatedAt=" + firstSeen.updatedAt + " generatedAt=" + firstSeen.generatedAt +
      "\nevent_to_disk_ms=" + eventToDiskMs + "\nevent_to_viewer_screen_ms=" + eventToScreenMs + " (sampled every 250 ms plus a pane read; the viewer repaints every 1 s)\nprompt_to_row_ms=" + (rowAt - promptAt) + " (includes the model turn)\n");
    assert(eventToScreenMs <= 2_000, "AC1.2: the row is on the viewer screen within 2 s of the todo_write event (" + eventToScreenMs + " ms)", {});

    for (let i = 0; i < 60 && status() !== "idle"; i += 1) await sleep(2_000);
    await sleep(2_000);

    // /todo append emits no event (README 4.5): recorded, not gated; the 1 s leaf poll or the next event reflects it.
    fixture.sendText(parent, "/todo");
    await sleep(900);
    fixture.sendText(parent, " append LV13 behaviour-row");
    await sleep(900);
    const appendedAt = Date.now();
    fixture.sendKeys(parent, "enter");
    let reflectedMs = null;
    for (let i = 0; i < 160 && reflectedMs === null; i += 1) {
      await sleep(100);
      try { if (JSON.stringify(readJson(dataFile()).phases).includes("behaviour-row")) reflectedMs = Date.now() - appendedAt; } catch { /* not yet */ }
    }
    writeEvidence(evidence, "ac1-2-todo-append.txt",
      "todo_append_reflected_ms_after_enter=" + reflectedMs + " (README 4.5: no event, next-event path; G9 value freshness was never measured)");
    result.ac12 = { todoWriteEventToDiskMs: eventToDiskMs, todoWriteEventToScreenMs: eventToScreenMs, todoAppendReflectedMs: reflectedMs };

    // ---- LV-6: a task subagent run leaves the Herdr log and the state tree alone ---------------
    const stateBefore = tree(paths.stateDir);
    const callsBefore = herdrCalls(fixture);
    const ownerBefore = readJson(join(slotsDir, slotKey, 'owner.json'));
    await sendPrompt(fixture, parent,
      'Use the task tool once with the executor agent: assignment "reply with the word pong and stop". Then reply done.');
    const subBegin = Date.now();
    let subSeen = false;
    while (Date.now() - subBegin < 150_000) {
      await sleep(3_000);
      if (status() === 'working') subSeen = true;
      if (subSeen && status() === 'idle') break;
    }
    const callsAfter = herdrCalls(fixture);
    const stateAfter = tree(paths.stateDir);
    const lockish = (f) => /\/lock\//.test(f) || /owner\.json$/.test(f) || /\.ready\.json$/.test(f) ||
      /slot\.json$/.test(f) || /todo\.json$/.test(f);
    const newFiles = stateAfter.filter((f) => !stateBefore.includes(f) && !lockish(f));
    writeEvidenceJson(evidence, 'lv6.json', { callsBefore, callsAfter, newFiles, subSeen,
      ownerBefore, ownerAfter: readJson(join(slotsDir, slotKey, 'owner.json')) });
    assert(subSeen, 'the parent ran a turn for the subagent request', {});
    const subWindow = fixture.rawLog().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.atMs >= subBegin);
    const byPpid = {};
    for (const e of subWindow) { const k = String(e.ppid ?? '?'); byPpid[k] = (byPpid[k] ?? 0) + 1; }
    const gjcPids = new Set([String(ownerBefore.pid)]);
    const foreign = Object.keys(byPpid).filter((k) => !gjcPids.has(k));
    writeEvidenceJson(evidence, 'lv6-calls-by-caller.json', { subBegin, ownerPid: ownerBefore.pid, byPpid, verbs: subWindow.reduce((m, e) => { const v = e.argv.slice(0, 2).join(' '); m[v] = (m[v] ?? 0) + 1; return m; }, {}) });
    assert(foreign.length === 0, 'every Herdr call during the subagent run came from the main gjc process (a subagent runs inside it, so this attributes calls to the process, not to the sub session; the sub-session guarantee is LT-6)', { byPpid, ownerPid: ownerBefore.pid });
    // The parent's own passes (turn_end/agent_end) may log `pane list` calls; what must not appear is
    // any mutation (split/run/close/rename). A raw count is recorded; the gate is mutations.
    const log = fixture.rawLog().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const mutations = log.filter((e) => ['split', 'run', 'close', 'rename'].includes(e.argv?.[1])
      && e.atMs >= subBegin);
    assert(mutations.length === 0, 'no Herdr mutation during the subagent run', { mutations });
    assert(newFiles.length === 0, 'no new state file other than lock/owner/ready/slot/data', { newFiles });
    result.lv6 = { calls: callsAfter - callsBefore, mutations: 0, newFiles: 0 };

    // ---- AC1.11 / LV-11: /new rebinds scope, pane id stays -------------------------------------
    const slotBeforeNew = readJson(join(slotsDir, slotKey, 'slot.json'));
    const paneBefore = viewerPanes(fixture)[0].pane_id;
    for (let i = 0; i < 60 && status() !== 'idle'; i += 1) await sleep(2_000);
    await sleep(3_000);
    // Keystrokes into the input popup can be swallowed (recorded harness race): retry the whole command.
    let slotAfterNew = slotBeforeNew;
    for (let attempt = 1; attempt <= 3 && slotAfterNew.scope?.scopeKey === slotBeforeNew.scope?.scopeKey; attempt += 1) {
      fixture.sendKeys(parent, 'escape');
      await sleep(600);
      fixture.sendText(parent, '/ne');
      await sleep(900);
      fixture.sendText(parent, 'w');
      await sleep(900);
      fixture.sendKeys(parent, 'enter');
      for (let i = 0; i < 15; i += 1) {
        await sleep(1_000);
        slotAfterNew = readJson(join(slotsDir, slotKey, 'slot.json'));
        if (slotAfterNew.scope?.scopeKey !== slotBeforeNew.scope?.scopeKey) break;
      }
      fixture.record('assertion', '/new attempt ' + attempt + ': scope ' + (slotAfterNew.scope?.scopeKey !== slotBeforeNew.scope?.scopeKey ? 'changed' : 'unchanged'));
    }
    writeEvidenceJson(evidence, 'lv11.json', { before: slotBeforeNew.scope, after: slotAfterNew.scope,
      paneBefore, paneAfter: viewerPanes(fixture)[0]?.pane_id });
    assert(slotAfterNew.scope?.scopeKey !== slotBeforeNew.scope?.scopeKey, '/new changed the scopeKey',
      { before: slotBeforeNew.scope, after: slotAfterNew.scope });
    assert(slotAfterNew.scope.scopeEpoch > slotBeforeNew.scope.scopeEpoch, 'scopeEpoch advanced');
    assert(viewerPanes(fixture)[0].pane_id === paneBefore, 'the viewer pane id did not change');
    result.lv11 = { scopeEpoch: [slotBeforeNew.scope.scopeEpoch, slotAfterNew.scope.scopeEpoch] };

    for (let i = 0; i < 60 && status() !== 'idle'; i += 1) await sleep(2_000);
    await sleep(2_000);
    // ---- AC1.9 exit: /exit -> 연결 끊김 within 5 s ----------------------------------------------
    fixture.sendText(parent, '/exi');
    await sleep(900);
    fixture.sendText(parent, 't');
    await sleep(900);
    const exitAt = Date.now();
    fixture.sendKeys(parent, 'enter');
    let disconnectMs = null;
    let frame = '';
    for (let i = 0; i < 60 && disconnectMs === null; i += 1) {
      await sleep(250);
      const pane = viewerPanes(fixture)[0];
      if (!pane) break;
      frame = stripAnsi(fixture.readPane(pane.pane_id));
      if (/연결 끊김/.test(frame)) disconnectMs = Date.now() - exitAt;
    }
    writeEvidence(evidence, 'viewer-after-exit.txt', frame);
    writeEvidence(evidence, 'ac1-9-exit.txt', `disconnect_label_ms_after_enter=${disconnectMs}`);
    assert(disconnectMs !== null, 'the viewer showed 연결 끊김 after /exit', { frame });
    assert(disconnectMs <= 5_000, `AC1.9: 연결 끊김 within 5 s of a normal exit (took ${disconnectMs} ms)`, { frame });
    assert(viewerPanes(fixture).length === 1, 'the viewer pane stays after /exit');
    result.ac19Exit = { disconnectMs };
    writeEvidenceJson(evidence, 'result.json', result);
    fixture.record('assertion', `l1-behaviour: ${JSON.stringify(result)}`);
    return result;
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
    assert(cleanup.verifiedAbsent, 'every harness resource was verified absent', cleanup);
  }
});
