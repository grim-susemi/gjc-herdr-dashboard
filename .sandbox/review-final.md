# Final bounded delta gate review

recommendation: APPROVE
deltaVerdict: COMMENT
reviewedRange: dda646e..1693b69
reviewedBranch: main
blockers: []

The owner-set rule for this run is HIGH-only blocking: data loss, modification of foreign files, a broken real-user install, state writes without ownership, or crash/hang. No such failure introduced by the reviewed delta was demonstrated. The findings below are follow-ups, not requests for another review round.

## originalIntent

Deliver a usable GJC 0.18.11 dashboard with a conditional goal row above Todo, background jobs visible on the first explicit /dashboard, and an installer supporting generation selection, rollback, removal, diagnosis, language selection and bounded failure recovery. Review only the merged L5b, jobs-order and L6 delta; do not implement fixes or install into the user's agent directory.

## desiredOutcome

A user can install with `node scripts/install.mjs --agent-dir C:/Users/USER/.gjc/agent --lang ko`, start GJC in Herdr, and open Todo and Workers through /dashboard. The goal row reflects the public goal source without leaking extra fields. Installation never replaces a foreign shim, never deletes generations or runtime state, and interrupted selection changes remain diagnosable and repairable.

## userOutcomeReview

The implemented default-language installation path is coherent: the builder copies the entry, package, all source files and three locales into one generation; the shim re-exports an absolute file URL; eligibility derives state from the generation layout; instance language falls back to that generation's config; viewer launch receives the resolved language. The first-pass jobs fix moves synchronization after the scope reset and has a real projection regression test. The goal source, view and host wiring satisfy the exercised L5b behavior, with the ownership and draining semantics of the existing Todo projection.

The full permitted suite was reproduced: `node scripts/test.mjs` completed with 593 tests, 593 pass, 0 fail, 0 cancelled and 0 skipped; duration 12143.7216 ms. The foreground command completed successfully. The initial background run's result was not exposed by the available session tools, so that run is not used as evidence. No live script, user-scope installer or user-scope removal was run by this reviewer.

The existing live artifacts support sandbox generation switching, post-rename mismatch detection and repair, and a visible goal row. They do not prove all-role language changes on adoption or positive delivery of the removed-command check. Those limitations are the first two nonblocking findings.

## Findings

- [MEDIUM] README.md:207 - The new promise that a fresh GJC session's viewer text follows --lang is not true when /dashboard adopts surviving viewers. Todo captures language once at src/viewers/todo/viewer.mjs:200; Workers does the same at src/viewers/workers/viewer.mjs:217. Their slot refresh only rebinds scope, not language. D1 installs ko A then en B and explicitly adopts A's viewers; test/live/l6-drills.mjs:168-175 asserts only B's English notification, never either adopted viewer's English frame. Suggested fix: make the adopted viewers follow the selected slot language without replacing their panes, or document the required q/reopen operation for a language change and exercise it for both roles. Criterion: AC-F2. Evidence: .evidence/L6/D1/{install-a.json,install-b.json,frame-b.txt,doctor.json}; the saved B frame says Todo adopted / Workers adopted. This is a language-consistency defect, not a broken default ko install or a HIGH finding under the owner-set rule.

- [MEDIUM] test/live/l6-drills.mjs:308-317 - D4 waits a fixed 12 seconds and then treats zero extension notifications as proof that /dashboard was unavailable. The same assertion passes when the TUI swallows the slash input; the saved frame supplies no positive delivery/unknown-command evidence. This is also a new nondeterministic, negative-only check. Suggested fix: establish a bounded observable signal that the input was processed or that command registration is absent, then assert the lack of an extension result; do not infer command absence solely from elapsed time and zero notifications. Criterion: AC6.1 / section 16 D4 evidence quality. Evidence: .evidence/L6/D4/{frame-after-remove.txt,notify-lines.txt,result.json} and the cited live test lines. The installer unit test independently proves shim-only removal and preservation, so this evidence weakness is not proof of a broken uninstall and is nonblocking here.

