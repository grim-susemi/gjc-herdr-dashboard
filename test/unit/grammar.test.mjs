// Golden-frame tests for the shared pane grammar (GRAMMAR.md G1-G13).
//
// The expected frames are plain text, one per pane state at 24, 26, 34, 52 and 54
// columns with 14 rows, spin 0 and a fixed clock. They pin the written grammar of
// GRAMMAR.md, which mirrors omo-herdr-dashboard 3242ad4; each case names the rule
// ids it exercises in its title, and a separate test proves the rule and deviation
// lists in GRAMMAR.md are complete. No snapshot files are written at test time, no
// wall clock is read, and every ko/en pair must render the identical English frame.
//
// The one width exception is the never-truncated footer (GRAMMAR G3, Deviations
// AC-F1/AC-F3): at 24 columns "Follow ON · SOURCE ERROR" is 24 cells and at 24/26
// "Follow OFF · OFFLINE 09:05" is 26 cells, both wider than the usable columns-1
// row. FOOTER_EXCEPTIONS names those panes, states and widths; any other overflow
// fails the test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { width } from "../../src/viewers/common.mjs";
import { renderFrame } from "../../src/viewers/todo/render.mjs";
import { renderWorkers, SPINNER } from "../../src/viewers/workers/render.mjs";

const NOW = new Date(2026, 0, 2, 9, 5).getTime();
const WIDTHS = [24, 26, 34, 52, 54];
const ROWS = 14;
const LANGUAGE_PAIR = ["ko", "en"];

const todoProjection = (phases, extra = {}) => ({ schema: "gjc-herdr-dashboard/todo/1",
  updatedAt: 1, phases, empty: phases.every((phase) => phase.tasks.length === 0), sourceError: null, ...extra });

// G5/G6 fixture: a closed phase that stays folded, one in-progress task (the default
// selection, G12) and one pending task. The goal is the G6 row.
const todoLive = (extra = {}) => todoProjection([
  { name: "Foundation", tasks: [{ content: "Confirmed authority", status: "completed" },
    { content: "Retired alternative", status: "abandoned" }] },
  { name: "Implementation", tasks: [{ content: "Wire the grammar", status: "in_progress" },
    { content: "Pin the frames", status: "pending" }] },
], extra);

const GOAL = Object.freeze({ objective: "Align both panes", status: "active",
  tokensUsed: 12345, timeUsedSeconds: 303 });

const workerCard = (id, extra = {}) => ({ id, agent: "worker", title: `card ${id}`,
  status: "running", background: false, currentTool: null, lastIntent: null, lastOutput: null,
  toolCount: 0, tokens: 0, contextPercent: null, cost: null, durationMs: 0,
  retry: null, startedAt: null, endedAt: null, ...extra });

// G7/G8/G9 fixture: one running card (selected), one failed card carrying the AC2.6
// background mark on row 2, and one completed card that folds unless showCompleted.
const workerCards = () => [
  workerCard("running", { title: "build the grammar", status: "running", toolCount: 12,
    tokens: 48000, contextPercent: 41, durationMs: 300000 }),
  workerCard("failed", { title: "review output", status: "failed", background: true,
    toolCount: 3, tokens: 2048, durationMs: 65000 }),
  workerCard("completed", { title: "folded card", status: "completed", toolCount: 1,
    tokens: 999, contextPercent: 100, durationMs: 1000 }),
];
const workersProjection = (cards, extra = {}) => ({ schema: "gjc-herdr-dashboard/workers/1",
  updatedAt: 1, empty: cards.length === 0, sourceError: null, cards, ...extra });

