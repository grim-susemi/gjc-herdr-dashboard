// L6 rollback drills D1-D4 (plan §16, stage-05 R5; AC6.1/AC6.3).
//
// One harness-owned Herdr session (`gjcdash-l6drill`) and one parent pane. The project-scope
// extension directory GJC loads is `<cwd>/.gjc/extensions` (measured G1: project dir = cwd), so the
// drill runs gjc with cwd `<repo>/.sandbox/case-drill` and installs into
// `<repo>/.sandbox/case-drill/.gjc` (`--agent-dir`). G13: GJC_CODING_AGENT_DIR is NOT honoured by
// this binary, which is why the agent dir and the cwd are the same directory.
//
//   D1  install A -> fresh gjc -> `ext gen-000001`; install B -> fresh gjc -> `ext gen-000002`;
//       --doctor: shim target == current.json
//   D2  --select A -> fresh gjc -> gen-000001; slot schema / state directory reused
//   D3  each install failpoint -> doctor (+ fresh gjc where the selection matters) and --select repair
//   D4  --remove -> fresh gjc has no /dashboard: no `ext ` notify and no extension error frame
//
// Run: node test/live/l6-drills.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createFixture, EVIDENCE, REPO, SANDBOX } from "./fixture.mjs";
import { assert, launchGjc, notifyLines, runScript, sendSlash, stripAnsi, viewerPanes,
  writeEvidence, writeEvidenceJson } from "./case.mjs";

const SESSION = "gjcdash-l6drill";
const CASE = "drill";
const DIR = join(SANDBOX, `case-${CASE}`);
const AGENT_DIR = join(DIR, ".gjc");
const STATE_DIR = join(AGENT_DIR, "herdr-dashboard", "state");
const INSTALL = join(REPO, "scripts", "install.mjs");
const WRAPPER = join(REPO, "test", "live", "herdr-wrapper.mjs");
const EVIDENCE_L6 = join(EVIDENCE, "L6");
const FAILPOINT_ENV = "GJC_HERDR_DASHBOARD_INSTALL_FAILPOINT";
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const listDir = (path) => {
  try { return readdirSync(path).sort(); }
  catch {
    // outcome: an absent directory is reported as an empty listing.
    return [];
  }
};
const ev = (drill) => join(EVIDENCE_L6, drill);

