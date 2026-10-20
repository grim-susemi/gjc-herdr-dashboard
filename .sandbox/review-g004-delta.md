# G004 bounded delta gate review

recommendation: APPROVE
deltaVerdict: COMMENT
reviewedRange: 0b8d8be..dda646e
reviewedHead: dda646ef52b1355d5c37f2b5288a5e28c7f1a68c
blockers: []

Only a HIGH defect introduced inside this delta blocks this review. No such defect was identified. The two findings below are nonblocking follow-ups; this report does not request another review round.

## originalIntent

Close G004 with one bounded review of the architect round-3 B1 and B2 fixes. Do not reopen earlier closed issues, implement changes, run live scripts, or review subsequent L5/L6 work. The active durable goal is G001-g004-closeout-one-bounded-delta-revi, attempt 1.

## desiredOutcome

A busy /dashboard invocation must leave another owner's slot and projections alone. Verification prose and LV-10 accounting must reflect retained evidence rather than accumulated notifications masquerading as one delivered pair. The supporting lifecycle changes must not introduce ownership corruption, double ownership, teardown data loss, unhandled rejection, crash, or hang.

## userOutcomeReview

B1 is fixed for the reported foreign-owner path. B2's retained numeric/accounting discrepancy is fixed. The allowed three-file test run completed with 106 tests, 106 pass, 0 fail, 0 cancelled, 0 skipped. The source inspection found one Workers projection regression and one test-sensitivity gap, neither HIGH under the owner-set blocking rule. Accordingly, the bounded-delta verdict is COMMENT and the gate recommendation is APPROVE.

## Findings

- [MEDIUM] [in-delta] src/host/instance.mjs:864-869 - The explicit path calls syncJobsFromCtx(ctx) before adoptPassScope(local), whose new reset at line 709 clears the jobs just ingested when the scope changes. On the initial open, scopeKey can also still be null, so existing background jobs are synchronized and then cleared before publishWorkers() snapshots them. A /dashboard response can therefore publish an empty Workers projection despite ctx.getJobs() containing jobs, until another trigger repopulates it. The old explicit path reset through syncBinding() before syncJobsFromCtx(), so the new ordering introduces this regression. Suggested fix: adopt/reset the successful owned scope before synchronizing the current ctx jobs, then publish. Extend the existing AC2.6 test with jobs already present during an initial open or an explicit session-changing pass. Evidence: delta hunks at instance.mjs:698-712 and :864-875; src/host/sources/workers.mjs:315-354 ingests jobs and :398-403 clears cards; test/unit/band-pass.test.mjs:503-522 currently supplies jobs only after the dashboard is already open. This is a source-proven ordering defect, not a runtime reproduction performed in this read-only review.

- [LOW] [in-delta] test/unit/instance.test.mjs:338-349 - The new B1 regression compares the slot bytes and only the names of top-level data directories. With the pre-pass rebind fixed, removing the owned-only projection gate alone would rewrite files in the existing old scope, leave those directory names and slot bytes unchanged, and still pass this test. Thus the test catches the original combined behavior but does not independently protect the projection half of B1. Suggested fix: give the busy invocation different Todo content and compare the existing projection file bytes before/after, or assert no projection writer invocation. Strengthen the existing test rather than adding a redundant test.

## B1 verification

