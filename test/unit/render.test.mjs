// Frame renderer tests for the Todo viewer.
//
// Adapted from omo-herdr-dashboard @4082c750 `packages/todo/test/render.test.mjs`.
// Kept as behaviour: grapheme width, truncation and wrapping; bounded frames over
// a layout matrix; fold/unfold of closed phases; narrow 34/52 column layouts;
// hostile terminal control sequences; footer content. Dropped with the features
// they covered: the `ask` panel and its own scroll, the strike-reveal animation,
// the `native-todo` projection and the reference click ranges of the omo band.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { clean, fit, width, wrap } from "../../src/viewers/common.mjs";
import { counts, isClosedPhase, marks, renderFrame, taskKeys } from "../../src/viewers/todo/render.mjs";

// Independent cell oracle for the ASCII/Hangul fixtures, not renderer.width.
const cells = (line) => Array.from(stripVTControlCharacters(line))
  .reduce((total, point) => total + (/[\u1100-\u115f\uac00-\ud7a3]/u.test(point) ? 2 : 1), 0);

const projection = (phases, extra = {}) => ({ schema: "gjc-herdr-dashboard/todo/1", updatedAt: 1,
  phases, empty: phases.every((phase) => phase.tasks.length === 0), sourceError: null, ...extra });

const mixed = () => projection([
  { name: "Foundation", tasks: [{ content: "Confirmed authority", status: "completed" },
    { content: "Retired alternative", status: "abandoned" }] },
  { name: "Implementation", tasks: [
    { content: "현재진행중인작업을읽기쉽게보여줍니다".repeat(3), status: "in_progress" },
    { content: "Concurrent current work", status: "in_progress" },
    { content: "Verify source", status: "pending" }] },
  { name: "Empty shell", tasks: [] },
]);

test("grapheme width, truncation and wrapping retain independently expected cells", () => {
  assert.equal(width("한글A"), 5);
  assert.equal(width("e\u0301"), 1);
  assert.equal(width("\u0301"), 0);
  assert.equal(width("\ud83c\uddf0\ud83c\uddf7"), 2);
  assert.equal(width("\ud83d\udc69\u200d\ud83d\udcbb"), 2);
  assert.equal(fit("한글A", 4), "한~");
  assert.equal(fit("한글A", 4, true), "한~ ");
  assert.deepEqual(wrap("가나다라마바사", 6), ["가나다", "라마바", "사"]);
  assert.deepEqual(wrap("e\u0301e\u0301e\u0301", 2), ["e\u0301e\u0301", "e\u0301"]);
  assert.deepEqual(wrap("한글", 1), ["?", "?"]);
});

test("counts and closed-phase classification follow the shared status vocabulary", () => {
  // Given the four statuses the shared contract allows plus an unknown one.
  const tasks = [{ status: "completed" }, { status: "abandoned" }, { status: "in_progress" },
    { status: "pending" }];
  // Then only completed and abandoned count as closed, and the two are counted apart.
  assert.deepEqual(counts(tasks), { total: 4, closed: 2, completed: 1, dropped: 1 });
  assert.equal(isClosedPhase({ tasks: [{ status: "completed" }, { status: "abandoned" }] }), true);
  assert.equal(isClosedPhase({ tasks: [] }), false);
  assert.equal(isClosedPhase({ tasks: [{ status: "pending" }] }), false);
  assert.equal(marks.abandoned, "[×]");
});

