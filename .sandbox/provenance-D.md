# PROVENANCE — Lane D (host adapter, Todo source, dev shim, README)

Pinned copy source: `C:/Users/USER/AppData/Local/Temp/omo-herdr-dashboard-4082c750/` (extract of
omo-herdr-dashboard at SHA `4082c7509c4a2f8a53128b85bfd38acf017a52c3`). Read-only: nothing in that
tree was built, installed or executed for this lane. The only omo file that informed code here is
`packages/todo/src/native-todo.mjs`, read for the *shape* of the phase payload and the
`cancelled -> abandoned` rule; no line was copied.

Authority for this lane: `stage-03-revision.md` §7.2 (eligibility, keys, notify) and §7.6 (Todo
source), `stage-05-revision.md` R1 (nested), R3 (viewer failpoint), R4 (ROOT URL, mirror detection,
state dir), R5 (generation token), R6 (arming entry points), and the L0 measurements recorded in
`VERIFICATION.md` (G3 `sessionMetadata.kind`, G4 `getTodoState()` shape, G8 two-tree layout,
G10 pid liveness).

Two places where the lane assignment's shorthand was deliberately read through the plan text:

1. **Mirror assets.** The task text says "missing sibling `locale/` and `viewers/` dirs".
   `stage-05 R4` is narrower and is what this lane implements: `locale/{ko,en,zh-cn}.json` must be
   readable (**and `ko.json` must parse**), `src/viewers/common.mjs` must be readable, and every
   released role's viewer entry (`src/viewers/<role>/viewer.mjs`) must be readable. The dev tree and
   the `generation-NNNNNN/` tree have the same relative layout, so one rule covers both, and there
   is no fallback path (R4's "대체·호환·탐색 fallback 경로는 없다").
2. **State dir.** Implemented as R4's three-step rule, not as the shorthand: env override (trimmed,
   resolved) -> `basename(root) === 'generation-\d{6}'` and its parent's basename is
   `herdr-dashboard`, giving `<parent>/state` -> otherwise `null`, which the caller reports as
   `ineligible:state-dir`. A dev tree therefore derives no state dir, which is why the dev shim
   writes one.

