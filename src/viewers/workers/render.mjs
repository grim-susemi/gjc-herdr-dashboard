// Workers viewer frame renderer for the GJC Herdr dashboard.
//
// Adapted from omo-herdr-dashboard @4082c750 `packages/dag/src/render.mjs`, which is
// the card layout this pane mirrors; the frame skeleton (header, body, divider,
// caller-supplied footer), the sizing primitives and the
// scroll/selection contract follow src/viewers/todo/render.mjs so both roles are one
// shape. Kept from omo: the card idea (a status glyph and title row, a context row,
// a metrics row), the compact duration vocabulary and the rule that no drawn row
// exceeds the pane width. Removed: the DAG graph and run selector, the model/effort
// badge, the box drawing, the descendant indentation and every string that belongs
// to omo's own projection.
//
// The input is the shared workers projection contract
// (`gjc-herdr-dashboard/workers/1`):
//   { schema, updatedAt, empty: boolean, sourceError: string | null,
//     cards: [{ id, agent, title, status, background, currentTool, lastIntent,
//       lastOutput, toolCount, tokens, contextPercent, cost, durationMs, retry,
//       startedAt, endedAt }] }   // newest first, at most 50 per scope
// with `status` exactly one of pending | running | completed | failed | aborted | paused.
//
// A card is at most three rows:
//   row 1  `<marker><glyph> <title><status label>` — always, folded or not. The
//          status suffix is reserved before the title is sized, so the title
//          truncates first and never pushes the status off the pane (AC-F4: title
//          and status both survive 24 columns).
//   row 2  current tool · last intent · last output — when the card is expanded or
//          running, because a finished card's last words are noise.
//   row 3  metrics — tools, tokens, context%, cost, duration, in that order so the
//          cheaper-to-earn numbers survive a narrow pane. An unknown context or an
//          unknown cost renders the localized unknown label (K1: the host reports 0
//          for subscription models, which is indistinguishable from "never
//          measured", so the source maps it to null and this renderer refuses to
//          print a confident "$0.0000").
// A completed card auto-folds to row 1 unless `expanded[id]` is true or
// `showCompleted` is set. A failed card and an aborted card never fold, and they
// differ both visually (`✗` vs `⊘`) and textually (two localized words, AC2.2).
//
// The footer rows arrive already final from the caller: this module never invents
// footer text and never truncates it, so the follow token and the connection label
// (AC-F1, AC-F3) are the caller's contract. `color` only wraps already-sized runs in
// SGR sequences, so it can never change a row width.
//
// MIT License, Copyright (c) 2026 omo-herdr-dag contributors (see PROVENANCE.md).
//
// Exported signatures
//   renderWorkers(projection, options?): Frame
//   stepSelection(frame, delta): { selection, scroll }
//
// Frame = { text, lines, bodyLines, ranges, selectable, selection, scroll, maxScroll,
//           bodyStart, bodyRows, empty, connection }
// `options` = { columns, rows, color, language, now, view, footer }
// `view`    = { scroll, follow, selection, expanded, showCompleted, detail }
import { clean, fit, languageOf, t, width } from "../common.mjs";

const layout = { fallbackColumns: 16, fallbackRows: 3 };
// failed is red, aborted is magenta and paused is yellow, so the three non-grey
// non-completed states stay apart in colour as well as in glyph and in word.
const style = { accent: "36", pending: "90", running: "36", completed: "32", failed: "31",
  aborted: "35", paused: "33", unknown: "31", muted: "90" };
const marks = { pending: "○", running: "◐", completed: "✓", failed: "✗",
  aborted: "⊘", paused: "Ⅱ" };
// Header tally order: running first because it is why the pane exists, then the two
// failure states kept apart (AC2.2), then paused, then the completed total.
const tallied = ["running", "failed", "aborted", "paused", "completed"];

const paint = (text, token, enabled, heading = false) => enabled && style[token]
  ? `\x1b[${heading ? "1;" : ""}${style[token]}m${text}\x1b[0m` : text;
// A corrupt scroll (a string, an object, NaN) is 0 rather than NaN: the frame's own
// `scroll` is a number a caller may persist straight back to disk.
const clamp = (value, max) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(Math.max(0, number), Math.max(0, max)) : 0;
};
const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
const text = (value) => (typeof value === "string" && value !== "" ? clean(value) : "");

