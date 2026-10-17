// Frame renderer tests for the Workers viewer.
//
// Mirrors test/unit/render.test.mjs (the Todo role) so both panes are pinned by the
// same expectations — a bounded frame whose rows never exceed the pane, a footer the
// caller supplies and the renderer never truncates, content asserted (never width
// alone) across columns and languages, and colour that never changes a row width.
// The workers-specific behaviour is asserted on its own: a card is a title row plus a
// context row plus a metrics row, completed cards auto-fold to one row, failed and
// aborted stay visually and textually apart (AC2.2), and an unknown context or cost
// renders the localized unknown label instead of a confident number (K1).
// Adapted from omo-herdr-dashboard @4082c750 `packages/dag/test/dashboard-b.test.mjs`,
// which pinned the same card idea against the DAG renderer; the DAG graph, the run
// selector and omo's metric vocabulary are not part of this contract.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { fit, width, wrap } from "../../src/viewers/common.mjs";
import { renderWorkers, stepSelection } from "../../src/viewers/workers/render.mjs";

const card = (id, extra = {}) => ({ id, agent: "subagent", title: `card ${id}`, status: "running",
  background: false, currentTool: null, lastIntent: null, lastOutput: null, toolCount: 0,
  tokens: 0, contextPercent: null, cost: null, durationMs: 0, retry: null, startedAt: null,
  endedAt: null, ...extra });

const projection = (cards, extra = {}) => ({ schema: "gjc-herdr-dashboard/workers/1",
  updatedAt: 1, empty: cards.length === 0, sourceError: null, cards, ...extra });

const STATUSES = ["pending", "running", "completed", "failed", "aborted", "paused"];
// Independent cell oracle for the ASCII/Hangul fixtures, not renderer.width, so a bug
// that is self-consistent inside `width()` cannot hide a row that overflowed a pane.
const cells = (line) => Array.from(stripVTControlCharacters(line))
  .reduce((total, point) => total + (/[\u1100-\u115f\uac00-\ud7a3]/u.test(point) ? 2 : 1), 0);
const WORDS = {
  ko: { pending: "대기", running: "실행 중", completed: "완료", failed: "실패",
    aborted: "중단", paused: "일시정지" },
  en: { pending: "Pending", running: "Running", completed: "Done", failed: "Failed",
    aborted: "Aborted", paused: "Paused" },
  "zh-cn": { pending: "待处理", running: "运行中", completed: "已完成", failed: "失败",
    aborted: "已中止", paused: "已暂停" },
};

// One running card, so the frame is exactly header + three card rows + divider + footer.
const one = (extra = {}, cards = [card("c1", { title: "ship it", status: "running",
  currentTool: "read", lastIntent: "reading the plan", lastOutput: "line 4",
  toolCount: 3, tokens: 1200, contextPercent: 41.6, cost: 0.01234, durationMs: 65000, ...extra })]) =>
  projection(cards);

const frameOf = (cards, options = {}) => renderWorkers(one({}, cards),
  { columns: 80, rows: 8, color: false, language: "en", view: { follow: false }, footer: ["F"],
    ...options });

test("status glyphs are one cell each and keep the six states apart", () => {
  const glyphs = new Set();
  for (const status of STATUSES) {
    const line = frameOf([card("c1", { title: "t", status })]).lines[1];
    const glyph = stripVTControlCharacters(line)[1];
    assert.equal(width(glyph), 1, `${status} glyph is one cell: ${JSON.stringify(glyph)}`);
    glyphs.add(glyph);
  }
  assert.equal(glyphs.size, STATUSES.length, `six distinct glyphs, got ${[...glyphs].join(",")}`);
  // AC2.2: failed and aborted are two different glyphs and two different words.
  const line = (status) => stripVTControlCharacters(frameOf([card("c1", { title: "t", status })]).lines[1]);
  assert.equal(line("failed")[1], "✗");
  assert.equal(line("aborted")[1], "⊘");
  assert.notEqual(line("failed")[1], line("aborted")[1]);
  assert.match(line("failed"), /실패|Failed|失败/);
  assert.match(line("aborted"), /중단|Aborted|已中止/);
  assert.notEqual(WORDS.ko.failed, WORDS.ko.aborted);
  assert.notEqual(WORDS.en.failed, WORDS.en.aborted);
});