| ours | omo source path @4082c750 | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `src/host/gjc-adapter.mjs` | — | new | — | No omo counterpart: omo's install/session probe lived in `packages/dag/src/controller.mjs` + `runtime.mjs` and was replaced wholesale by plan §7.2's ordered eligibility gate, §7.2's `layoutKey`/`scopeKey` binding, and §7.4+R5's single notify line. Contains `checkEligibility` (the eight reasons in plan order, LT-4's notify matrix), `bindingOf` (env + `ctx.sessionManager.getSessionId()`, never throwing), `notifyText` (all 13 documented result codes plus every eligibility reason, partial/replaced why and failed code; the machine token is kept verbatim beside its localized description), and the R4 mirror/state-dir helpers. `notifyText` degrades to a raw line when the catalogue is unreadable so a pass still produces exactly one message (LT-4). |
| `test/unit/adapter.test.mjs` | — | new | — | Covers the eligibility matrix one input at a time (13 single-failure cases plus the ordering test that proves an earlier failure hides a later one), the R1 nested rule (dead pid only, unknown/junk is nested), mirror detection (tmpdir comparison with case-insensitive real paths, each shipped asset required individually, malformed `ko.json` rejected), the state-dir rules, `bindingOf` degradation, and every notify code × 3 languages × 2 generation forms, plus the LT-4 degradation matrix (a `null` ctx/env/deps, a bad or non-file module URL, a null module URL falling back to the package root). All paths are scratch directories under `.sandbox/adapter-test-*` inside the repo, created at module load and removed in a single `after` hook; `isTTY`, `pidAlive`, `tmpdir`, `access`, `readFile` and `stateDirResolver` are all injected, so no real temp dir, home, Herdr or owner file is touched. |
| `src/host/sources/todo.mjs` | `packages/todo/src/native-todo.mjs` | adapt (shape only) | 15/15/0 (`packages/todo/test/native-todo.test.mjs`, not copied) | Kept from that file: the phase payload reading (`phases[]` with `name`+`tasks[]`), the `cancelled -> abandoned` mapping, and the rule that a malformed payload is rejected rather than half-converted. Changed with the product and the measured host: the primary source is `ctx.getTodoState()` (L0 G4 returned `[{name,tasks:[{content,status}]}]`), the transcript replay scans for the newest custom `user_todo_edit` entry (`data.phases`) or the newest successful `todo_write` tool result (`details.phases`), matching the binary's own `getLatestTodoPhasesFromEntries` order. Dropped from omo: the `ask` panel payload, phase/task occurrence keys (the renderer derives its own), the scheduler and native task ids. Added: `sourceError` instead of throwing, and a privacy filter (no notes, ids, assignment text or transcript bodies ever leave this module). |
| `test/unit/todo-source.test.mjs` | `packages/todo/test/native-todo.test.mjs` | adapt | 15/15/0 | Kept: the newest-eligible-payload rule, the failed-tool-result exclusion, and the status vocabulary. Adapted: the primary-source behaviour of this product (`getTodoState` first), the round trip through the viewer's own `readProjection` (one contract, not two), and the privacy assertion that notes/ids/assignee never reach the projection. Added: the throwing-accessor fallback, a newer broken payload reported instead of silently falling back to an older "valid" one, and the legacy `{todos:[…]}`/bare `{phases:[…]}` shapes. |
| `scripts/dev-shim.mjs` | `scripts/install.mjs` (shim write only) | adapt | — | Kept: the absolute re-export form `export { default } from '<absolute URL>';` (stage-05 R4, §7.7) and the `case-<id>/.gjc/extensions/gjc-herdr-dashboard.js` location. Changed: this is the *dev* shim, so it also writes three `??=` defaults (`GJC_HERDR_DASHBOARD_STATE_DIR`, `GJC_HERDR_DASHBOARD_HERDR`, optional `GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT` from R3/SR9) and it never touches an existing value. The installer (L6) writes the production shim with env assignments and FAILPOINTs at 0. Header comment records the ESM ordering caveat and proves it is observed, not assumed, by `test/unit/dev-shim.test.mjs`. SR9 places the `FAILPOINT` allowance for this file with `src/core/launch.mjs`; the file itself contains no `FAILPOINT` literal, and the flag is spelled `--viewer-failpoint`. |
| `test/unit/dev-shim.test.mjs` | `test/install.test.mjs` (shim assertions only) | adapt | 6/6/0 (`packages/todo/test/install.test.mjs`, not copied) | Kept: "the shim re-exports by absolute URL, never by relative path" and "the target exists before anything is written". Adapted to the dev shim: the scratch repo and sandbox root live under `.sandbox/dev-shim-test-*` (created in a scratch dir, removed in `after`), and the generated file is imported for real with a cache-busting `?v=` per case, so the ESM ordering claim is observed rather than asserted from text: the entry records what it saw at import time (no defaults yet) and what the factory sees afterwards (defaults applied). Added: the Korean+space case id, `--herdr` JSON validation, `--state` override, and `main`'s exit codes and stderr messages. |
| `locale/{ko,en,zh-cn}.json` (`notify.*` keys) | `packages/dag/src/i18n.mjs` (key naming) | new keys | 1/3/2 (`packages/dag/test/i18n.test.mjs`) | The three catalogues are lane B's file; this lane added the `notify.*` namespace only, which is 47 of the current 65 keys. All three files carry an identical key set with identical interpolation parameters, which lane B's parity test checks generically and `test/unit/adapter.test.mjs` pins for the notify subset. The keys were cross-checked against every code lane C's `src/core/reconciler.mjs` and `src/core/launch.mjs` actually emit, including `partial:ownership-unproven` and `failed:{herdr-split,herdr-process-info,herdr-record,herdr-rename,herdr-run,herdr-close,internal,lock-io,failpoint}`, and a test fails if any of those ever renders its raw token instead of a sentence. omo's baseline i18n test fails two of three assertions in this archive, so it was a naming reference, not a test source. |
| `README.md` | `README.md` | new (Korean) | — | Written for the owner, not copied. Every limitation is traceable: duplicate widget + `alt+shift+t` (AC1.12, E11, A-20), depth-1 workers (§7.6), cost 0 = unknown (K1), no third pane (F1 FAIL, §10), `/todo` G9-conditional reflection (partial L0 G9), restart after a generation change (R5), omo `foreignWaiting` (§7.10), `/reload` unmeasured (G12), schema-major slot reuse (§16), and the M1–M5 manual recovery boundary with R1's exact file operations and the explicit warning that breaking the precondition can produce double ownership. No behaviour is claimed beyond what the tests in this lane and the L0 record support. |
| `.sandbox/provenance-D.md` | — | new | — | This file. |

## Not copied (deliberate)

- omo `packages/todo/src/{controller,presence,native-host,display-bridge,parent-slot,workspace}.mjs`:
  the omo session/custody/presence machinery is what plan §7 replaces; only the phase payload shape
  survived (above).
- omo `packages/dag/src/{controller,viewer,render,model,view-state,terminal-input}.mjs` and
  `packages/dag/test/*`: L2–L5 lanes own these.
- `src/host/instance.mjs`, `extension.mjs`, `src/core/{reconciler,launch,data}.mjs`: other lanes.

## Host facts this lane depends on

| fact | source | use here |
|---|---|---|
| `ctx.sessionMetadata.kind === 'main'`, `hasUI===true` for the interactive main; sub has `hasUI===false` | `VERIFICATION.md` G3 | eligibility steps 1–2 |
| `ctx.getTodoState()` returns `[{name, tasks:[{content, status}]}]` | `VERIFICATION.md` G4, `.sandbox/probe-g4.jsonl` | `projectTodo` primary source |
| `todo_write` `tool_execution_end` carries `details.phases`; `/todo` edits append a `user_todo_edit` custom entry and emit no event | `VERIFICATION.md` G4 plus the 0.18.11 bundle's own replay helper (`getLatestTodoPhasesFromEntries` and the `user_todo_edit` reader next to it), read out of the binary in this session | replay order, G9 limitation in README |
| `process.kill(pid,0)` -> success / ESRCH / EPERM | `VERIFICATION.md` G10 | `isNested`, and `pidAlive`'s `null` for "unknowable" |
| two-tree ROOT layout (dev tree, `generation-NNNNNN/`) and the `generation-\d{6}` state rule | `VERIFICATION.md` G8, stage-05 R4 | mirror detection, `defaultStateDirResolver` |
| a tree under `os.tmpdir()` or missing `locale/`/`src/viewers/` is a mirror, `ineligible:mirrored-install` | stage-05 R4 | `isMirrored` |