const todoCase = (id, rules, frame) => ({ id, rules, frame });
const TODO_CASES = [
  todoCase("waiting", "G1 G2 G3 G4 G10", (columns, language) =>
    renderFrame(null, { columns, rows: ROWS, language, color: true })),
  todoCase("empty", "G1 G2 G3 G4 G10", (columns, language) =>
    renderFrame(todoProjection([], { empty: true }), { columns, rows: ROWS, language, color: true })),
  todoCase("live", "G1 G2 G3 G4 G5 G6 G12", (columns, language) =>
    renderFrame(todoLive(), { columns, rows: ROWS, language, color: true, goal: GOAL })),
  todoCase("source-error", "G1 G2 G3 G4 G5 G6", (columns, language) =>
    renderFrame(todoLive({ sourceError: "todo.json unreadable" }),
      { columns, rows: ROWS, language, color: true, goal: GOAL })),
  todoCase("offline", "G1 G2 G3 G4 G6", (columns, language) =>
    renderFrame(todoLive(), { columns, rows: ROWS, language, color: true, goal: GOAL,
      follow: false, connection: { kind: "disconnected", at: NOW } })),
];

const workerCase = (id, rules, frame) => ({ id, rules, frame });
const WORKER_CASES = [
  workerCase("empty", "G1 G2 G3 G4 G10 G11", (columns, language) =>
    renderWorkers(workersProjection([]), { columns, rows: ROWS, language, color: true,
      now: NOW, spin: 0, footer: ["Follow ON · EMPTY"] })),
  workerCase("hidden", "G1 G2 G3 G4 G7 G8 G9 G11 G12", (columns, language) =>
    renderWorkers(workersProjection(workerCards()), { columns, rows: ROWS, language, color: true,
      now: NOW, spin: 0, footer: ["Follow ON · LIVE"], view: { follow: false } })),
  workerCase("showCompleted", "G1 G2 G3 G4 G7 G8 G9 G11 G12", (columns, language) =>
    renderWorkers(workersProjection(workerCards()), { columns, rows: ROWS, language, color: true,
      now: NOW, spin: 0, footer: ["Follow ON · LIVE"],
      view: { follow: false, showCompleted: true } })),
  workerCase("offline", "G1 G2 G3 G4 G7 G8 G9 G12", (columns, language) =>
    renderWorkers(workersProjection(workerCards()), { columns, rows: ROWS, language, color: true,
      now: NOW, spin: 0, footer: ["Follow OFF · OFFLINE 09:05"],
      connection: { kind: "disconnected", at: NOW }, view: { follow: false } })),
];

// Every golden case's title names the rule ids it exercises; the coverage test at
// the end of this file re-reads these same titles.
const goldenTitle = (pane, scenario, columns) =>
  `${pane} ${scenario.id} at ${columns} columns - ${scenario.rules}: exact ko/en frame`;

// The only row allowed wider than columns-1: the never-truncated footer, named per
// pane, state and width (G3; Deviations AC-F1 and AC-F3).
const FOOTER_EXCEPTIONS = Object.freeze({
  "todo:source-error": Object.freeze([24]),
  "todo:offline": Object.freeze([24, 26]),
  "workers:offline": Object.freeze([24, 26]),
});
const footerMayOverflow = (pane, id, columns) =>
  (FOOTER_EXCEPTIONS[`${pane}:${id}`] ?? []).includes(columns);

const plainOf = (frame) => frame.lines.map((line) => stripVTControlCharacters(line));

function assertFrame(plain, columns, exception) {
  assert.equal(plain.length, ROWS, `${ROWS} rows`);
  for (const [index, line] of plain.entries()) {
    const cells = width(line);
    if (cells <= columns - 1) continue;
    assert.equal(index, plain.length - 1, `row ${index} is wider than columns-1`);
    assert.equal(exception, true, `${columns} columns: the footer is not a documented exception`);
    assert.match(line, /^ ?Follow (ON|OFF) · /, "only the footer overflows");
  }
  if (exception) {
    assert.ok(width(plain.at(-1)) > columns - 1, "the named footer exception overflows");
  }
}

