// User-scope install check (plan §14 AC6.2/AC6.3, §16 last line): run only after the owner approved
// the user-scope install and `node scripts/install.mjs --agent-dir <dir> --lang ko` has been run.
//
// One harness-owned Herdr session (`gjcdash-userscope`). gjc runs in an empty sandbox cwd, so the
// only way it can load the dashboard is the user-scope shim `<agent-dir>/extensions/`. No Herdr vector
// override is typed: the installed product resolves Herdr exactly as it would for the owner.
//
//   AC6.2  --doctor ok -> fresh gjc `/dashboard` -> `ext gen-NNNNNN · Todo 열림 · Workers 열림`
//          (token == the selected generation), Todo viewer paints `자동 추적 ON`, a Workers pane exists
//   AC6.3  --remove -> fresh gjc `/dashboard` -> no `ext ` notify and no extension error frame
//   restore --select <the same generation> -> --doctor ok again (the owner keeps the install)
//
// Slot/data entries this run created under `<agent-dir>/herdr-dashboard/state` belong to the dead
// test session; they are removed after the fixture cleanup, entries that existed before are kept.
//
// Run: node test/live/l6-userscope.mjs --agent-dir C:/Users/USER/.gjc/agent --confirm-user-scope
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFixture, EVIDENCE, REPO, SANDBOX } from "./fixture.mjs";
import { assert, launchGjc, notifyLines, runScript, sendSlash, stripAnsi, viewerPanes,
  writeEvidence, writeEvidenceJson } from "./case.mjs";

const USAGE = "Usage: node test/live/l6-userscope.mjs --agent-dir <dir> --confirm-user-scope";
const argv = process.argv.slice(2);
const at = argv.indexOf("--agent-dir");
const AGENT_DIR = at >= 0 && argv[at + 1] ? resolve(argv[at + 1]) : null;
if (AGENT_DIR === null || !argv.includes("--confirm-user-scope")) {
  console.error(USAGE);
  process.exit(2);
}

const SESSION = "gjcdash-userscope";
const DIR = join(SANDBOX, "case-userscope");
const STATE_DIR = join(AGENT_DIR, "herdr-dashboard", "state");
const INSTALL = join(REPO, "scripts", "install.mjs");
const EVID = join(EVIDENCE, "L6", "userscope");
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const listDir = (path) => {
  try { return readdirSync(path).sort(); }
  catch {
    // outcome: an absent directory is reported as an empty listing.
    return [];
  }
};