test("every language names the six statuses with six distinct words", () => {
  for (const language of Object.keys(WORDS)) {
    const words = STATUSES.map((status) => stripVTControlCharacters(
      frameOf([card("c1", { title: "t", status })], { language }).lines[1]));
    const tails = new Set(words.map((line) => line.trim().slice(2)));
    assert.equal(tails.size, STATUSES.length, `${language}: ${JSON.stringify([...tails])}`);
    for (const status of STATUSES) assert.ok(words.some((line) => line.includes(WORDS[language][status])),
      `${language}/${status}: ${JSON.stringify(words)}`);
  }
});

// AC-F4: the title and the status label survive 24 columns, for every status, in both
// languages. Content is asserted, never width alone.
for (const columns of [24, 40, 54]) {
  for (const language of ["ko", "en"]) {
    test(`${columns} columns in ${language}: every status shows its title, glyph and word`, () => {
      for (const status of STATUSES) {
        const title = `${status}-card`;
        const frame = frameOf([card("c1", { title, status })], { columns, language });
        const line = frame.lines[1];
        assert.match(line, new RegExp(title), `${columns}/${language}/${status}: title: ${line}`);
        assert.match(line, new RegExp(WORDS[language][status]), `${columns}/${language}/${status}: ${line}`);
        assert.equal(stripVTControlCharacters(line)[1], stripVTControlCharacters(frame.lines[1])[1]);
        assert.ok(width(line) <= columns - 1, `${columns}/${language}/${status}: ${width(line)} cells`);
      }
    });
  }
}

// A long title at the narrow end: the title is what truncates, so the status label is
// still whole and still readable (AC-F4 with real band widths).
test("a long title truncates but never pushes the status label off a 24-column pane", () => {
  for (const language of ["ko", "en", "zh-cn"]) {
    const frame = frameOf([card("c1", { title: "x".repeat(80), status: "failed" })],
      { columns: 24, language });
    assert.ok(frame.lines[1].includes(WORDS[language].failed), `${language}: ${frame.lines[1]}`);
    assert.match(frame.lines[1], /x{4,}~/);
    assert.ok(width(frame.lines[1]) <= 23);
  }
  // Even a pathological glyph width degrades to one coloured strip rather than a
  // status that fell off the row.
  const tiny = frameOf([card("c1", { title: "t", status: "aborted" })], { columns: 4 });
  assert.equal(tiny.lines.length, 8);
  assert.ok(width(tiny.lines[1]) <= 3, tiny.lines[1]);
});

for (const [columns, rows] of [[80, 24], [54, 23], [40, 16], [24, 12], [12, 4], [1, 1]]) {
  test(`${columns}x${rows}: a bounded frame whose caller footer survives`, () => {
    const frame = frameOf([card("c1"), card("c2", { status: "completed" })],
      { columns, rows, language: "ko", footer: ["FOOTER"] });
    assert.equal(frame.lines.length, rows);
    assert.equal(frame.text.split("\n").length, rows);
    // AC-F1/F3: the caller's footer is the last row and is never cut, at any width.
    assert.equal(stripVTControlCharacters(frame.lines.at(-1)), "FOOTER");
    // Everything this renderer sized stays inside the pane; the footer is the only row
    // allowed to overflow, because the caller owns its content.
    for (const line of frame.lines.slice(0, -1)) {
      assert.ok(width(line) <= columns - 1, `${columns}x${rows}: ${JSON.stringify(line)}`);
      assert.ok(cells(line) <= columns - 1, `${columns}x${rows} (oracle): ${JSON.stringify(line)}`);
    }
    assert.ok(frame.scroll >= 0 && frame.scroll <= frame.maxScroll);
  });
}

test("the empty, waiting and source-error states are three different sentences", () => {
  const labelOf = (proj, language) => renderWorkers(proj,
    { columns: 40, rows: 5, color: false, language, footer: ["F"] }).bodyLines.join(" | ");
  const expected = {
    ko: { empty: "실행 중인 작업이 없습니다.", waiting: "Workers 원본을 기다립니다.",
      error: "Workers 원본을 읽을 수 없습니다." },
    en: { empty: "No work is running.", waiting: "Waiting for the Workers source.",
      error: "The Workers source is unavailable." },
    "zh-cn": { empty: "当前没有运行中的任务。", waiting: "等待 Workers 来源。",
      error: "无法读取 Workers 来源。" },
  };
  for (const [language, words] of Object.entries(expected)) {
    assert.equal(labelOf(projection([]), language), words.empty, language);
    assert.equal(labelOf(null, language), words.waiting, language);
    assert.equal(labelOf(projection([], { sourceError: "bus handler exploded" }), language), words.error,
      language);
    // Three distinct sentences per language, and never the same word across them.
    assert.equal(new Set(Object.values(words)).size, 3, language);
  }
  const all = Object.values(expected).flatMap((words) => Object.values(words));
  assert.equal(new Set(all).size, all.length, "no two labels share a sentence");
});

