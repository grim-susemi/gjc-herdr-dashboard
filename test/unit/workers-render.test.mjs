// Frame renderer tests for the Workers viewer.
//
// Re-pinned for the OMO 3242ad4 grammar (GRAMMAR G1-G13): the pane opens with the
// OMO header row and a dim divider, a card is the three-row OMO card (bar/spinner
// title row, role row, metrics row), completed cards fold behind `done N ▸`, and
// status words follow owner decision Q3=A (running and done show the glyph only;
// failed, aborted, paused, pending and unknown keep their word). The guards that
// matter are asserted independently: AC2.2 (failed `×`/`failed` versus aborted
// `⊘`/`aborted`), the amended AC-F4 at 24 columns, AC2.6 (background on row 2),
// K1 (an unknown cost is never `$0.0000`), and the caller's never-truncated footer
// (AC-F1/AC-F3). Fixture titles are neutral so only an emitted status suffix can
// satisfy a status-word assertion.
//
// Adapted from omo-herdr-dashboard @3242ad4 `packages/dag/test/dashboard-b.test.mjs`.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { fit, width, wrap } from "../../src/viewers/common.mjs";
import { renderWorkers, stepSelection, SPINNER } from "../../src/viewers/workers/render.mjs";

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
  ko: { pending: "pending", running: "running", completed: "done", failed: "failed",
    aborted: "aborted", paused: "paused" },
  en: { pending: "pending", running: "running", completed: "done", failed: "failed",
    aborted: "aborted", paused: "paused" },
  "zh-cn": { pending: "待处理", running: "运行中", completed: "已完成", failed: "失败",
    aborted: "已中止", paused: "已暂停" },
};
const GLYPHS = { pending: "○", running: SPINNER[0], completed: "✓", failed: "×",
  aborted: "⊘", paused: "Ⅱ" };

// One running card, so the frame is exactly header + divider + three card rows +
// divider + footer at a tall enough pane.
const one = (extra = {}, cards = [card("c1", { title: "ship it", status: "running",
  currentTool: "read", lastIntent: "reading the plan", lastOutput: "line 4",
  toolCount: 3, tokens: 1200, contextPercent: 41.6, cost: 0.01234, durationMs: 65000, ...extra })]) =>
  projection(cards);

const frameOf = (cards, options = {}) => renderWorkers(one({}, cards),
  { columns: 80, rows: 8, color: false, language: "en", view: { follow: false }, footer: ["F"],
    ...options });

const plainLine = (line) => stripVTControlCharacters(line);

test("status glyphs are one cell each and keep the six states apart", () => {
  const glyphs = new Set();
  for (const status of STATUSES) {
    const line = plainLine(frameOf([card("c1", { title: "item one", status })],
      { view: { follow: false, showCompleted: true } }).bodyLines[0]);
    const glyph = line[2];
    assert.equal(width(glyph), 1, `${status} glyph is one cell: ${JSON.stringify(glyph)}`);
    assert.equal(glyph, GLYPHS[status], status);
    glyphs.add(glyph);
  }
  assert.equal(glyphs.size, STATUSES.length, `six distinct glyphs, got ${[...glyphs].join(",")}`);
  // AC2.2: failed and aborted are two different glyphs and two different words.
  const line = (status) => plainLine(frameOf([card("c1", { title: "item one", status })],
    { view: { follow: false, showCompleted: true } }).bodyLines[0]);
  assert.equal(line("failed")[2], "×");
  assert.equal(line("aborted")[2], "⊘");
  assert.notEqual(line("failed")[2], line("aborted")[2]);
  assert.match(line("failed"), / · failed/);
  assert.match(line("aborted"), / · aborted/);
  assert.doesNotMatch(line("failed"), /aborted/);
  assert.doesNotMatch(line("aborted"), /failed/);
  assert.notEqual(WORDS.ko.failed, WORDS.ko.aborted);
  assert.notEqual(WORDS.en.failed, WORDS.en.aborted);
});

// Q3=A: running and done carry the glyph only; every other state keeps its word.
// The neutral title proves the word can only come from the emitted suffix.
test("Q3=A: running and done show the glyph only, the other states keep their word", () => {
  for (const language of Object.keys(WORDS)) {
    const line = (status) => plainLine(frameOf([card("c1", { title: "item one", status })],
      { language, view: { follow: false, showCompleted: true } }).bodyLines[0]);
    for (const status of ["running", "completed"]) {
      assert.ok(!line(status).includes(` · ${WORDS[language][status]}`),
        `${language}/${status}: no status word: ${line(status)}`);
    }
    for (const status of ["pending", "failed", "aborted", "paused"]) {
      assert.ok(line(status).includes(` · ${WORDS[language][status]}`),
        `${language}/${status}: status word: ${line(status)}`);
    }
    // The glyph always survives, in every language and state.
    for (const status of STATUSES) assert.equal(line(status)[2], GLYPHS[status], `${language}/${status}`);
  }
});