- src/host/instance.mjs:838-851 removes the pre-pass await syncBinding(local), replacing it with a local binding assignment. That assignment does not write slot.json.
- src/core/reconciler.mjs:425-444 classifies a live/unclassifiable foreign owner and returns busy:other-owner before the rebind at :487-496. The reconciler's only delta in this area is an explanatory comment; the owner-before-rebind behavior is the existing contract now used by the explicit caller.
- src/host/instance.mjs:868-875 asks ownsSlot(local), adopts the scope only if true, and gates both publishTodo and publishWorkers behind that result.
- The new test is named `B1: busy:other-owner leaves the slot scope and the data directory untouched` (test/unit/instance.test.mjs:329). It passed in my 106-test run.
- The test would fail on the old behavior: it first opens a slot for s-1, writes a live foreign owner, changes the ctx to s-2, and captures slotBefore. At 0b8d8be the explicit caller awaited syncBinding(local) before explicitPass. Because reboundSessionId was s-1, this invokes public reconciler.rebind(), whose applyScope changes sessionId/scopeKey/epoch without an owner classification. The exact slot-byte equality at test line 346 consequently fails even though the later explicit pass returns busy:other-owner. This conclusion is established from the old/new diff and the unchanged rebind implementation, not from modifying or checking out old code. The executor's claimed mutation run was not independently repeated because the task is read-only.

## B2 verification

- VERIFICATION.md:147 states 546 tests, 0 fail. The retained .evidence/L4/test-report.txt:550-559 reports tests 546, pass 546, fail 0. The lead's separate .omo/evidence/ulw-loop-01a1555d/g004-unit-dda646e.txt:552-561 also reports 546/546 with no failures. These files support the count; I did not run the full suite again.
- VERIFICATION.md:64 now identifies the retained L4 Todo latency as 314 ms to disk and 1188 ms to the screen. .evidence/L4/LV-13b/ac1-2-todo-write.txt contains exactly those values.
- VERIFICATION.md:69 now identifies the retained owner-kill duration as killToLabelMs 8352. .evidence/L4/LV-7b/ac1-9-timing.json contains 8352, consistent with the rounded 8.4 s prose.
- VERIFICATION.md:168 says attempt 1 delivered one notification and attempt 2 delivered two healthy notifications, after the band was already open. .evidence/L4/LV-10/attempts.json records (before=0, pair=1, cumulative=1) followed by (before=1, pair=2, cumulative=3). delivered.json and notices.json each contain one opened line followed by two healthy lines. wrapper.log.jsonl:3 and :10 contain exactly the two splits for the band.
- test/live/l4-lock.mjs:60 captures the notification count before sending each pair, :66 slices delivered.slice(seen), :67-69 records and tests pairNotifies, and :79 asserts the last pair's count rather than the cumulative count. A 1+1 sequence from separate attempts no longer meets the >=2 requirement for one attempt.
- This supports two delivered calls on an existing band, not first-open overlap or true cross-process contention; the revised table explicitly withholds those live claims. Counting notifications does not itself prove temporal overlap, and I do not certify that the two successful calls actually overlapped. Live scripts were not run.

## Other changed behavior and HIGH-risk review

- Tracking/drain: instance.mjs:225-234 tracks settling promises with rejection observers, :405-408 tracks heartbeat and pending-role timer work, :442-450 tracks workers publishing, :545 tracks polling, and :648/:1199 track delegated/direct explicit work. drain() at :1063-1070 waits for automatic work, the owner stamp, tracked work, and writer flush. No tracked promise is observed to depend on drain() itself in the production call graph, so no new self-wait was found. The 20-round ceiling is finite; the writer's existing flush() drains scheduled/active writes internally.
- Arm guard: instance.mjs:662-664 checks armed/disposed after the initial heartbeat await, preventing that await from restarting timers after shutdown. The documented later prune await caveat is outside the newly added guard and is not reopened as a blocker.
- Strict folding: instance.mjs:903 preserves an already-folded strict=true even when the newest ctx comes from a non-strict bus trigger. The existing trailing-pass error policy remains intact.
- Viewer heartbeat tail: common.mjs:173-193 returns the latest interval commit, and both viewer stop paths now await it alongside saving. This is additional lifetime waiting, not a new owner claim. The code does not aggregate overlapping older heartbeat commits or an already-disposed viewer's earlier stop result; those limitations predate the new waiting behavior and are not recast as newly introduced HIGH findings.
- No in-delta double-owner change, newly unguarded foreign-owner write, new unhandled rejection, teardown write loss, crash, or hanging drain was demonstrated. The passing test run is evidence of its exercised paths, not proof of every possible scheduling interleaving.