test("connection is derived from the projection and a source error keeps its cards", () => {
  const connection = (proj) => renderWorkers(proj, { columns: 40, rows: 5, footer: ["F"] }).connection;
  assert.equal(connection(null), "waiting");
  assert.equal(connection(projection([])), "empty");
  assert.equal(connection(one()), "live");
  // A host source error outranks the cards it kept: the row says so above the body and
  // the surviving cards stay selectable and still render.
  const failed = renderWorkers(projection([card("c1", { title: "kept", status: "running" })],
    { sourceError: "handlers exploded" }),
  { columns: 60, rows: 6, color: false, language: "en", view: { follow: false }, footer: ["F"] });
  assert.equal(failed.connection, "source-error");
  assert.match(failed.lines[1], /Source error: handlers exploded/);
  assert.deepEqual(failed.selectable, ["c1"]);
  assert.equal(failed.empty, false);
  assert.match(failed.bodyLines[0], /kept/);
});

test("an empty projection renders one label row and reports no selection", () => {
  const frame = renderWorkers(projection([]), { columns: 40, rows: 6, color: false, language: "ko",
    view: { selection: "gone", detail: true, follow: false }, footer: ["F"] });
  assert.deepEqual(frame.selectable, []);
  assert.equal(frame.selection, null);
  assert.equal(frame.bodyLines.length, 1);
  assert.equal(frame.empty, true);
  assert.deepEqual(stepSelection(frame, 1), { selection: null, scroll: frame.scroll });
  assert.deepEqual(stepSelection(frame, -1), { selection: null, scroll: frame.scroll });
});

// A completed card is one row until `c` (showCompleted) or its own fold says otherwise.
// Every other status is at least two rows (title plus metrics); the context row is the
// one that stays behind a fold or a selection, because it is the card's prose.
test("completed cards auto-fold to one row, until `c` or a per-card fold unfolds them", () => {
  const cards = [card("c1", { title: "done one", status: "completed", lastIntent: "finished" }),
    card("c2", { title: "failed one", status: "failed", lastOutput: "EACCES" })];
  const frame = (view) => frameOf(cards, { view: { follow: false, ...view } });
  const folded = frame({});
  assert.equal(folded.bodyLines.length, 3, "one row for the completed card plus two for the failure");
  assert.match(folded.bodyLines[0], /done one/);
  assert.doesNotMatch(folded.bodyLines[0], /finished/, "a folded card shows no context row");
  assert.equal(folded.ranges.c1.end - folded.ranges.c1.start, 1);
  assert.equal(folded.ranges.c2.end - folded.ranges.c2.start, 2,
    "a failed card is never auto-folded: it keeps its metrics row");
  assert.match(folded.bodyLines[1], /failed one/);
  assert.match(folded.bodyLines[2], /0 tools/);
  // `expanded[{id: true}]` unfolds exactly one card, and the unfolded card gains both
  // the context row (its reason) and the metrics row.
  const one = frame({ expanded: { c2: true } });
  assert.equal(one.bodyLines.length, 4);
  assert.match(one.bodyLines[2], /EACCES/, "the failure reason is on the context row");
  assert.equal(one.ranges.c2.end - one.ranges.c2.start, 3);
  const unfoldedDone = frame({ expanded: { c1: true } });
  assert.equal(unfoldedDone.bodyLines.length, 5, "the unfolded completed card is three rows");
  assert.match(unfoldedDone.bodyLines[1], /finished/);
  assert.match(unfoldedDone.bodyLines[2], /0 tools/, "an unfolded card keeps its metrics row");
  // `c` (showCompleted) turns off the auto-fold, so a completed card shows its metrics
  // row; its context row still needs an explicit expand, like every non-running card.
  const all = frame({ showCompleted: true });
  assert.equal(all.bodyLines.length, 4);
  assert.match(all.bodyLines[1], /0 tools/);
  assert.doesNotMatch(all.bodyLines[1], /finished/);
  // Folding changes rows, never the selectable card list.
  for (const candidate of [folded, one, all, unfoldedDone]) {
    assert.deepEqual(candidate.selectable, ["c1", "c2"]);
  }
});

