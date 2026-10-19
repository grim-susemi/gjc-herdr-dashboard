// L5b live case LV-goal: the Todo pane gains exactly one goal row after `/goal`, within 2 s of
// the gjc status line showing the goal, and has no row before it.
//
// Run: node test/live/l5-goal.mjs   (HERDR_BIN_PATH must point at the Herdr executable)
//
// The harness owns a separate Herdr session and one workspace. Every input goes through the
// fixture's owned-pane guard; the parent pane is typed into only after it was created by this
// script. The gjc process is launched inside that pane, so the dashboard's role viewers are
// discovered read-only inside the same workspace.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createFixture, REPO, SANDBOX } from "./fixture.mjs";
import { assert, createCase, evidenceDirFor, launchGjc, runScript, sendSlash, stripAnsi,
  viewerPanes, writeEvidence, writeEvidenceJson } from "./case.mjs";

const LV = "LV-goal";
const CASE = "l5goal";
const SESSION = "gjcdash-l5goal";
const WRAPPER = join(REPO, "test", "live", "herdr-wrapper.mjs");
const GOAL_PROMPT = "reply with the single word ok and stop";
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

const goalLineOf = (frame) => stripAnsi(frame).split(/\r?\n/).find((line) => line.includes("◎")) ?? "";
const hasGoalLine = (frame) => goalLineOf(frame) !== "";

// A slash command with arguments: narrow the completion popup to the single `/goal` command
// first (the measured 5-character head), then type the argument text in short chunks.
async function sendGoal(fixture, paneId, prompt) {
  fixture.sendText(paneId, "/goal");
  await sleep(900);
  const text = ` ${prompt}`;
  for (let at = 0; at < text.length; at += 12) {
    fixture.sendText(paneId, text.slice(at, at + 12));
    await sleep(150);
  }
  await sleep(1_200);
  fixture.sendKeys(paneId, "enter");
}

await runScript("l5-goal (LV-goal / AC5.2)", async () => {
  const evidence = evidenceDirFor("L5", LV);
  rmSync(join(SANDBOX, `case-${CASE}`), { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  const result = { schema: "gjc-herdr-dashboard/l5-goal-live/1", case: CASE, session: SESSION,
    goalPrompt: GOAL_PROMPT };
  let parent = null;
  let stopped = false;

  // Escape stops the model turn; `/exit` leaves the TUI. Both are best-effort because a failed
  // assertion must still reach fixture.cleanup(), and the guard refuses a pane we do not own.
  async function stopGjc() {
    if (stopped || parent === null) return;
    stopped = true;
    try {
      fixture.sendKeys(parent, "escape");
      await sleep(800);
      await fixture.slash(parent, "exit");
      await sleep(3_000);
    } catch (error) {
      // outcome: the TUI may already be gone; cleanup below still closes every harness resource.
      fixture.record("note", `stop-gjc: ${error.code ?? error.message}`);
    }
  }

  try {
    await fixture.startSession();
    const workspace = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    parent = workspace.rootPaneId;
    await launchGjc(fixture, parent, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ["GJC_LIVE_HERDR_SESSION", SESSION]] });
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });

    const opened = await sendSlash(fixture, parent, "dashboard", /열림|opened/);
    writeEvidence(evidence, "notify-open.txt", opened.line);

    // Wait for the Todo role pane and its first live frame before the baseline snapshot.
    let todo = null;
    const paneDeadline = Date.now() + 45_000;
    while (Date.now() < paneDeadline) {
      todo = viewerPanes(fixture, "todo")[0] ?? null;
      if (todo) break;
      await sleep(500);
    }
    assert(todo !== null, "the Todo viewer pane exists", { panes: fixture.listPanes() });
    await fixture.waitFor(todo.pane_id, (frame) => stripAnsi(frame).includes("Todo ["),
      { timeoutMs: 30_000, label: "Todo viewer frame" });
    await sleep(2_000);

    const beforeFrame = fixture.snapshot(evidence, "frame-before", todo.pane_id);
    fixture.snapshotLayout(evidence, "layout-todo", todo.pane_id);
    fixture.snapshotLayout(evidence, "layout-parent", parent);
    assert(!hasGoalLine(beforeFrame), "the Todo pane has NO goal line before /goal",
      { frame: stripAnsi(beforeFrame) });
    const beforeText = stripAnsi(beforeFrame);
    assert(!beforeText.includes("◎"), "the goal marker is absent before /goal", { frame: beforeText });

    await sendGoal(fixture, parent, GOAL_PROMPT);

    // Sample both panes in one loop. The status line is the reference event; the goal row must be
    // on the Todo pane no later than 2 s after the first sample that showed that status.
    let statusAt = null;
    let lineAt = null;
    let statusFrame = "";
    let lineFrame = "";
    let lastParent = "";
    let lastTodo = "";
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      lastParent = stripAnsi(fixture.readPane(parent));
      if (statusAt === null && /🎯\s*Goal/.test(lastParent)) {
        statusAt = Date.now();
        statusFrame = lastParent;
      }
      lastTodo = stripAnsi(fixture.readPane(todo.pane_id));
      if (lineAt === null && lastTodo.includes("◎")) {
        lineAt = Date.now();
        lineFrame = lastTodo;
      }
      if (statusAt !== null && lineAt !== null) break;
      if (statusAt !== null && Date.now() - statusAt > 2_000) break;
      await sleep(150);
    }

    assert(statusAt !== null, "the gjc pane status line showed the goal",
      { frame: lastParent });
    assert(lineAt !== null, "the Todo pane showed the goal line",
      { frame: lastTodo, statusFrame });
    const latencyMs = lineAt - statusAt;
    assert(latencyMs <= 2_000,
      `AC5.2: the goal line is on the Todo pane within 2 s of the status line (took ${latencyMs} ms)`,
      { latencyMs, statusFrame, lineFrame });

    const afterFrame = fixture.snapshot(evidence, "frame-goal", todo.pane_id);
    writeEvidence(evidence, "gjc-goal-status.txt", statusFrame);
    writeEvidence(evidence, "todo-goal-line.txt", goalLineOf(afterFrame));
    const row = goalLineOf(afterFrame);
    assert(row.includes("◎"), "the captured frame carries the goal marker", { row });
    // The host in this environment has no model credentials, so the goal's token/time counters can
    // legitimately stay at 0; the format is the assertion, not a positive number.
    assert(/·\s*\d+(?:\.\d+)?[KMB]?\s*토큰\s*·\s*\d+(?:시간|분|초)/.test(row),
      "the captured row carries a compact token count and elapsed time", { row });

    Object.assign(result, {
      todoPaneId: todo.pane_id,
      parentPaneId: parent,
      beforeHadGoalLine: false,
      afterHadGoalLine: true,
      statusAt,
      lineAt,
      latencyMs,
      goalLine: row,
      measuredAt: new Date().toISOString(),
    });
    writeEvidenceJson(evidence, "result.json", result);
    fixture.record("assertion", `l5-goal: ${JSON.stringify(result)}`);

    await stopGjc();
    return result;
  } finally {
    await stopGjc();
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, "cleanup.json", cleanup);
    assert(cleanup.verifiedAbsent, "every harness resource was verified absent", cleanup);
  }
});