- [LOW] test/unit/goal-source.test.mjs:20-24 - The status-list equality assertion pins a test-only export rather than renderer behavior. GOAL_STATUSES in src/host/sources/goal.mjs:34 has no production consumer, while src/viewers/todo/render.mjs:131 maintains a separate status set. The test stays green if the renderer's actual status support drifts. Suggested fix: remove the unused duplicate export/list assertion and rely on or extend the existing rendered-status behavior cases; retain the schema sentinel assertion because that field is machine-consumed. This is a direct overfit/slop finding, not a product acceptance blocker.

## Requested risk judgments

### (a) Ownership and repair

The static file operations are confined to the expected installation paths. install, selectGeneration and removeShim read the fixed shim first and refuse a nonmatching first-line managed marker. buildGeneration refuses an already-existing destination; the next generation number is chosen above all generation-shaped entries, not just managed ones. assertSelectable requires a valid generation name, managed marker, matching generation token, supported language and entry existence. It cannot select an arbitrary outside path. removeShim removes only the marker-bearing shim, not current.json, any generation, or state. The state path is returned/reported but not written or removed by the installer.

The four intended failure states are recoverable. All pre-rename failpoints preserve the previous shim/current selection. The post-rename failpoint leaves a complete managed target active while current.json is stale; doctor reports selection-mismatch and select rewrites both records. Those transitions pass in install.test.mjs and agree with the retained D3 doctor and notification artifacts. No unrecoverable selection produced by these operations was found. Doctor is read-only and select is the repair operation.

These conclusions cover the stated normal directories and operations, not an unspecified adversary replacing paths between asynchronous filesystem calls, symlink/junction configurations the plan forbids, or maliciously forged managed markers. No such scenario was manufactured as a blocker.

### (b) Failed-generation leftovers

Yes. scripts/install.mjs:261-263 builds and marks a complete generation before testing the pre-rename failpoints, and no failure cleanup removes that directory. D3 retains generation-000003 through generation-000005 while selection remains generation-000001. The unit test explicitly verifies these are managed and usable. They consume disk space and generation numbers but do not alter the active selection or state: clutter, not a HIGH defect. A real copy failure can leave an incomplete unmarked directory; the next install skips its number and select refuses it. No automatic deletion of an unowned directory is needed for recovery.

### (c) Goal ownership and dispose

Explicit publication is inside the ownsSlot(local) branch after the reconciler pass. Automatic publication follows the self-owner and ownsSlot gates and the existing scope synchronization. publishGoal additionally requires a readable slot, scopeKey and nonclosed Todo record. It uses the same dataWriter as Todo and Workers, and session_shutdown/dispose drain that writer after stopping timers. The owner-gated no-write, event fallback, newest burst and closed/no-record tests pass. The existing shutdown drain covers the newly added goal kind without a separate writer lifetime.

As with Todo, this is an ownership gate before scheduling, not a new per-byte ownership fence inside the delayed writer. The pre-existing pending-write lifetime/owner-turnover limitations recorded in VERIFICATION.md are not represented as newly solved by L5b or reopened as new delta blockers.

### (d) SR5 / SR9

The added actual imports in verify-package.mjs call import(pathToFileURL(absolutePath).href); the paths are resolved or joined from an absolute generation directory. They meet the plan's absolute-URL exception and do not use relative dynamic imports. The SR5 regex adds a pathToFileURL prefix allowance; it is not a complete JavaScript/URL verifier. Existing literal/template-string blind spots were already present before this delta. No newly shipped forbidden relative dynamic import was found. Strengthening the checker beyond its prefix-based recognition is a follow-up, not an observed runtime breach.

SR9's new allowance is exactly scripts/install.mjs. Actual INSTALL_FAILPOINT reads are in that file, with a fixed four-name allowlist; the builder, verifier, installed shim and runtime receive no installer failpoint plumbing. The real shim written by shimSource is only the managed comment and absolute re-export. This is within section 13's explicit installer failpoint authority.