test("a running card shows tool, intent and last output on its second row", () => {
  const frame = frameOf([card("c1", { title: "live", status: "running", currentTool: "read",
    lastIntent: "reading the plan", lastOutput: "line 4" }), card("c2", { title: "queued", status: "pending" })]);
  // Three rows for the running card, two for the pending one: the context row is what
  // the pending card does not get while it is folded, and it carries its metrics anyway.
  assert.equal(frame.bodyLines.length, 5);
  assert.match(frame.bodyLines[1], /read · reading the plan · line 4/);
  assert.match(frame.bodyLines[3], /queued/);
  assert.doesNotMatch(frame.bodyLines[3], /reading/);
  assert.match(frame.bodyLines[4], /0 tools/);
  // The whole triple is on one row and stays inside the pane.
  assert.ok(width(frame.bodyLines[1]) <= 79);
  // A pending card gains its context row when it is expanded (the contract's rule).
  const expanded = frameOf([card("c2", { title: "queued", status: "pending", currentTool: "bash",
    lastIntent: "waiting" })], { view: { follow: false, expanded: { c2: true } } });
  assert.match(expanded.bodyLines[1], /bash · waiting/);
  // An absent context row is an empty row, never the word "undefined".
  const bare = frameOf([card("c1", { status: "running" })]);
  assert.equal(bare.bodyLines[1].trim(), "");
  assert.doesNotMatch(bare.text, /undefined|null/);
});

test("the metrics row is tools, tokens, context, cost, duration in that order", () => {
  const metrics = (language, columns = 80) => frameOf([card("c1", { title: "t", status: "running",
    toolCount: 7, tokens: 1234, contextPercent: 41.6, cost: 0.01234, durationMs: 65000 })],
  { language, columns }).bodyLines[2].trim();
  assert.equal(metrics("en"), "7 tools · 1234 tok · ctx 42% · $0.0123 · 1m 5s");
  assert.equal(metrics("ko"), "도구 7 · 토큰 1234 · 컨텍스트 42% · 비용 $0.0123 · 1m 5s"
    .replace("1m 5s", "1분 5초").replace("7 tools".slice(0, 0), ""));
  assert.equal(metrics("zh-cn"), "工具 7 · token 1234 · 上下文 42% · 费用 $0.0123 · 1分 5秒");
  // The order is stable, so a narrow pane drops the tail (cost, then duration) and the
  // counts a reader scans first survive.
  assert.match(metrics("en", 30), /^7 tools · 1234 tok/);
  assert.ok(!metrics("en", 30).includes("$0.0123"));
});

// K1: the host reports 0 for subscription models, which is indistinguishable from
// "never measured", so 0 and null both render the localized unknown label and never a
// confident "$0.0000". A real cost keeps four decimals.
test("an unknown cost and an unknown context render the localized unknown label", () => {
  const row = (cost, contextPercent, language = "en") => frameOf([card("c1", { title: "t",
    status: "running", cost, contextPercent })], { language }).bodyLines[2].trim();
  assert.equal(row(null, null), "0 tools · 0 tok · ctx ?% · ? · 0s");
  assert.equal(row(0, 0), "0 tools · 0 tok · ctx 0% · ? · 0s", "K1: a reported 0 cost is unknown");
  assert.equal(row(undefined, undefined), "0 tools · 0 tok · ctx ?% · ? · 0s");
  assert.equal(row(-1, -1), "0 tools · 0 tok · ctx ?% · ? · 0s", "a negative cost is not a number");
  assert.equal(row(NaN, NaN), "0 tools · 0 tok · ctx ?% · ? · 0s");
  assert.equal(row("0.5", "50"), "0 tools · 0 tok · ctx ?% · ? · 0s", "a string is not a measurement");
  assert.equal(row(0.0123, 99.4), "0 tools · 0 tok · ctx 99% · $0.0123 · 0s");
  assert.equal(row(1000000, 100), "0 tools · 0 tok · ctx 100% · $1000000.0000 · 0s");
  assert.equal(row(null, null, "ko"), "도구 0 · 토큰 0 · 컨텍스트 ?% · 비용 ? · 0초");
  assert.equal(row(null, null, "zh-cn"), "工具 0 · token 0 · 上下文 ?% · 费用 ? · 0秒");
  // A 41.6% context rounds, it never prints a fraction.
  assert.match(row(1, 41.6), /ctx 42%/);
});