for (const [columns, rows] of [[80, 24], [52, 23], [40, 16], [34, 18], [24, 8], [12, 4], [1, 1]]) {
  test(`${columns}x${rows}: a bounded frame whose footer survives`, () => {
    const frame = renderFrame(mixed(), { columns, rows, color: false, language: "ko" });
    assert.equal(frame.lines.length, rows);
    // The footer is the last row in every layout and always carries both required
    // tokens (AC-F1/F3 is a content assertion). From the 24-column width upward it
    // also fits untruncated; below that it is the only row allowed to overflow.
    const footer = stripVTControlCharacters(frame.lines.at(-1));
    assert.match(footer, /Follow ON/);
    assert.match(footer, /LIVE/);
    if (columns >= 24) assert.ok(frame.footerFits, `footer fits at ${columns}`);
    for (const line of frame.lines.slice(0, -1)) assert.ok(cells(line) <= columns, JSON.stringify(line));
    assert.doesNotMatch(frame.text, /j\/k|a\/z|c q|q 닫기|^f /m);
  });
}

test("phase shells, fold ranges and every status stay reachable by body scroll", () => {
  const snapshot = mixed();
  const full = renderFrame(snapshot, { columns: 40, rows: 16, color: false, expanded: true });
  assert.equal(Object.keys(full.phaseRanges).length, 3);
  assert.equal(Object.keys(full.taskRanges).length, 5);
  assert.equal(Object.values(full.taskRanges).filter((range) => range.status === "in_progress").length, 2);
  assert.equal(full.bodyLines.filter((line) => line.includes("[•]")).length, 2);
  assert.equal(full.selectableKeys.length, 5);
  assert.deepEqual(full.selectableKeys, taskKeys(snapshot));
  for (const [, phase] of snapshot.phases.entries()) {
    const range = Object.values(full.phaseRanges).find((value) => full.bodyLines[value.start].includes(phase.name));
    assert.ok(range, `phase ${phase.name} has a body row`);
    const frame = renderFrame(snapshot, { columns: 40, rows: 16, scroll: range.start,
      color: false, expanded: true });
    assert.ok(frame.lines.some((line) => line.includes(phase.name)));
  }
  const shell = renderFrame(projection([{ name: "Empty", tasks: [] }]), { columns: 40, rows: 16, color: false, language: "en" });
  assert.match(shell.text, /Empty 0\/0/);
  assert.match(shell.text, /\(empty phase\)/);
});

test("a fully closed phase folds away entirely until 'c' expands it", () => {
  const snapshot = projection([{ name: "Closed", tasks: [
    { content: "DONE_HIDE", status: "completed" }, { content: "DROP_HIDE", status: "abandoned" }] },
  { name: "Empty", tasks: [] },
  { name: "Open", tasks: [{ content: "LIVE_KEEP", status: "in_progress" }] }]);
  const original = structuredClone(snapshot);
  const folded = renderFrame(snapshot, { columns: 80, rows: 40, color: false, language: "en" });
  const expanded = renderFrame(snapshot, { columns: 80, rows: 40, color: false, language: "en", expanded: true });
  // Auto-collapsed: the closed phase contributes no body row at all, and its counts
  // survive only in the header, which is what keeps the frame truthful.
  assert.doesNotMatch(folded.text, /DONE_HIDE|DROP_HIDE|Closed/);
  assert.match(folded.text, /Todo \[2\/3\]  done:1 · drop:1/);
  assert.equal(Object.keys(folded.phaseRanges).length, 2);
  assert.match(expanded.text, /DONE_HIDE/);
  assert.match(expanded.text, /DROP_HIDE/);
  assert.match(expanded.text, /Closed 2\/2 drop:1/);
  assert.match(expanded.text, /Empty 0\/0/);
  assert.equal(Object.keys(expanded.phaseRanges).length, 3);
  assert.ok(expanded.bodyLines.length > folded.bodyLines.length);
  // The renderer never mutates its input.
  assert.deepEqual(snapshot, original);
});