## Tests checked

Executed from C:/Users/USER/orca/projects/gjc-herdr-dashboard:

`node --test --test-isolation=none test/unit/instance.test.mjs test/unit/band-pass.test.mjs test/unit/reconciler.test.mjs`

Completed result: 106 tests, 106 pass, 0 fail, 0 cancelled, 0 skipped; duration 16579.7391 ms. The initial background invocation's completion summary was not available through this session's exposed tools, so I obtained a completed foreground result with the same permitted command. No live script or full-suite command was run by me.

Relevant passing names include:

- `B1: busy:other-owner leaves the slot scope and the data directory untouched`
- `LT-4 busy:other-owner: a live foreign owner yields exactly one busy notify`
- `LT-6: main shutdown closes zero panes, deletes no record and stamps stoppedAt`
- `LT-6: reload (same session + module) replaces the entry and retires the old instance`
- `L4: a retired instance cannot reclaim the successor's owner record`
- `L4: before /dashboard adopts a stopped previous owner, no automatic trigger writes a slot or data file`
- `critic #3: a bus-triggered workers publish is owner-gated like the automatic pass`
- `AC2.6: ctx.getJobs() feeds background cards and a task tool_execution_end re-reads them`
- `plan 7.2: a scope change resets the workers tracker instead of leaking the old scope cards`
- `dispose unsubscribes every bus channel when the host hands back an unsubscribe function`
- `LT-7 (a): a live holder is never displaced, at +31 s or +600 s, with zero writes`
- `LT-7 (d), (e), (f): a stale recoverer, two racers and a fenced resume all end in busy`
- `critic #1: a pass suspended before its owner claim cannot revive a record shutdown released`
- `markStopped is final: a writeOwner that follows (or races) it cannot erase the stoppedAt stamp`

## Skill-perspective and overfit/slop review

Loaded and applied the installed remove-ai-slops and programming skills directly as review criteria. Their cleanup/refactoring directives do not authorize edits in this read-only delta review; the owner-set HIGH-only blocking rule takes precedence over skill style/size preferences.

- Excessive/useless tests: the delta adds one behavior regression, B1, not a test-count expansion. Its real filesystem and reconciler interactions are useful; its incomplete sensitivity is reported as LOW above.
- Deletion-only or removal-verification tests: none added. B1 asserts an ownership invariant, not the absence of a source string or removed function.
- Tautological tests: the added B1 uses a real instance, real reconciler, real slot/projection files, and fake external Herdr/process/timer seams. It is not a mock returning the expected result.
- Implementation-mirroring tests: the new test's slot equality is appropriate for a no-write invariant, but directory-name comparison leaves overwrites undetected. No source-text assertions or prose pinning were added.
- Unnecessary production extraction/parsing/normalization: track() serves several lifecycle entry points and adopts standard Promise/Set primitives. adoptPassScope() uses existing readSlot rather than introducing a parser; it updates real scope bookkeeping, but its reset ordering causes the MEDIUM finding. No dependency, speculative normalization layer, or broad unrelated extraction was introduced.
- Maintenance/scope: fixture handle collection closes real lifecycle leaks before temporary-directory deletion. Existing large modules, broad catches, and timer-based settle helpers were not introduced by this delta and are not reasons to broaden this review. The changed live accounting still uses the pre-existing 12-second wait, so successful evidence does not establish deterministic call attribution/overlap.
- Skill-report coverage: no round-3 code-review report path or separate manual QA matrix/notepad was provided. VERIFICATION.md references `35-34-ArchitectL4R3` and summarizes its findings, but does not explicitly record the same overfit/slop checks. The older .sandbox/arch-l4.txt was inspected and is for ee6b165, not the requested round-3 delta; it cannot substitute for that missing report. Therefore matching upstream skill-perspective coverage cannot be confirmed. My direct check above is independent of that reporting gap. It is a NOTE, not an owner-authorized blocker.