// AC-F4 (amended by Q3=A): at 24 columns the title keeps at least one cell and the
// status indicator survives: the glyph for running and done, glyph plus word for the
// other states. Content is asserted, never width alone.
for (const columns of [24, 40, 54]) {
  for (const language of ["ko", "en"]) {
    test(`${columns} columns in ${language}: title, glyph and the Q3=A status indicator survive`, () => {
      for (const status of STATUSES) {
        // The fixture title cannot contain a status word, so only the emitted suffix
        // can satisfy the status assertion below (AC-F4).
        const title = "item one";
        const line = plainLine(frameOf([card("c1", { title, status })],
          { columns, language, view: { follow: false, showCompleted: true } }).bodyLines[0]);
        assert.ok(line.includes(title), `${columns}/${language}/${status}: title: ${line}`);
        assert.equal(line[2], GLYPHS[status], `${columns}/${language}/${status}: glyph: ${line}`);
        if (status === "running" || status === "completed") {
          assert.ok(!line.includes(` · ${WORDS[language][status]}`),
            `${columns}/${language}/${status}: glyph only: ${line}`);
        } else {
          assert.ok(line.includes(` · ${WORDS[language][status]}`),
            `${columns}/${language}/${status}: status word: ${line}`);
        }
        assert.ok(width(line) <= columns - 1, `${columns}/${language}/${status}: ${width(line)} cells`);
      }
    });
  }
}

// A long title at the narrow end: the title is what truncates with the Workers `…`
// mark, so the status label is still whole and still readable.
test("a long title truncates with `…` but never pushes the status off a 24-column pane", () => {
  for (const language of ["ko", "en", "zh-cn"]) {
    const frame = frameOf([card("c1", { title: "x".repeat(80), status: "failed" })],
      { columns: 24, language });
    const line = plainLine(frame.bodyLines[0]);
    assert.equal(line[2], "×", language);
    assert.ok(line.includes(` · ${WORDS[language].failed}`), `${language}: ${line}`);
    assert.match(line, /x{4,}…/);
    assert.ok(width(line) <= 23);
  }
  // Even a pathological width degrades to one coloured strip rather than a status
  // that fell off the row.
  const tiny = frameOf([card("c1", { title: "t", status: "aborted" })], { columns: 4 });
  assert.equal(tiny.lines.length, 8);
  assert.ok(width(tiny.bodyLines[0]) <= 3, tiny.bodyLines[0]);
});

for (const [columns, rows] of [[80, 24], [54, 23], [40, 16], [24, 12], [12, 4], [1, 1]]) {
  test(`${columns}x${rows}: a bounded frame whose caller footer survives`, () => {
    const frame = frameOf([card("c1"), card("c2", { status: "completed" })],
      { columns, rows, language: "ko", footer: ["FOOTER"] });
    assert.equal(frame.lines.length, rows);
    assert.equal(frame.text.split("\n").length, rows);
    // AC-F1/F3: the caller's footer is the last row and is never cut, at any width.
    // The one-column inset is added only when it fits.
    const usable = Math.max(1, columns - 1);
    const expected = width("FOOTER") + 1 <= usable ? " FOOTER" : "FOOTER";
    assert.equal(plainLine(frame.lines.at(-1)), expected);
    // Everything this renderer sized stays inside the pane; the footer is the only row
    // allowed to overflow, because the caller owns its content. At one column the
    // fallback header is empty, so the pane's own rows still fit the zero-cell budget.
    const budget = columns === 1 ? 0 : columns - 1;
    for (const line of frame.lines.slice(0, -1)) {
      assert.ok(width(line) <= budget, `${columns}x${rows}: ${JSON.stringify(line)}`);
      assert.ok(cells(line) <= budget, `${columns}x${rows} (oracle): ${JSON.stringify(line)}`);
    }
    assert.ok(frame.scroll >= 0 && frame.scroll <= frame.maxScroll);
  });
}

test("the empty, waiting and source-error states use the OMO empty shape", () => {
  const body = (proj, language = "en", color = false) => renderWorkers(proj,
    { columns: 40, rows: 9, color, language, footer: ["F"] }).bodyLines;
  const plainBody = (proj, language = "en") => body(proj, language).map(plainLine);
  const expected = {
    ko: { empty: "No workers yet", waiting: "Waiting for the Workers source.",
      error: "Cannot read the Workers source.", hint1: "Workers from this chat", hint2: "show here." },
    en: { empty: "No workers yet", waiting: "Waiting for the Workers source.",
      error: "Cannot read the Workers source.", hint1: "Workers from this chat", hint2: "show here." },
    "zh-cn": { empty: "当前没有运行中的任务。", waiting: "等待 Workers 来源。",
      error: "无法读取 Workers 来源。", hint1: "本会话启动的工作者", hint2: "会显示在这里。" },
  };
  for (const [language, words] of Object.entries(expected)) {
    assert.deepEqual(plainBody(projection([]), language),
      ["", `  ○  ${words.empty}`, "", `  ${words.hint1}`, `  ${words.hint2}`], language);
    assert.deepEqual(plainBody(null, language), ["", `  ○  ${words.waiting}`], language);
    assert.deepEqual(plainBody(projection([], { sourceError: "bus handler exploded" }), language),
      ["", `  ○  ${words.error}`], language);
    // Three distinct sentences per language.
    assert.equal(new Set([words.empty, words.waiting, words.error]).size, 3, language);
  }
  // ko and en share the English pane chrome; zh-cn keeps its translations.
  assert.deepEqual(expected.ko, expected.en);
  for (const key of Object.keys(expected.ko)) {
    assert.notEqual(expected["zh-cn"][key], expected.ko[key], key);
  }
  // Only the two hint rows are dim; the ○ row itself is plain (OMO :612-616).
  const colored = body(projection([]), "en", true);
  assert.ok(!colored[1].includes("\x1b[2m"), colored[1]);
  assert.ok(colored[3].includes("\x1b[2m"), colored[3]);
  assert.ok(colored[4].includes("\x1b[2m"), colored[4]);
});