test("a running card's duration follows startedAt; a finished card keeps its own", () => {
  // Every case is expanded, so the metrics row is the last row of the card either way.
  const tail = (extra) => frameOf([card("c1", { title: "t", ...extra })],
    { now: 70000, columns: 60, view: { follow: false, expanded: { c1: true } } }).bodyLines.at(-1).trim();
  // A running card's published durationMs is a floor: a stale bus value never rewinds
  // the elapsed clock, and a fresher one is kept.
  assert.match(tail({ status: "running", durationMs: 5000, startedAt: 1000 }), /1m 9s$/);
  assert.match(tail({ status: "running", durationMs: 90000, startedAt: 1000 }), /1m 30s$/);
  assert.match(tail({ status: "running", durationMs: 5000 }), /5s$/);
  // A finished card keeps the recorded duration: now - startedAt would keep growing.
  assert.match(tail({ status: "completed", durationMs: 5000, startedAt: 1000 }), /5s$/);
  assert.match(tail({ status: "aborted", durationMs: 5000, startedAt: 1000 }), /5s$/);
  // Hours are compact in every language.
  const long = { status: "running", durationMs: 3 * 3600 * 1000 + 61_000 };
  assert.match(tail(long), /3h 1m 1s$/);
  assert.match(frameOf([card("c1", { title: "t", ...long })],
    { language: "ko", columns: 60, view: { follow: false, expanded: { c1: true } } }).bodyLines[2], /3시간 1분 1초/);
  assert.match(frameOf([card("c1", { title: "t", ...long })],
    { language: "zh-cn", columns: 60, view: { follow: false, expanded: { c1: true } } }).bodyLines[2], /3小时 1分 1秒/);
});

test("`d` expands only the selected card's record and never changes the selection", () => {
  const cards = [card("c1", { title: "alpha", status: "running", currentTool: "read",
    lastIntent: "reading", lastOutput: "ok", retry: { attempt: 2, delayMs: 3000 } }),
    card("c2", { title: "beta", status: "pending" })];
  const view = { follow: false, selection: "c1" };
  const list = frameOf(cards, { view });
  const detail = frameOf(cards, { view: { ...view, detail: true } });
  assert.ok(detail.bodyLines.length > list.bodyLines.length);
  assert.deepEqual(detail.selectable, list.selectable);
  assert.equal(detail.selection, "c1");
  const joined = detail.bodyLines.join("\n");
  for (const field of ["id: c1", "agent: subagent", "status: Running", "tool: read",
    "intent: reading", "last output: ok", "retry: 2 (3s)"]) {
    assert.ok(joined.includes(field), `detail shows ${field}: ${joined}`);
  }
  // Only the selected card grows: the other card keeps its two rows.
  assert.equal(detail.ranges.c2.end - detail.ranges.c2.start, 2);
  assert.ok(detail.ranges.c1.end - detail.ranges.c1.start > list.ranges.c1.end - list.ranges.c1.start);
  // A detail view with no explicit selection still resolves to the newest card, and `d`
  // again restores the list frame exactly (the toggle is symmetric).
  const fallback = frameOf(cards, { view: { follow: false, detail: true } });
  assert.equal(fallback.selection, "c1");
  assert.notEqual(fallback.text, list.text);
  assert.equal(frameOf(cards, { view: { follow: false, detail: false } }).text, list.text);
  // An absent field is the unknown label, not the string "undefined", and no retry row
  // appears when the card carries none.
  const bare = frameOf([card("c1", { status: "failed" })], { view: { follow: false, detail: true } });
  assert.match(bare.bodyLines.join("\n"), /intent: \?/);
  assert.doesNotMatch(bare.bodyLines.join("\n"), /undefined/);
  assert.doesNotMatch(bare.bodyLines.join("\n"), /retry:/);
  // A retry with an unknown attempt still names the row.
  const retry = frameOf([card("c1", { retry: { attempt: null, delayMs: null } })],
    { view: { follow: false, detail: true } });
  assert.match(retry.bodyLines.join("\n"), /retry: \?/);
});

test("a selected card is marked and the selection resolves against the newest card", () => {
  const cards = [card("c1", { title: "newest" }), card("c2", { title: "older" })];
  const frame = (selection) => frameOf(cards, { view: { follow: false, selection } });
  assert.equal(frame("c2").selection, "c2");
  // Each running card is three rows, so the second card's title is bodyLines[3].
  assert.equal(frame("c2").bodyLines[0][0], " ", "an unselected card carries no marker");
  assert.equal(frame("c2").bodyLines[3][0], ">", "the selected card carries the marker");
  assert.equal(frame("c1").bodyLines[0][0], ">");
  assert.equal(frame("gone").selection, "c1");
  assert.equal(frame(null).selection, "c1");
  assert.equal(frame(7).selection, "c1");
  assert.equal(frame("").selection, "c1");
  // Duplicate and empty ids are collapsed so one id names exactly one card.
  const dupes = frameOf([card("c1"), card("c1"), card(""), card("c2")]);
  assert.deepEqual(dupes.selectable, ["c1", "c2"]);
});

