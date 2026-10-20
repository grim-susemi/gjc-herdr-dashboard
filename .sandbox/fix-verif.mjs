import { readFileSync, writeFileSync } from "node:fs";
const path = "VERIFICATION.md";
let t = readFileSync(path, "utf8");
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const rep = (from, to) => { must(t.includes(from), `missing: ${from.slice(0, 60)}`); t = t.replace(from, to); };

rep("Unit: `node scripts/test.mjs` 341 tests, 341 pass (LT-1..LT-8 incl. LT-4 matrix, LT-6, A-29..A-32 obligations, SR1-SR9). Reconciler stress: 15 repeated runs, 0 failures after replacing a timer-based wait with a deterministic gate.",
  "Unit: `node scripts/test.mjs` 357 tests, 357 pass (LT-1..LT-8 incl. LT-4 matrix, LT-6 clauses 1-3, A-29..A-32 obligations, SR1-SR9, R3 heartbeat-tick and viewer-failpoint argv). Reconciler stress: 15 repeated runs, 0 failures after replacing a timer-based wait with a deterministic gate. `live-wrapper.test.mjs` once failed a single full-suite run (`delay-run-25s` detach test, since deleted) and passed 6/6 isolated re-runs; the flag no longer exists.");

rep("| AC1.7 external close | harness closed the viewer pane; next `/dashboard` created a new pane (`열림`) | PASS for external close only; viewer kill and 25 s delay not run live | - |",
  "| AC1.7 external close | harness closed the viewer pane; next `/dashboard` created a new pane (`열림`) | PASS | - |\n| AC1.7 viewer kill | `node test/live/kill-recovery.mjs`: `taskkill` of the viewer pid from `roles/todo.ready.json`; the pane disappeared (U10, shell trailer `; exit`); the next `/dashboard` took T4 (`열림`, new pane, new viewer pid, exactly one role pane) | PASS | `.evidence/L1/LV-7b/` |");

rep("| AC1.9 disconnect | clean `/exit` wrote `stoppedAt`; viewer showed `연결 끊김 14:32` and the pane stayed | PASS for normal exit; kill within 20 s not run live | `LV-1/disconnected-frame.txt`, `owner-after-exit.json` |",
  "| AC1.9 disconnect (exit) | clean `/exit` wrote `stoppedAt`; viewer showed `연결 끊김 14:32` and the pane stayed | PASS | `LV-1/disconnected-frame.txt`, `owner-after-exit.json` |\n| AC1.9 owner kill | `kill-recovery.mjs`: `taskkill` of the owner gjc pid without `/exit` (no `stoppedAt`); the viewer, using the default `pidAlive` probe, showed `연결 끊김` 21.7 s later (20 s heartbeat gate + 3 s sample) and the pane stayed. This is the live proof for review blocker B3 | PASS | `LV-7b/viewer-after-owner-kill.txt`, `list-after-owner-kill.json` |");

const start = t.indexOf("Not run live in L1: LV-2");
const end = t.indexOf("Lock directory growth:");
must(start > 0 && end > start, "not-run paragraph markers");
t = t.slice(0, start) + "Not run live in L1: LV-5 adopt (L4), `/resume` (no persisted session under the shared SDK lock), cross-process lock contention (unit tests LT-7 a-d with fakes), G9 value freshness, G12 resume/fork/reload.\n" + t.slice(end);

rep("Unit tests for the wrapper: `test/unit/live-wrapper.test.mjs` (14).", "Unit tests for the wrapper: `test/unit/live-wrapper.test.mjs`. The wrapper has exactly two fault flags (`fail-split-once`, `fail-list`); it never delays or edits a call (stage-05 R3 l.153).");

rep("| LV-3 | `node test/live/lt3-delay.mjs` | `delay-run-25s` + one `/dashboard`: the viewer painted `Todo [0/0]` + `자동 추적 ON` within 45 s, one split, one pane, no second notify in a 20 s quiet window | PASS | `.evidence/L1/LV-3/viewer-frame.txt` |",
  "| LV-3 | `node test/live/lt3-delay.mjs` | dev shim `--viewer-failpoint ready-delay-25s`; one model turn wrote a Todo row (`todo_write`), then ONE `/dashboard`: wrapper log has 1 split and 1 run (29 ms, <5 s); notify `열림`; 5 s `pane list` samples show 1 role pane and slot role `pending` with no data row until +25.5 s; slot role `ready` (T13) at +30.7 s; the frame then shows `lv3-row-alpha` and the footer `자동 추적 ON · 실시간`; no second `/dashboard` notify in a 10 s quiet window. `notify-latency.txt` records 52.6 s because `sendSlash` retries keystrokes on its popup race (harness, attempt 2); the timing gates are the wrapper run duration and the slot samples | PASS | `.evidence/L1/LV-3/{samples.json,wrapper.log.jsonl,early-frame.txt,viewer-frame.txt,notify-latency.txt}` |\n| AC1.7 / AC1.9 kills | `node test/live/kill-recovery.mjs` (see the rows above) | PASS | `.evidence/L1/LV-7b/` |");

const n1 = t.indexOf("Note: a wrapper that sleeps is killed");
const n2 = t.indexOf("Still not run live: AC1.7 viewer-kill");
must(n1 > 0 && n2 > n1, "note markers");
const n2end = t.indexOf("\n", n2);
t = t.slice(0, n1) + "Reviewer round 1 (architect, HEAD `496c33f`) found three defects that the unit tests and the first LV-3 run had hidden; all are fixed and covered:\n1. B1 `heartbeat-tick`: the host never ran the automatic pass on the 5 s tick, so a late viewer (T13) was never promoted without another `/dashboard`. Fixed in `instance.mjs` (pass runs only while the todo record is `pending`); instance test `R3: the 5 s heartbeat tick runs ...`.\n2. B2 viewer failpoint: the launcher passed `--failpoint ready-delay-25s` but the viewer rejected the flag (exit 2, pane dropped) and read an unplanned env var instead. The flag is now parsed in `src/viewers/common.mjs` (SR9), the env var is gone, and the delay gates the ready write, the heartbeat, the repaint timer and the slot watcher. Tests feed the real `viewerArgs()` output to `parseViewerArgs` and run the interactive late viewer.\n3. B3 owner probe: the viewer never probed the owner pid (`ownerAlive=null` meant always alive). It now uses `core/liveness.mjs#pidAlive` (only ESRCH is dead); unit test without an injected `alive`, plus the live owner-kill row above.\nThe earlier LV-3 PASS used a wrapper `delay-run-25s` flag that the plan deleted (R3 l.153) and never observed T13; that run and flag were removed and LV-3 was redone through the product failpoint." + t.slice(n2end);

writeFileSync(path, t);
console.log("ok");