const TODO_EXPECTED = {
    "waiting": {
      "24": [
        " Todo [0/0]",
        "───────────────────────",
        "Waiting for the Todo",
        "source.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────",
        " Follow ON · WAITING"
      ],
      "26": [
        " Todo [0/0]",
        "─────────────────────────",
        "Waiting for the Todo",
        "source.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        " Follow ON · WAITING"
      ],
      "34": [
        " Todo [0/0]  done:0 · drop:0",
        "─────────────────────────────────",
        "Waiting for the Todo source.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow ON · WAITING"
      ],
      "52": [
        " Todo [0/0]  done:0 · drop:0",
        "───────────────────────────────────────────────────",
        "Waiting for the Todo source.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow ON · WAITING"
      ],
      "54": [
        " Todo [0/0]  done:0 · drop:0",
        "─────────────────────────────────────────────────────",
        "Waiting for the Todo source.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow ON · WAITING"
      ]
    },
    "empty": {
      "24": [
        " Todo [0/0]",
        "───────────────────────",
        "The checklist is empty.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────",
        " Follow ON · EMPTY"
      ],
      "26": [
        " Todo [0/0]",
        "─────────────────────────",
        "The checklist is empty.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        " Follow ON · EMPTY"
      ],
      "34": [
        " Todo [0/0]  done:0 · drop:0",
        "─────────────────────────────────",
        "The checklist is empty.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow ON · EMPTY"
      ],
      "52": [
        " Todo [0/0]  done:0 · drop:0",
        "───────────────────────────────────────────────────",
        "The checklist is empty.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow ON · EMPTY"
      ],
      "54": [
        " Todo [0/0]  done:0 · drop:0",
        "─────────────────────────────────────────────────────",
        "The checklist is empty.",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow ON · EMPTY"
      ]
    },
    "live": {
      "24": [
        " Todo [2/4]",
        "───────────────────────",
        " ~ · active · 12K · ⧖ ~",
        "─ Implementation 0/2 ──",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────",
        " Follow ON · LIVE"
      ],
      "26": [
        " Todo [2/4]",
        "─────────────────────────",
        " ~ · active · 12K · ⧖ 5m~",
        "─ Implementation 0/2 ────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        " Follow ON · LIVE"
      ],
      "34": [
        " Todo [2/4]  done:1 · drop:1",
        "─────────────────────────────────",
        " ◎ Alig~ · active · 12K · ⧖ 5m 3s",
        "─ Implementation 0/2 ────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow ON · LIVE"
      ],
      "52": [
        " Todo [2/4]  done:1 · drop:1",
        "───────────────────────────────────────────────────",
        " ◎ Align both panes · active · 12K tok · ⧖ 5m 3s",
        "─ Implementation 0/2 ──────────────────────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow ON · LIVE"
      ],
      "54": [
        " Todo [2/4]  done:1 · drop:1",
        "─────────────────────────────────────────────────────",
        " ◎ Align both panes · active · 12K tok · ⧖ 5m 3s",
        "─ Implementation 0/2 ────────────────────────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow ON · LIVE"
      ]
    },
    "source-error": {
      "24": [
        " Todo [2/4]",
        "───────────────────────",
        " ~ · active · 12K · ⧖ ~",
        "Read error: todo.json ~",
        "─ Implementation 0/2 ──",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────",
        "Follow ON · SOURCE ERROR"
      ],
      "26": [
        " Todo [2/4]",
        "─────────────────────────",
        " ~ · active · 12K · ⧖ 5m~",
        "Read error: todo.json un~",
        "─ Implementation 0/2 ────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        " Follow ON · SOURCE ERROR"
      ],
      "34": [
        " Todo [2/4]  done:1 · drop:1",
        "─────────────────────────────────",
        " ◎ Alig~ · active · 12K · ⧖ 5m 3s",
        "Read error: todo.json unreadable",
        "─ Implementation 0/2 ────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow ON · SOURCE ERROR"
      ],
      "52": [
        " Todo [2/4]  done:1 · drop:1",
        "───────────────────────────────────────────────────",
        " ◎ Align both panes · active · 12K tok · ⧖ 5m 3s",
        "Read error: todo.json unreadable",
        "─ Implementation 0/2 ──────────────────────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow ON · SOURCE ERROR"
      ],
      "54": [
        " Todo [2/4]  done:1 · drop:1",
        "─────────────────────────────────────────────────────",
        " ◎ Align both panes · active · 12K tok · ⧖ 5m 3s",
        "Read error: todo.json unreadable",
        "─ Implementation 0/2 ────────────────────────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow ON · SOURCE ERROR"
      ]
    },
    "offline": {
      "24": [
        " Todo [2/4]",
        "───────────────────────",
        " ~ · active · 12K · ⧖ ~",
        "─ Implementation 0/2 ──",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────",
        "Follow OFF · OFFLINE 09:05"
      ],
      "26": [
        " Todo [2/4]",
        "─────────────────────────",
        " ~ · active · 12K · ⧖ 5m~",
        "─ Implementation 0/2 ────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        "Follow OFF · OFFLINE 09:05"
      ],
      "34": [
        " Todo [2/4]  done:1 · drop:1",
        "─────────────────────────────────",
        " ◎ Alig~ · active · 12K · ⧖ 5m 3s",
        "─ Implementation 0/2 ────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow OFF · OFFLINE 09:05"
      ],
      "52": [
        " Todo [2/4]  done:1 · drop:1",
        "───────────────────────────────────────────────────",
        " ◎ Align both panes · active · 12K tok · ⧖ 5m 3s",
        "─ Implementation 0/2 ──────────────────────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow OFF · OFFLINE 09:05"
      ],
      "54": [
        " Todo [2/4]  done:1 · drop:1",
        "─────────────────────────────────────────────────────",
        " ◎ Align both panes · active · 12K tok · ⧖ 5m 3s",
        "─ Implementation 0/2 ────────────────────────────────",
        ">[•] Wire the grammar",
        " [ ] Pin the frames",
        "",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow OFF · OFFLINE 09:05"
      ]
    }
  };