test("connection is derived from the projection, and the caller's link outranks it", () => {
  const connection = (proj, options = {}) => renderWorkers(proj,
    { columns: 40, rows: 5, footer: ["F"], ...options }).connection;
  assert.equal(connection(null), "waiting");
  assert.equal(connection(projection([])), "empty");
  assert.equal(connection(one()), "live");
  // A disconnected owner wins even while the last projection still looks healthy.
  assert.equal(connection(one(), { connection: { kind: "disconnected", at: 0 } }), "disconnected");
  assert.equal(connection(projection([]), { connection: { kind: "disconnected", at: 0 } }), "disconnected");
  assert.equal(connection(one(), { connection: { kind: "bogus" } }), "live", "unknown kinds fall back");
  // The link decides the footer colour: live and EMPTY are connected (cyan), the
  // other states are yellow. The inset sits outside the colour sequence.
  const footer = (proj, link) => renderWorkers(proj, { columns: 60, rows: 6, color: true,
    connection: link, footer: ["Follow ON · LIVE"] }).lines.at(-1);
  assert.equal(footer(one(), { kind: "live", at: 0 }), " \x1b[36mFollow ON · LIVE\x1b[0m");
  assert.equal(footer(projection([]), { kind: "empty", at: 0 }), " \x1b[36mFollow ON · LIVE\x1b[0m");
  assert.equal(footer(one(), { kind: "disconnected", at: 0 }), " \x1b[33mFollow ON · LIVE\x1b[0m");
  assert.equal(footer(one(), { kind: "source-error", at: 0 }), " \x1b[33mFollow ON · LIVE\x1b[0m");
  // A host source error outranks the cards it kept: the row says so above the body and
  // the surviving cards stay selectable and still render.
  const failed = renderWorkers(projection([card("c1", { title: "kept", status: "running" })],
    { sourceError: "handlers exploded" }),
  { columns: 60, rows: 6, color: false, language: "en", view: { follow: false }, footer: ["F"] });
  assert.equal(failed.connection, "source-error");
  assert.match(failed.lines[2], /Source error: handlers exploded/);
  assert.deepEqual(failed.selectable, ["c1"]);
  assert.equal(failed.empty, false);
  assert.match(failed.bodyLines[0], /kept/);
});

test("an empty projection renders the five OMO rows and reports no selection", () => {
  const frame = renderWorkers(projection([]), { columns: 40, rows: 6, color: false, language: "ko",
    view: { selection: "gone", detail: true, follow: false }, footer: ["F"] });
  assert.deepEqual(frame.selectable, []);
  assert.equal(frame.selection, null);
  assert.equal(frame.bodyLines.length, 5);
  assert.equal(frame.empty, true);
  assert.deepEqual(stepSelection(frame, 1), { selection: null, scroll: frame.scroll });
  assert.deepEqual(stepSelection(frame, -1), { selection: null, scroll: frame.scroll });
});

