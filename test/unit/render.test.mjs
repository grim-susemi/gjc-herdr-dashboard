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
import { counts, isClosedPhase, marks, phaseRomanNumeral, renderFrame, taskKeys }
  from "../../src/viewers/todo/render.mjs";

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
  assert.equal(marks.pending, "☐");
  assert.equal(marks.in_progress, "☐");
  assert.equal(marks.completed, "☑");
  assert.equal(marks.abandoned, "☐");
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
  assert.equal(full.bodyLines.filter((line) => /^── (I|II|III)\. /.test(stripVTControlCharacters(line))).length, 3,
    "each drawn phase starts with its divider row");
  assert.equal(full.bodyLines.filter((line) => /^[├└]─ [☐☑] /.test(stripVTControlCharacters(line))).length, 5,
    "every task row starts with a branch glyph");
  assert.equal(full.bodyLines.filter((line) => /^└─ [☐☑] /.test(stripVTControlCharacters(line))).length, 2,
    "the last task of a phase closes the branch with └─");
  assert.equal(full.selectableKeys.length, 5);
  assert.deepEqual(full.selectableKeys, taskKeys(snapshot));
  for (const [, phase] of snapshot.phases.entries()) {
    const range = Object.values(full.phaseRanges).find((value) => full.bodyLines[value.start].includes(phase.name));
    assert.ok(range, `phase ${phase.name} has a body row`);
    const frame = renderFrame(snapshot, { columns: 40, rows: 16, scroll: range.start,
      color: false, expanded: true, follow: false });
    assert.ok(frame.lines.some((line) => line.includes(phase.name)));
  }
  const shell = renderFrame(projection([{ name: "Empty", tasks: [] }]), { columns: 40, rows: 16, color: false, language: "en" });
  assert.match(shell.text, /── I\. Empty  0\/0/);
  assert.match(shell.text, /\(empty phase\)/);
});

test("a fully closed phase folds away entirely until 'c' expands it", () => {
  const snapshot = projection([{ name: "Closed", tasks: [
    { content: "DONE_HIDE", status: "completed" }, { content: "DROP_HIDE", status: "abandoned" }] },
  { name: "Empty", tasks: [] },
  { name: "Open", tasks: [{ content: "LIVE_KEEP", status: "in_progress" }] }]);
  const original = structuredClone(snapshot);
  const folded = renderFrame(snapshot, { columns: 80, rows: 40, color: false, language: "en" });
  // Follow OFF keeps every drawn phase in the window; follow ON pins the live phase to the top.
  const expanded = renderFrame(snapshot, { columns: 80, rows: 40, color: false, language: "en",
    expanded: true, follow: false });
  // Auto-collapsed: the closed phase contributes no body row at all, and its counts
  // survive only in the header, which is what keeps the frame truthful.
  assert.doesNotMatch(folded.text, /DONE_HIDE|DROP_HIDE|Closed/);
  assert.match(folded.text, /Todo \[2\/3\]  done:1 · drop:1/);
  assert.equal(Object.keys(folded.phaseRanges).length, 2);
  assert.match(expanded.text, /DONE_HIDE/);
  assert.match(expanded.text, /DROP_HIDE/);
  assert.match(expanded.text, /^── I\. Closed  2\/2 drop:1/m);
  assert.match(expanded.text, /^── II\. Empty  0\/0/m);
  assert.equal(Object.keys(expanded.phaseRanges).length, 3);
  assert.ok(expanded.bodyLines.length > folded.bodyLines.length);
  // The renderer never mutates its input.
  assert.deepEqual(snapshot, original);
});