function cli(args) {
  const result = spawnSync(process.execPath, [INSTALL, "--agent-dir", AGENT_DIR, ...args],
    { cwd: REPO, encoding: "utf8", windowsHide: true });
  let json = null;
  try { json = JSON.parse(result.stdout); }
  catch {
    // outcome: a failed run writes plain stderr; the caller records the raw output.
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

await runScript("l6-userscope (AC6.2/AC6.3)", async () => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  assert(!existsSync(join(DIR, ".gjc")), "the test cwd has no project-scope extension");

  const doctorBefore = cli(["--doctor"]);
  assert(doctorBefore.status === 0 && doctorBefore.json?.ok === true,
    "precondition: the user-scope install is present and --doctor is ok", doctorBefore);
  const generation = doctorBefore.json.shim.targetGeneration;
  const token = `gen-${generation.slice(-6)}`;
  writeEvidenceJson(EVID, "doctor-before.json", doctorBefore.json);
  const slotsBefore = listDir(join(STATE_DIR, "slots"));
  const dataBefore = listDir(join(STATE_DIR, "data"));

  const fixture = createFixture({ session: SESSION, evidenceDir: EVID,
    logDir: join(SANDBOX, `live-${SESSION}`) });
  const summary = { schema: "gjc-herdr-dashboard/l6-userscope/1", session: SESSION,
    agentDir: AGENT_DIR, generation, token, startedAt: new Date().toISOString() };
  let live = false;
  let parent = null;
  const statusOf = () => fixture.listPanes()
    .find((pane) => (pane.pane_id ?? pane.paneId) === parent)?.agent_status ?? null;

  async function startGjc() {
    await launchGjc(fixture, parent, { dir: DIR });
    live = true;
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });
  }

  async function exitGjc(label) {
    const deadline = Date.now() + 60_000;
    while (statusOf() === "working" && Date.now() < deadline) await sleep(1_000);
    fixture.sendText(parent, "/exi");
    await sleep(900);
    fixture.sendText(parent, "t");
    await sleep(900);
    fixture.sendKeys(parent, "enter");
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      const frame = stripAnsi(fixture.readPane(parent));
      if (/PS [A-Za-z]:\\/.test(frame) || statusOf() === null) {
        await sleep(1_500);
        live = false;
        return frame;
      }
      await sleep(500);
    }
    throw Object.assign(new Error(`gjc did not return to the shell (${label})`), { code: "live-timeout" });
  }

  try {
    if (fixture.sessionRunning()) summary.staleSessionStopped = await fixture.stopSession();
    await fixture.startSession();
    parent = fixture.createWorkspace({ cwd: DIR, label: "l6-userscope" }).rootPaneId;

    // ------------------------------------------------------------------ AC6.2 ------------------
    await startGjc();
    const baseline = notifyLines(fixture.readPane(parent)).length;
    const open = await sendSlash(fixture, parent, "dashboard", /^\s*ext \S+ · /,
      { label: "AC6.2 user scope", since: () => baseline });
    writeEvidence(EVID, "notify-open.txt", open.line);
    fixture.snapshot(EVID, "frame-parent", parent);
    assert(open.line.includes(`ext ${token} ·`), `AC6.2: the notify carries ${token}`, { line: open.line });
    assert(/Todo 열림/.test(open.line) && /Workers 열림/.test(open.line),
      "AC6.2: both roles opened from the user-scope install", { line: open.line });
    let todo = null;
    const until = Date.now() + 45_000;
    while (todo === null && Date.now() < until) {
      todo = viewerPanes(fixture, "todo")[0] ?? null;
      if (todo === null) await sleep(1_000);
    }
    assert(todo !== null, "AC6.2: a Todo viewer pane exists", { panes: fixture.listPanes() });
    await fixture.waitFor(todo.pane_id, (value) => stripAnsi(value).includes("자동 추적 ON"),
      { timeoutMs: 45_000, label: "Todo viewer footer" });
    fixture.snapshot(EVID, "frame-todo", todo.pane_id);
    const workers = viewerPanes(fixture, "workers")[0] ?? null;
    assert(workers !== null, "AC6.2: a Workers viewer pane exists", { panes: fixture.listPanes() });
    fixture.snapshot(EVID, "frame-workers", workers.pane_id);
    summary.ac62 = { line: open.line, todoPane: todo.pane_id, workersPane: workers.pane_id };
    await exitGjc("AC6.2");

    // ------------------------------------------------------------------ AC6.3 ------------------
    const remove = cli(["--remove"]);
    assert(remove.status === 0 && remove.json?.removed === true, "AC6.3: --remove deletes the shim", remove);
    writeEvidenceJson(EVID, "remove.json", remove.json);
    await startGjc();
    const frameBase = stripAnsi(fixture.readPane(parent));
    const quietBase = notifyLines(frameBase).length;
    await fixture.slash(parent, "dashboard");
    await sleep(12_000);
    const frameRemoved = fixture.readPane(parent);
    const plainRemoved = stripAnsi(frameRemoved);
    const newNotifies = notifyLines(frameRemoved).slice(quietBase);
    fixture.snapshot(EVID, "frame-after-remove", parent);
    // Silence alone could be a swallowed keystroke (final review, MEDIUM): require positive proof that
    // gjc took the input - the input box is back to its placeholder and the frame changed.
    assert(/Type your message/.test(plainRemoved), "AC6.3: the input box consumed the command",
      { frame: plainRemoved });
    assert(plainRemoved !== frameBase, "AC6.3: gjc reacted to the typed command", { frame: plainRemoved });
    assert(newNotifies.length === 0, "AC6.3: no ext notify without the shim", { newNotifies });
    assert(!/ineligible:|failed:/.test(plainRemoved), "AC6.3: no extension error frame");
    fixture.sendKeys(parent, "escape");
    await sleep(1_000);
    await exitGjc("AC6.3");
    summary.ac63 = { removed: true, newNotifies };

    // ------------------------------------------------------------------ restore ----------------
    const select = cli(["--select", generation]);
    assert(select.status === 0 && select.json?.selected === true, "restore: --select re-creates the shim", select);
    const doctorAfter = cli(["--doctor"]);
    assert(doctorAfter.status === 0 && doctorAfter.json?.ok === true
      && doctorAfter.json.shim.targetGeneration === generation, "restore: --doctor ok again", doctorAfter);
    writeEvidenceJson(EVID, "doctor-after.json", doctorAfter.json);
    summary.restored = { generation, doctorOk: true };
    summary.finishedAt = new Date().toISOString();
    writeEvidenceJson(EVID, "result.json", summary);
    return summary;
  } finally {
    if (live === true) {
      try { await exitGjc("finally"); }
      catch (error) {
        // outcome: a failed graceful exit is recorded; cleanup still re-confirms ownership first.
        writeEvidenceJson(EVID, "finally-exit.json", { code: error.code ?? null, message: error.message });
      }
    }
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(EVID, "cleanup.json", cleanup);
    const created = {
      slots: listDir(join(STATE_DIR, "slots")).filter((name) => !slotsBefore.includes(name)),
      data: listDir(join(STATE_DIR, "data")).filter((name) => !dataBefore.includes(name)),
    };
    for (const name of created.slots) rmSync(join(STATE_DIR, "slots", name), { recursive: true, force: true });
    for (const name of created.data) rmSync(join(STATE_DIR, "data", name), { recursive: true, force: true });
    writeEvidenceJson(EVID, "state-cleanup.json", created);
    assert(cleanup.verifiedAbsent, "every harness resource was verified absent", cleanup);
  }
});