// G9: completed cards are hidden behind the header count. `c` shows them folded to
// row 1 only, an explicit expand shows the full card, and a selected completed card
// stays drawn so Space never acts on an invisible card.
test("completed cards hide behind `done N ▸`, show as one row under `▾`, and expand on demand", () => {
  const cards = [card("c1", { title: "done one", status: "completed", lastIntent: "finished" }),
    card("c2", { title: "failed one", status: "failed", lastOutput: "EACCES" })];
  const frame = (view) => frameOf(cards, { view: { follow: false, ...view } });
  const folded = frame({});
  assert.doesNotMatch(folded.bodyLines.join("\n"), /done one/, "a completed card is not drawn");
  assert.equal(folded.ranges.c1, undefined);
  assert.deepEqual(folded.selectable, ["c2"]);
  assert.equal(folded.bodyLines.length, 3, "the failed card keeps its title, role and metrics rows");
  assert.match(folded.bodyLines[0], /failed one/);
  assert.equal(folded.lines[0], " Workers [1/2]  run 0 · failed 1 · done 1 ▸");
  // `c` unfolds the group to row 1 only and turns the mark.
  const all = frame({ showCompleted: true });
  assert.equal(all.bodyLines.length, 4);
  assert.equal(all.ranges.c1.end - all.ranges.c1.start, 1);
  assert.doesNotMatch(all.bodyLines[0], /finished/, "a folded card has no detail rows");
  assert.equal(all.lines[0], " Workers [1/2]  run 0 · failed 1 · done 1 ▾");
  assert.deepEqual(all.selectable, ["c1", "c2"]);
  // An explicit expand draws the full completed card.
  const expanded = frame({ expanded: { c1: true } });
  assert.equal(expanded.bodyLines.length, 6);
  assert.equal(expanded.ranges.c1.end - expanded.ranges.c1.start, 3);
  assert.match(expanded.bodyLines[1], /\[subagent\]/);
  assert.match(expanded.bodyLines[2], /0 tok/);
  // A selected card that completes stays drawn with the marker, and Space's expand
  // flag then opens that same id; the header still says the group is hidden.
  const selected = frame({ selection: "c1" });
  assert.equal(selected.selection, "c1");
  assert.deepEqual(selected.selectable, ["c1", "c2"]);
  assert.equal(selected.bodyLines[0][0], ">");
  assert.match(selected.bodyLines[0], /done one/);
  assert.equal(selected.ranges.c1.end - selected.ranges.c1.start, 1);
  assert.equal(selected.lines[0].endsWith("done 1 ▸"), true);
  const opened = frame({ selection: "c1", expanded: { c1: true } });
  assert.equal(opened.ranges.c1.end - opened.ranges.c1.start, 3);
  // Failed and aborted never fold: both keep title, role and metrics rows.
  const problems = frameOf([card("a", { title: "alpha", status: "failed" }),
    card("b", { title: "beta", status: "aborted" })]);
  assert.equal(problems.bodyLines.length, 6);
  assert.equal(problems.ranges.a.end - problems.ranges.a.start, 3);
  assert.equal(problems.ranges.b.end - problems.ranges.b.start, 3);
});

// One row at completion: the title row, no bar, no role row, no metrics row.
test("a folded completed card is one row with no bar", () => {
  const frame = frameOf([card("c1", { title: "done one", status: "completed", tokens: 900,
    toolCount: 2, durationMs: 12000 })], { view: { follow: false, showCompleted: true } });
  assert.equal(frame.bodyLines.length, 1);
  const line = plainLine(frame.bodyLines[0]);
  assert.match(line, /done one/);
  assert.equal(line[0], ">", "the only drawn card is the resolved selection");
  assert.equal(line[1], " ", "a one-row card gets a space instead of the bar");
  assert.equal(line[2], "✓");
  assert.match(line, / · ⧖ 12s/);
});

test("a running card is the three-row OMO card; tool, intent and output are detail-only", () => {
  const frame = frameOf([card("c1", { title: "live", status: "running", currentTool: "read",
    lastIntent: "reading the plan", lastOutput: "line 4", tokens: 48000, toolCount: 12,
    contextPercent: 41 })]);
  assert.equal(frame.bodyLines.length, 3);
  assert.match(frame.bodyLines[0], /live/);
  assert.equal(plainLine(frame.bodyLines[1]).slice(2), "[subagent]");
  assert.equal(plainLine(frame.bodyLines[2]).slice(2), "48K tok · 12 tools · ctx 41%");
  const joined = plainLine(frame.bodyLines.join("\n"));
  assert.doesNotMatch(joined, /read|reading the plan|line 4/);
  // A bare card with nothing on rows 2 and 3 is one row and carries no bar.
  const bare = frameOf([card("c1", { title: "bare", status: "running", agent: "",
    tokens: null, toolCount: null, contextPercent: null })]);
  assert.equal(bare.bodyLines.length, 1);
  assert.equal(plainLine(bare.bodyLines[0])[1], " ");
  assert.doesNotMatch(plainLine(bare.bodyLines[0]), /▌/);
  // A running row always keeps its spinner glyph even without a word.
  assert.equal(plainLine(bare.bodyLines[0])[2], "⠋");
});

test("the metrics row is tokens, tools, context and omits every missing value", () => {
  const metrics = (extra, options = {}) => {
    const frame = frameOf([card("c1", { title: "t", status: "running", ...extra })], options);
    return frame.bodyLines[2] === undefined ? null : plainLine(frame.bodyLines[2]).slice(2);
  };
  assert.equal(metrics({ tokens: 48000, toolCount: 12, contextPercent: 41.6 }),
    "48K tok · 12 tools · ctx 42%");
  assert.equal(metrics({ tokens: 48000, toolCount: 12, contextPercent: null }),
    "48K tok · 12 tools", "a null context is omitted");
  assert.equal(metrics({ tokens: null, toolCount: 12, contextPercent: 41 }),
    "12 tools · ctx 41%", "a missing token count is omitted");
  assert.equal(metrics({ tokens: null, toolCount: null, contextPercent: null }), null,
    "an empty metrics row is not drawn");
  assert.equal(metrics({ tokens: 0, toolCount: 0, contextPercent: null }), "0 tok · 0 tools",
    "a real zero is a measurement");
  // Cost is never on the list row (K1 lives in the detail view).
  assert.equal(metrics({ tokens: 1, toolCount: 1, contextPercent: 1, cost: 0.5 }),
    "1 tok · 1 tools · ctx 1%");
});