const WORKERS_EXPECTED = {
    "empty": {
      "24": [
        " Workers [0/0]  run 0",
        "───────────────────────",
        "",
        "  ○  No workers yet",
        "",
        "  Workers from this ch…",
        "  show here.",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────",
        " Follow ON · EMPTY"
      ],
      "26": [
        " Workers [0/0]  run 0",
        "─────────────────────────",
        "",
        "  ○  No workers yet",
        "",
        "  Workers from this chat",
        "  show here.",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        " Follow ON · EMPTY"
      ],
      "34": [
        " Workers [0/0]  run 0",
        "─────────────────────────────────",
        "",
        "  ○  No workers yet",
        "",
        "  Workers from this chat",
        "  show here.",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow ON · EMPTY"
      ],
      "52": [
        " Workers [0/0]  run 0",
        "───────────────────────────────────────────────────",
        "",
        "  ○  No workers yet",
        "",
        "  Workers from this chat",
        "  show here.",
        "",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow ON · EMPTY"
      ],
      "54": [
        " Workers [0/0]  run 0",
        "─────────────────────────────────────────────────────",
        "",
        "  ○  No workers yet",
        "",
        "  Workers from this chat",
        "  show here.",
        "",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow ON · EMPTY"
      ]
    },
    "hidden": {
      "24": [
        " Workers [1/3]  run 1 …",
        "───────────────────────",
        ">▌⠋ build the grammar",
        " ▌[worker]",
        " ▌⧖ 5m 0s · 48K tok · …",
        " ▌× review ou… · failed",
        " ▌[worker] background",
        " ▌⧖ 1m 5s · 2K tok · 3…",
        "",
        "",
        "",
        "",
        "───────────────────────",
        " Follow ON · LIVE"
      ],
      "26": [
        " Workers [1/3]  run 1 · …",
        "─────────────────────────",
        ">▌⠋ build the … · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · c…",
        " ▌× review outp… · failed",
        " ▌[worker] background",
        " ▌⧖ 1m 5s · 2K tok · 3 t…",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        " Follow ON · LIVE"
      ],
      "34": [
        " Workers [1/3]  run 1 · failed 1…",
        "─────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review ou… · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow ON · LIVE"
      ],
      "52": [
        " Workers [1/3]  run 1 · failed 1 · done 1 ▸",
        "───────────────────────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review output · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow ON · LIVE"
      ],
      "54": [
        " Workers [1/3]  run 1 · failed 1 · done 1 ▸",
        "─────────────────────────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review output · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow ON · LIVE"
      ]
    },
    "showCompleted": {
      "24": [
        " Workers [1/3]  run 1 …",
        "───────────────────────",
        ">▌⠋ build the grammar",
        " ▌[worker]",
        " ▌⧖ 5m 0s · 48K tok · …",
        " ▌× review ou… · failed",
        " ▌[worker] background",
        " ▌⧖ 1m 5s · 2K tok · 3…",
        "  ✓ folded card · ⧖ 1s",
        "",
        "",
        "",
        "───────────────────────",
        " Follow ON · LIVE"
      ],
      "26": [
        " Workers [1/3]  run 1 · …",
        "─────────────────────────",
        ">▌⠋ build the … · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · c…",
        " ▌× review outp… · failed",
        " ▌[worker] background",
        " ▌⧖ 1m 5s · 2K tok · 3 t…",
        "  ✓ folded card · ⧖ 1s",
        "",
        "",
        "",
        "─────────────────────────",
        " Follow ON · LIVE"
      ],
      "34": [
        " Workers [1/3]  run 1 · failed 1…",
        "─────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review ou… · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "  ✓ folded card · ⧖ 1s",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow ON · LIVE"
      ],
      "52": [
        " Workers [1/3]  run 1 · failed 1 · done 1 ▾",
        "───────────────────────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review output · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "  ✓ folded card · ⧖ 1s",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow ON · LIVE"
      ],
      "54": [
        " Workers [1/3]  run 1 · failed 1 · done 1 ▾",
        "─────────────────────────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review output · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "  ✓ folded card · ⧖ 1s",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow ON · LIVE"
      ]
    },
    "offline": {
      "24": [
        " Workers [1/3]  run 1 …",
        "───────────────────────",
        ">▌⠋ build the grammar",
        " ▌[worker]",
        " ▌⧖ 5m 0s · 48K tok · …",
        " ▌× review ou… · failed",
        " ▌[worker] background",
        " ▌⧖ 1m 5s · 2K tok · 3…",
        "",
        "",
        "",
        "",
        "───────────────────────",
        "Follow OFF · OFFLINE 09:05"
      ],
      "26": [
        " Workers [1/3]  run 1 · …",
        "─────────────────────────",
        ">▌⠋ build the … · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · c…",
        " ▌× review outp… · failed",
        " ▌[worker] background",
        " ▌⧖ 1m 5s · 2K tok · 3 t…",
        "",
        "",
        "",
        "",
        "─────────────────────────",
        "Follow OFF · OFFLINE 09:05"
      ],
      "34": [
        " Workers [1/3]  run 1 · failed 1…",
        "─────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review ou… · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "",
        "",
        "",
        "",
        "─────────────────────────────────",
        " Follow OFF · OFFLINE 09:05"
      ],
      "52": [
        " Workers [1/3]  run 1 · failed 1 · done 1 ▸",
        "───────────────────────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review output · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "",
        "",
        "",
        "",
        "───────────────────────────────────────────────────",
        " Follow OFF · OFFLINE 09:05"
      ],
      "54": [
        " Workers [1/3]  run 1 · failed 1 · done 1 ▸",
        "─────────────────────────────────────────────────────",
        ">▌⠋ build the grammar · ⧖ 5m 0s",
        " ▌[worker]",
        " ▌48K tok · 12 tools · ctx 41%",
        " ▌× review output · failed · ⧖ 1m 5s",
        " ▌[worker] background",
        " ▌2K tok · 3 tools",
        "",
        "",
        "",
        "",
        "─────────────────────────────────────────────────────",
        " Follow OFF · OFFLINE 09:05"
      ]
    }
  };

