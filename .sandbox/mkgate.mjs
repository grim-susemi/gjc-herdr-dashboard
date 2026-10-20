import { readFileSync, writeFileSync } from "node:fs";
const g = JSON.parse(readFileSync(".sandbox/qg-api.json", "utf8"));
const hash = "sha256:71632868b46b7a9554a8cab9b30881a0da615cb968fdc374da4bcce4c9038fa7";
g.architectReview.evidence = "architect 6-FinalArchitectL0 at f60caf2/d790b88: architecture, product and code CLEAR, recommendation APPROVE; non-blocking findings carried to L1 in VERIFICATION.md";
g.architectReview.commands = ["architect-review: read VERIFICATION.md, static-rules.test.mjs, git ls-files (no product code)"];
const q = g.executorQa;
q.evidence = "node scripts/test.mjs ran 21 tests, 21 pass; live Herdr/gjc probes G1-G13 recorded in VERIFICATION.md with evidence files under .evidence/L0; partial G9/G12 and FAIL G13 recorded honestly and accepted by owner Go";
q.e2eCommands = ["node scripts/test.mjs", "node src/viewers/todo/viewer.mjs in g8-tree-dev and generation-000001 trees (exit 0)"];
q.redTeamCommands = ["node scripts/test.mjs (static-rules.test.mjs seeds a violation for each SR rule and asserts detection)"];
q.artifactRefs = [
  { id: "adversarial-report", kind: "failure-mode-test", path: ".evidence/L0/artifacts/test-report.txt", description: "Static-rule tests with seeded violations plus G13 false-pass correction", inlineEvidence: "SR1-SR9 tests each seed a violating source and assert the rule reports it; the G13 false PASS was found by an adversarial isolation check and corrected to FAIL." },
  { id: "api-report-1", kind: "test-report", path: ".evidence/L0/artifacts/test-report.txt", description: "node:test report for L0 static rules", inlineEvidence: "tests 21, pass 21, fail 0 from node scripts/test.mjs at HEAD 3a86fce." },
];
q.contractCoverage = [
  { id: "contract-1", contractRef: "approved-plan:goal", obligation: "L0 gates G0-G13, U7, U9-U13, F1, K1 and SR1-SR9 measured or honestly recorded as partial or failed, with owner Go before any L1 work", status: "covered", surfaceEvidenceRefs: ["surface-1"], adversarialCaseRefs: ["case-g13-false-pass"] },
];
q.surfaceEvidence = [
  { id: "surface-1", surface: "api", contractRef: "approved-plan:goal", invocation: "node scripts/test.mjs and live gjc/Herdr probes recorded in VERIFICATION.md", verdict: "passed", artifactRefs: ["api-report-1"] },
];
q.adversarialCases = [
  { id: "case-g13-false-pass", contractRef: "approved-plan:goal", scenario: "A user-scope extension load via GJC_CODING_AGENT_DIR passed only because a project-scope shim was still present", expectedBehavior: "The false PASS is detected, corrected to FAIL, and the original evidence preserved as FALSE-PASS-g13", verdict: "passed", artifactRefs: ["adversarial-report"] },
];
g.criticReview = { verdict: "OKAY", evidence: "critic 7-FinalCriticL0B OKAY at 3a86fce after fixing the G8 viewer-run gap flagged by 5-FinalCriticL0", blockers: [] };
const it = g.iteration;
it.evidence = "three terminal-critic ITERATE rounds and one final ITERATE (G8 viewer) were fixed; final critic OKAY and architect APPROVE; full test rerun 21/21";
it.rerunCommands = ["node scripts/test.mjs"];
it.reviewCohort.sourceHash = hash;
for (const k of Object.keys(it.reviewCohort.lanes)) it.reviewCohort.lanes[k].sourceHash = hash;
it.reviewCohort.lanes.cleaner.evidence = "repo contains only docs, scripts and tests; spike/ removed and archived outside git";
it.reviewCohort.lanes.architect.evidence = "architect APPROVE, CLEAR x3";
it.reviewCohort.lanes.qa.evidence = "node scripts/test.mjs 21/21 pass";
writeFileSync(".sandbox/qg-G001-final.json", JSON.stringify(g, null, 2));