test("Tab/n/p step the selection and clamp at both ends", () => {
  const cards = [card("c1"), card("c2"), card("c3")];
  const frame = frameOf(cards, { view: { follow: false, selection: "c1" } });
  assert.deepEqual(stepSelection(frame, 1), { selection: "c2", scroll: frame.scroll });
  assert.deepEqual(stepSelection({ ...frame, selection: "c2" }, -1),
    { selection: "c1", scroll: frame.scroll });
  assert.equal(stepSelection(frame, -1).selection, "c1", "the first card cannot step back");
  assert.equal(stepSelection({ ...frame, selection: "c3" }, 1).selection, "c3");
  assert.equal(stepSelection({ ...frame, selection: "c3" }, 99).selection, "c3");
  assert.equal(stepSelection({ ...frame, selection: null }, 1).selection, "c2");
  // Every result stays inside the projection's own ids, in render order.
  for (const delta of [-2, -1, 1, 2]) {
    assert.ok(frame.selectable.includes(stepSelection(frame, delta).selection), String(delta));
  }
  // A frame whose selection is missing from `selectable` still steps from the first card.
  assert.equal(stepSelection({ ...frame, selection: "gone" }, 1).selection, "c2");
  // Stepping is pure: the frame it was given is untouched.
  const before = JSON.stringify(frame);
  stepSelection(frame, 1);
  assert.equal(JSON.stringify(frame), before);
});

test("scrolling is clamped to the body and follow ON pulls the selection back", () => {
  // Completed cards auto-fold to one row each: ten cards, ten body rows.
  const cards = Array.from({ length: 10 }, (_, index) =>
    card(`c${index + 1}`, { title: `card ${index + 1}`, status: "completed" }));
  const wide = { columns: 40, rows: 8, color: false, language: "en", footer: ["F"] };
  const bodyRows = 8 - 1 - 1 - 1;
  const far = renderWorkers(projection(cards), { ...wide, view: { follow: false, scroll: 99 } });
  assert.equal(far.bodyRows, bodyRows);
  assert.equal(far.maxScroll, 10 - bodyRows);
  assert.equal(far.scroll, far.maxScroll, "a scroll past the end is clamped");
  assert.equal(far.lines.length, 8);
  assert.ok(far.bodyLines[far.scroll].includes("card 6"));
  assert.equal(renderWorkers(projection(cards), { ...wide, view: { follow: false, scroll: -4 } }).scroll, 0);
  // A mistyped scroll is clamped to a number, never NaN, so the frame's own scroll can
  // be persisted straight back to disk ("9" is read as 9 and then clamped to the end).
  assert.equal(renderWorkers(projection(cards), { ...wide, view: { follow: false, scroll: "9" } }).scroll,
    5);
  for (const scroll of [NaN, {}, [], undefined]) {
    assert.equal(renderWorkers(projection(cards), { ...wide, view: { follow: false, scroll } }).scroll, 0,
      JSON.stringify(scroll));
  }
  // follow OFF keeps the caller's scroll even when the selected card is off screen.
  const manual = renderWorkers(projection(cards), { ...wide,
    view: { follow: false, scroll: 5, selection: "c1" } });
  assert.equal(manual.scroll, 5);
  assert.equal(manual.selection, "c1", "follow never overrides the selection");
  // follow ON (and the default) brings the selected card back into the window.
  for (const view of [{ follow: true, scroll: 5, selection: "c1" }, { scroll: 5, selection: "c1" }]) {
    const pulled = renderWorkers(projection(cards), { ...wide, view });
    assert.equal(pulled.scroll, 0, JSON.stringify(view));
    assert.equal(pulled.selection, "c1");
    assert.ok(pulled.bodyLines[0].includes("card 1"));
  }
  // A tall enough pane never scrolls, and a missing view object is a valid frame.
  const roomy = renderWorkers(projection(cards),
    { columns: 40, rows: 20, color: false, language: "en", view: { follow: false, scroll: 3 }, footer: ["F"] });
  assert.equal(roomy.maxScroll, 0);
  assert.equal(roomy.scroll, 0);
  assert.equal(renderWorkers(projection(cards), wide).scroll, 0);
});

