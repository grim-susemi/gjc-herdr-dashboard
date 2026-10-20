
### L1 live fault scripts (re-run by the caller; each script also self-cleans and records `verifiedAbsent`)

Harness: `test/live/{herdr-wrapper,fixture,case}.mjs` (wrapper logs every Herdr call and injects faults only through flag files; the fixture refuses input to any pane it did not create). Unit tests for the wrapper: `test/unit/live-wrapper.test.mjs` (14).

| LV | Script | Observed | Result | Evidence |
|---|---|---|---|---|
| LV-2 | `node test/live/lt1-fault.mjs` | `fail-split-once` + `/dashboard` x2: first notify `실패(pane split: herdr-split)` with zero panes, second `ext dev · Todo 열림` with exactly one `GJC Todo` pane | PASS | `.evidence/L1/LV-2/` |
| LV-3 | `node test/live/lt3-delay.mjs` | `delay-run-25s` + one `/dashboard`: the viewer painted `Todo [0/0]` + `자동 추적 ON` within 45 s, one split, one pane, no second notify in a 20 s quiet window | PASS | `.evidence/L1/LV-3/viewer-frame.txt` |
| LV-10 | `node test/live/l4-lock.mjs` | two `/dashboard` sent back to back in one parent: at most one split and one viewer pane, no lock/busy notify | PASS (single-parent only; true cross-process contention is covered by unit tests LT-7 a-d with fakes, not live) | `.evidence/L1/LV-10/` |

Note: a wrapper that sleeps is killed by the reconciler's 5 s per-call timeout, so the delayed `pane run` is deferred to a detached helper (the log therefore shows two `pane run` lines for LV-3).
Still not run live: AC1.7 viewer-kill, AC1.9 owner-kill, LV-5 adopt (L4).