// AC2.6: the background mark rides on row 2, never on the title row, and a neutral
// title means only the emitted mark can satisfy the assertion.
test("AC2.6: `background` rides on card row 2", () => {
  const cards = [card("c1", { title: "alpha", status: "running" }),
    card("c2", { title: "beta", status: "running", background: true })];
  for (const [language, word] of [["ko", "background"], ["en", "background"], ["zh-cn", "后台"]]) {
    const frame = frameOf(cards, { language });
    assert.equal(plainLine(frame.bodyLines[1]).slice(2), "[subagent]");
    assert.match(plainLine(frame.bodyLines[4]), new RegExp(`\\[subagent\\] ${word}`));
    assert.doesNotMatch(plainLine(frame.bodyLines.slice(0, 3).join("\n")), new RegExp(word));
  }
  // A background card with no agent still names the mark.
  const bare = frameOf([card("c1", { title: "alpha", status: "running", agent: "",
    background: true })]);
  assert.equal(plainLine(bare.bodyLines[1]).slice(2), "background");
});

// K1: a reported 0 is exactly the "never measured" ambiguity, so the detail view
// prints `?`, never a confident `$0.0000`. The list has no cost row at all.
test("K1: an unknown cost is `?` in the detail view only", () => {
  const detail = (cost) => renderWorkers(projection([card("c1", { title: "alpha",
    status: "running", cost })]), { columns: 60, rows: 8, color: false, language: "en",
    view: { follow: false, detail: true }, footer: ["F"] });
  for (const cost of [null, undefined, 0, -1, NaN, "0.5"]) {
    const joined = detail(cost).bodyLines.join("\n");
    assert.match(joined, /cost: \?/, `${String(cost)}: ${joined}`);
    assert.doesNotMatch(joined, /\$0\.0000/);
  }
  assert.match(detail(0.0123).bodyLines.join("\n"), /cost: \$0\.0123/);
  assert.match(detail(1000000).bodyLines.join("\n"), /cost: \$1000000\.0000/);
  // The list never prints the cost, even when the projection carries one.
  const list = frameOf([card("c1", { title: "alpha", cost: 0.5 })]);
  assert.doesNotMatch(plainLine(list.bodyLines.join("\n")), /cost|\$/);
});