const statusOf = (status) => (Object.hasOwn(marks, status) ? status : "unknown");
const statusLabel = (language, status) => t(language, `workers.status.${statusOf(status)}`);
const unknown = (language) => t(language, "workers.unknown");
const expandedFlag = (expanded, id) => Boolean(expanded && typeof expanded === "object" &&
  expanded[id] === true);

// One caller-supplied footer entry stays exactly one row: control sequences are
// stripped and an embedded newline becomes a space, but nothing is ever cut.
const row = (line) => clean(line).replaceAll("\n", " ");
const divider = (columns, color) => paint("─".repeat(columns), "muted", color);
const inset = (line, columns, color) => paint(fit(`  ${line}`, columns), "muted", color);

function compactDuration(language, ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return [hours ? t(language, "workers.compactHours", { count: hours }) : "",
    hours || minutes ? t(language, "workers.compactMinutes", { count: minutes }) : "",
    t(language, "workers.compactSeconds", { count: seconds % 60 })].filter(Boolean).join(" ");
}

// A running card's published `durationMs` is only as fresh as its last bus event, so
// an elapsed measure from `startedAt` wins when it is larger. A finished card keeps
// the duration its source recorded, because `now - startedAt` would keep growing.
function durationOf(card, now) {
  const given = Number.isFinite(card?.durationMs) ? Math.max(0, card.durationMs) : 0;
  const live = statusOf(card?.status) === "running" && Number.isFinite(card?.startedAt) &&
    Number.isFinite(now);
  return live ? Math.max(given, Math.max(0, now - card.startedAt)) : given;
}

// "$0.0123", or null for a value that is absent, negative or zero. A reported 0 is
// exactly the K1 ambiguity (the host returns 0 for subscription models), so it must
// never be painted as a confident "$0.0000".
const formatCost = (value) =>
  (Number.isFinite(value) && value > 0 ? `$${value.toFixed(4)}` : null);

// The card ids a caller can step through, in render order. Duplicates and empty ids
// are dropped so one id names exactly one card.
function idsOf(cards) {
  const ids = new Set();
  for (const card of cards) {
    const id = String(card?.id ?? "");
    if (id !== "") ids.add(id);
  }
  return [...ids];
}

// A stale prefs id (a card that left the projection) never leaves the pane with
// nothing selected: the newest card takes over, exactly like the Todo renderer.
const resolveSelection = (selectable, requested) =>
  (typeof requested === "string" && selectable.includes(requested) ? requested : selectable[0] ?? null);

const connectionOf = ({ sourceError, waiting, empty }) =>
  (sourceError ? "source-error" : waiting ? "waiting" : empty ? "empty" : "live");

function metricsText(card, language, now) {
  const percent = Number.isFinite(card?.contextPercent) && card.contextPercent >= 0
    ? String(Math.round(card.contextPercent)) : unknown(language);
  const cost = formatCost(card?.cost);
  return [
    t(language, "workers.metrics.tools", { count: count(card?.toolCount) }),
    t(language, "workers.metrics.tokens", { count: count(card?.tokens) }),
    t(language, "workers.metrics.context", { percent }),
    t(language, "workers.metrics.cost", { cost: cost ?? unknown(language) }),
    t(language, "workers.metrics.duration",
      { duration: compactDuration(language, durationOf(card, now)) }),
  ].join(" · ");
}

// Row 1. The status suffix is reserved first so the title is the only element that
// can truncate, and when even the suffix does not fit the row degrades to a single
// coloured strip that keeps the glyph, the status word and whatever title fits.
function titleRow(card, { columns, color, language, selection }) {
  const status = statusOf(card?.status);
  const marker = String(card?.id ?? "") !== "" && String(card.id) === selection ? ">" : " ";
  const glyph = marks[status];
  const badge = card?.background === true ? ` [${t(language, "workers.background")}]` : "";
  const suffix = ` ${statusLabel(language, status)}${badge}`;
  const name = text(card?.title) || text(card?.agent) || text(card?.id);
  const room = columns - width(`${marker}${glyph} `) - width(suffix);
  if (room < 1) return paint(fit(`${marker}${glyph} ${name}${suffix}`, columns), status, color);
  const head = `${marker === ">" ? paint(">", "running", color, true) : " "}` +
    `${paint(glyph, status, color, true)} `;
  return `${head}${paint(fit(name, room), "accent", color, true)}${paint(suffix, status, color)}`;
}