### (e) Real-user ko installation

No concrete failure on the specified C:/Users/USER/.gjc/agent ko path was found in the delta. The language fallback feeds the launch path; the generation tree contains the required assets; the entry imports successfully in the installer tests. The foreign-shim refusal is intentional and returns a visible error rather than overwriting that file. GJC/Herdr eligibility and Node requirements remain the existing product contract. Actual user-scope extension discovery and frames remain unverified here because the owner restricted this review to reads and tests. AC6.2/AC6.3 are not claimed complete by this report.

## Direct skill-perspective and overfit/slop pass

Loaded the installed remove-ai-slops and programming skill files directly. Their cleanup and structural refactoring directions do not authorize edits or override this run's HIGH-only blocking rule. The delta is JavaScript ESM, not one of programming's language-specific TypeScript/Python/Rust/Go targets; its shared behavioral and test criteria were applied.

- Excessive/useless tests: the render language/width matrix is justified by the stated 34/52-column and localization criteria; the install cases distinguish real filesystem outcomes. The constant-only status case above is unnecessary. No test-count total was used as a substitute for inspecting the assertions.
- Deletion-only / removal-verification tests: remove-shim tests cover the requested uninstall behavior and retained state, not mere absence of source strings. No requested-removal source grep or prose pin was added.
- Tautology: new projection and installation assertions read real output files and independent expected values. The config-language override fixture differs from its fallback. The D3 test checks both previous and effective selection and actual repair. The test-only status list is weak semantic coverage as recorded above.
- Implementation mirroring: no new source-code snapshot pins were found. The exact shim source check in verification is a machine-loaded artifact contract, not prose. Goal source tests whitelist the four privacy-sensitive fields. The added jobs regression reads the output Workers projection on the first open, so restoring the old reset order would remove the expected job.
- Normalization/parsing: the goal projection is an external host boundary and whitelists fields; viewer disk input is a second external boundary. Those validations have real consumers. configOf is shared by generation and language lookup. No new dependency or extraction layer was introduced. The unused duplicate GOAL_STATUSES list is the bounded production-slop observation.
- Async correctness: the changed heartbeat and poll callbacks return their tracked work, improving deterministic test observation. New unit tests do not introduce sleeps. The live scripts do introduce fixed sleeps and polling, particularly D4's negative-only conclusion; that is reported above rather than silently certified.
- Scope/maintenance: installer/build/verifier own their requested CLI behavior. The installer is large and repeats some small CLI parsing with the other two tools; neither fact demonstrates a named acceptance failure or warrants an architecture rewrite in this review.

## Review-report coverage

The checked prior code/gate review, .sandbox/review-g004-delta.md, explicitly records both skill perspectives and all requested overfit/slop categories. It covers 0b8d8be..dda646e, not this L5b/L6 delta, and therefore is not approval evidence for the present work. No separate L5b/L6 code-review report, manual QA matrix file, or notepad path was supplied or found in the inspected .evidence / .sandbox report inventory. VERIFICATION.md and the durable goals ledger supply executor claims and a scenario matrix, not an independent current-delta skill review. Matching upstream report coverage for this delta cannot be confirmed. This report's direct pass does not depend on those missing reports; the reporting gap is a NOTE under the owner-set rule.

## Exact evidence gaps and limits