for (const scenario of TODO_CASES) {
  for (const columns of WIDTHS) {
    test(goldenTitle("todo", scenario, columns), () => {
      const [ko, en] = LANGUAGE_PAIR.map((language) => plainOf(scenario.frame(columns, language)));
      assert.deepEqual(ko, en, "ko and en render the identical English frame");
      assert.deepEqual(en, TODO_EXPECTED[scenario.id][columns]);
      assertFrame(en, columns, footerMayOverflow("todo", scenario.id, columns));
    });
  }
}

for (const scenario of WORKER_CASES) {
  for (const columns of WIDTHS) {
    test(goldenTitle("workers", scenario, columns), () => {
      const [ko, en] = LANGUAGE_PAIR.map((language) => plainOf(scenario.frame(columns, language)));
      assert.deepEqual(ko, en, "ko and en render the identical English frame");
      assert.deepEqual(en, WORKERS_EXPECTED[scenario.id][columns]);
      assertFrame(en, columns, footerMayOverflow("workers", scenario.id, columns));
    });
  }
}

test("colour runs: header chrome, connection footer and EMPTY colours - G1 G2 G3 G4", () => {
  const frame = (scenario, columns, language = "en") =>
    scenario.frame(columns, language);
  for (const columns of [34, 52, 54]) {
    const todo = frame(TODO_CASES.find((entry) => entry.id === "live"), columns);
    assert.ok(todo.lines[0].startsWith(" \x1b[1;36mTodo\x1b[0m \x1b[1;33m["));
    assert.equal(todo.lines.at(-1), " \x1b[36mFollow ON · LIVE\x1b[0m");
    const workers = frame(WORKER_CASES.find((entry) => entry.id === "hidden"), columns);
    assert.ok(workers.lines[0].startsWith(" \x1b[1;36mWorkers\x1b[0m \x1b[1;33m["));
    assert.equal(workers.lines.at(-1), " \x1b[36mFollow ON · LIVE\x1b[0m");
    // G2: the header divider is 90 on the Todo pane and dim on the Workers pane.
    assert.ok(todo.lines[1].startsWith("\x1b[90m─"));
    assert.ok(workers.lines[1].startsWith("\x1b[2m─"));
    // G3: Todo WAITING is yellow; EMPTY is cyan in both panes, and Workers EMPTY
    // shares the live colour.
    assert.equal(frame(TODO_CASES.find((entry) => entry.id === "waiting"), columns).lines.at(-1),
      " \x1b[33mFollow ON · WAITING\x1b[0m");
    assert.equal(frame(TODO_CASES.find((entry) => entry.id === "empty"), columns).lines.at(-1),
      " \x1b[36mFollow ON · EMPTY\x1b[0m");
    assert.equal(frame(WORKER_CASES.find((entry) => entry.id === "empty"), columns).lines.at(-1),
      " \x1b[36mFollow ON · EMPTY\x1b[0m");
  }
  // G1: the Todo name takes the connection colour.
  assert.ok(frame(TODO_CASES.find((entry) => entry.id === "waiting"), 34).lines[0]
    .startsWith(" \x1b[1;36mTodo\x1b[0m"));
  assert.ok(frame(TODO_CASES.find((entry) => entry.id === "offline"), 34).lines[0]
    .startsWith(" \x1b[1;33mTodo\x1b[0m"));
  assert.ok(frame(TODO_CASES.find((entry) => entry.id === "source-error"), 34).lines[0]
    .startsWith(" \x1b[1;31mTodo\x1b[0m"));
  // Workers keeps the cyan name in every state.
  assert.ok(frame(WORKER_CASES.find((entry) => entry.id === "offline"), 34).lines[0]
    .startsWith(" \x1b[1;36mWorkers\x1b[0m"));
});