// Row 2: what the card is doing right now. It is drawn when the card is expanded or
// running (the contract's two conditions); a card that merely never folds — failed,
// aborted, paused, pending — gains its reason from `d` instead. Unlabelled because the
// parts are self-describing (a tool token, then prose) and a narrow pane cannot
// afford labels.
const contextText = (card) =>
  [text(card?.currentTool), text(card?.lastIntent), text(card?.lastOutput)]
    .filter(Boolean).join(" · ");

// The detail view (`d`, never persisted) is the selected card's full record, one
// field per row. It reuses the same metric row as the list so the numbers cannot drift.
function detailRows(card, { columns, color, language, now }) {
  const value = (raw) => text(raw) || unknown(language);
  const rows = [
    `${t(language, "workers.field.id")}: ${text(card?.id)}`,
    `${t(language, "workers.field.agent")}: ${value(card?.agent)}`,
    `${t(language, "workers.field.status")}: ${statusLabel(language, statusOf(card?.status))}`,
    `${t(language, "workers.field.tool")}: ${value(card?.currentTool)}`,
    `${t(language, "workers.field.intent")}: ${value(card?.lastIntent)}`,
    `${t(language, "workers.field.output")}: ${value(card?.lastOutput)}`,
    metricsText(card, language, now),
  ];
  const retry = card?.retry;
  if (retry && typeof retry === "object") {
    const attempt = Number.isFinite(retry.attempt) ? String(retry.attempt) : unknown(language);
    const delay = Number.isFinite(retry.delayMs)
      ? ` (${compactDuration(language, Math.max(0, retry.delayMs))})` : "";
    rows.push(`${t(language, "workers.field.retry")}: ${attempt}${delay}`);
  }
  return rows.map((line) => inset(line, columns, color));
}

// Body rows for every card, in projection order. Each card keeps its row range so a
// caller can scroll the selected card into view without re-deriving the fold rules.
function body(cards, { columns, color, language, now, view, selection }) {
  const bodyLines = [], ranges = Object.create(null);
  for (const card of cards) {
    const id = String(card?.id ?? "");
    const status = statusOf(card?.status);
    const start = bodyLines.length;
    bodyLines.push(titleRow(card, { columns, color, language, selection }));
    const expanded = expandedFlag(view?.expanded, id);
    const unfolded = status !== "completed" || expanded || view?.showCompleted === true;
    if (unfolded) {
      if (expanded || status === "running") bodyLines.push(inset(contextText(card), columns, color));
      bodyLines.push(inset(metricsText(card, language, now), columns, color));
    }
    if (view?.detail === true && id !== "" && id === selection) {
      bodyLines.push(...detailRows(card, { columns, color, language, now }));
    }
    if (id !== "") ranges[id] = { start, end: bodyLines.length, status };
  }
  return { bodyLines, ranges };
}

function headerPlain(cards, language) {
  const title = `${t(language, "workers.title")} [${cards.length}]`;
  const tally = tallied
    .map((status) => ({ status, at: cards.filter((card) => statusOf(card?.status) === status).length }))
    .filter((entry) => entry.at > 0)
    .map((entry) => `${statusLabel(language, entry.status)} ${entry.at}`);
  return tally.length ? `${title}  ${tally.join(" · ")}` : title;
}

// The body of a projection with nothing to draw: a source error, a source that has
// not published yet, and a genuinely empty scope are three different sentences.
const emptyLabel = ({ sourceError, waiting }) =>
  (sourceError ? "workers.errorBody" : waiting ? "workers.waitingBody" : "workers.emptyBody");