function cli(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [INSTALL, "--agent-dir", AGENT_DIR, ...args],
    { cwd: REPO, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true });
  let json = null;
  try { json = JSON.parse(result.stdout); }
  catch {
    // outcome: a failed run writes plain stderr; the caller records the raw output.
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

const installCli = (args, options) => cli(args, options);
const doctorCli = () => cli(["--doctor"]);

function tokenOf(line) {
  const match = /\bext\s+(\S+)\s+·/.exec(line);
  assert(match !== null, `a notify line carries a generation token: ${line}`, { line });
  return match[1];
}

await runScript("l6-drills (D1-D4)", async () => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const fixture = createFixture({ session: SESSION, evidenceDir: EVIDENCE_L6,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  const summary = { schema: "gjc-herdr-dashboard/l6-drill/1", session: SESSION,
    agentDir: AGENT_DIR, stateDir: STATE_DIR, startedAt: new Date().toISOString(), drills: {} };
  let live = false;
  let parent = null;

  const statusOf = () => fixture.listPanes()
    .find((pane) => (pane.pane_id ?? pane.paneId) === parent)?.agent_status ?? null;

  async function startGjc() {
    const command = await launchGjc(fixture, parent, { dir: DIR,
      herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ["GJC_LIVE_HERDR_SESSION", SESSION]] });
    live = true;
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });
    return command;
  }

  async function waitForShell(label) {
    const deadline = Date.now() + 30_000;
    let frame = "";
    while (Date.now() < deadline) {
      frame = stripAnsi(fixture.readPane(parent));
      // The pane is PowerShell; when gjc exits, its agent_status disappears and the prompt returns.
      if (/PS [A-Za-z]:\\/.test(frame) || statusOf() === null) {
        await sleep(1_500);
        live = false;
        return frame;
      }
      await sleep(500);
    }
    throw Object.assign(new Error(`gjc did not return to the shell (${label})`),
      { code: "live-timeout", details: { frame } });
  }

  async function exitGjc(label) {
    const deadline = Date.now() + 60_000;
    while (statusOf() === "working" && Date.now() < deadline) await sleep(1_000);
    fixture.sendText(parent, "/exi");
    await sleep(900);
    fixture.sendText(parent, "t");
    await sleep(900);
    fixture.sendKeys(parent, "enter");
    return waitForShell(label);
  }

  async function openDashboard(label) {
    const frame = fixture.readPane(parent);
    const baseline = notifyLines(frame).length;
    return sendSlash(fixture, parent, "dashboard", /^\s*ext \S+ · /,
      { label, since: () => baseline });
  }

  async function todoViewerFrame(evidence, name, expected) {
    const deadline = Date.now() + 45_000;
    let pane = null;
    while (pane === null && Date.now() < deadline) {
      pane = viewerPanes(fixture, "todo")[0] ?? null;
      if (pane === null) await sleep(1_000);
    }
    assert(pane !== null, "a Todo viewer pane exists", { panes: fixture.listPanes() });
    await fixture.waitFor(pane.pane_id, value => stripAnsi(value).includes(expected),
      { timeoutMs: 45_000, label: `viewer shows ${expected}` });
    fixture.snapshot(join(EVIDENCE_L6, evidence), name, pane.pane_id);
    return stripAnsi(fixture.readPane(pane.pane_id));
  }

  try {
    if (fixture.sessionRunning()) {
      summary.staleSessionStopped = await fixture.stopSession();
    }
    await fixture.startSession();
    const workspace = fixture.createWorkspace({ cwd: DIR, label: "l6-drill" });
    parent = workspace.rootPaneId;

    // ------------------------------------------------------------------ D1 ---------------------
    const installA = installCli(["--lang", "ko"]);
    assert(installA.status === 0, "D1: generation A installs", installA);
    assert(installA.json.generation === "generation-000001", "D1: A is generation-000001", installA.json);
    writeEvidenceJson(ev("D1"), "install-a.json", installA.json);

    await startGjc();
    const openA = await openDashboard("D1 generation A");
    const tokenA = tokenOf(openA.line);
    assert(tokenA === "gen-000001", `D1: A's notify carries gen-000001 (got ${tokenA})`, { line: openA.line });
    assert(/열림/.test(openA.line), "D1: the ko generation says opened", { line: openA.line });
    writeEvidence(ev("D1"), "notify-a.txt", openA.line);
    fixture.snapshot(join(EVIDENCE_L6, "D1"), "frame-a", parent);
    const frameA = await todoViewerFrame("D1", "viewer-a", "Follow ON");
    assert(/LIVE|WAITING|EMPTY/.test(frameA), "D1: the ko viewer painted its footer", { frameA });
    const slotA = readJson(join(STATE_DIR, "slots", listDir(join(STATE_DIR, "slots"))[0], "slot.json"));
    await exitGjc("D1 after A");

    const installB = installCli(["--lang", "en"]);
    assert(installB.status === 0, "D1: generation B installs", installB);
    assert(installB.json.generation === "generation-000002", "D1: B is generation-000002", installB.json);
    writeEvidenceJson(ev("D1"), "install-b.json", installB.json);

    await startGjc();
    const openB = await openDashboard("D1 generation B");
    const tokenB = tokenOf(openB.line);
    assert(tokenB === "gen-000002", `D1: B's notify carries gen-000002 (got ${tokenB})`, { line: openB.line });
    assert(/opened|adopted|ready/.test(openB.line), "D1: the en generation reports in English",
      { line: openB.line, language: installB.json.language });
    writeEvidence(ev("D1"), "notify-b.txt", openB.line);
    fixture.snapshot(join(EVIDENCE_L6, "D1"), "frame-b", parent);
    await exitGjc("D1 after B");

    const doctorD1 = doctorCli();
    assert(doctorD1.status === 0, "D1: --doctor exits 0", doctorD1);
    assert(doctorD1.json.ok === true, "D1: --doctor has no mismatch", doctorD1.json);
    assert(doctorD1.json.shim.targetGeneration === doctorD1.json.current.generation,
      "D1: shim target == current.json", doctorD1.json);
    assert(doctorD1.json.shim.targetGeneration === "generation-000002", "D1: B is selected", doctorD1.json);
    writeEvidence(ev("D1"), "doctor.json", JSON.stringify(doctorD1.json, null, 2));
    summary.drills.D1 = { tokenA, tokenB, selected: doctorD1.json.shim.targetGeneration,
      doctorOk: doctorD1.json.ok, slotSchemaA: slotA.schema };
    writeEvidenceJson(ev("D1"), "result.json", summary.drills.D1);

    // ------------------------------------------------------------------ D2 ---------------------
    const slotsBefore = listDir(join(STATE_DIR, "slots"));
    const slotFile = join(STATE_DIR, "slots", slotsBefore[0], "slot.json");
    const slotBefore = readJson(slotFile);
    const selectA = installCli(["--select", "generation-000001"]);
    assert(selectA.status === 0, "D2: --select generation-000001 succeeds", selectA);
    writeEvidenceJson(ev("D2"), "select-a.json", selectA.json);

    await startGjc();
    const openD2 = await openDashboard("D2 back to generation A");
    const tokenD2 = tokenOf(openD2.line);
    assert(tokenD2 === "gen-000001", `D2: the notify carries gen-000001 (got ${tokenD2})`, { line: openD2.line });
    assert(/열림|인계|정상/.test(openD2.line), "D2: the ko generation reports in Korean", { line: openD2.line });
    writeEvidence(ev("D2"), "notify.txt", openD2.line);
    fixture.snapshot(join(EVIDENCE_L6, "D2"), "frame", parent);
    const slotAfter = readJson(slotFile);
    assert(slotAfter.schema === slotBefore.schema, "D2: the same slot schema is reused",
      { before: slotBefore.schema, after: slotAfter.schema });
    assert(slotAfter.layoutKey === slotBefore.layoutKey, "D2: the same layoutKey is reused");
    const dataScopes = listDir(join(STATE_DIR, "data"));
    assert(dataScopes.length >= 2, "D2: data from both sessions stays in the same state directory",
      { dataScopes });
    await exitGjc("D2");

    const doctorD2 = doctorCli();
    assert(doctorD2.status === 0 && doctorD2.json.ok === true, "D2: --doctor is clean", doctorD2);
    assert(doctorD2.json.shim.targetGeneration === "generation-000001", "D2: A is selected", doctorD2.json);
    writeEvidence(ev("D2"), "doctor.json", JSON.stringify(doctorD2.json, null, 2));
    summary.drills.D2 = { token: tokenD2, schema: slotAfter.schema, layoutKey: slotAfter.layoutKey,
      dataScopes, doctorOk: doctorD2.json.ok };
    writeEvidenceJson(ev("D2"), "result.json", summary.drills.D2);

    // ------------------------------------------------------------------ D3 ---------------------
    const d3 = { failpoints: [] };
    const previousSelection = "generation-000001";
    for (const failpoint of ["after-gen-copy", "after-shim-tmp", "before-shim-rename"]) {
      const attempt = installCli(["--lang", "ko"], { env: { [FAILPOINT_ENV]: failpoint } });
      assert(attempt.status !== 0, `D3 ${failpoint}: the install fails`, attempt);
      assert(`${attempt.stderr}`.includes(failpoint), `D3 ${failpoint}: stderr names the failpoint`, attempt);
      writeEvidence(ev("D3"), `install-${failpoint}.txt`,
        `status=${attempt.status}\nstderr=${attempt.stderr}\nstdout=${attempt.stdout}`);

      const doctor = doctorCli();
      assert(doctor.status === 0 && doctor.json.ok === true,
        `D3 ${failpoint}: the previous selection is intact`, doctor);
      assert(doctor.json.shim.targetGeneration === previousSelection,
        `D3 ${failpoint}: shim still points at ${previousSelection}`, doctor.json);

      await startGjc();
      const open = await openDashboard(`D3 ${failpoint}`);
      const token = tokenOf(open.line);
      assert(token === "gen-000001", `D3 ${failpoint}: a fresh gjc still runs ${previousSelection} (got ${token})`,
        { line: open.line });
      await exitGjc(`D3 ${failpoint}`);
      writeEvidence(ev("D3"), `notify-${failpoint}.txt`, open.line);
      writeEvidence(ev("D3"), `doctor-${failpoint}.json`, JSON.stringify(doctor.json, null, 2));
      d3.failpoints.push({ failpoint, status: attempt.status, token, doctorOk: doctor.json.ok,
        selected: doctor.json.shim.targetGeneration });
    }

    const post = installCli(["--lang", "ko"], { env: { [FAILPOINT_ENV]: "after-shim-rename-before-current" } });
    assert(post.status !== 0, "D3 post-rename: the install fails", post);
    writeEvidence(ev("D3"), "install-after-shim-rename-before-current.txt",
      `status=${post.status}\nstderr=${post.stderr}\nstdout=${post.stdout}`);
    const doctorPost = doctorCli();
    assert(doctorPost.status !== 0, "D3 post-rename: --doctor exits non-zero", doctorPost);
    assert(doctorPost.json.ok === false, "D3 post-rename: --doctor reports the mismatch", doctorPost.json);
    assert(doctorPost.json.mismatches.some((entry) => entry.code === "selection-mismatch"),
      "D3 post-rename: the mismatch is shim != current.json", doctorPost.json);
    assert(doctorPost.json.shim.targetGeneration === "generation-000006",
      "D3 post-rename: the new shim is effective", doctorPost.json);
    assert(doctorPost.json.current.generation === previousSelection,
      "D3 post-rename: current.json still names the old generation", doctorPost.json);
    writeEvidence(ev("D3"), "doctor-after-shim-rename-before-current.json",
      JSON.stringify(doctorPost.json, null, 2));

    await startGjc();
    const openPost = await openDashboard("D3 post-rename selection");
    const tokenPost = tokenOf(openPost.line);
    assert(tokenPost === "gen-000006", `D3 post-rename: the new selection is effective (got ${tokenPost})`,
      { line: openPost.line });
    writeEvidence(ev("D3"), "notify-after-shim-rename-before-current.txt", openPost.line);
    await exitGjc("D3 post-rename");

    const repair = installCli(["--select", previousSelection]);
    assert(repair.status === 0, "D3: --select repairs the record", repair);
    const doctorRepaired = doctorCli();
    assert(doctorRepaired.status === 0 && doctorRepaired.json.ok === true,
      "D3: --doctor is clean after --select", doctorRepaired);
    writeEvidence(ev("D3"), "doctor-repaired.json", JSON.stringify(doctorRepaired.json, null, 2));

    await startGjc();
    const openRepair = await openDashboard("D3 repaired selection");
    const tokenRepair = tokenOf(openRepair.line);
    assert(tokenRepair === "gen-000001", `D3: the repair restores gen-000001 (got ${tokenRepair})`,
      { line: openRepair.line });
    writeEvidence(ev("D3"), "notify-repaired.txt", openRepair.line);
    await exitGjc("D3 repaired");

    d3.postRename = { token: tokenPost, doctorOk: doctorPost.json.ok,
      mismatch: doctorPost.json.mismatches.map((entry) => entry.code), repairedToken: tokenRepair };
    summary.drills.D3 = d3;
    writeEvidenceJson(ev("D3"), "result.json", d3);

    // ------------------------------------------------------------------ D4 ---------------------
    const generationsBefore = listDir(join(AGENT_DIR, "herdr-dashboard"));
    const scopesBefore = listDir(STATE_DIR);
    const remove = installCli(["--remove"]);
    assert(remove.status === 0 && remove.json.removed === true, "D4: --remove deletes the shim", remove);
    assert(!existsSync(join(AGENT_DIR, "extensions", "gjc-herdr-dashboard.js")),
      "D4: the managed shim is gone");
    writeEvidenceJson(ev("D4"), "remove.json", remove.json);
    const generationsAfter = listDir(join(AGENT_DIR, "herdr-dashboard"));
    assert(JSON.stringify(generationsAfter) === JSON.stringify(generationsBefore),
      "D4: generations and current.json stay", { generationsBefore, generationsAfter });
    assert(JSON.stringify(listDir(STATE_DIR)) === JSON.stringify(scopesBefore),
      "D4: the state directory stays", { scopesBefore, after: listDir(STATE_DIR) });

    await startGjc();
    const baseline = notifyLines(fixture.readPane(parent)).length;
    await fixture.slash(parent, "dashboard");
    await sleep(12_000);
    const frameD4 = fixture.readPane(parent);
    const plainD4 = stripAnsi(frameD4);
    const newNotifies = notifyLines(frameD4).slice(baseline);
    fixture.snapshot(join(EVIDENCE_L6, "D4"), "frame-after-remove", parent);
    writeEvidence(ev("D4"), "notify-lines.txt", JSON.stringify(newNotifies, null, 2));
    assert(newNotifies.length === 0, "D4: /dashboard produces no ext notify without the extension",
      { newNotifies });
    assert(!/ineligible:|failed:/.test(plainD4), "D4: no extension error frame", { frame: plainD4 });
    fixture.sendKeys(parent, "escape");
    await sleep(1_000);
    await exitGjc("D4");

    const doctorD4 = doctorCli();
    assert(doctorD4.status !== 0 && doctorD4.json.ok === false,
      "D4: --doctor reports that nothing is installed", doctorD4);
    writeEvidence(ev("D4"), "doctor.json", JSON.stringify(doctorD4.json, null, 2));
    summary.drills.D4 = { removed: remove.json.removed, newNotifies,
      generationsKept: generationsAfter.filter((name) => name.startsWith("generation-")),
      stateKept: listDir(STATE_DIR), doctorOk: doctorD4.json.ok };
    writeEvidenceJson(ev("D4"), "result.json", summary.drills.D4);

    summary.finishedAt = new Date().toISOString();
    writeEvidenceJson(EVIDENCE_L6, "result.json", summary);
    fixture.record("assertion", `l6-drills: ${JSON.stringify(summary.drills)}`);
    return summary;
  } finally {
    if (live === true) {
      try { await exitGjc("finally"); }
      catch (error) {
        // outcome: a failed graceful exit is recorded; cleanup still re-confirms ownership first.
        summary.finallyExitError = { code: error.code ?? null, message: error.message };
        writeEvidenceJson(EVIDENCE_L6, "finally-exit.json", summary.finallyExitError);
      }
    }
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(EVIDENCE_L6, "cleanup.json", cleanup);
    assert(cleanup.verifiedAbsent, "every harness resource was verified absent", cleanup);
  }
});
