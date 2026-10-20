# PROVENANCE — Lane C (L1 core lifecycle: launch / reconciler / data)

Pinned copy source: `C:/Users/USER/AppData/Local/Temp/omo-herdr-dashboard-4082c750/` (archive extract of
omo-herdr-dashboard at SHA `4082c7509c4a2f8a53128b85bfd38acf017a52c3`). Read-only; nothing was built or
executed from that tree.

Authority for this lane: stage-03 §7 (host contract, launch sequence, pass order), §8 (row table),
§9 (LT-1..LT-8), §13 (files); stage-05 R1 (lock protocol), R2 (row table amendments), R3 (failpoints
and viewer args), R4, R6; `herdr-dash-a29-fix-01/stage-01-planner.md` (A-29/C-14) and its
`pending-approval.md` §4 (A-30/A-31/A-32 executor obligations).

| ours | omo source path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/core/launch.mjs` | `packages/dag/src/controller.mjs` (`ensure`, L458-503), `packages/todo/src/controller.mjs` (`launchTodo` region, L2540-2600) | adapt | `test/dashboard-dag-b.test.mjs`, `test/dashboard-todo-b.test.mjs` in B1 (13 failures, none in these paths) | The launch sequence (`split --direction right --no-focus` -> `process-info` -> record -> `rename` -> `run (shellCommand)`) is the omo order, with three plan-driven changes: (1) U12's measured flag set has no combined split+run, so these stay separate calls; the omo `--ratio 0.65` is dropped because L1 has no band placement (L2 owns it) and the plan's L1 step list does not include it; (2) the omo `--close-pane` viewer argument is replaced by the plan's `--state/--layout/--role/--token/--pane` contract, which lane B's viewer already parses; (3) a durable `intent.json` is written before the split and deleted after the record (T19), which omo does not have — omo instead writes `{attempted:true}`/`{paneId,ready:false}` to a per-role record file. `shellCommand`/quoting are reused from this repo's `src/herdr.mjs` (lane A's port of omo `packages/dag/src/herdr.mjs`). FAILPOINT (FP1-FP4, SR9) is new: omo simulates crashes only through its test helpers. |
| `src/core/reconciler.mjs` | `packages/dag/src/controller.mjs` (`DagPane.enqueue`, `closePane`, `closeDagPanes`, `ensure`, `restorePlacementFocus` L1990-2035), `packages/todo/src/controller.mjs` (`mutate`/`verifyInputPane`/`launchTodo`) | adapt | see above | Reused patterns: the per-instance serial queue (`enqueue(job, {force})`), the "close only after a re-read proves the pane is ours" rule (omo `canCleanupPane` + `membership` before `close`), the neighbour-walk focus restoration (`neighbor --pane X --direction D` then `focus --pane X --direction D`, max 3 steps in omo, 4 here), and the `layout-waiting` refusal shape (which the plan replaces with a coded terminal result — LT-5 forbids a waiting state, so every refusal becomes `partial:*`/`failed:*`). Replaced: omo's single `slot.json` + heartbeat + `fence()` with the R1 generation-file protocol from this repo's `slot.mjs`; omo's `BLOCKED` phase with `busy`/`busy:other-owner`; omo's per-role `roleFile` JSON with the plan 7.9 `slots/<layoutKey>/{slot,owner,intent,roles/*.ready}.json` set. New: the budget/deadline guard, the A-32 read-only automatic-pass restriction, and the T19 interrupted-launch row. |
| `src/core/data.mjs` | `packages/dag/src/controller.mjs` (`receiveStream` coalescing, L368-392; `save`) | adapt | see above | The 200 ms merge is the plan's number for the plan 7.9 `data/<scopeKey>/<kind>.json` file family; omo's nearest equivalent is the 250 ms `streamDelay` coalescing of streamed tokens, whose structure is reused (`setTimeout` + a promise that settles after the coalesced write, `unref()` so a pending merge never holds the process open). Changed: this writer stores a caller-computed projection verbatim (the plan's writer/store split) instead of omo's in-memory `streams` map, and adds the caller's `shouldWrite` gate and a `flush()` that drains in-flight writes — both are consequences of the plan's host contract, which omo has no counterpart for. |
| `test/unit/launch.test.mjs` | — | new | — | No direct omo test counterpart: the omo launch order is exercised indirectly through `test/dashboard-*-b.test.mjs`, which drive the whole controller. This file tests the launch primitive directly (preflight coded failures with zero panes; the §7.3 call order; FP1-FP5 leftovers; quoting with a Korean path containing spaces; focus restore only when the focused pane moved; LT-1's split-failure-then-open; LT-8's run-target provenance). |
| `test/unit/reconciler.test.mjs` | — | new | — | One test per lifecycle row (LT-2 r1-r7), the A-29/C-14 observation sequences S1, S2, S3, S5, S6a-S6d, the A-30 close-error matrix, the A-31 automatic-event drivers, the A-32 verb audit, LT-3's age boundaries and the FP1-FP5 window, LT-5's no-waiting-state cases, LT-7's lock races and LT-8's run-target check. |
| `test/unit/latch.test.mjs` | — | new | — | The E1-E5 latch-defect suite: end-to-end sequences proving no silent pass, no permanent latch after a coded failure, no inherited record, and window convergence. |
| `test/unit/data.test.mjs` | `packages/dag/test/controller.test.mjs` (coalescing assertions) | adapt | B1: `test/dashboard-dag-b.test.mjs` passed; `controller.test.mjs` not in B1 | The coalescing test's intent (two rapid publishes produce one write, the newest value wins) is reused; the remaining cases (the `shouldWrite` gate, `flush` draining a slow write, `flush` rethrowing a failed write, malformed target rejection, array/`null` projections stored verbatim) are new, because the plan's writer contract has no omo counterpart. |
| `test/unit/fake-herdr.mjs` | `test/helpers/split-tree-herdr.mjs` (copy source) | adapt | B1: `test/split-tree-herdr.test.mjs` (13 B1 failures include this family) | **Not in the declared lane-C file list; added deliberately.** The split-tree fixture is the only omo file that models Herdr pane state, so it is the closest copy source, but it is a `dag`-test helper with geometry calibrated for omo's band layout. This fixture keeps the calibrated split behaviour (the source pane keeps the first child, the new pane takes the second child, so a `right` split puts the new pane to the right — verified against `.evidence/L0/g2-split.json` and `u11-split.json`), the close-gives-the-sibling-the-space rule, and the `neighbor` semantics of `pane focus --pane X --direction D`. Added: the A-32 call tracer, failure injection (`{code}`, `{times}`, `{skip}`, `{hang}`, `{remove}`), the fake process table and the fake clock. It lives under `test/unit/` rather than in production code so no test seam enters `src/`. |

## Baseline honesty

- The 13 B1 failures recorded in `.evidence/L0/baseline-omo.json` are omo's own pre-existing failures
  (band geometry, split-tree helper, install guards). None of them is inherited as an exemption here:
  every case this lane copies was re-derived from the plan's contract and made to pass on this host.
- No file in this lane was executed or imported from the archive tree; the archive is read-only.

## Test counts (this lane, per file, isolated `node --test --test-isolation=none`)

| file | tests | pass | fail |
|---|---|---|---|
| `test/unit/launch.test.mjs` | 12 | 12 | 0 |
| `test/unit/reconciler.test.mjs` | 41 | 41 | 0 |
| `test/unit/latch.test.mjs` | 17 | 17 | 0 |
| `test/unit/data.test.mjs` | 6 | 6 | 0 |
| total | 76 | 76 | 0 |

`test/unit/static-rules.test.mjs` (phase 1, unmodified) is green with these files present: 21/21.

## Deviations from the plan (reported to the parent)

1. `failed:fenced` is reported as `busy` + `fence:true`, because stage-05 R1 deletes base 7.5's
   `fence()`/`failed:fenced` and replaces it with the generation re-check.
2. LT-7 (a)/(d) follow R1: a frozen live holder yields `busy`/`busy:other-owner`, never a takeover at
   31 s; a superseded recoverer deletes only its own generation file and reports `busy`.
3. `--failpoint` parsing lives in `src/core/launch.mjs` (allowed by SR9) for the launch-side
   FP1-FP4 crash points; the viewer-side FP5 value is passed through as `--failpoint ready-delay-25s`.
4. Preflight (node/viewer/herdr checks) runs eagerly for explicit passes and is skipped entirely for
   automatic passes, because A-32 forbids `checkNode`'s process spawn in an automatic pass.
5. `test/unit/fake-herdr.mjs` is an added fixture file inside the lane's own test tree.
6. `input.failpoint` is an added optional pass-input field (test seam for R3's FP1-FP5); production
   callers never set it, and the field is documented in the module header.
7. A launch that fails **after** it wrote the pending record now hands that slot snapshot back to
   the pass (`launchRole` returns `slot`/`record` on the post-record failure paths), so a later
   role in the same pass cannot write its stale pre-launch snapshot over the record. Found by the
   `fp2`/`failed:herdr-rename`/`failed:herdr-run` tests; see `test/unit/reconciler.test.mjs`.
8. A `pane split` that exceeds the per-call limit is `partial:timeout`, not `failed:herdr-split`:
   the pane may exist, so the intent is kept and the next pass reports the T19 row. A coded split
   refusal (nothing created) clears the intent and is `failed:herdr-split`, which is what LT-1's
   "split failure then opened" sequence measures. Same rule for a per-call timeout raised anywhere
   else in the pass: the aggregate becomes `partial:timeout`, never `failed:internal`, and every
   role row is filled with that code so the caller's single notify can never see a `null` row.
9. `herdr` calls are wrapped in a per-call timeout (`herdrTimeoutMs`, 5000 ms by default) inside
   the reconciler; the launch primitive relies on the caller's wrapper (`call`) for the same limit.
10. The pass order keeps the contract's `placement` step as a documented no-op: band placement
    (plan 7.8) is L2's `src/core/layout.mjs`, so this lane has no geometry work between the role
    rows and the focus step. The only geometry read here is the pre-split parent-size guard
    (`partial:size`), which exists so LT-5 can never report a waiting state.
11. Cross-module note (not changed by this lane): the committed phase-1 `transitions.mjs` gives an
    automatic pass `[discard-record]` for T5/T4. The task text's "record cleanups T3/T4/T13 only"
    does not name T5, so an automatic T5 discards a record whose pane it deliberately never
    touches. The reconciler only applies the decided actions, and lane A's table is the authority;
    this is flagged for the parent rather than silently amended.

## Integration notes for other lanes

- **`partial:interrupted-launch` (T19) needs notify wording.** My reconciler emits it for a
  leftover `intent.json`, and it is in the plan's table (`stage-05 R2` row 2: `partial`), but it is
  absent from the emitted-code list in `test/unit/adapter.test.mjs` (lane D, `src/host/gjc-adapter.mjs`).
  It currently renders as the generic `부분 완료(why: interrupted-launch)` fallback in ko/en/zh-cn
  instead of a real sentence. Lane D was offline when this was found; their
  "every lane-C code has wording" test passes only because the code is not in their list, so the
  list needs one more entry plus three locale keys. Every other code I emit
  (`failed:herdr-split|-close|-process-info|-record|-rename|-run`, `failed:failpoint`,
  `partial:size`, `partial:timeout`, `partial:ownership-unproven`, `replaced:stalled|dead`,
  `busy`, `busy:other-owner`, `opened`, `adopted`, `ready`, `pending`, `pending-slow`,
  `unresponsive`) is already covered there.
- The reconciler's automatic-pass `code` set is closed: `none | closed | discarded | ready |
  pending | pending-slow | unresponsive | quarantined | busy:other-owner`. The adapter never has to
  format a notify for an automatic pass, and it must not.
- A `busy`/`busy:other-owner` result always carries `lock:{generation,dir}` and an
  `ownerDetail`/`detail` string, which is exactly what `notifyText`'s `pid <P|unknown> · g<N> ·
  <path>` line is built from.