test("stepSelection scrolls the newly selected card into the visible window", () => {
  const cards = Array.from({ length: 10 }, (_, index) =>
    card(`c${index + 1}`, { title: `card ${index + 1}`, status: "completed" }));
  const options = { columns: 40, rows: 6, color: false, language: "en", footer: ["F"] };
  let current = renderWorkers(projection(cards), { ...options, view: { follow: false, selection: "c1" } });
  assert.equal(current.bodyRows, 3);
  const seen = [];
  for (let step = 0; step < 9; step++) {
    const next = stepSelection(current, 1);
    current = renderWorkers(projection(cards),
      { ...options, view: { follow: false, selection: next.selection, scroll: next.scroll } });
    assert.equal(current.selection, next.selection);
    const range = current.ranges[next.selection];
    assert.ok(range.start >= current.scroll && range.start < current.scroll + current.bodyRows,
      `step ${step}: card ${next.selection} at ${range.start} inside ` +
      `${current.scroll}..${current.scroll + current.bodyRows}`);
    seen.push(next.selection);
  }
  assert.deepEqual(seen, cards.slice(1).map((entry) => entry.id));
  assert.equal(current.scroll, current.maxScroll);
  // Stepping back keeps the earlier window rather than staying pinned at the bottom.
  const back = stepSelection(current, -1);
  assert.equal(back.selection, "c9");
  assert.ok(back.scroll <= current.scroll);
  // A frame with no room for a body (the narrow fallback) still steps, scroll 0.
  const flat = renderWorkers(projection(cards), { ...options, rows: 2 });
  assert.equal(flat.bodyRows, 0);
  assert.deepEqual(stepSelection(flat, 1), { selection: "c2", scroll: 0 });
});

test("the caller's footer rows are appended verbatim and are the only rows allowed to overflow", () => {
  const footer = ["자동 추적 ON · 실시간", "second footer row"];
  const frame = frameOf([card("c1")], { language: "ko", rows: 8, footer });
  assert.deepEqual(frame.lines.slice(-2), footer);
  assert.equal(frame.bodyStart, 1);
  assert.equal(frame.bodyRows, 8 - 1 - 1 - 2);
  // The renderer never invents, wraps or truncates a footer row: a 200-cell row stays
  // one row, even at one column.
  const long = "F".repeat(200);
  const narrow = frameOf([card("c1")], { columns: 1, rows: 4, footer: [long] });
  assert.equal(narrow.lines.length, 4);
  assert.equal(narrow.lines.at(-1), long);
  // An explicitly empty footer is honoured; a non-string entry cannot break the frame.
  assert.equal(frameOf([card("c1")], { rows: 6, footer: [] }).lines.at(-1),
    "─".repeat(79), "with no footer rows the divider is last");
  const odd = frameOf([card("c1")], { rows: 6, footer: [null, "ok"] });
  assert.equal(odd.lines.at(-1), "ok");
  // A control sequence in a caller's footer row cannot repaint the pane.
  const escaped = frameOf([card("c1")], { rows: 6, footer: ["\x1b[2Jgone"] });
  assert.equal(escaped.lines.at(-1), "gone");
});

test("the header tallies the cards and the background marker rides on the card", () => {
  const cards = [card("c1", { title: "foreground", status: "running" }),
    card("c2", { title: "detached", status: "running", background: true }),
    card("c3", { title: "broken", status: "failed" }),
    card("c4", { title: "stopped", status: "aborted" }),
    card("c5", { title: "done", status: "completed" })];
  // The failed and aborted tallies stay apart (AC2.2), and a status with no card is
  // not tallied at all.
  const ko = frameOf(cards, { language: "ko", columns: 100, rows: 20, view: { follow: false, showCompleted: true } });
  assert.equal(ko.lines[0], "Workers [5]  실행 중 2 · 실패 1 · 중단 1 · 완료 1");
  const en = frameOf(cards, { language: "en", columns: 100, rows: 20, view: { follow: false, showCompleted: true } });
  assert.equal(en.lines[0], "Workers [5]  Running 2 · Failed 1 · Aborted 1 · Done 1");
  const zh = frameOf(cards, { language: "zh-cn", columns: 100, rows: 20, view: { follow: false, showCompleted: true } });
  assert.equal(zh.lines[0], "Workers [5]  Running 2 · Failed 1 · Aborted 1 · Done 1"
    .replace("Running", "运行中").replace("Failed", "失败").replace("Aborted", "已中止").replace("Done", "已完成"));
  // A single-card projection says so, without an empty tally tail.
  assert.equal(frameOf([card("c1", { status: "paused" })]).lines[0], "Workers [1]  Paused 1");
  assert.equal(frameOf([], { rows: 4 }).lines[0], "Workers [0]");
  // The background marker rides on the card that has it (AC2.6).
  assert.match(ko.bodyLines[3], /\[백그라운드\]/);
  assert.doesNotMatch(ko.bodyLines[0], /백그라운드/);
  assert.match(en.bodyLines[3], /\[background\]/);
  assert.match(zh.bodyLines[3], /\[后台\]/);
  // A card with no title falls back to its agent and then to its id, never a blank row.
  const bare = frameOf([card("c9", { title: "", agent: "", status: "pending" })]);
  assert.match(bare.bodyLines[0], /c9/);
  const agent = frameOf([card("c9", { title: "", agent: "explorer", status: "pending" })]);
  assert.match(agent.bodyLines[0], /explorer/);
});

