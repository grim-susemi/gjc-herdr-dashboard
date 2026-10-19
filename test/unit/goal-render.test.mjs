// L5b goal row tests: one row directly under the Todo header divider (row 2), only while a
// goal exists, at the two contractual widths and in all three languages. The footer is asserted
// by content (AC-F1/F3): the goal row may never push the follow token or the connection label off
// the pane. L5b is amended: the row moved from row 0 to row 2 when the header divider landed.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { width } from "../../src/viewers/common.mjs";
import { goalLine, renderFrame } from "../../src/viewers/todo/render.mjs";

const projection = () => ({ schema: "gjc-herdr-dashboard/todo/1", updatedAt: 1,
  phases: [{ name: "Build", tasks: [{ content: "first row", status: "in_progress" }] }],
  empty: false, sourceError: null });
const goal = { objective: "reply with the single word ok and stop", status: "active",
  tokensUsed: 214181, timeUsedSeconds: 14 };
const plain = (frame) => stripVTControlCharacters(frame.text);

const matrix = [
  { language: "ko", status: "active", seconds: "14s", followOn: "Follow ON",
    followOff: "Follow OFF", live: "LIVE" },
  { language: "en", status: "active", seconds: "14s", followOn: "Follow ON",
    followOff: "Follow OFF", live: "LIVE" },
  { language: "zh-cn", status: "进行中", seconds: "14秒", followOn: "自动跟随 ON",
    followOff: "自动跟随 OFF", live: "实时" },
];

for (const entry of matrix) {
  for (const columns of [34, 52]) {
    test(`${entry.language} ${columns} columns: one goal row keeps every footer token whole`, () => {
      const frame = renderFrame(projection(), { columns, rows: 12, color: false,
        language: entry.language, goal });
      const lines = plain(frame).split("\n");
      assert.equal(lines.length, 12);
      const row = lines[2];
      assert.match(row, /^ ◎ /, "the goal row sits under the header divider");
      assert.match(lines[0], /^ Todo \[0\/1\]/, "row 0 is the inset header");
      assert.match(lines[1], /^─+$/, "row 1 is the header divider");
      assert.match(row, /rep/, "the objective is present and fitted");
      assert.ok(row.includes(entry.status), row);
      assert.ok(row.includes("214K"), row);
      assert.ok(row.includes(`⧖ ${entry.seconds}`), row);
      assert.ok(width(row) <= columns, JSON.stringify(row));
      const footer = lines.at(-1);
      assert.ok(footer.includes(entry.followOn), footer);
      assert.ok(footer.includes(entry.live), footer);
      assert.equal(frame.footerFits, true);
      // Only the footer may overflow; every other row fits the pane.
      for (const line of lines.slice(0, -1)) assert.ok(width(line) <= columns, JSON.stringify(line));
    });

    test(`${entry.language} ${columns} columns: follow OFF stays whole beside the goal row`, () => {
      const frame = renderFrame(projection(), { columns, rows: 12, color: false,
        language: entry.language, goal, follow: false });
      const footer = plain(frame).split("\n").at(-1);
      assert.ok(footer.includes(entry.followOff), footer);
      assert.ok(footer.includes(entry.live), footer);
      assert.equal(frame.footerFits, true);
    });
  }
}

test("no goal means no row and no blank row", () => {
  const frame = renderFrame(projection(), { columns: 34, rows: 12, color: false, language: "ko" });
  const lines = plain(frame).split("\n");
  assert.match(lines[0], /^ Todo \[/);
  assert.match(lines[1], /^─+$/, "the divider is the only row between the header and the body");
  assert.equal(frame.bodyStart, 2, "the header and its divider are above the body");
  assert.doesNotMatch(plain(frame), /◎/);
  assert.equal(frame.goal, null);
  assert.equal(lines.length, 12);
  // A null goal is the same frame; only a goal object adds the row.
  const nullGoal = renderFrame(projection(), { columns: 34, rows: 12, color: false, language: "ko",
    goal: null });
  assert.deepEqual(nullGoal.lines, frame.lines);
  const withGoal = renderFrame(projection(), { columns: 34, rows: 12, color: false, language: "ko",
    goal });
  assert.equal(withGoal.lines.length, frame.lines.length);
  assert.equal(withGoal.bodyRows, frame.bodyRows - 1, "the row is taken from the body, not the footer");
  assert.deepEqual(withGoal.bodyLines, frame.bodyLines, "the body content itself is unchanged");
});

test("the objective is fitted with the shared ellipsis and never pushes the metrics off", () => {
  const long = { ...goal, objective: "a very long objective that cannot fit on one narrow pane ".repeat(3) };
  const narrow = goalLine(long, { columns: 33, language: "en", color: false });
  assert.match(narrow, /~/, narrow);
  assert.ok(narrow.includes("active"), narrow);
  assert.ok(narrow.includes("214K"), narrow);
  assert.ok(narrow.includes("⧖ 14s"), narrow);
  const wide = goalLine(long, { columns: 300, language: "en", color: false });
  assert.doesNotMatch(wide, /~/, wide);
  // The frame passes its edge and asks for the one-column inset; the marker keeps it.
  const inset = goalLine(goal, { columns: 34, language: "en", color: false, inset: true });
  assert.match(inset, /^ ◎ /, inset);
  assert.ok(width(inset) <= 34, inset);
});

test("status, token compaction and elapsed time cover the native and long-running values", () => {
  const at = (extra, language = "ko") => goalLine({ ...goal, ...extra },
    { columns: 80, language, color: false });
  assert.match(at({ status: "paused" }), /paused/);
  assert.match(at({ status: "completed" }), /done/);
  assert.match(at({ status: "cancelled" }), /cancelled/);
  assert.match(at({ status: "failed" }), /failed/);
  assert.match(at({ status: "future-state" }), /future-state/);
  assert.match(at({ tokensUsed: 999 }), /999/);
  assert.match(at({ tokensUsed: 1_500_000 }), /1\.5M/);
  assert.match(at({ timeUsedSeconds: 125 }), /2m 5s/);
  assert.match(at({ timeUsedSeconds: 3_725 }), /1h 2m/);
  assert.match(at({ objective: "" }), /\(untitled\)/);
  assert.equal(goalLine(null), null);
  assert.equal(goalLine({ objective: "x" }), null);
});