test("colour runs: offline footer keeps the leading space only where it fits - G3 G4", () => {
  for (const [columns, prefix] of [[24, ""], [26, ""], [34, " "], [52, " "], [54, " "]]) {
    const expected = `${prefix}\x1b[33mFollow OFF · OFFLINE 09:05\x1b[0m`;
    const todo = TODO_CASES.find((entry) => entry.id === "offline").frame(columns, "en");
    assert.equal(todo.lines.at(-1), expected);
    const workers = WORKER_CASES.find((entry) => entry.id === "offline").frame(columns, "en");
    assert.equal(workers.lines.at(-1), expected);
  }
});

test("workers spinner cycles one frame per tick - G8 G13", () => {
  // GRAMMAR.md G13: the literal cycle, independent of the renderer export. OMO
  // packages/dag/src/render.mjs:79-80 (`spinnerFrames`) carries the same ten.
  const SPINNER_FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
  assert.equal(SPINNER.length, SPINNER_FRAMES.length, "the product table has ten frames");
  const glyphs = [];
  for (let spin = 0; spin <= SPINNER_FRAMES.length; spin += 1) {
    const frame = renderWorkers(workersProjection([workerCard("running", { title: "spin" })]),
      { columns: 54, rows: 6, language: "en", color: false, now: NOW, spin,
        footer: ["Follow ON · LIVE"], view: { follow: false } });
    glyphs.push(frame.bodyLines[0][2]);
  }
  assert.deepEqual(glyphs.slice(0, SPINNER_FRAMES.length), [...SPINNER_FRAMES]);
  assert.equal(glyphs[SPINNER_FRAMES.length], SPINNER_FRAMES[0], "the tenth tick wraps to the first frame");
});