test("a phase that still holds pending work is never hidden; only closed phases fold away", () => {
  const snapshot = projection([{ name: "Waiting", tasks: [{ content: "QUEUED_VISIBLE", status: "pending" }] },
    { name: "Running", tasks: [{ content: "ACTIVE_KEEP", status: "in_progress" }] },
    { name: "Finished", tasks: [{ content: "DONE_HIDDEN", status: "completed" }] }]);
  const folded = renderFrame(snapshot, { columns: 60, rows: 20, color: false });
  // Pending work is the whole point of a todo list: it is listed without pressing 'c'.
  assert.match(folded.text, /QUEUED_VISIBLE/);
  assert.match(folded.text, /ACTIVE_KEEP/);
  assert.match(folded.text, /Waiting 0\/1/);
  // A fully closed phase is the only thing that starts folded, and 'c' reveals it.
  assert.doesNotMatch(folded.text, /DONE_HIDDEN/);
  const expanded = renderFrame(snapshot, { columns: 60, rows: 20, color: false, expanded: true });
  assert.match(expanded.text, /DONE_HIDDEN/);
  assert.ok(expanded.bodyLines.length > folded.bodyLines.length);
});

test("waiting, empty, disconnected and source error have distinct labels", () => {
  const waiting = renderFrame(null, { color: false, language: "ko" });
  const empty = renderFrame(projection([], { empty: true }), { color: false, language: "ko" });
  const disconnected = renderFrame(mixed(), { color: false, language: "ko",
    connection: { kind: "disconnected", at: new Date(2026, 0, 1, 9, 5).getTime() } });
  const failed = renderFrame(mixed(), { color: false, language: "ko",
    connection: { kind: "source-error" } });
  const labels = [waiting, empty, disconnected, failed].map((frame) =>
    stripVTControlCharacters(frame.lines.at(-1)).split(" · ").at(-1));
  assert.equal(new Set(labels).size, 4, labels.join(" | "));
  assert.match(labels[0], /WAITING/);
  assert.match(labels[1], /EMPTY/);
  assert.match(labels[2], /OFFLINE 09:05/);
  assert.match(labels[3], /SOURCE ERROR/);
});

test("a read error is pinned above the footer and still leaves the footer intact", () => {
  const frame = renderFrame(mixed(), { columns: 34, rows: 18, color: false, language: "ko",
    connection: { kind: "source-error" }, notices: [] ,
    selection: taskKeys(mixed())[0] });
  const plain = stripVTControlCharacters(frame.text);
  assert.match(plain, /LIVE|SOURCE ERROR/);
  assert.equal(frame.lines.length, 18);
  for (const line of frame.lines) assert.ok(cells(line) <= 34);
});

test("terminal control sequences in task content cannot clear, retitle or recolor the frame", () => {
  const hostile = "safe\x1b[2J\x1b]0;foreign\x07\x1b[31m text\x1b[0m\x00\x08\u202e";
  assert.equal(clean(hostile), "safe text");
  const snapshot = projection([{ name: hostile,
    tasks: [{ content: hostile, status: "in_progress" }] }]);
  const frame = renderFrame(snapshot, { color: false, language: "ko" });
  assert.doesNotMatch(frame.text, /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202e]/u);
  assert.doesNotMatch(frame.text, /foreign/);
  assert.match(frame.text, /safe text/);
});

test("the selection resolves against the requested key without drawing a marker column", () => {
  const snapshot = mixed();
  const keys = taskKeys(snapshot);
  const explicit = renderFrame(snapshot, { columns: 60, rows: 20, color: false, expanded: true,
    selection: keys[4] });
  const plain = stripVTControlCharacters(explicit.text);
  // G12: the task row starts at column 0 with its mark, and no row carries a marker.
  assert.match(plain, /^\[ \] Verify source$/m);
  assert.doesNotMatch(plain, /^>/m);
  assert.equal(explicit.selection, keys[4]);
  assert.equal(explicit.selectionIndex, 4);
  // The first task row starts with its mark; wrapped continuation rows are the only
  // body rows that begin with spaces, and nothing begins with the old marker.
  assert.ok(explicit.bodyLines.some((line) => stripVTControlCharacters(line).startsWith("[•] ")));
  assert.doesNotMatch(plain, /^> /m);
  // No selection requested: the first in-progress task is the resolved selection.
  const inferred = renderFrame(snapshot, { columns: 60, rows: 20, color: false, expanded: true });
  assert.equal(inferred.selection, keys[2]);
  assert.equal(inferred.selectionIndex, 2);
  // A stale key from another scope never wins, and never leaves nothing selected.
  const stale = renderFrame(snapshot, { columns: 60, rows: 20, color: false, expanded: true,
    selection: "[\"gone\"]" });
  assert.equal(stale.selection, keys[2]);
  assert.equal(stale.selectionIndex, 2);
  assert.doesNotMatch(stripVTControlCharacters(stale.text), /^>/m);
});