test("a phase that still holds pending work is never hidden; only closed phases fold away", () => {
  const snapshot = projection([{ name: "Waiting", tasks: [{ content: "QUEUED_VISIBLE", status: "pending" }] },
    { name: "Running", tasks: [{ content: "ACTIVE_KEEP", status: "in_progress" }] },
    { name: "Finished", tasks: [{ content: "DONE_HIDDEN", status: "completed" }] }]);
  const folded = renderFrame(snapshot, { columns: 60, rows: 20, color: false, follow: false });
  // Pending work is the whole point of a todo list: it is listed without pressing 'c'.
  assert.match(folded.text, /QUEUED_VISIBLE/);
  assert.match(folded.text, /ACTIVE_KEEP/);
  assert.match(folded.text, /^── I\. Waiting  0\/1/m);
  // A fully closed phase is the only thing that starts folded, and 'c' reveals it.
  assert.doesNotMatch(folded.text, /DONE_HIDDEN/);
  // Follow ON pins the phase that holds the live task, so the pending phase above it is out of
  // view for that frame but still drawn, and follow OFF brings it back.
  const pinned = renderFrame(snapshot, { columns: 60, rows: 20, color: false });
  assert.doesNotMatch(pinned.text, /QUEUED_VISIBLE/);
  assert.match(pinned.text, /ACTIVE_KEEP/);
  const expanded = renderFrame(snapshot, { columns: 60, rows: 20, color: false, expanded: true,
    follow: false });
  assert.match(expanded.text, /DONE_HIDDEN/);
  assert.ok(expanded.bodyLines.length > folded.bodyLines.length);
  // With follow OFF the closed phase is drawn above the live one and the numerals stay put.
  const shown = renderFrame(snapshot, { columns: 60, rows: 20, color: false, expanded: true, follow: false });
  assert.match(shown.text, /^── I\. Waiting  0\/1/m);
  assert.match(shown.text, /^── III\. Finished  1\/1/m);
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
  // G12: the task row starts with its branch glyph, its checkbox and a space, and no row
  // carries a marker.
  assert.match(plain, /^└─ ☐ Verify source$/m);
  assert.doesNotMatch(plain, /^>/m);
  assert.equal(explicit.selection, keys[4]);
  assert.equal(explicit.selectionIndex, 4);
  // The first task row opens the branch; wrapped continuation rows are the only
  // body rows that start with a rail or blanks, and nothing starts with the old marker.
  assert.ok(explicit.bodyLines.some((line) => stripVTControlCharacters(line).startsWith("├─ ☐ ")));
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

// GJC's red-claw palette: claw accent live, warning amber offline, dangerRed source error.
test("the Todo header name takes the GJC red-claw connection ink: claw, amber offline, dangerRed source error", () => {
  const input = projection([{ name: "Build", tasks: [{ content: "work", status: "in_progress" }] }]);
  const waiting = renderFrame(null, { columns: 80, rows: 14, color: true, language: "en" });
  const live = renderFrame(input, { columns: 80, rows: 14, color: true, language: "en" });
  const empty = renderFrame(projection([], { empty: true }), { columns: 80, rows: 14, color: true, language: "en" });
  const offline = renderFrame(input, { columns: 80, rows: 14, color: true, language: "en",
    connection: { kind: "disconnected", at: 0 } });
  const failed = renderFrame({ ...input, sourceError: "todo_write failed" },
    { columns: 80, rows: 14, color: true, language: "en" });
  for (const frame of [waiting, live, empty]) {
    assert.ok(frame.lines[0].includes("\x1b[1;38;2;255;106;61mTodo"), "live/waiting/empty is bold claw");
  }
  assert.ok(offline.lines[0].includes("\x1b[1;38;2;245;184;75mTodo"), "disconnected is warning amber");
  assert.ok(failed.lines[0].includes("\x1b[1;38;2;255;77;94mTodo"), "source error is dangerRed");
  assert.equal(failed.lines[0].includes("\x1b[1;38;2;245;184;75mTodo"), false, "source error is not amber");
});

// GJC's own todo list numbers phases with ASCII roman numerals by their one-based
// position among ALL phases; the numeral is display-only state (no key carries it).
test("phaseRomanNumeral spells I..XII and nothing below one", () => {
  const expected = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
  assert.deepEqual(expected.map((unused, index) => phaseRomanNumeral(index + 1)), expected);
  assert.equal(phaseRomanNumeral(0), "");
  assert.equal(phaseRomanNumeral(-3), "");
});

test("phase numbering is stable when an earlier phase is folded closed", () => {
  const snapshot = projection([
    { name: "Closed", tasks: [{ content: "DONE", status: "completed" }] },
    { name: "Open", tasks: [{ content: "LIVE", status: "in_progress" }] },
    { name: "Later", tasks: [{ content: "QUEUED", status: "pending" }] }]);
  const folded = renderFrame(snapshot, { columns: 52, rows: 14, color: false, language: "en" });
  const expanded = renderFrame(snapshot, { columns: 52, rows: 14, color: false, language: "en",
    expanded: true, follow: false });
  // Folding removes rows but never renumbers: `Open` stays II and `Later` stays III.
  assert.match(folded.text, /^── II\. Open  0\/1/m);
  assert.match(folded.text, /^── III\. Later  0\/1/m);
  assert.doesNotMatch(folded.text, /I\. Closed/);
  assert.match(expanded.text, /^── I\. Closed  1\/1/m);
  assert.match(expanded.text, /^── II\. Open  0\/1/m);
  assert.match(expanded.text, /^── III\. Later  0\/1/m);
  // The selection keys are the phase name and occurrence, so they are numeral-free. A folded
  // phase drops its rows but the keys of the remaining tasks do not change.
  assert.deepEqual(taskKeys(snapshot), ["[\"Closed\",0,\"DONE\",0]",
    "[\"Open\",0,\"LIVE\",0]", "[\"Later\",0,\"QUEUED\",0]"].map((key) => key));
  assert.deepEqual(folded.selectableKeys, taskKeys(snapshot).slice(1));
  assert.deepEqual(expanded.selectableKeys, taskKeys(snapshot));
  for (const key of taskKeys(snapshot)) {
    assert.doesNotMatch(key, /\b(I|II|III|IV|V)\b/, "no numeral in a selection key");
  }
});

test("task rows build a tree: ├─ for a later task, └─ for the phase's last, │ on wrapped lines", () => {
  const content = "align the continuation rows under the task text so a long sentence still reads well";
  const snapshot = projection([{ name: "Build", tasks: [
    { content, status: "in_progress" }, { content: "second task", status: "pending" }] }]);
  const frame = renderFrame(snapshot, { columns: 34, rows: 24, color: false, language: "en" });
  const rows = frame.bodyLines.slice(1).map(stripVTControlCharacters);
  // The first task opens the branch; its continuation rows keep the rail (`│  ` plus blanks)
  // so the wrapped text starts in the same column as the first row's text.
  const textColumn = width("├─ ☐ ");
  assert.equal(textColumn, 6);
  assert.match(rows[0], /^├─ ☐ align the/);
  const continuation = rows.slice(1).filter((row) => !row.startsWith("└─ ☐ "));
  assert.ok(continuation.length >= 2, "the long task wraps onto continuation rows");
  for (const row of continuation) {
    assert.equal(row.slice(0, textColumn), `│${" ".repeat(textColumn - 1)}`, row);
  }
  // The last task of the phase closes the branch and blank continuation rows line up too.
  assert.match(rows.at(-1), /^└─ ☐ second task$/);
  assert.equal(rows.filter((row) => row.includes("├")).length, 1,
    "only a task with a later sibling opens the branch");
  assert.equal(rows.filter((row) => row.includes("└")).length, 1,
    "only the phase's last task closes the branch");
  // Every row still fits a 34-column pane.
  for (const line of frame.lines) assert.ok(width(line) <= 34, JSON.stringify(line));
});

test("GJC task ink: dim strike kelp done, dangerRed strike dropped, claw bold live, mutedShell pending", () => {
  const snapshot = projection([{ name: "Build", tasks: [
    { content: "done work", status: "completed" },
    { content: "dropped work", status: "abandoned" },
    { content: "live work", status: "in_progress" },
    { content: "queued work", status: "pending" }] }]);
  const frame = renderFrame(snapshot, { columns: 52, rows: 14, color: true, language: "en" });
  const row = (needle) => frame.bodyLines.find((line) => stripVTControlCharacters(line).includes(needle));
  // Completed work is dim and struck through in kelp; only completed and dropped rows are struck.
  assert.equal(row("done work"), "\x1b[2;9;38;2;110;231;183m├─ ☑ done work\x1b[0m");
  assert.equal(row("dropped work"), "\x1b[9;38;2;255;77;94m├─ ☐ dropped work\x1b[0m");
  assert.equal(row("live work"), "\x1b[1;38;2;255;106;61m├─ ☐ live work\x1b[0m");
  assert.equal(row("queued work"), "\x1b[38;2;185;143;134m└─ ☐ queued work\x1b[0m");
  // The phase row is a dimShell divider around a bold claw title for the live phase.
  assert.equal(frame.bodyLines[0], "\x1b[38;2;111;71;67m── \x1b[0m" +
    "\x1b[1;38;2;255;106;61mI. Build  2/4 drop:1\x1b[0m" +
    `\x1b[38;2;111;71;67m ${"─".repeat(27)}\x1b[0m`);
  // A closed phase title is mutedShell and not bold, and an open non-current phase is bold coral.
  const closed = renderFrame(projection([{ name: "Done", tasks: [{ content: "d", status: "completed" }] },
    { name: "Queued", tasks: [{ content: "q", status: "pending" }] }]),
  { columns: 52, rows: 14, color: true, language: "en", expanded: true, follow: false });
  assert.ok(closed.bodyLines[0].includes("\x1b[38;2;185;143;134mI. Done  1/1\x1b[0m"), closed.bodyLines[0]);
  assert.ok(closed.bodyLines[2].includes("\x1b[1;38;2;255;138;101mII. Queued  0/1\x1b[0m"), closed.bodyLines[2]);
  // With colour off the same rows are plain and carry no dim, strike or escape at all.
  const plain = renderFrame(snapshot, { columns: 52, rows: 14, color: false, language: "en" });
  assert.doesNotMatch(plain.text, /\x1b/, "color:false stays escape-free");
  assert.doesNotMatch(plain.text, /\u001b\[2;|\u001b\[9m|\u001b\[0m/);
  assert.match(plain.text, /^├─ ☑ done work$/m);
});

test("every wrapped physical row of a completed task carries dim, strike and a reset, selected or not", () => {
  const long = "ship the wrapped done work so every physical row keeps the dim strike ink";
  const snapshot = projection([
    { name: "Build", tasks: [
      { content: long, status: "completed" },
      { content: "dropped work", status: "abandoned" },
      { content: "live work", status: "in_progress" },
      { content: "queued work", status: "pending" }] },
    { name: "Finish", tasks: [
      { content: "last queued work", status: "pending" },
      { content: long, status: "completed" }] },
  ]);
  const keys = taskKeys(snapshot);
  const completedInk = /^\x1b\[2;9;38;2;110;231;183m[^\x1b]*\x1b\[0m$/;
  const rowsOf = (frame, key) => {
    const range = frame.taskRanges[key];
    assert.ok(range, `task range for ${key}`);
    return { range, lines: frame.bodyLines.slice(range.start, range.end) };
  };
  // The middle completed task is selected: its rail continuation rows are styled too.
  const selected = renderFrame(snapshot, { columns: 34, rows: 24, color: true, language: "en",
    expanded: true, selection: keys[0] });
  assert.equal(selected.selection, keys[0], "the completed task really is the selection");
  const middle = rowsOf(selected, keys[0]);
  assert.equal(middle.range.status, "completed");
  assert.ok(middle.lines.length >= 2, "the completed task wraps onto continuation rows");
  for (const [index, line] of middle.lines.entries()) {
    assert.match(line, completedInk, `completed row ${index} is dim, struck and reset`);
    assert.equal(stripVTControlCharacters(line).slice(0, 1), index === 0 ? "├" : "│",
      `row ${index} keeps the branch or rail prefix`);
  }
  // The last completed task of a phase blanks its continuation and is styled the same way.
  const last = rowsOf(selected, keys[keys.length - 1]);
  assert.equal(last.range.status, "completed");
  assert.ok(last.lines.length >= 2, "the last completed task wraps too");
  for (const [index, line] of last.lines.entries()) {
    assert.match(line, completedInk, `last completed row ${index} is dim, struck and reset`);
    assert.equal(stripVTControlCharacters(line).slice(0, 1), index === 0 ? "└" : " ",
      `last completed row ${index} keeps the tree or blank prefix`);
  }
  // Abandoned work stays exactly as before: struck dangerRed and not dim.
  const dropped = rowsOf(selected, keys[1]);
  assert.equal(dropped.lines[0], "\x1b[9;38;2;255;77;94m├─ ☐ dropped work\x1b[0m");
  // Neither neighbour gains dim or strike: exact in-progress and pending ink survives.
  const live = rowsOf(selected, keys[2]);
  assert.equal(live.lines[0], "\x1b[1;38;2;255;106;61m├─ ☐ live work\x1b[0m");
  const pending = rowsOf(selected, keys[3]);
  assert.equal(pending.lines[0], "\x1b[38;2;185;143;134m└─ ☐ queued work\x1b[0m");
  assert.doesNotMatch(live.lines[0], /\x1b\[2;|\x1b\[9;/);
  assert.doesNotMatch(pending.lines[0], /\x1b\[2;|\x1b\[9;/);
  // With colour off the same wrapped, selected fixture has no escapes at all.
  const plain = renderFrame(snapshot, { columns: 34, rows: 24, color: false, language: "en",
    expanded: true, selection: keys[0] });
  assert.equal(plain.selection, selected.selection);
  assert.doesNotMatch(plain.text, /\x1b/, "color:false text stays escape-free");
  for (const line of plain.bodyLines) assert.doesNotMatch(line, /\x1b/, "color:false body stays escape-free");
  assert.equal(plain.bodyLines.slice(middle.range.start, middle.range.end).join("\n"),
    middle.lines.map(stripVTControlCharacters).join("\n"), "colour only changes the escapes");
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

// Follow keeps the active task's phase title on screen. Without it a window that starts on the
// active task alone shows an anonymous row, and a title scrolled off the top is the symptom the
// owner reported (the group title was hidden for a moment).
const longPhases = (activePhase, activeTask) => projection(Array.from({ length: 5 }, (unused, p) => ({
  name: `Group${p}`,
  tasks: Array.from({ length: 6 }, (unusedTask, i) => ({ content: `g${p}t${i}`,
    status: p === activePhase && i === activeTask ? 'in_progress' : 'pending' })),
})));

test('follow keeps the active task phase title visible across every position and pane height', () => {
  for (const rows of [8, 10, 12, 16]) {
    for (let phase = 0; phase < 5; phase += 1) {
      for (let task = 0; task < 6; task += 1) {
        const snapshot = longPhases(phase, task);
        const active = taskKeys(snapshot)[phase * 6 + task];
        const frame = renderFrame(snapshot, { columns: 52, rows, color: false, language: 'en',
          selection: active, revealSelection: true, expanded: true });
        const text = stripVTControlCharacters(frame.text);
        assert.ok(text.includes(`g${phase}t${task}`), `rows=${rows} task visible`);
        assert.ok(text.includes(`${phaseRomanNumeral(phase + 1)}. Group${phase}`),
          `rows=${rows} title of Group${phase} visible with g${phase}t${task}`);
      }
    }
  }
});

test('a selection that is already fully visible does not move the window', () => {
  const snapshot = longPhases(0, 1);
  const keys = taskKeys(snapshot);
  const near = renderFrame(snapshot, { columns: 52, rows: 14, color: false, selection: keys[3], scroll: 0 });
  assert.equal(near.scroll, 0, 'a visible later task keeps the current scroll');
});

test('a tall phase cannot hold its title and the selection together: the title is pinned on top', () => {
  const big = projection([{ name: 'Huge', tasks: Array.from({ length: 30 }, (unused, i) => ({
    content: `row${i}`, status: i === 20 ? 'in_progress' : 'pending' })) }]);
  const frame = renderFrame(big, { columns: 52, rows: 10, color: false, language: 'en',
    selection: taskKeys(big)[20], expanded: true });
  const body = frame.lines.slice(frame.bodyStart, frame.bodyStart + frame.bodyRows)
    .map((line) => stripVTControlCharacters(line));
  assert.ok(body[0].includes('I. Huge'), `title pinned: ${body[0]}`);
  assert.ok(body.some((line) => line.includes('row20')), 'the selected task stays visible');
});

// The phase row is a divider: `── <ROMAN>. <name>  <closed>/<total>` then dashes to the pane's
// edge. It stays one row, so phaseRanges, click and scroll arithmetic are unchanged.
test("phase rows are divider rows that fill the pane and never exceed it", () => {
  const snapshot = projection([
    { name: "준비", tasks: [{ content: "계획", status: "completed" }] },
    { name: "워커 실행", tasks: [{ content: "워커 A", status: "in_progress" },
      { content: "워커 B", status: "pending" }] }]);
  for (const columns of [80, 52, 40, 34, 24, 20]) {
    const frame = renderFrame(snapshot, { columns, rows: 20, color: false, language: "ko",
      expanded: true, follow: false });
    const rows = Object.values(frame.phaseRanges)
      .map((range) => stripVTControlCharacters(frame.bodyLines[range.start]));
    assert.equal(rows.length, 2, `${columns}: one row per drawn phase`);
    for (const row of rows) {
      assert.match(row, /^── [IVX]+\. /, `${columns}: the divider lead and numeral: ${row}`);
      assert.ok(cells(row) <= columns, `${columns}: ${JSON.stringify(row)} fits ${columns} cells`);
    }
    // The wide panes fill the row exactly; the narrow ones give up the dashes first.
    if (columns >= 34) {
      assert.equal(cells(rows[0]), columns - 1, `${columns}: filler dashes reach the edge`);
    }
    assert.match(rows[0], /── I\. 준비  1\/1 ─/);
  }
  // A title that eats the whole pane leaves no dashes at all, and still fits.
  const tight = renderFrame(projection([{ name: "가".repeat(12) + " 나다라마바사아자차",
    tasks: [{ content: "x", status: "pending" }] }]),
  { columns: 20, rows: 12, color: false, language: "ko", follow: false });
  const head = stripVTControlCharacters(tight.bodyLines[0]);
  assert.ok(cells(head) <= 20, JSON.stringify(head));
  assert.match(head, /^── I\. /);
});

// The example the owner asked for: follow ON with phase I closed puts phase II's divider row
// at the top of the body, and follow OFF brings phase I back.
test("follow pins the phase holding the live task to body row 0, and follow OFF shows the closed phase", () => {
  const snapshot = projection([
    { name: "준비", tasks: [{ content: "계획 읽기", status: "completed" }] },
    { name: "워커 실행", tasks: [{ content: "워커 A 실행", status: "in_progress" },
      { content: "워커 B 실행", status: "pending" }, { content: "워커 C 실행", status: "pending" }] },
    { name: "검증", tasks: [{ content: "결과 확인", status: "pending" }] }]);
  const options = { columns: 40, rows: 16, color: false, language: "ko", expanded: true };
  const pinned = renderFrame(snapshot, options);
  const first = stripVTControlCharacters(pinned.lines[pinned.bodyStart]);
  assert.match(first, /^── II\. 워커 실행  0\/3 ─+$/, first);
  assert.equal(pinned.bodyStart, 2, "the header and its divider sit above the body");
  const body = pinned.lines.slice(pinned.bodyStart, pinned.bodyStart + pinned.bodyRows)
    .map((line) => stripVTControlCharacters(line));
  // The frame reserves the last terminal cell, so the filler dashes reach `columns - 1`.
  const divider = (label) => `${label} ${"─".repeat(39 - width(`${label} `))}`;
  assert.deepEqual(body.slice(0, 5), [divider("── II. 워커 실행  0/3"),
    "├─ ☐ 워커 A 실행", "├─ ☐ 워커 B 실행", "└─ ☐ 워커 C 실행",
    divider("── III. 검증  0/1")]);
  // Follow ON does not clamp to the end of the body: the scroll is the anchor row even when the
  // list is shorter than the window, and the empty rows below are padded blanks.
  assert.equal(pinned.scroll, pinned.phaseRanges[JSON.stringify(["워커 실행", 0])].start);
  assert.equal(body.at(-1), "");
  assert.doesNotMatch(stripVTControlCharacters(pinned.text), /준비|계획 읽기/);
  // Follow OFF keeps the passed scroll and shows the closed phase first.
  const free = renderFrame(snapshot, { ...options, follow: false });
  assert.equal(free.scroll, 0);
  assert.match(stripVTControlCharacters(free.lines[free.bodyStart]), /^── I\. 준비  1\/1 ─+$/);
});

test("follow ON raises the window to the selected task but never lower than the anchor", () => {
  const snapshot = projection([{ name: "Huge", tasks: Array.from({ length: 30 }, (unused, index) => ({
    content: `row${index}`, status: index === 20 ? "in_progress" : "pending" })) }]);
  const keys = taskKeys(snapshot);
  const frame = renderFrame(snapshot, { columns: 52, rows: 10, color: false, language: "en",
    expanded: true, selection: keys[24] });
  const selected = frame.taskRanges[keys[24]];
  assert.ok(selected.end <= frame.scroll + frame.bodyRows, "the selected task is inside the window");
  const body = frame.lines.slice(frame.bodyStart, frame.bodyStart + frame.bodyRows)
    .map((line) => stripVTControlCharacters(line));
  assert.match(body[0], /^── I\. Huge  0\/30 /, `the anchor row stays on top: ${body[0]}`);
  assert.ok(body.some((line) => line.includes("row24")), "the selected row is drawn");
});

test("a follow-ON frame keeps the pinned divider on row 0 when the selection is far down", () => {
  const snapshot = projection([{ name: "Huge", tasks: Array.from({ length: 40 }, (unused, index) => ({
    content: `row${index}`, status: index === 0 ? "in_progress" : "pending" })) }]);
  const frame = renderFrame(snapshot, { columns: 52, rows: 8, color: false, language: "en",
    expanded: true, selection: taskKeys(snapshot)[39] });
  const body = frame.lines.slice(frame.bodyStart, frame.bodyStart + frame.bodyRows)
    .map((line) => stripVTControlCharacters(line));
  assert.match(body[0], /^── I\. Huge  0\/40 /, body[0]);
  assert.ok(body.some((line) => line.includes("row39")), "the selected task is still revealed");
});

// With color false there is no escape anywhere, including the divider ink and the tree rows.
test("the divider and tree rows stay escape-free with color false", () => {
  const snapshot = projection([{ name: "Build", tasks: [
    { content: "done", status: "completed" }, { content: "dropped", status: "abandoned" },
    { content: "live", status: "in_progress" }, { content: "queued", status: "pending" }] }]);
  for (const follow of [true, false]) {
    const frame = renderFrame(snapshot, { columns: 52, rows: 20, color: false, language: "en", follow });
    assert.doesNotMatch(frame.text, /\x1b/, `follow=${follow}: no ESC`);
    assert.match(frame.text, /^── I\. Build  2\/4 drop:1 /m);
    assert.match(frame.text, /^└─ ☐ queued$/m);
  }
});