// -- GRAMMAR.md coverage -----------------------------------------------------
// The rule list is read from the document and also spelled out here, so deleting a
// rule heading or a Deviations row from GRAMMAR.md fails this test.
const GRAMMAR = readFileSync(fileURLToPath(new URL("../../GRAMMAR.md", import.meta.url)), "utf8");
const RULE_IDS = Object.freeze(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10",
  "G11", "G12", "G13"]);
const DEVIATION_IDS = Object.freeze(["AC-F1", "AC-F3", "AC1.9", "AC2.2", "AC-F4", "selection",
  "data-absent", "truncation", "zh-cn", "L5b", "d", "g", "h", "i", "j", "todo-body",
  "k"]);

function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `${heading} exists in GRAMMAR.md`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

function deviationRows(text) {
  const table = sectionOf(text, "## Deviations");
  return table.split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells[0] !== "id" && !cells.every((cell) => /^-+$/.test(cell)));
}

test("GRAMMAR.md states every rule and deviation row, each with its citation", () => {
  const headings = [...GRAMMAR.matchAll(/^## (G\d+)\. /gm)].map((match) => match[1]);
  assert.deepEqual(headings, [...RULE_IDS], "G1..G13 headings in order");
  for (const id of RULE_IDS) {
    const section = sectionOf(GRAMMAR, `## ${id}.`);
    assert.match(section, /3242ad4|packages\//, `${id} cites its OMO source`);
  }
  assert.match(sectionOf(GRAMMAR, "## Deviations"), /3242ad4/, "the deviation table names its OMO baseline");
  const rows = deviationRows(GRAMMAR);
  assert.deepEqual(rows.map((cells) => cells[0]), [...DEVIATION_IDS],
    "all 17 deviation ids, in table order (todo-body included)");
  for (const cells of rows) {
    assert.equal(cells.length, 4, `${cells[0]} keeps four columns`);
    assert.ok(cells[1] !== "" && cells[2] !== "" && cells[3] !== "",
      `${cells[0]} names its behaviour, OMO source and reason`);
  }
});

test("every rule id is named by at least one golden-frame test title", () => {
  // The exact titles the loops above hand to node:test.
  const titles = [
    ...TODO_CASES.flatMap((scenario) => WIDTHS.map((columns) => goldenTitle("todo", scenario, columns))),
    ...WORKER_CASES.flatMap((scenario) => WIDTHS.map((columns) => goldenTitle("workers", scenario, columns))),
    "colour runs: header chrome, connection footer and EMPTY colours - G1 G2 G3 G4",
    "colour runs: offline footer keeps the leading space only where it fits - G3 G4",
    "workers spinner cycles one frame per tick - G8 G13",
  ];
  // A case may only cite real rule ids, and together the titles must cite all 13.
  for (const scenario of [...TODO_CASES, ...WORKER_CASES]) {
    const named = scenario.rules.split(/\s+/);
    assert.ok(named.length > 0 && named.every((id) => RULE_IDS.includes(id)),
      `${scenario.id} cites only rule ids`);
  }
  for (const id of RULE_IDS) {
    assert.ok(titles.some((title) => new RegExp(`\\b${id}\\b`).test(title)),
      `${id} is named by a test title`);
  }
});
