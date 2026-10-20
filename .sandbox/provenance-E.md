# PROVENANCE — Lane E (`extension.mjs` + `src/host/instance.mjs` unit tests)

Authority for this lane: stage-03-revision §7.1 (instance rules: one factory per session, arm-time
registry, no factory side effects), §7.2 (eligibility, `layoutKey`/`scopeKey`, L1 rebinding with
`/new`+`/resume`), §7.4 (explicit pass = exactly one notify, automatic pass = no notify, no pane
mutation), §7.5 (R1 lock/owner/nested), §9 LT-4 (the no-silent-no-op matrix) and LT-6 (per-session
factory), §14 AC1.2/AC1.4/AC1.5/AC1.6/AC1.10/AC1.11, and stage-05 R1/R4/R6.

Scope: tests only. `extension.mjs` and `src/host/instance.mjs` are the subject under test and were
not modified by this lane; nothing under `src/` was edited. Every path a test writes lives in a
`mkdtemp` directory removed in `t.after`; no test loads a live Herdr, a live GJC, or the owner's home.

| ours | copy source | copy/adapt/new | baseline | notes |
|---|---|---|---|---|
| `test/unit/instance.test.mjs` | — (no omo counterpart: omo's lifecycle lived behind `packages/{dag,todo}/src/controller.mjs` and had no per-session factory/registry split to test) | new | — | 33 tests. The **real** modules provide the behaviour: `createInstance` (the subject), `checkEligibility`/`bindingOf`/`notifyText` (`src/host/gjc-adapter.mjs`), `createReconciler` (`src/core/reconciler.mjs`), `createDataWriter` (`src/core/data.mjs`), `layoutKeyOf`/`scopeKeyOf`/`slotPaths`/`dataPaths` (`src/core/slot.mjs`), `projectTodo` (`src/host/sources/todo.mjs`) and `readSlot`'s real validator (so a test slot must be a *valid* slot, not a stub shape). Only the seams the module documents as injectable are replaced: the shared stateful fake Herdr/clock/process table plus its pass tracer (`test/unit/fake-herdr.mjs`), an instrumented `Map` that records `set`/`delete` (LT-6's "zero registry writes"), a hand-written timer rig (no real clock), an injected `nodeResolver` (no process spawn) and, where the 200 ms merge window would make an assertion time-dependent, a `createDataWriter` with `delayMs: 0` and a recording `io.writeJson`. Coverage: LT-4's whole matrix — session-kind, no-ui, tty, outside-herdr, disabled, nested, mirrored-install, state-dir, busy, busy:other-owner, herdr missing, node missing, list failure, `partial:size`, `partial:timeout`, normal `opened`, duplicate `warn:duplicate-install` — each asserting **exactly one** `ctx.ui.notify` carrying the code token the plan names, plus the negative side of every row (zero registry writes, zero Herdr calls, zero files, zero splits, zero closes, and the holder snapshot `pid … · g… · …` for both busy rows); LT-6 (main then sub in one process, sub bus + sub `session_shutdown` leaving main armed with both timers alive and 0 registry writes / 0 Herdr calls / 0 new files; main `session_shutdown` closing 0 panes, keeping the record and stamping `stoppedAt`; `/reload` replace handover with a stray `/dashboard` delegating to the new owner; a different module URL delegating and warning once); AC1.4 (three `/dashboard` calls → one `GJC Todo · <key8>` pane and one split); AC1.5 (outside-herdr token); AC1.10 (the fake's verb log never contains `report-agent`/`report-metadata`/`release-agent`/`send-text`/`send-keys`, driven through every trigger); AC1.11 (a session id changed between handler calls leaves paneId unchanged, moves `slot.scope.scopeKey`, bumps `scopeEpoch` and writes the projection under the new scopeKey); AC1.2 (`todo_write` publishes inside the call, a non-todo tool publishes nothing); the §7.1 item 5 data gate opening and closing; the G9 poll fallback (`state().pollMode === 'event-only'` after a throwing retained ctx, heartbeat timer intact, event triggers still running passes); and the trigger set (turn_end / agent_end / todo_write-only / goal_updated / three bus channels). **One test fails on purpose**: `FAILS-ON-PURPOSE binding-seam-fault` pins the real defect at `src/host/instance.mjs:442` (see the report below). |
| `test/unit/extension.test.mjs` | — | new | — | 5 tests, factory purity only (§7.1 items 1/2/3). The factory body is observed rather than inspected: wrapped `node:fs`/`node:fs/promises` writers republished to already-imported ESM consumers with `syncBuiltinESMExports()`, replaced `globalThis.setInterval`/`clearInterval`, and `process` property descriptors that *record* every read of `env`/`pid`/`platform`/`stdout`/`execPath`/`argv` for the duration of the call. A recording getter is used instead of a throwing one on purpose: Node's own internals read `process.env` for colour detection, and a throw would be attributed to the wrong actor (measured in `.sandbox/probe-trap*.mjs` during this lane). Asserted: no env/platform/pid/stdout read, no timer, no fs write, **no registry map created** (`Object.hasOwn(globalThis, REGISTRY_KEY) === false`), the handle is exactly `{armed, dispose, state}` with `armed:false`, `pollMode:'event-only'`, `instanceId:null` (no id is minted at factory time) and a plain-JSON snapshot; the exact registration list (six `pi.on` handlers, three `pi.events.on` channels, one `registerCommand('dashboard')` with the adapter's description); that the entry point passes this very module's `import.meta.url` as a value (SR5: no dynamic import); a non-vacuity test proving the same accessors ARE recorded once an ineligible handler runs (`process.stdout` for `isTTY`, `process.env` for `HERDR_*`); and two independent factories sharing nothing but the lazy registry. |

## Bug found in `src/host/instance.mjs` (reported, not worked around)

`/dashboard` can escape the handler with **zero** notifies, which is exactly the E1 defect LT-4
(§9/§14 AC1.5) forbids.

- Location: `src/host/instance.mjs:442` — `const local = bindingOfCtx()(ctx, environment);` inside
  `arm()`. The call is outside any `try`/`catch`, and `arm()` is awaited at
  `src/host/instance.mjs:772` (`const outcome = armed ? { kind: 'owner' } : await arm(ctx, eligibility);`)
  *before* the `try { return await runExplicit(ctx); } catch` block that begins at `:800` and whose
  own comment at `:802` claims to be "the last resort for a fault in the steps before it (binding,
  rebind)".
- Trigger: any `deps.bindingOf` that throws (a documented injectable seam), or a seam that returns
  `undefined` — the same fault class as a host whose `sessionManager` accessor throws. Measured in
  `.sandbox/probe-instance-adversarial.mjs`: `bindingOf: () => { throw … }` → 0 notifies and the
  error propagates to the caller; `bindingOf: () => undefined` → `TypeError: Cannot read properties
  of undefined (reading 'socket')`, also 0 notifies.
- Failing test name (left in place): **`FAILS-ON-PURPOSE binding-seam-fault: a throwing binding seam
  still owes one notify`** in `test/unit/instance.test.mjs`.
- Impact: the real `bindingOf` never throws and always returns an object, so the shipped product is
  not broken today; the gap is between the module's stated contract (`deps` are all injectable; the
  handler never throws and always notifies once) and its code. Suggested fix (not applied, src is
  out of scope for this lane): move the `await arm(...)` inside the existing `try`, or wrap the
  `bindingOfCtx()(...)` call in `arm()` with the `record()` + `{ kind: 'invalid' }` path that already
  exists for a bad binding.

## Other findings (no code change, test-level observations)

1. The `busy`/`busy:other-owner` notify carries the pass's own lock view (`pid unknown · g<N> · <lock dir>`),
   not the foreign holder's pid, because `runExplicit` → `notify(ctx, result, …)` passes a result whose
   `lock` is the pass's own and `detail` is a string. The adapter renders unknown rather than guessing,
   which matches its documented rule, so the test pins the actual rendering.
2. Arming writes the owner record itself before the first pass, so the "foreign live owner" row is
   reachable only after arming (or by another process); the test models exactly that.
3. `state()` reports `moduleUrl` from `deps.moduleUrl`, so a factory test can prove the entry point
   passes `import.meta.url` as a value.

## Test counts (this lane, isolated `node --test --test-isolation=none`)

| file | tests | pass | fail |
|---|---|---|---|
| `test/unit/instance.test.mjs` | 33 | 32 | 1 (the intentional bug pin above) |
| `test/unit/extension.test.mjs` | 5 | 5 | 0 |
| total | 38 | 37 | 1 |
