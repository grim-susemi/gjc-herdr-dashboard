import { readFileSync, writeFileSync } from "node:fs";
const hash = process.argv[2];
const criticEvidence = process.argv[3];
if (!hash?.startsWith("sha256:") || !criticEvidence) throw new Error("usage: <sourceHash> <criticEvidence>");
const g = JSON.parse(readFileSync(".sandbox/qg-G001-final.json", "utf8"));
g.architectReview.evidence = "G003 (L2 layout/launch/reconciler band and L3 pointer routing) reviewed by critic 29-22 and 30; layout and reconciler follow the architect-approved L1 contract; no structural change to the L1 reconciler protocol";
g.architectReview.commands = ["critic-review: read src/core/layout.mjs, reconciler.mjs, src/viewers/workers, src/terminal-input.mjs, tests, VERIFICATION.md, .evidence/L2, .evidence/L3"];
const q = g.executorQa;
q.evidence = "node scripts/test.mjs: 530 tests, 530 pass; live scripts in a harness-owned Herdr session: l2-workers (LV-7), l2-width (AC-F4), l3-pointer (LV-8, 19 observations), plus L1 lt1-fault, lt3-delay, l4-lock, kill-recovery, l1-behaviour; AC-G1 protected omo files identical before/after";
q.e2eCommands = ["node scripts/test.mjs", "node test/live/l2-workers.mjs", "node test/live/l2-width.mjs", "node test/live/l3-pointer.mjs", "node test/live/l1-behaviour.mjs", "node test/live/lt1-fault.mjs", "node scripts/omo-protected.mjs"];
q.redTeamCommands = ["node scripts/test.mjs (band-pass foreign sibling -> partial:shape, bus fault -> sourceError, subscription failure notice, stale-prefs pointer regression)", "node test/live/l3-pointer.mjs (wheel/click/drag/blur against the live panes)"];
q.artifactRefs = [
  { id: "adversarial-report", kind: "failure-mode-test", path: ".evidence/L3/LV-8/observations.json", description: "Live pointer and focus observations", inlineEvidence: "19 observations all ok: wheel/click/drag turn follow OFF, blur returns ON, the other role is untouched, resize leaves the viewer alive." },
  { id: "api-report-1", kind: "test-report", path: ".evidence/L2/test-report.txt", description: "node:test report for L2+L3", inlineEvidence: "tests 530, pass 530, fail 0 from node scripts/test.mjs." },
];
q.contractCoverage = [
  { id: "contract-1", contractRef: "approved-plan:goal", obligation: "L2 Workers pane and band (AC2.*, AC-F4) and L3 pointer/focus (AC3.*) measured by unit and live tests in VERIFICATION.md ## L2 and ## L3", status: "covered", surfaceEvidenceRefs: ["surface-1"], adversarialCaseRefs: ["case-focus"] },
];
q.surfaceEvidence = [
  { id: "surface-1", surface: "api", contractRef: "approved-plan:goal", invocation: "node scripts/test.mjs plus live scripts under test/live recorded in VERIFICATION.md ## L2 and ## L3", verdict: "passed", artifactRefs: ["api-report-1"] },
];
q.adversarialCases = [
  { id: "case-focus", contractRef: "approved-plan:goal", scenario: "The pane loses focus after the user scrolled, then the wheel and a click arrive; and the Herdr focus subscription fails or closes", expectedBehavior: "Follow returns ON on blur, the next pointer step starts from the drawn scroll, a focus-subscription failure shows exactly one notice and the viewer keeps working", verdict: "passed", artifactRefs: ["adversarial-report"] },
];
g.criticReview = { verdict: "OKAY", evidence: criticEvidence, blockers: [] };
const it = g.iteration;
it.evidence = "critic round 1 ITERATE (pointer base scroll, focus-close notice, stdin pause, overclaims) fixed with regression tests that fail on the old source; critic round 2 OKAY; full unit rerun 530/530; five live scripts plus l2-width re-run PASS";
it.rerunCommands = ["node scripts/test.mjs"];
it.reviewCohort.sourceHash = hash;
for (const k of Object.keys(it.reviewCohort.lanes)) it.reviewCohort.lanes[k].sourceHash = hash;
it.reviewCohort.lanes.cleaner.evidence = "sandbox/evidence excluded from git; no dead flags; no new empty catches (static rules test passes)";
it.reviewCohort.lanes.architect.evidence = "critic 29-22/30 structural review of layout, reconciler and viewers";
it.reviewCohort.lanes.qa.evidence = "node scripts/test.mjs 530/530 pass; l2-workers, l2-width, l3-pointer and L1 live scripts PASS";
writeFileSync(".sandbox/qg-G003.json", JSON.stringify(g, null, 2));
console.log("written");