1. User-scope install/remove (AC6.2/AC6.3) were not run; no user-scope frame is asserted. The parent goal makes these conditional on owner approval.
2. No live scripts were rerun by this reviewer. Saved frames and doctor outputs were opened and compared with their live test assertions. L5's saved goal row has zero counters; nonzero goal values are covered by unit tests and host-surface measurements, not that viewer live run.
3. D1 provides B's English notification, not both adopted viewer frames in English. D4 provides a negative notification count, not positive input-delivery evidence. Findings above state their exact impact.
4. The complete merged-HEAD representative live regression belongs to the parent's integration criterion G004/C001 and was not supplied as completed evidence in this child brief. This verdict is the requested fixed-range review, not completion of all parent handover criteria.
5. No independent current-delta code-review report, standalone manual QA matrix or notepad path was provided. The older G004 report has explicit skill coverage but a different range.
6. The exposed tools have no JS eval/status entry point. The SDK environment path is inside C:/Users/USER/.omo-stable-500, which this task explicitly forbids touching, so it was not imported. The report path was derived from the inspected parent durable goal G004-integration-and-handover-l5b-and-l6, using canonical a1 for this one-round final review. goals.json still recorded that goal as pending/attempt 0 at inspection; currentAttemptDir itself was not reproduced. Only this report artifact was written, not a .sandbox/review-final.md copy.
7. The shared checkout advanced during review to 9bd648c, whose sole addition is test/live/l6-userscope.mjs (189 lines). That file is outside dda646e..1693b69, was not reviewed or run, and does not change any reviewed source, unit test or test runner. The reproduced unit result therefore exercises the same reviewed production/unit files. No other agent's change was edited.
8. Initial and final git status --short output were empty. The only reviewer write is this report outside the product checkout. No additional validation pass or fix round is requested.

## Checked artifact paths

Product repository root: C:/Users/USER/orca/projects/gjc-herdr-dashboard.

- git diff dda646e 1693b69 inventory; runtime, test, locale and documentation hunks; complete new script/source/test files. git log dda646e..1693b69. Shared-checkout movement: git diff --stat 1693b69 9bd648c and selected paths (no reviewed-file delta).
- scripts/{build,install,verify-package,test}.mjs and package.json.
- src/host/instance.mjs; src/host/sources/goal.mjs; src/host/gjc-adapter.mjs.
- src/viewers/common.mjs; src/viewers/todo/{render,viewer}.mjs; src/viewers/workers/viewer.mjs language and slot sections.
- src/core/data.mjs; src/core/reconciler.mjs scope/owner/pass references; src/storage.mjs.
- test/unit/{install,goal-source,goal-render,static-rules,i18n,instance,band-pass,viewer}.test.mjs, the complete changed hunks and relevant surrounding fixtures. Full suite execution also covers their unchanged neighboring tests.
- test/live/{l5-goal,l6-drills}.mjs.
- locale/{en,ko,zh-cn}.json changed keys; README.md; VERIFICATION.md.
- .evidence/L5/goalsurface/summary.json; .evidence/L5/LV-goal/{result.json,frame-before.txt,frame-goal.txt}.
- .evidence/L6/{result.json,verify-package.json,cleanup.json}.
- .evidence/L6/D1/{doctor.json,frame-b.txt}; .evidence/L6/D2/frame.txt.
- .evidence/L6/D3/{doctor-after-shim-rename-before-current.json,doctor-repaired.json}.
- .evidence/L6/D4/{frame-after-remove.txt,remove.json}.
- .sandbox/DIRECTION-2026-10-20.md; .sandbox/review-g004-delta.md.
- Plan authority: C:/Users/USER/orca/projects/기타 작업/.gjc/_session-01a1458c-79b4-7608-a677-d3c253f43429/plans/ralplan/01a1458c-79b4-7608-a677-d3c253f43429/stage-03-revision.md, including sections 7.7, 10, 13, 14, 15.2 and 16.
- Parent brief/goals: C:/Users/USER/orca/projects/기타 작업/.omo/ulw-loop/01a1555d-67f6-779f-9cad-ec6fc7819d1e/{brief.md,goals.json}.
- Skills: C:/Users/USER/.codex/plugins/cache/sisyphuslabs/omo/5.1.38/skills/{remove-ai-slops,programming}/SKILL.md.
- Language-server error diagnostics for scripts/install.mjs, src/host/instance.mjs and src/viewers/todo/viewer.mjs: no diagnostics found. The repository has no separate lint/typecheck command configured in package.json; passing JS diagnostics are not claimed as a strict typecheck.