test("a running card's duration follows startedAt; a finished card keeps its own", () => {
  const title = (extra, options = {}) => plainLine(frameOf([card("c1", { title: "t", ...extra })],
    { now: 70000, columns: 60, view: { follow: false, ...options } }).bodyLines[0]);
  // A running card's published durationMs is a floor: a stale bus value never rewinds
  // the elapsed clock, and a fresher one is kept.
  assert.match(title({ status: "running", durationMs: 5000, startedAt: 1000 }), /⧖ 1m 9s$/);
  assert.match(title({ status: "running", durationMs: 90000, startedAt: 1000 }), /⧖ 1m 30s$/);
  assert.match(title({ status: "running", durationMs: 5000 }), /⧖ 5s$/);
  // A finished card keeps the recorded duration: now - startedAt would keep growing.
  assert.match(title({ status: "completed", durationMs: 5000, startedAt: 1000 },
    { showCompleted: true }), /⧖ 5s$/);
  assert.match(title({ status: "aborted", durationMs: 5000, startedAt: 1000 }), /⧖ 5s$/);
  // Hours are compact in every language.
  const long = { status: "running", durationMs: 3 * 3600 * 1000 + 61_000 };
  assert.match(title(long), /⧖ 3h 1m 1s$/);
  assert.match(plainLine(frameOf([card("c1", { title: "t", ...long })],
    { language: "zh-cn", columns: 60, view: { follow: false } }).bodyLines[0]), /⧖ 3小时 1分 1秒$/);
  // The time moves to the front of row 3 when the title would keep fewer than ten
  // cells beside it (OMO :409-410).
  const moved = frameOf([card("c1", { title: "x".repeat(80), status: "running", ...long })],
    { columns: 24, now: 70000 });
  assert.doesNotMatch(plainLine(moved.bodyLines[0]), /⧖/);
  assert.match(plainLine(moved.bodyLines[2]), /⧖ 3h 1m 1s · 0 tok/);
  assert.match(plainLine(moved.bodyLines[2]), /…$/);
  // The time is yellow while running and grey otherwise.
  const running = frameOf([card("c1", { title: "t", status: "running", durationMs: 61000 })],
    { columns: 60, color: true });
  assert.match(running.bodyLines[0], /\x1b\[33m · ⧖ 1m 1s\x1b\[0m/);
  const finished = frameOf([card("c1", { title: "t", status: "completed", durationMs: 61000 })],
    { columns: 60, color: true, view: { follow: false, showCompleted: true } });
  assert.match(finished.bodyLines[0], /\x1b\[90m · ⧖ 1m 1s\x1b\[0m/);
});

test("a retry adds one alert row in yellow and the detail keeps the retry field", () => {
  const cards = [card("c1", { title: "alpha", status: "failed", retry: { attempt: 2, delayMs: 3000 } })];
  const list = frameOf(cards);
  assert.equal(list.bodyLines.length, 4, "title, role, metrics, alert");
  assert.equal(plainLine(list.bodyLines[3]).slice(2), "↻ 2 · 3s");
  assert.match(frameOf(cards, { color: true }).bodyLines[3], /\x1b\[33m/);
  const detail = frameOf(cards, { view: { follow: false, detail: true } });
  assert.match(plainLine(detail.bodyLines.join("\n")), /retry: 2 \(3s\)/);
  // No retry object, no alert row; an unknown attempt still names the row.
  assert.equal(frameOf([card("c1", { title: "alpha", status: "failed" })]).bodyLines.length, 3);
  const unknown = frameOf([card("c1", { title: "alpha", status: "failed",
    retry: { attempt: null, delayMs: null } })]);
  assert.match(plainLine(unknown.bodyLines[3]), /^ ▌↻ \? · \?$/);
});

test("`d` expands only the selected card's record and never changes the selection", () => {
  const cards = [card("c1", { title: "alpha", status: "running", currentTool: "read",
    lastIntent: "reading", lastOutput: "ok", durationMs: 65000,
    retry: { attempt: 2, delayMs: 3000 } }),
    card("c2", { title: "beta", status: "pending" })];
  const view = { follow: false, selection: "c1" };
  const tall = { rows: 14 };
  const list = frameOf(cards, { ...tall, view });
  const detail = frameOf(cards, { ...tall, view: { ...view, detail: true } });
  assert.ok(detail.bodyLines.length > list.bodyLines.length);
  assert.deepEqual(detail.selectable, list.selectable);
  assert.equal(detail.selection, "c1");
  const joined = plainLine(detail.bodyLines.join("\n"));
  for (const field of ["id: c1", "agent: subagent", "status: running", "tool: read",
    "intent: reading", "last output: ok", "cost: ?", "⧖ 1m 5s", "retry: 2 (3s)"]) {
    assert.ok(joined.includes(field), `detail shows ${field}: ${joined}`);
  }
  // Only the selected card grows: the other card keeps its three rows.
  assert.equal(detail.ranges.c2.end - detail.ranges.c2.start, 3);
  assert.ok(detail.ranges.c1.end - detail.ranges.c1.start > list.ranges.c1.end - list.ranges.c1.start);
  // A detail view with no explicit selection still resolves to the newest card, and `d`
  // again restores the list frame exactly (the toggle is symmetric).
  const fallback = frameOf(cards, { ...tall, view: { follow: false, detail: true } });
  assert.equal(fallback.selection, "c1");
  assert.notEqual(fallback.text, list.text);
  assert.equal(frameOf(cards, { ...tall, view: { follow: false, detail: false } }).text, list.text);
  // An absent field is the unknown label, not the string "undefined", and no retry row
  // appears when the card carries none.
  const bare = frameOf([card("c1", { title: "alpha", status: "failed" })],
    { view: { follow: false, detail: true } });
  assert.match(plainLine(bare.bodyLines.join("\n")), /intent: \?/);
  assert.doesNotMatch(plainLine(bare.bodyLines.join("\n")), /undefined/);
  assert.doesNotMatch(plainLine(bare.bodyLines.join("\n")), /retry:/);
});

test("a selected card is marked in column 0 and the selection resolves against drawn cards", () => {
  const cards = [card("c1", { title: "newest" }), card("c2", { title: "older" })];
  const frame = (selection, options = {}) => frameOf(cards, { view: { follow: false, selection }, ...options });
  assert.equal(frame("c2").selection, "c2");
  // Each running card is three rows, so the second card's title is bodyLines[3].
  assert.equal(frame("c2").bodyLines[0][0], " ", "an unselected card carries no marker");
  assert.equal(frame("c2").bodyLines[3][0], ">", "the selected card carries the marker");
  assert.equal(frame("c1").bodyLines[0][0], ">");
  assert.equal(frame("gone").selection, "c1");
  assert.equal(frame(null).selection, "c1");
  assert.equal(frame(7).selection, "c1");
  assert.equal(frame("").selection, "c1");
  // A hidden completed card is not a selectable id until it is selected or shown.
  const hidden = frameOf([card("c1", { status: "completed" }),
    card("c2", { title: "newest" })], { view: { follow: false, selection: "gone" } });
  assert.equal(hidden.selection, "c2");
  assert.deepEqual(hidden.selectable, ["c2"]);
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
  // One-row running cards make the body math exact: ten cards, ten body rows.
  const cards = Array.from({ length: 10 }, (_, index) =>
    card(`c${index + 1}`, { title: `card ${index + 1}`, status: "running", agent: "",
      tokens: null, toolCount: null, contextPercent: null }));
  const wide = { columns: 40, rows: 8, color: false, language: "en", footer: ["F"] };
  const bodyRows = 8 - 2 - 1 - 1;
  const far = renderWorkers(projection(cards), { ...wide, view: { follow: false, scroll: 99 } });
  assert.equal(far.bodyRows, bodyRows);
  assert.equal(far.maxScroll, 10 - bodyRows);
  assert.equal(far.scroll, far.maxScroll, "a scroll past the end is clamped");
  assert.equal(far.lines.length, 8);
  assert.ok(far.bodyLines[far.scroll].includes("card 7"));
  assert.equal(renderWorkers(projection(cards), { ...wide, view: { follow: false, scroll: -4 } }).scroll, 0);
  // A mistyped scroll is clamped to a number, never NaN, so the frame's own scroll can
  // be persisted straight back to disk ("9" is read as 9 and then clamped to the end).
  assert.equal(renderWorkers(projection(cards), { ...wide, view: { follow: false, scroll: "9" } }).scroll,
    6);
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
    card(`c${index + 1}`, { title: `card ${index + 1}`, status: "running", agent: "",
      tokens: null, toolCount: null, contextPercent: null }));
  const options = { columns: 40, rows: 6, color: false, language: "en", footer: ["F"] };
  let current = renderWorkers(projection(cards), { ...options, view: { follow: false, selection: "c1" } });
  assert.equal(current.bodyRows, 2);
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
  const footer = ["Follow ON · LIVE", "second footer row"];
  const frame = frameOf([card("c1")], { language: "ko", rows: 8, footer });
  // The inset is one cell when it fits, and sits outside the colour sequence.
  assert.deepEqual(frame.lines.slice(-2), [" Follow ON · LIVE", " second footer row"]);
  assert.equal(frame.bodyStart, 2, "header + divider are above the body");
  assert.equal(frame.bodyRows, 8 - 2 - 1 - 2);
  // The renderer never invents, wraps or truncates a footer row: a 200-cell row stays
  // one row, even at one column.
  const long = "F".repeat(200);
  const narrow = frameOf([card("c1")], { columns: 1, rows: 4, footer: [long] });
  assert.equal(narrow.lines.length, 4);
  assert.equal(narrow.lines.at(-1), long);
  // An explicitly empty footer is honoured; a non-string entry cannot break the frame.
  assert.equal(frameOf([card("c1")], { rows: 6, footer: [] }).lines.at(-1),
    "─".repeat(79), "with no footer rows the bottom divider is last");
  assert.equal(frameOf([card("c1")], { rows: 6, footer: [null, "ok"] }).lines.at(-1), " ok");
  // A control sequence in a caller's footer row cannot repaint the pane.
  const escaped = frameOf([card("c1")], { rows: 6, footer: ["\x1b[2Jgone"] });
  assert.equal(escaped.lines.at(-1), " gone");
  // The footer divider is the OMO dim divider (ANSI 2), not the Todo grey (90).
  const colored = frameOf([card("c1")], { rows: 6, footer: ["F"], color: true });
  assert.equal(colored.lines[1], "\x1b[2m" + "─".repeat(79) + "\x1b[0m");
  assert.equal(colored.lines.at(-2), "\x1b[2m" + "─".repeat(79) + "\x1b[0m");
});

test("the header is `Workers [done/total]` with an always-present run count and the fold mark", () => {
  const cards = [card("c1", { title: "foreground", status: "running" }),
    card("c2", { title: "detached", status: "running", background: true }),
    card("c3", { title: "broken", status: "failed" }),
    card("c4", { title: "stopped", status: "aborted" }),
    card("c5", { title: "finished", status: "completed" })];
  // The failed and aborted tallies stay apart (AC2.2); `run` is always present.
  const ko = frameOf(cards, { language: "ko", columns: 100, rows: 20,
    view: { follow: false, showCompleted: true } });
  assert.equal(ko.lines[0], " Workers [1/5]  run 2 · failed 1 · aborted 1 · done 1 ▾");
  const en = frameOf(cards, { language: "en", columns: 100, rows: 20,
    view: { follow: false, showCompleted: true } });
  assert.equal(en.lines[0], ko.lines[0]);
  const zh = frameOf(cards, { language: "zh-cn", columns: 100, rows: 20,
    view: { follow: false, showCompleted: true } });
  assert.equal(zh.lines[0], " Workers [1/5]  运行 2 · 失败 1 · 中止 1 · 完成 1 ▾");
  // Fold mark off by default; a single-card projection says run 0.
  assert.equal(frameOf(cards, { columns: 100, rows: 20 }).lines[0],
    " Workers [1/5]  run 2 · failed 1 · aborted 1 · done 1 ▸");
  assert.equal(frameOf([card("c1", { status: "paused" })]).lines[0],
    " Workers [0/1]  run 0 · paused 1");
  assert.equal(frameOf([], { rows: 6 }).lines[0], " Workers [0/0]  run 0");
  // A card with no title falls back to its agent and then to its id, never a blank row.
  const bare = frameOf([card("c9", { title: "", agent: "", status: "pending" })]);
  assert.match(bare.bodyLines[0], /c9/);
  const agent = frameOf([card("c9", { title: "", agent: "explorer", status: "pending" })]);
  assert.match(agent.bodyLines[0], /explorer/);
});

test("a narrow mixed header drops secondary tallies before the completed fold", () => {
  const cards = [card("r", { title: "run", status: "running" }),
    card("f", { title: "fail", status: "failed" }),
    card("c", { title: "done", status: "completed" })];
  const header = (columns, showCompleted = false) => frameOf(cards, { columns, rows: 14,
    view: { follow: false, showCompleted } }).lines[0];
  // 34 columns: failed is dropped first, but the done count and its mark survive.
  assert.equal(header(34), " Workers [1/3]  run 1 · done 1 ▸");
  assert.equal(header(34, true), " Workers [1/3]  run 1 · done 1 ▾");
  // 24/26 columns still clip the retained summary like OMO rather than dropping the mark
  // for a different one; the run count is always readable.
  assert.equal(header(24), " Workers [1/3]  run 1 …");
  assert.equal(header(26), " Workers [1/3]  run 1 · …");
  // Wide panes keep every tally in the documented order.
  assert.equal(header(54), " Workers [1/3]  run 1 · failed 1 · done 1 ▸");
  // Drop order is paused, aborted, failed; the fold segment is never dropped while it fits.
  const all = [card("r", { status: "running" }), card("f", { status: "failed" }),
    card("a", { status: "aborted" }), card("p", { status: "paused" }),
    card("c", { status: "completed" })];
  const five = frameOf(all, { columns: 52, rows: 14, view: { follow: false } }).lines[0];
  assert.equal(five, " Workers [1/5]  run 1 · failed 1 · done 1 ▸");
});

test("the header name is bold cyan in every state, the tally is bold yellow, the summary dim", () => {
  const frame = frameOf([card("c1")], { columns: 60, color: true });
  assert.ok(frame.lines[0].startsWith(" \x1b[1;36mWorkers\x1b[0m \x1b[1;33m["));
  // A disconnected pane keeps the same header colours (the link colours the footer).
  const offline = frameOf([card("c1")], { columns: 60, color: true,
    connection: { kind: "disconnected", at: 0 } });
  assert.ok(offline.lines[0].startsWith(" \x1b[1;36mWorkers\x1b[0m \x1b[1;33m["));
});

test("the spinner cycles the ten OMO frames and normalises a bad spin value", () => {
  const glyph = (spin) => plainLine(frameOf([card("c1", { title: "spin", status: "running" })],
    { spin }).bodyLines[0])[2];
  for (let frame = 0; frame < SPINNER.length; frame++) assert.equal(glyph(frame), SPINNER[frame]);
  assert.equal(glyph(10), SPINNER[0], "ten frames wrap");
  assert.equal(glyph(-1), SPINNER[9], "a negative frame wraps backwards");
  assert.equal(glyph(1.5), SPINNER[0], "a non-integer falls back to frame 0");
  assert.deepEqual([...SPINNER], ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
});

test("color only wraps already-sized runs, so it never changes a row width", () => {
  const cards = STATUSES.map((status) => card(status, { title: `${status} card`, status,
    durationMs: 61000, toolCount: 2, tokens: 40, contextPercent: 12.5, cost: 0.5 }));
  const options = { columns: 54, rows: 20, language: "ko",
    view: { follow: false, showCompleted: true }, footer: ["Follow ON · LIVE"] };
  const plain = renderWorkers(projection(cards), { ...options, color: false });
  const colored = renderWorkers(projection(cards), { ...options, color: true });
  assert.equal(plain.lines.length, colored.lines.length);
  for (const [index, line] of colored.lines.entries()) {
    assert.ok(line.includes("\x1b["), `row ${index} is painted`);
    assert.equal(stripVTControlCharacters(line), plain.lines[index], `row ${index}`);
    assert.equal(width(line), width(plain.lines[index]), `row ${index} width`);
    assert.ok(line.endsWith("\x1b[0m"), `row ${index} closes its colour`);
  }
  // `text` is exactly the frame `lines`.
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
    assert.match(frame.bodyLines[0], /한글 제목/);
  }
});

test("the narrow fallback keeps the caller's footer and never claims an unknown status", () => {
  const odd = projection([card("c1", { title: "mystery", status: "teleported" })]);
  for (const [columns, rows] of [[12, 4], [1, 2], [40, 3]]) {
    const narrow = renderWorkers(odd, { columns, rows, color: false, language: "en", footer: ["F"] });
    assert.equal(narrow.lines.length, rows, `${columns}x${rows}`);
    const expected = width("F") + 1 <= Math.max(1, columns - 1) ? " F" : "F";
    assert.equal(narrow.lines.at(-1), expected);
    assert.equal(narrow.bodyRows, 0);
    assert.equal(narrow.maxScroll, 0);
    assert.equal(narrow.scroll, 0);
  }
  // An unknown status is a localized word and the `?` glyph, never a blank or a crash.
  const wide = renderWorkers(odd, { columns: 60, rows: 8, color: false, language: "en",
    view: { detail: true, follow: false }, footer: ["F"] });
  assert.equal(plainLine(wide.bodyLines[0])[2], "?");
  assert.match(wide.bodyLines[0], /unknown/);
  assert.match(wide.bodyLines.join("\n"), /status: unknown/);
  assert.equal(width(wide.bodyLines[0]), width(stripVTControlCharacters(wide.bodyLines[0])));
  // The renderer leans on the shared primitives rather than its own copies (Todo keeps
  // the default `~` mark; the Workers renderer passes `…` explicitly).
  assert.equal(fit("한글A", 4), "한~");
  assert.deepEqual(wrap("가나다라마바사", 6), ["가나다", "라마바", "사"]);
});