test("truncation shortens a task row before it can touch the footer", () => {
  const long = projection([{ name: "N", tasks: [
    { content: "긴내용".repeat(40), status: "in_progress" }] }]);
  for (const columns of [34, 52]) {
    const frame = renderFrame(long, { columns, rows: 20, color: false, language: "ko", follow: false });
    const footer = stripVTControlCharacters(frame.lines.at(-1));
    assert.match(footer, /Follow OFF/);
    assert.match(footer, /LIVE/);
    assert.ok(cells(footer) <= columns);
    // A long body row wraps instead of being cut, and no wrapped row may overflow.
    const rows = frame.bodyLines.filter((line) => line.includes("긴내용"));
    assert.ok(rows.length > 1, "a long row wraps across several body rows");
    for (const line of rows) assert.ok(cells(line) <= columns, JSON.stringify(line));
    const last = rows.at(-1);
    assert.ok(cells(last) < columns, "the final wrapped row is a partial line");
  }
});

test("the footer carries follow and connection but no keyboard legend in every language", () => {
  for (const [language, followOn, followOff, live] of [["ko", "Follow ON", "Follow OFF", "LIVE"],
    ["en", "Follow ON", "Follow OFF", "LIVE"], ["zh-cn", "自动跟随 ON", "自动跟随 OFF", "实时"]]) {
    for (const columns of [34, 52]) {
      for (const follow of [true, false]) {
        const frame = renderFrame(mixed(), { columns, rows: 20, color: false, language, follow });
        const footer = stripVTControlCharacters(frame.lines.at(-1));
        assert.match(footer, new RegExp(follow ? followOn : followOff), `${language} ${columns} follow=${follow}`);
        assert.match(footer, new RegExp(live), `${language} ${columns} live token`);
        assert.doesNotMatch(footer, /j\/k|q 닫기|a\/z|Tab|Space/);
      }
    }
  }
});

// OMO packages/todo/src/render.mjs:202 at 3242ad4 paints the header name with
// warning for last-known/disconnected and error for a source error, and accent otherwise.
test("the Todo header name mirrors OMO's state colours: cyan, yellow offline, red source error", () => {
  const input = projection([{ name: "Build", tasks: [{ content: "work", status: "in_progress" }] }]);
  const waiting = renderFrame(null, { columns: 80, rows: 14, color: true, language: "en" });
  const live = renderFrame(input, { columns: 80, rows: 14, color: true, language: "en" });
  const empty = renderFrame(projection([], { empty: true }), { columns: 80, rows: 14, color: true, language: "en" });
  const offline = renderFrame(input, { columns: 80, rows: 14, color: true, language: "en",
    connection: { kind: "disconnected", at: 0 } });
  const failed = renderFrame({ ...input, sourceError: "todo_write failed" },
    { columns: 80, rows: 14, color: true, language: "en" });
  for (const frame of [waiting, live, empty]) assert.ok(frame.lines[0].includes("\x1b[1;36mTodo"), "accent cyan");
  assert.ok(offline.lines[0].includes("\x1b[1;33mTodo"), "disconnected is warning yellow");
  assert.ok(failed.lines[0].includes("\x1b[1;31mTodo"), "source error is error red");
  assert.equal(failed.lines[0].includes("\x1b[1;33mTodo"), false, "source error is not warning yellow");
});