test("color only wraps already-sized runs, so it never changes a row width", () => {
  const cards = STATUSES.map((status) => card(status, { title: `${status} card`, status,
    durationMs: 61000, toolCount: 2, tokens: 40, contextPercent: 12.5, cost: 0.5 }));
  const options = { columns: 54, rows: 20, language: "ko", view: { follow: false, detail: true },
    footer: ["자동 추적 ON · 실시간"] };
  const plain = renderWorkers(projection(cards), { ...options, color: false });
  const colored = renderWorkers(projection(cards), { ...options, color: true });
  assert.equal(plain.lines.length, colored.lines.length);
  for (const [index, line] of colored.lines.entries()) {
    assert.ok(line.includes("\x1b["), `row ${index} is painted`);
    assert.equal(stripVTControlCharacters(line), plain.lines[index], `row ${index}`);
    assert.equal(width(line), width(plain.lines[index]), `row ${index} width`);
    assert.ok(line.endsWith("\x1b[0m"), `row ${index} closes its colour`);
  }
  // `render` is exactly the frame `renderWorkers(...).text`.
  assert.equal(plain.text, plain.lines.join("\n"));
  assert.ok(!plain.text.includes("\x1b["));
});

test("a hostile title or field cannot break the frame, and every row is still sized", () => {
  const hostile = card("c1", { title: "\x1b[2J\x1b]0;owned\x07한글 제목\r\nsecond",
    status: "running", currentTool: "\x07rm -rf", lastOutput: "\x1b[31mred\x1b[0m" });
  for (const columns of [24, 40, 80]) {
    const frame = renderWorkers(projection([hostile]), { columns, rows: 10, color: false,
      language: "ko", view: { detail: true, follow: false }, footer: ["F"] });
    assert.equal(frame.lines.length, 10);
    const joined = frame.lines.join("");
    assert.ok(!joined.includes("\x07"));
    assert.ok(!/\x1b\[2J|\x1b]0;/.test(joined));
    assert.ok(!frame.lines.some((line) => line.includes("\n")));
    for (const line of frame.lines.slice(0, -1)) assert.ok(width(line) <= columns - 1, JSON.stringify(line));
    // The cleaned title is still readable rather than dropped.
    assert.match(frame.lines[1], /한글 제목/);
  }
});

test("the narrow fallback keeps the caller's footer and never claims an unknown status", () => {
  const odd = projection([card("c1", { title: "mystery", status: "teleported" })]);
  for (const [columns, rows] of [[12, 4], [1, 2], [40, 3]]) {
    const narrow = renderWorkers(odd, { columns, rows, color: false, language: "en", footer: ["F"] });
    assert.equal(narrow.lines.length, rows, `${columns}x${rows}`);
    assert.equal(narrow.lines.at(-1), "F");
    assert.equal(narrow.bodyRows, 0);
    assert.equal(narrow.maxScroll, 0);
    assert.equal(narrow.scroll, 0);
  }
  // An unknown status is a localized word, never a blank or a crash.
  const wide = renderWorkers(odd, { columns: 60, rows: 5, color: false, language: "en",
    view: { detail: true, follow: false }, footer: ["F"] });
  assert.match(wide.bodyLines[0], /Unknown/);
  assert.match(wide.bodyLines.join("\n"), /status: Unknown/);
  assert.equal(width(wide.bodyLines[0]), width(stripVTControlCharacters(wide.bodyLines[0])));
  // The renderer leans on the shared primitives rather than its own copies.
  assert.equal(fit("한글A", 4), "한~");
  assert.deepEqual(wrap("가나다라마바사", 6), ["가나다", "라마바", "사"]);
});
