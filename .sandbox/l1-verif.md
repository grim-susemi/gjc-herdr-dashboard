
## L1 (Todo pane, instance lifecycle and lock)

Unit: `node scripts/test.mjs` 341 tests, 341 pass (LT-1..LT-8 incl. LT-4 matrix, LT-6, A-29..A-32 obligations, SR1-SR9). Reconciler stress: 15 repeated runs, 0 failures after replacing a timer-based wait with a deterministic gate.

Live (harness-owned Herdr session `gjcdash-l1`, interactive `gjc --no-session --no-title` in `.sandbox/case-lv1`, dev shim, GJC 0.18.11; session stopped and workspace closed afterwards; owner pane `w1:pT5` and all other sessions untouched):

| Item | Observed | Result | Evidence |
|---|---|---|---|
| AC1.1 open | `/dash` + `board` -> notify `ext dev · Todo 열림`; exactly one `GJC Todo · bbf6636f` pane right of the parent; parent stays focused | PASS | `.evidence/L1/LV-1/list-after-x3.json`, `layout.json` |
| AC1.4 `/dashboard` x3 | pane count stays 1, notify `정상`, parent focus unchanged | PASS | `LV-1/list-after-x3.json` |
| AC1.2 todo_write | `todo_write` by the model -> `data/<scopeKey>/todo.json` has Setup/alpha/beta; slot record pending -> ready; viewer frame shows the phase after reopen | PASS (after fix 1 below) | `LV-1/viewer-frame.txt`, `state-tree.txt` |
| AC1.3 reopen | `f` -> `자동 추적 OFF`; `q` -> pane closes itself; `/dashboard` reopens with `자동 추적 ON`; the Setup phase is shown | PASS (after fix 2 below) | `LV-1/reopen-frame.txt` |
| AC1.7 external close | harness closed the viewer pane; next `/dashboard` created a new pane (`열림`) | PASS for external close only; viewer kill and 25 s delay not run live | - |
| AC1.9 disconnect | clean `/exit` wrote `stoppedAt`; viewer showed `연결 끊김 14:32` and the pane stayed | PASS for normal exit; kill within 20 s not run live | `LV-1/disconnected-frame.txt`, `owner-after-exit.json` |
| AC1.10 / LV-13 | parent `agent_status` working -> idle while the dashboard was open; no reporter verbs in product code (SR2) | PASS | `LV-13/list-during-prompt.json` |
| AC1.11 / LV-11 | `/new` changed `scopeKey` and `scopeEpoch` 1 -> 2; viewer pane id unchanged; new data dir created. `/resume` not measured (no persisted session, shared SDK lock) | PASS for `/new` only | state tree |
| AC1.5 / LV-4 | gjc started without `HERDR_*`: notify `ineligible: outside-herdr`; no state dir created | PASS | `LV-4-outside-herdr.txt` |
| AC1.6 / LV-6 | one `task` subagent run: only lock-generation files changed, all lock files carry the main gjc pid and instanceId; no new pane | PASS (the herdr-call count 0 from a wrapper log was not measured; unit test LT-6 covers it with fakes) | `LV-6/` |

Defects found live and fixed (both missed by unit tests; regression tests added in `test/unit/viewer.test.mjs`):
1. The viewer repainted its first frame forever (the 1 s timer only redrew the cached frame), so a Todo written after the first paint never appeared. `paint()` now calls `refresh()`.
2. The viewer had no default Herdr client, so `q` never closed its own pane in a real run. It now uses the argv vector recorded in `slot.json.herdr`.
Also fixed from unit work: a throwing binding seam in `arm()` produced zero notifies (now one `failed:internal`).

Not run live in L1: LV-2 (fault injection `fail-split-once`), LV-3 (25 s delayed run), LV-10 (two simultaneous `/dashboard`), AC1.7 viewer-kill, AC1.9 owner-kill, LV-5 adopt. These are covered only by unit tests with fakes; the wrapper-based fault flags (`test/live/herdr-wrapper.mjs`) are not implemented yet.
Lock directory growth: one generation file pair per pass; four files remained after a long session, so the existing GC keeps it bounded.