Additional command evidence: git diff --check 0b8d8be dda646e reported trailing whitespace on ten added lines in test/live/l4-lock.mjs (:58, :60, :64-69, :74, :79). Formatting is not clean under that command, but this is not a functional HIGH blocker. git status --short was empty before and after review commands. No production or test file was edited.

## Exact evidence gaps

1. The added B1 test was not executed against a mutated or old checkout. Static old/new control-flow comparison demonstrates why its slot assertion fails on the old combined behavior.
2. No new adversarial runtime test specifically delays concurrent explicit teardown, overlapping viewer heartbeat writes, or strict poll -> bus folding; the permitted existing suites pass, and the relevant changed code was inspected.
3. The saved live artifacts establish the retained counts and values but do not independently attest every claimed historical/consecutive run or the precise source tree of each run. No live behavior was rerun.
4. No round-3 standalone review report, manual QA matrix, or notepad path was supplied; upstream skill coverage cannot be certified.
5. The JS eval/status tool was not exposed in this child session. The report directory was derived from the inspected durable goals.json activeGoalId and attempt=1 using the required canonical .omo/evidence/ulw/<session>/<goal>/a1 layout, rather than a reproduced currentAttemptDir SDK result.
6. The durable goal's requested .sandbox/review-g004-delta.md copy is not written here because the role permits only this gate report artifact. This report contains the complete bounded verdict for the lead to record at its requested closeout path; that packaging detail does not change the HIGH-only verdict.

## Checked artifact paths

Repository root for relative entries below: C:/Users/USER/orca/projects/gjc-herdr-dashboard.

- Complete git diff 0b8d8be dda646e; git show dda646e; git rev-parse HEAD; git status --short.
- README.md delta; VERIFICATION.md, especially :64, :69 and :144-183.
- src/host/instance.mjs (full file, for the changed lifecycle/pass paths).
- src/core/reconciler.mjs, owner classification/rebind and owner-IO/public API sections.
- src/core/data.mjs (writer publish/flush behavior needed to judge drain).
- src/host/sources/workers.mjs (syncJobs/reset behavior needed to judge the new adoption step).
- src/viewers/common.mjs:130-229; src/viewers/todo/viewer.mjs:270-349; src/viewers/workers/viewer.mjs:320-399; their full delta hunks.
- test/live/l4-lock.mjs (full file).
- test/unit/instance.test.mjs, fixture, B1, and ownership/fold/shutdown sections; full delta hunks.
- test/unit/band-pass.test.mjs, fixture and AC2.6/scope/disposal sections; full delta hunks.
- test/unit/reconciler.test.mjs test-name inventory plus executed test results.
- .evidence/L4/LV-10/{attempts.json,delivered.json,notices.json,lock-coverage.json,wrapper.log.jsonl}.
- .evidence/L4/LV-13b/{ac1-2-todo-write.txt,ac1-9-exit.txt}.
- .evidence/L4/LV-7b/ac1-9-timing.json.
- .evidence/L4/test-report.txt (initial and summary sections).
- .sandbox/DIRECTION-2026-10-20.md; .sandbox/arch-l4.txt; .sandbox/arch-l4r2-raw.txt (empty output).
- C:/Users/USER/orca/projects/기타 작업/.omo/ulw-loop/01a1555d-67f6-779f-9cad-ec6fc7819d1e/{brief.md,goals.json}.
- C:/Users/USER/orca/projects/기타 작업/.omo/evidence/ulw-loop-01a1555d/{g004-b1-test.txt,g004-unit-dda646e.txt}.
- C:/Users/USER/.bun/install/global/node_modules/oh-my-openagent/dist/skills/remove-ai-slops/SKILL.md.
- C:/Users/USER/.bun/install/global/node_modules/oh-my-openagent/dist/skills/programming/SKILL.md.
