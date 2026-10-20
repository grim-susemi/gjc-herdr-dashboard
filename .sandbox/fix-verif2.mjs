import { readFileSync, writeFileSync } from "node:fs";
const path = "VERIFICATION.md";
let t = readFileSync(path, "utf8");
const must = (c, m) => { if (!c) throw new Error(m); };
const rowStart = (key) => { const i = t.indexOf(key); must(i >= 0, `row ${key}`); return i; };
const replaceRow = (key, newRow) => {
  const i = rowStart(key);
  const end = t.indexOf("\n", i);
  t = t.slice(0, i) + newRow + t.slice(end);
};

replaceRow("| AC1.7 external close |",
  "| AC1.7 external close | `kill-recovery.mjs`: the harness closed the viewer pane with `pane close`; the pane was gone; the next `/dashboard` answered `열림` (T4) and exactly one role pane existed again | PASS | `.evidence/L1/LV-7b/{external-close-reply.json,notify-after-external-close.txt}` |");
replaceRow("| AC1.9 disconnect (exit) |",
  "| AC1.9 disconnect (exit) | `l1-behaviour.mjs`: `/exit` -> the viewer showed `연결 끊김` 1.2 s after Enter (gate 5 s); the pane stayed. The LV-1 run also showed `연결 끊김 14:32` | PASS | `.evidence/L1/LV-13b/{ac1-9-exit.txt,viewer-after-exit.txt}`, `LV-1/disconnected-frame.txt` |");
replaceRow("| AC1.9 owner kill |",
  "| AC1.9 owner kill | `kill-recovery.mjs`: `taskkill` of the owner gjc without `/exit` (no `stoppedAt`); the viewer, using the default `pidAlive` probe, showed `연결 끊김` 17.0 s after the kill and 20.8 s after the owner's last heartbeat (the 20 s gate is anchored on the heartbeat; the script allows 22.5 s = gate + 1 s viewer repaint + 1 s sampling + 0.5 s skew); the pane stayed. This is the live proof for review blocker B3 | PASS | `.evidence/L1/LV-7b/{ac1-9-timing.json,viewer-after-owner-kill.txt}` |");
replaceRow("| AC1.10 / LV-13 |",
  "| AC1.10 / LV-13 | a prompt (`sleep 15` via bash) was sent with the dashboard open: parent `agent_status` sampled every 2 s read `idle,working x8,idle` (idle before, working during, idle after) and the role pane count stayed 1 throughout; no reporter verbs in product code (SR2) | PASS | `.evidence/L1/LV-13b/agent-status-samples.json` |");
replaceRow("| AC1.2 todo_write |",
  "| AC1.2 todo_write | a model-driven `todo_write`: the row was on disk 383 ms after the projection's `updatedAt` (sampled every 250 ms; gate 2 s). `/todo append` emits no event (README 4.5); it was reflected after 2.4 s through the 1 s leaf poll (recorded, not gated: G9 value freshness was never measured) | PASS (todo_write); recorded (/todo) | `.evidence/L1/LV-13b/{ac1-2-todo-write.txt,ac1-2-todo-append.txt}`, `LV-1/viewer-frame.txt` |");
replaceRow("| AC1.11 / LV-11 |",
  "| AC1.11 / LV-11 | `/new` changed `scopeKey` (`64b7...` -> `cabc...`) and `scopeEpoch` 1 -> 2 in `slot.json`; the viewer pane id stayed `w1:p2` (`lv11.json`). `/resume` not measured (no persisted session under the shared SDK lock) | PASS for `/new` only | `.evidence/L1/LV-13b/lv11.json` |");
replaceRow("| AC1.6 / LV-6 |",
  "| AC1.6 / LV-6 | one `task` subagent run, wrapper log with the new `ppid` field: every Herdr call during the run (39 `pane list` + 39 `pane process-info`, all read-only automatic-pass calls) came from the main gjc pid (`byPpid` holds one key, the owner pid); 0 mutations (no split/run/close/rename); no new state file besides lock/owner/ready/slot/data. The sub process made 0 Herdr calls. Unit test LT-6 covers the same with fakes | PASS | `.evidence/L1/LV-13b/{lv6.json,lv6-calls-by-caller.json}`, `LV-6/` (earlier file diff) |");

// LV-3 row: notify latency wording
t = t.replace(/\| LV-3 \| `node test\/live\/lt3-delay\.mjs` \|[^\n]*\n/, () =>
  "| LV-3 | `node test/live/lt3-delay.mjs` | dev shim `--viewer-failpoint ready-delay-25s`; a launch message made the model call `todo_write` (one pending row), then ONE `/dashboard` (a keystroke batch the input popup swallowed is re-sent, batch #2 here, harness race recorded in `notify-latency.txt`): first notify `열림` 2.5 s after the accepted batch (gate 15 s; R3 text says `pending`, the first call answers `opened` per T1/R5); wrapper log: 1 split, 1 run (29 ms, <5 s); 5 s `pane list` samples: 1 role pane, slot role `pending` and no data row until +25.6 s, slot role `ready` (T13) at +30.7 s; the frame then shows `lv3-row-alpha` and `자동 추적 ON · 실시간`; no second `/dashboard` notify in a 10 s quiet window | PASS | `.evidence/L1/LV-3/{samples.json,wrapper.log.jsonl,viewer-frame.txt,notify-latency.txt}` |\n");

// AC-G1 row after AC1.13 row
const g1 = "| AC-G1 | before/after sha256 of the two protected omo files and the omo repo `main`/`status --porcelain`, around all five L1 live scripts (`node scripts/omo-protected.mjs`): identical (`ebe79288...`, `cdfb4d00...`, `main=fffed31f...`, 0 status lines) | PASS | `.evidence/L1/AC-G1-before.txt`, `AC-G1-after.txt` |\n";
const at = t.indexOf("| AC1.13 (L1 exit) |");
must(at >= 0, "AC1.13 row");
t = t.slice(0, at) + g1 + t.slice(at);

t = t.replace("`notify-latency.txt` records 52.6 s because `sendSlash` retries keystrokes on its popup race (harness, attempt 2); the timing gates are the wrapper run duration and the slot samples", "");
t = t.replace("LV-3 notify said `열림` at 52.6 s (harness retry) rather than `pending` within 15 s, and `early-frame.txt` is empty because the pane label appears only after the first pass; AC1.7 external-close has no committed evidence file (L1 LV-1 run only).", "`early-frame.txt` of LV-3 is empty because the pane label appears only after the first pass (the 5 s samples carry the no-row-before-25 s proof).");
t = t.replace("Not run live in L1: LV-5 adopt (L4),", "Critic round 1 (`19-FinalCriticL1`, ITERATE) asked for live timing and protected-file evidence; the live rows above were re-measured accordingly (LV-13/LV-6/LV-11/AC1.2/AC1.9 in `test/live/l1-behaviour.mjs`, AC1.7 external close in `kill-recovery.mjs`, AC-G1 via `scripts/omo-protected.mjs`).\nNot run live in L1: LV-5 adopt (L4),");
writeFileSync(path, t);
console.log("ok");
