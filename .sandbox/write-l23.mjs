import { appendFileSync, readFileSync } from "node:fs";
const tests = readFileSync(".evidence/L2/test-report.txt", "utf8").match(/ℹ tests (\d+)/)?.[1] ?? "?";
const section = `

## L2 (Workers pane and the two-role band)

Unit: \`node scripts/test.mjs\` ${tests} tests, 0 fail (report \`.evidence/L2/test-report.txt\`). New modules: \`src/host/sources/workers.mjs\`, \`src/core/layout.mjs\`, \`src/viewers/workers/{render,viewer}.mjs\`; changed: \`launch.mjs\` (anchor, direction, ratio), \`reconciler.mjs\` (two-role loop, planner, shape check), \`instance.mjs\` (ROLES, bus wiring, per-role tick). L1 tests changed because the band opens two panes: AC1.4 (2 splits then 0), AC1.2 (two projections per publish), LT-5 (foreign sibling now \`partial:shape\`, was \`opened\`).

| Item | What was run and observed | Verdict | Evidence |
|---|---|---|---|
| AC2.1 band | \`l2-workers.mjs\`: first \`/dashboard\` -> notify \`Todo 열림 · Workers 열림\`; \`pane layout\`: parent 60x40 at x=0, Todo 60x14 at (60,0), Workers 60x26 at (60,14); Todo holds 0.35 of the rows; floors hold; focus stays on the parent; \`/dashboard\` x3 leaves one Todo and one Workers pane (AC1.4) | PASS | \`.evidence/L2/LV-7/{layout.json,list-after-open.json,notify-open-*.txt}\` |
| AC2.2 parallel | two parallel \`task\` subagents (sleep 12): the Workers frame showed both cards \`실행 중\` at the same time (not marked background), then both \`완료\`, auto-folded to one line; \`c\` expands them; failed/aborted have different glyphs and words (render and \`l2-width.mjs\` fixture) | PASS | \`.evidence/L2/LV-7/{workers-frame-running,workers-frame-done,workers-frame-c}.txt\`, \`.evidence/L2/LV-7w/\` |
| AC2.3 cost | host cost is 0 for this subscription model (K1); cards carry \`cost: null\`, the frame prints \`비용 ?\` | PASS | \`workers.json.snapshot.json\`, \`workers-frame-c.txt\` |
| AC2.5 assignment | the sentinel \`SENTINEL-ASSIGNMENT-7c1\` was in both assignments; it is in no Workers frame and in no file of the state tree | PASS | \`LV-7/workers-frame-done.txt\` and the file scan in \`l2-workers.mjs\` |
| AC2.6 background | a \`task\` run in the background showed as a card (\`lvwbg 실행 중\`, tool \`bash\`); depth > 1 is not shown (README limitation) | PASS | \`LV-7/workers-frame-background.txt\` |
| AC2.7 bus fault | unit only: a throwing bus handler -> \`sourceError\`, no throw into the host, Todo and \`/dashboard\` unaffected | PASS (unit) | \`test/unit/band-pass.test.mjs\` |
| AC2.8 foreign sibling | unit only (fake Herdr): \`partial:shape\`, foreign pane byte-identical, no mutation aimed at it. Not run live | PASS (unit) | \`test/unit/band-pass.test.mjs\`, \`reconciler.test.mjs\` LT-5 |
| AC-F4 width | the real Workers viewer process with \`--width 24\` and \`--width 40\` in Herdr panes (\`l2-width.mjs\`): all three card title lines and every status word (Running/Failed/Aborted) visible; at 24 columns titles are cut with \`~\` and the status stays; no line is wider than the width. The width is the viewer's own override, because the harness PTY does not follow the pane rect (see the L3 limit) | PASS | \`.evidence/L2/LV-7w/{workers-24col,workers-40col}.txt\` |
| Bus-fed cards are not background | live LV-7 first marked every card \`[백그라운드]\` because ctx.getJobs() lists the same runs; the bus now names the card and clears the job-only flag; unit test pinned | fixed | \`workers-source.test.mjs\` |
| L1 live scripts under the band | lt1-fault, lt3-delay (2 splits, 2 runs, each < 5 s), l4-lock (<= 2 splits, <= 1 pane per role), kill-recovery, l1-behaviour all PASS again | PASS | \`.sandbox/run-*.txt\` outputs of the final run |
| AC-G1 | protected omo files and the omo repo ref/status identical before/after the L2+L3 live run | PASS | \`.evidence/L2/AC-G1-{before,after}.txt\` |

## L3 (pointer and focus)

Unit: viewers route stdin through \`terminalInput\` (SGR pointer, DEC 1004 focus) and subscribe with \`watchHerdrFocus\`; \`test/unit/pointer-todo.test.mjs\` and \`pointer-workers.test.mjs\` cover wheel +-3 with clamping, click select (Workers: second click folds), drag, release, blur (follow ON, detail closed, drag ended), subscription failure (one notice, viewer keeps working), dispose, fragmented reports, and that mouse bytes no longer reach \`key()\`.

LV-8 (\`node test/live/l3-pointer.mjs\`, 19 observations, SGR reports sent with \`pane send-text\` only to the adopted role pane):

| Role | Observation | Verdict |
|---|---|---|
| Todo | follow starts ON; two wheel-down steps move the body by 6 lines and turn follow OFF; wheel up moves 3 back, stays OFF; the Workers pane's follow is untouched; moving focus to another pane and back returns follow ON (AC3.2); click turns follow OFF; drag keeps follow OFF and changes the visible body; a pane resize leaves the viewer alive and redrawing | PASS |
| Workers | follow starts ON; wheel down turns follow OFF; wheel up keeps it OFF; the Todo pane's follow is untouched; blur returns follow ON; click and drag turn follow OFF; resize leaves the viewer alive | PASS |

Evidence: \`.evidence/L3/LV-8/{observations.json,todo-*.txt,workers-*.txt,pty-size.txt}\`.

**Harness limit (measured, recorded honestly).** The harness Herdr server is detached with no client attached; every pane PTY stays at the terminal size (120x40) after splits and resizes (\`pane get\` \`viewport_rows\` 40 for a 14-row pane rect; a node process reads \`process.stdout\` as 120x40 at all times). Consequences: (1) the Todo body overflows the PTY (60 rows), so wheel distance and drag scrolling were observed on Todo; the Workers body fits the PTY, so Workers wheel/drag distance is only unit-tested, and live it checks the follow flag; (2) the viewer's redraw-on-resize cannot be triggered by a pane resize here (unit-tested); (3) AC-F4 widths use the viewer's \`--width\`. In a user's attached Herdr window the PTY follows the pane, so these paths are exercised there. AC3.3 (subscription failure) is unit-tested; live the real subscription was established without a failure notice.

## G003 gaps carried forward
Not measured live: AC2.8 and AC2.7 (unit only), depth > 1 workers, \`/resume\` and reload with two roles (L4), Workers wheel distance and resize redraw in an attached window (harness limit above), cross-process lock with two roles (L4), user-scope install (L6).
`;
appendFileSync("VERIFICATION.md", section);
console.log("appended");