// Short panes: present optional rows (goal, error, header divider) fill the room
// above the body in priority order. An absent row must not reserve a slot, and a
// present row that fits must never be dropped. The footer and the bottom divider
// are never dropped (AC-F1).
const shortProjection = () => projection([{ name: "Build", tasks: [
  { content: "align the todo pane with omo", status: "in_progress" }] }]);
const shortGoal = { objective: "align the todo pane with omo", status: "active",
  tokensUsed: 12_000, timeUsedSeconds: 303 };
const shortCases = [
  { name: "none", options: {}, sourceError: null },
  { name: "goal", options: { goal: shortGoal }, sourceError: null },
  { name: "error", options: {}, sourceError: "todo_write failed" },
  { name: "both", options: { goal: shortGoal }, sourceError: "todo_write failed" },
];
for (const entry of shortCases) {
  for (const rows of [4, 5, 6, 7, 8]) {
    test(`short pane ${rows} rows, ${entry.name}: present optional rows fit exactly`, () => {
      const input = { ...shortProjection(), sourceError: entry.sourceError };
      const frame = renderFrame(input, { columns: 34, rows, color: false, language: "en", ...entry.options });
      const lines = frame.lines.map(stripVTControlCharacters);
      assert.equal(lines.length, rows);
      // The footer and the bottom divider are unconditional.
      assert.match(lines.at(-1), /^ Follow ON · (LIVE|SOURCE ERROR)$/);
      assert.match(lines.at(-2), /^─+$/);
      const present = [entry.options.goal ? "goal" : null, entry.sourceError ? "error" : null, "divider"]
        .filter(Boolean);
      const kept = present.slice(0, rows - 3);
      // Top rows are drawn header, divider, goal, error regardless of priority.
      const expectedTop = ["header"];
      if (kept.includes("divider")) expectedTop.push("divider");
      if (kept.includes("goal")) expectedTop.push("goal");
      if (kept.includes("error")) expectedTop.push("error");
      const top = lines.slice(0, frame.bodyStart);
      assert.equal(top.length, expectedTop.length, JSON.stringify(top));
      assert.match(top[0], /^ Todo \[0\/1\]/);
      for (const [index, kind] of expectedTop.slice(1).entries()) {
        const row = top[index + 1];
        if (kind === "divider") assert.match(row, /^─+$/, `rows=${rows} ${entry.name}: divider kept`);
        if (kind === "goal") assert.match(row, /^ ◎ /, `rows=${rows} ${entry.name}: goal kept`);
        if (kind === "error") assert.match(row, /^Read error: todo_write failed$/, `rows=${rows} ${entry.name}: error kept`);
      }
      // An absent optional row leaves no gap and is not drawn at all.
      assert.equal(top.some((line) => /^ ◎ /.test(line)), kept.includes("goal"));
      assert.equal(top.some((line) => /^Read error: todo_write failed$/.test(line)), kept.includes("error"));
      assert.equal(frame.bodyRows, Math.max(0, rows - 3 - kept.length));
      // Required short-pane counterexamples.
      if (entry.name === "error" && rows === 4) {
        assert.ok(top.includes("Read error: todo_write failed"), "error-only rows=4 keeps the error row");
      }
      if (entry.name === "none" && rows <= 5) assert.match(top[1], /^─+$/, "the header divider fits");
      if (entry.name === "goal" && rows === 5) assert.match(top[1], /^─+$/, "goal-only rows=5 keeps the divider");
      if (entry.name === "both" && rows === 5) {
        assert.equal(top.some((line) => /^─+$/.test(line)), false, "both rows=5 drops only the divider");
        assert.ok(top.some((line) => /^ ◎ /.test(line)));
        assert.ok(top.some((line) => /^Read error: todo_write failed$/.test(line)));
      }
    });
  }
}