export function renderWorkers(projection, {
  columns = 80, rows = 24, color = true, language = "ko", now = Date.now(),
  view = {}, footer = [],
} = {}) {
  const languageCode = languageOf(language);
  // Keep the terminal's final cell free: ConPTY can otherwise wrap a wide glyph.
  columns = Math.max(1, Math.floor(columns) - 1);
  rows = Math.max(1, Math.floor(rows));
  const cards = Array.isArray(projection?.cards) ? projection.cards : [];
  const selectable = idsOf(cards);
  const selection = resolveSelection(selectable, view?.selection);
  const sourceError = typeof projection?.sourceError === "string" && projection.sourceError !== ""
    ? projection.sourceError : "";
  const waiting = projection === null || projection === undefined;
  const empty = projection?.empty === true || (cards.length === 0 && !waiting && !sourceError);
  const connection = connectionOf({ sourceError, waiting, empty });
  const header = paint(fit(headerPlain(cards, languageCode), columns),
    connection === "live" || connection === "empty" ? "accent" : "warning", color,
    connection === "live");
  const errorLine = sourceError
    ? paint(fit(t(languageCode, "workers.readError", { error: clean(sourceError) }), columns),
      "failed", color)
    : "";
  // The footer is already final and is never truncated, at any width: the follow
  // token and the connection label are the caller's content contract (AC-F1/AC-F3).
  const footerLines = (Array.isArray(footer) ? footer : []).map((line) =>
    paint(row(line), connection === "live" ? "accent" : "warning", color));
  const drawn = body(cards, { columns, color, language: languageCode, now, view, selection });
  if (cards.length === 0) {
    drawn.bodyLines.push(paint(fit(t(languageCode, emptyLabel({ sourceError, waiting })), columns),
      "muted", color));
  }

  // Only the header, the divider and the caller's footer rows are unconditional.
  const fixed = 1 + (errorLine ? 1 : 0) + 1 + footerLines.length;
  if (columns < layout.fallbackColumns || rows <= layout.fallbackRows || fixed >= rows) {
    const lead = rows === 1 ? [] : [columns === 1 ? "" : fit(headerPlain(cards, languageCode), columns)];
    const room = Math.max(0, rows - lead.length);
    const tail = footerLines.length <= room ? footerLines : footerLines.slice(footerLines.length - room);
    while (lead.length + tail.length < rows) lead.push("");
    const lines = [...lead, ...tail];
    return { text: lines.join("\n"), lines, bodyLines: drawn.bodyLines, ranges: drawn.ranges,
      selectable, selection, scroll: 0, maxScroll: 0, bodyStart: lines.length - tail.length,
      bodyRows: 0, empty, connection };
  }

  const bodyRows = rows - fixed;
  const maxScroll = Math.max(0, drawn.bodyLines.length - bodyRows);
  let scroll = clamp(view?.scroll, maxScroll);
  // follow ON pulls the selected card back into the window; follow OFF (a manual j/k)
  // leaves the scroll exactly where the caller asked for it.
  const range = drawn.ranges[selection];
  if (view?.follow !== false && range && (range.start < scroll || range.start >= scroll + bodyRows)) {
    scroll = clamp(range.start, maxScroll);
  }
  const visible = drawn.bodyLines.slice(scroll, scroll + bodyRows);
  while (visible.length < bodyRows) visible.push("");

  const lines = [header];
  if (errorLine) lines.push(errorLine);
  lines.push(...visible, divider(columns, color), ...footerLines);
  return { text: lines.join("\n"), lines, bodyLines: drawn.bodyLines, ranges: drawn.ranges,
    selectable, selection, scroll, maxScroll, bodyStart: 1 + (errorLine ? 1 : 0), bodyRows,
    empty, connection };
}

// Selection stepping used by the viewer: Tab/n/p walk the rendered cards, and the
// returned scroll keeps the newly selected card's title row on screen. Both fields
// come back already clamped, so the caller may persist them as they are.
export function stepSelection(frame, delta) {
  const keys = Array.isArray(frame?.selectable) ? frame.selectable : [];
  const maxScroll = Math.max(0, Math.floor(frame?.maxScroll ?? 0));
  const scroll = clamp(frame?.scroll, maxScroll);
  if (keys.length === 0) return { selection: null, scroll };
  const found = keys.indexOf(frame?.selection);
  const selection = keys[clamp((found < 0 ? 0 : found) + delta, keys.length - 1)];
  const bodyRows = Math.max(0, Math.floor(frame?.bodyRows ?? 0));
  const range = frame?.ranges?.[selection];
  if (range && bodyRows > 0 && (range.start < scroll || range.start >= scroll + bodyRows)) {
    return { selection, scroll: clamp(range.start, maxScroll) };
  }
  return { selection, scroll };
}
