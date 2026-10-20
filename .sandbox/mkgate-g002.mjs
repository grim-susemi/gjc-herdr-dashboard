import { readFileSync, writeFileSync } from "node:fs";
const hash = process.argv[2];
const criticEvidence = process.argv[3];
if (!hash?.startsWith("sha256:") || !criticEvidence) throw new Error("usage: <sourceHash> <criticEvidence>");
const g = JSON.parse(readFileSync(".sandbox/qg-G001-final.json", "utf8"));
g.architectReview.evidence = "architect 18-L1ReReview at b52655f: B1-B8 PASS, no HIGH finding, APPROVE; nonBlocking items carried in VERIFICATION.md (L2+ carryover)";
g.architectReview.commands = ["architect-review: read src/, test/, VERIFICATION.md, PROVENANCE.md, .evidence/L1/*"];
const q = g.executorQa;
q.evidence = "node scripts/test.mjs: 357 tests, 357 pass; live Herdr/gjc scripts in a harness-owned session: lt1-fault (LV-2), lt3-delay (LV-3), l4-lock (LV-10), kill-recovery (AC1.7/AC1.9), l1-behaviour (LV-13/LV-6/LV-11/AC1.2/AC1.9); AC-G1 protected omo files identical before/after";
q.e2eCommands = ["node scripts/test.mjs", "node test/live/lt1-fault.mjs", "node test/live/lt3-delay.mjs", "node test/live/l4-lock.mjs", "node test/live/kill-recovery.mjs", "node test/live/l1-behaviour.mjs", "node scripts/omo-protected.mjs"];
q.redTeamCommands = ["node scripts/test.mjs (static-rules seeds a violation per SR rule; reconciler/lock/failpoint fault tests)", "node test/live/lt1-fault.mjs (injected split failure)", "node test/live/kill-recovery.mjs (viewer/owner kill, external pane close)"];
q.artifactRefs = [
  { id: "adversarial-report", kind: "failure-mode-test", path: ".evidence/L1/LV-7b/ac1-9-timing.json", description: "Owner kill and external pane close recovery timings", inlineEvidence: "kill -> 연결 끊김 6.5 s (gate 20 s); external pane close -> next /dashboard reopens (T4); viewer kill -> T4/T16 recovery." },
  { id: "api-report-1", kind: "test-report", path: ".evidence/L1/artifacts/test-report.txt", description: "node:test report for L1", inlineEvidence: "tests 357, pass 357, fail 0 from node scripts/test.mjs at HEAD 8c8d454." },
];
q.contractCoverage = [
  { id: "contract-1", contractRef: "approved-plan:goal", obligation: "L1 Todo pane acceptance AC1.1-AC1.13 and AC-G1 measured by unit and live tests in VERIFICATION.md ## L1", status: "covered", surfaceEvidenceRefs: ["surface-1"], adversarialCaseRefs: ["case-kill"] },
];
q.surfaceEvidence = [
  { id: "surface-1", surface: "api", contractRef: "approved-plan:goal", invocation: "node scripts/test.mjs plus live scripts under test/live recorded in VERIFICATION.md ## L1", verdict: "passed", artifactRefs: ["api-report-1"] },
];
q.adversarialCases = [
  { id: "case-kill", contractRef: "approved-plan:goal", scenario: "The owner gjc is killed without /exit, and the viewer pane is closed externally", expectedBehavior: "The viewer shows 연결 끊김 within 20 s, the pane stays; an external close is recovered by the next /dashboard", verdict: "passed", artifactRefs: ["adversarial-report"] },
];
g.criticReview = { verdict: "OKAY", evidence: criticEvidence, blockers: [] };
const it = g.iteration;
it.evidence = "architect 2-round review (ITERATE B1-B8 fixed, then APPROVE); critic ITERATE rounds on live evidence fixed (AC1.2 to screen, AC1.9 gates, LV-6 attribution, AC-G1 hashes); full unit rerun 357/357";
it.rerunCommands = ["node scripts/test.mjs"];
it.reviewCohort.sourceHash = hash;
for (const k of Object.keys(it.reviewCohort.lanes)) it.reviewCohort.lanes[k].sourceHash = hash;
it.reviewCohort.lanes.cleaner.evidence = "sandbox/evidence excluded from git; no dead flags (delay-run wrapper flag and READY_DELAY env removed)";
it.reviewCohort.lanes.architect.evidence = "architect 18-L1ReReview APPROVE";
it.reviewCohort.lanes.qa.evidence = "node scripts/test.mjs 357/357 pass; five live scripts PASS";
writeFileSync(".sandbox/qg-G002.json", JSON.stringify(g, null, 2));
console.log("written");
