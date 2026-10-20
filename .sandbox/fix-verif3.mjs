import { readFileSync, writeFileSync } from "node:fs";
const path = "VERIFICATION.md";
let t = readFileSync(path, "utf8");
const replaceRow = (key, row) => {
  const i = t.indexOf(key);
  if (i < 0) throw new Error("row " + key);
  t = t.slice(0, i) + row + t.slice(t.indexOf("\n", i));
};
replaceRow("| AC1.2 todo_write |",
  "| AC1.2 todo_write | a model-driven `todo_write`: `projection.updatedAt` (host clock right after the tool finished) -> row on disk 215 ms -> row visible on the viewer screen (pane read) 515 ms; gate 2 s on the screen span; sampling 250 ms. `/todo append` emits no event (README 4.5); it was reflected after ~2.4 s through the 1 s leaf poll (recorded, not gated: G9 value freshness was never measured) | PASS (todo_write); recorded (/todo) | `.evidence/L1/LV-13b/{ac1-2-todo-write.txt,ac1-2-todo-append.txt}` |");
replaceRow("| AC1.9 disconnect (exit) |",
  "| AC1.9 disconnect (exit) | `l1-behaviour.mjs`: `/exit` -> the viewer showed `연결 끊김` 0.9 s after Enter, asserted <= 5 s; the pane stayed | PASS | `.evidence/L1/LV-13b/{ac1-9-exit.txt,viewer-after-exit.txt}` |");
replaceRow("| AC1.9 owner kill |",
  "| AC1.9 owner kill | `kill-recovery.mjs`: `taskkill` of the owner gjc without `/exit` (no `stoppedAt`); the viewer (default `pidAlive` probe) showed `연결 끊김` 6.5 s after the kill, asserted <= 20 s measured from the kill (plan AC1.9). Product rule: a dead owner pid + heartbeat >= 10 s old (two missed 5 s beats) => disconnected (changed from 20 s after the first live run measured 20.2 s, which was inside no margin); a live pid is never disconnected by heartbeat age alone | PASS | `.evidence/L1/LV-7b/{ac1-9-timing.json,viewer-after-owner-kill.txt}` |");
replaceRow("| AC1.6 / LV-6 |",
  "| AC1.6 / LV-6 | one `task` subagent run: 0 Herdr mutations (no split/run/close/rename) in the wrapper log, 0 new state files besides lock/owner/ready/slot/data. Every Herdr call in the window (read-only `pane list` / `pane process-info` from the automatic pass) carries the main gjc pid (`ppid`). A GJC subagent runs inside that same process, so the live log cannot attribute calls to the sub session; that attribution (sub session makes 0 calls, no `/dashboard` effect) is proven by unit test LT-6 with fakes and by the sub-session gating code, not by this live row | PASS (mutations/files live; per-session attribution by LT-6 only) | `.evidence/L1/LV-13b/{lv6.json,lv6-calls-by-caller.json}` |");
t = t.replace("1 split, 1 run (29 ms, <5 s)", "1 split, 1 run (49 ms and 53 ms, <5 s)");
writeFileSync(path, t);
console.log("ok");
