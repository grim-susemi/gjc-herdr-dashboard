// Workers viewer frame renderer for the GJC Herdr dashboard.
//
// Re-aligned with omo-herdr-dashboard @3242ad4 `packages/dag/src/render.mjs`: the
// pane starts with the OMO header row (` Work [done/total]  summary`) and a divider
// under it, a worker card is the OMO three-row card (bar, spinner/title row; role
// row; metrics row), completed cards fold behind the header's `done N ▸` mark, and
// the empty pane is the OMO empty shape (`  ○  No workers yet` plus two hint rows).
// The GJC safety rules stay: the footer is caller-supplied and never truncated
// (AC-F1/AC-F3), the five connection labels stay pairwise distinct (AC1.9), failed
// and aborted stay apart in glyph, word and colour (AC2.2), the background mark
// rides on card row 2 (AC2.6), and an unknown cost is never printed as `$0.0000`
// (K1: the host reports 0 for subscription models, indistinguishable from "never
// measured", so the renderer prints the localized unknown label instead).
//
// The pane wears GJC's own `red-claw` palette (24-bit SGR bodies, `style` below)
// instead of the 16-colour OMO table.
//
// The input is the shared workers projection contract
// (`gjc-herdr-dashboard/workers/1`):
//   { schema, updatedAt, empty: boolean, sourceError: string | null,
//     cards: [{ id, agent, title, status, background, model, currentTool,
//       lastIntent, lastOutput, toolCount, tokens, contextPercent, cost,
//       durationMs, retry, startedAt, endedAt }] }   // newest first, at most 50 per scope
// with `status` exactly one of pending | running | completed | failed | aborted | paused.
// `model` is `provider/modelId` or null; a missing/null model is simply not drawn.
//
// Card rows (GRAMMAR G7/G8):
//   row 1  column 0 is the status bar (only on a multi-row card), then the glyph,
//          the title, the Q3=A word for the non-running states and the elapsed
//          time. The word and time are reserved before the title is sized; when the
//          title would keep fewer than 10 cells the time moves to the front of row 3
//          (OMO `:409-410`).
//   row 2  `[agent]` in coral plus ` <model>` in seafoam plus ` background` in dim,
//          left out when empty. The model only rides here on the ordinary shortcut
//          path, where badge, model and tail all fit; a wrapped identity stays as
//          it is and the model leads row 3 instead.
//   row 3  `48K tok · 12 tools · ctx 41%` in muted; each part is omitted when the
//          projection has no finite value for it. A model that could not ride on
//          row 2 leads this row (`claude-sonnet-4.6 · 48K tok · ...`).
//   row 4  the retry alert `↻ 2 · 3s` in sand, only when `retry` is an object.
// A collapsed one-row completed card never shows the model.
// Cost, tool, model, intent, last output and the exact duration live in the `d`
// detail view of the selected card.
//
// Completed cards are not drawn unless `showCompleted` is set (then row 1 only) or
// their `expanded[id]` flag is true (then the full card). A selected card that
// completes stays drawn while it is selected, so Space never acts on an invisible
// card. Failed and aborted cards never fold.
//
// The footer rows arrive already final from the caller: this module never invents
// footer text and never truncates it, so the follow token and the connection label
// (AC-F1, AC-F3) are the caller's contract. `connection` is the caller's live link
// object `{ kind, at }`; it outranks the state derived from the projection, because
// only the viewer knows about owner liveness and an unreadable slot. `color` only
// wraps already-sized runs in SGR sequences, so it can never change a row width.
//
// MIT License, Copyright (c) 2026 omo-herdr-dag contributors (see PROVENANCE.md).
//
// Exported signatures
//   renderWorkers(projection, options?): Frame
//   stepSelection(frame, delta): { selection, scroll }
//   SPINNER: readonly string[]                  // the ten OMO spinner frames
//
// Frame = { text, lines, bodyLines, ranges, selectable, selection, scroll, maxScroll,
//           bodyStart, bodyRows, empty, connection }
// `options` = { columns, rows, color, language, now, spin, connection, view, footer }
// `view`    = { scroll, follow, selection, expanded, showCompleted, detail }
import { clean, compactCount, fit, languageOf, t, width } from "../common.mjs";

const layout = { fallbackColumns: 16, fallbackRows: 3 };
// OMO packages/dag/src/render.mjs:77-80. A running card cycles one frame per 125 ms
// tick; every other state keeps one glyph.
export const SPINNER = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
const marks = { pending: "○", running: SPINNER[0], completed: "✓", failed: "×",
  aborted: "⊘", paused: "Ⅱ", unknown: "?" };
// GJC's own palette, `red-claw` (24-bit SGR bodies: each entry is used verbatim as
// `\x1b[<body>m`, so the header still prepends the bold `1;`). The role badge is coral
// and the model seafoam, so the two identity facts never share a colour.
const style = { accent: "38;2;255;106;61", pending: "38;2;111;71;67",
  running: "38;2;255;106;61", completed: "38;2;110;231;183",
  failed: "38;2;255;77;94", aborted: "38;2;255;138;101",
  paused: "38;2;245;184;75", unknown: "38;2;255;77;94",
  muted: "38;2;185;143;134", badge: "38;2;255;138;101",
  model: "38;2;125;211;199", time: "38;2;255;215;168", dim: "38;2;111;71;67" };
// Header tally order: running first because it is why the pane exists, then the two
// failure states kept apart (AC2.2), then paused, then the completed group.
const tallied = ["running", "failed", "aborted", "paused"];
const worded = new Set(["pending", "failed", "aborted", "paused", "unknown"]);
const connections = new Set(["live", "waiting", "empty", "disconnected", "source-error"]);

const paint = (text, token, enabled, heading = false) => enabled && style[token]
  ? `\x1b[${heading ? "1;" : ""}${style[token]}m${text}\x1b[0m` : text;
// Grapheme-aware splitting for the long-identity continuation rows.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Owner #259: at most six continuation rows after the first `[agent` row. A corrupt
// projection therefore cannot grow one card past eight identity rows; beyond the cap
// the last continuation ends `…]` instead of hiding the remaining text silently.
const MAX_IDENTITY_CONTINUATION = 6;
// A corrupt scroll (a string, an object, NaN) is 0 rather than NaN: the frame's own
// `scroll` is a number a caller may persist straight back to disk.
const clamp = (value, max) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.min(Math.max(0, number), Math.max(0, max)) : 0;
};
const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
const text = (value) => (typeof value === "string" && value !== "" ? clean(value) : "");

const statusOf = (status) => (Object.hasOwn(marks, status) ? status : "unknown");
// Display band: live work first, finished work stacked below it. Failed and aborted cards sit
// between the two so a problem is never buried under a pile of completed cards. Array sort is
// stable, so inside one band the projection's own order (newest first) is kept.
const bandOf = (status) => (status === "completed" ? 2 : status === "failed" || status === "aborted" ? 1 : 0);
const statusLabel = (language, status) => t(language, `workers.status.${statusOf(status)}`);
const unknown = (language) => t(language, "workers.unknown");
const expandedFlag = (expanded, id) => Boolean(expanded && typeof expanded === "object" &&
  expanded[id] === true);

// The card's model in display form: host form is `provider/modelId`, and only the id
// is read on a card row, so everything before the FIRST `/` is dropped. A value with
// no `/` is already a bare id and stays whole. A card row is one line, so any newline
// becomes a space; anything non-string is no model.
function modelNameOf(value) {
  const raw = text(value).replaceAll("\n", " ").trim();
  if (raw === "") return "";
  const slash = raw.indexOf("/");
  return (slash < 0 ? raw : raw.slice(slash + 1)).trim();
}

// One caller-supplied footer entry stays exactly one row: control sequences are
// stripped and an embedded newline becomes a space, but nothing is ever cut.
const row = (line) => clean(line).replaceAll("\n", " ");
const divider = (columns, color) => paint("─".repeat(columns), "dim", color);
const inset = (line, columns, color) => paint(fit(`  ${line}`, columns, false, "…"), "muted", color);

// A running card cycles the ten OMO frames; a non-integer or negative value is
// normalised instead of crashing or reaching past the table.
const glyphOf = (status, spin) => {
  if (status !== "running") return marks[status] ?? marks.unknown;
  const frame = Number.isInteger(spin) ? spin : 0;
  return SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length];
};

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
// exactly the K1 ambiguity, so it is rendered as the localized unknown label.
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

// Row 3 (also reused by the detail view): tokens, tools and context only. Each part
// is omitted when the projection has no finite value; cost and duration are not
// repeated here because they live on their own detail rows.
function metricsText(card, language) {
  const parts = [];
  if (Number.isFinite(card?.tokens)) {
    parts.push(t(language, "workers.metrics.tokens", { count: compactCount(card.tokens) }));
  }
  if (Number.isFinite(card?.toolCount)) {
    parts.push(t(language, "workers.metrics.tools", { count: count(card.toolCount) }));
  }
  if (Number.isFinite(card?.contextPercent) && card.contextPercent >= 0) {
    parts.push(t(language, "workers.metrics.context",
      { percent: Math.round(card.contextPercent) }));
  }
  return parts.join(" · ");
}

// One row fitted as a whole, then cut back into coloured runs in segment order. Fitting
// runs the existing cell budget and `…` mark over the plain text, so a colour can never
// change a row's width.
function paintSegments(segments, room, color) {
  const plain = segments.map((segment) => segment.text).join("");
  const fitted = fit(plain, room, false, "…");
  let at = 0, painted = "";
  for (const segment of segments) {
    const end = Math.min(fitted.length, at + segment.text.length);
    if (end > at) painted += paint(fitted.slice(at, end), segment.token, color);
    at = Math.max(at, end);
    if (at >= fitted.length) return painted;
  }
  // The `…` mark (or a cut tail) past the last whole run keeps that run's colour, so a
  // fitted row is still exactly `fit()`'s plain text. No text, no escape sequence.
  const tail = fitted.slice(at);
  return tail === "" ? painted
    : painted + paint(tail, segments.at(-1)?.token ?? "muted", color);
}

// The detail view (`d`, never persisted) is the selected card's full record, one
// field per row, two cells in and muted. It is the only place cost, the model, the
// current tool, the intent, the last output and the exact duration are printed.
function detailRows(card, { columns, color, language, now }) {
  const value = (raw) => text(raw) || unknown(language);
  const rows = [
    `${t(language, "workers.field.id")}: ${text(card?.id)}`,
    `${t(language, "workers.field.agent")}: ${value(card?.agent)}`,
    `${t(language, "workers.field.model")}: ${value(card?.model)}`,
    `${t(language, "workers.field.status")}: ${statusLabel(language, statusOf(card?.status))}`,
    `${t(language, "workers.field.tool")}: ${value(card?.currentTool)}`,
    `${t(language, "workers.field.intent")}: ${value(card?.lastIntent)}`,
    `${t(language, "workers.field.output")}: ${value(card?.lastOutput)}`,
  ];
  const metrics = metricsText(card, language);
  if (metrics) rows.push(metrics);
  rows.push(`${t(language, "workers.field.cost")}: ${formatCost(card?.cost) ?? unknown(language)}`);
  rows.push(`⧖ ${t(language, "workers.metrics.duration",
    { duration: compactDuration(language, durationOf(card, now)) })}`);
  const retry = card?.retry;
  if (retry && typeof retry === "object" && !Array.isArray(retry)) {
    const attempt = Number.isFinite(retry.attempt) ? String(retry.attempt) : unknown(language);
    const delay = Number.isFinite(retry.delayMs)
      ? ` (${compactDuration(language, Math.max(0, retry.delayMs))})` : "";
    rows.push(`${t(language, "workers.field.retry")}: ${attempt}${delay}`);
  }
  return rows.map((line) => inset(line, columns, color));
}

// One card, in the OMO three-row grammar plus the retry alert. The bar spans every
// drawn row of a multi-row card; a one-row card gets a space, so a folded completed
// card has no bar (OMO `:507-511`). The bar is column 0 and stays there on every row
// of the card, so the card edge is straight.
function cardLines(card, { columns, color, language, now, spin, selected, expanded }) {
  const status = statusOf(card?.status);
  const name = text(card?.title) || text(card?.agent) || text(card?.id);
  const oneRow = status === "completed" && !expanded;
  const word = worded.has(status) ? ` · ${statusLabel(language, status)}` : "";
  const elapsed = `⧖ ${compactDuration(language, durationOf(card, now))}`;
  const timeSuffix = ` · ${elapsed}`;
  const timeToken = status === "running" ? "time" : "muted";
  const agent = text(card?.agent).replaceAll("\n", " ");
  const background = card?.background === true;
  const hasAgentRow = !oneRow && Boolean(agent || background);
  // A one-row folded card never shows the model: there is no second row to hold it.
  const modelName = oneRow ? "" : modelNameOf(card?.model);
  const modelSuffix = modelName === "" ? "" : ` ${modelName}`;
  const rowRoom = columns - 1;
  const badgeTail = background ? ` ${t(language, "workers.background")}` : "";
  // The ordinary shortcut path is unchanged: the whole badge plus the background tail fits
  // one row. The model only joins that row when it also fits there, so a card whose badge row
  // would overflow falls back to leading row 3 with the model instead of being rewrapped.
  const shortcutRow = Boolean(agent) && rowRoom >= 1 &&
    width(`[${agent}]`) + width(badgeTail) <= rowRoom;
  const modelFitsOnBadge = shortcutRow &&
    width(`[${agent}]`) + width(modelSuffix) + width(badgeTail) <= rowRoom;
  const statsModel = modelFitsOnBadge ? "" : modelName;
  const metrics = metricsText(card, language);
  const retry = card?.retry && typeof card.retry === "object" && !Array.isArray(card.retry)
    ? card.retry : null;
  const alert = !oneRow && retry
    ? t(language, "workers.retry", {
      attempt: Number.isFinite(retry.attempt) ? String(retry.attempt) : unknown(language),
      delay: Number.isFinite(retry.delayMs)
        ? compactDuration(language, Math.max(0, retry.delayMs)) : unknown(language),
    })
    : "";
  const room = columns - 1; // status bar
  // OMO `:402`: a collapsed completed card keeps the per-card fold chevron after the
  // glyph (`✓ ▸ done one`), including when the card is drawn because it is selected.
  const fold = oneRow ? "▸ " : "";
  // OMO `:409-410`: the time ends the title row only when the title keeps at least
  // ten cells (or its whole short self); otherwise it leads row 3.
  const titleRoomWithTime = room - 2 - width(fold) - width(word) - width(timeSuffix);
  const timeInTitle = titleRoomWithTime >= Math.min(width(name), 10);
  const titleRoom = timeInTitle ? titleRoomWithTime : room - 2 - width(fold) - width(word);
  const statsRow = !oneRow && (metrics !== "" || statsModel !== "" || !timeInTitle);
  const multiRow = hasAgentRow || statsRow || Boolean(alert);
  const bar = paint(multiRow ? "▌" : " ", status, color);
  // Even the status word does not fit: keep the existing single coloured strip
  // (still fitted to the pane with the Workers `…` mark).
  if (titleRoom < 1) {
    return [paint(fit(`${bar}${glyphOf(status, spin)} ${fold}${name}${word}`, columns, false, "…"),
      status, color)];
  }
  const lines = [
    `${bar}${paint(glyphOf(status, spin), status, color, true)} ${paint(fold, status, color)}` +
    `${paint(fit(name, titleRoom, false, "…"), status, color, selected)}` +
    `${paint(word, status, color)}` +
    (timeInTitle ? paint(timeSuffix, timeToken, color) : ""),
  ];
  if (hasAgentRow) {
    if (agent) {
      const tail = badgeTail;
      const full = `[${agent}]`;
      // The ordinary short badge keeps its one-row shape and is the only path that shows
      // the model: `[agent] model background`, all in one row.
      if (shortcutRow) {
        lines.push(`${bar}${paint(full, "badge", color)}` +
          (modelFitsOnBadge ? paint(modelSuffix, "model", color) : "") +
          (tail ? paint(tail, "dim", color) : ""));
      } else {
        // OMO `:395,399,445-447`: the role keeps its own rows instead of being cut
        // short to share one. Only card.agent is wrapped; the model deliberately stays
        // off these rows and leads the metrics row instead.
        // `[agent` starts on the first row, continuation rows align under the badge
        // (two-cell indent) and keep the card's bar column, and the closing `]` ends
        // the last identity row. The background mark moves to that last row when it
        // fits and otherwise takes one dim indented row of its own, so it stays visible.
        const identities = [];
        const pushIdentity = (styled, plainWidth) => identities.push({ styled, plainWidth });
        const addTail = (tailText) => {
          if (!tailText) return;
          const last = identities.at(-1);
          if (last && last.plainWidth + width(tailText) <= rowRoom) {
            last.styled += paint(tailText, "dim", color);
            last.plainWidth += width(tailText);
          } else {
            pushIdentity(`  ${paint(t(language, "workers.background"), "dim", color)}`,
              2 + width(t(language, "workers.background")));
          }
        };
        if (rowRoom < 3) {
          // A degenerate pane: one fitted identity row, never a continuation loop.
          pushIdentity(paint(fit(`${full}${tail}`, Math.max(1, rowRoom), false, "…"),
            "badge", color), Math.max(1, rowRoom));
        } else {
          if (width(full) <= rowRoom) {
            // The badge itself fits: keep it whole on the first identity row even when
            // ` background` does not. addTail puts the mark on its own dim indented
            // row; a `]`-only row is never drawn for a badge that could have fitted.
            pushIdentity(paint(full, "badge", color), width(full));
          } else {
            // Close by construction: the badge is the single string `[` + agent +
            // `]`, consumed grapheme by grapheme into whole chunks. The first row
            // holds up to rowRoom cells (columns minus the bar); every
            // continuation row holds rowRoom-2 after its two-cell indent. Because
            // `]` is the last grapheme of the input, the final chunk always carries
            // it. The only chunk that can end up as a lone `]` is that final one,
            // when the previous row consumed exactly the last agent grapheme: moving
            // that grapheme down (`  a]`) makes the close share agent text. That
            // move needs a two-cell grapheme plus `]`, i.e. three cells, so it is
            // valid whenever the continuation room is at least 3. Badge rows are
            // drawn only from input columns 17 (internal rowRoom 15, continuation
            // room 13); the narrower plain fallback never draws them.
            const continuationRoom = rowRoom - 2;
            const parts = [...segmenter.segment(full)].map((part) => part.segment);
            const chunks = [];
            let at = 0;
            const takeChunk = (cells) => {
              const start = at;
              let used = 0;
              while (at < parts.length) {
                const size = width(parts[at]);
                if (used + size > cells) break;
                used += size; at += 1;
              }
              return parts.slice(start, at).join("");
            };
            chunks.push(takeChunk(rowRoom));
            // At most six continuation rows. When the sixth cannot hold the rest,
            // it ends `…]` so the cap drops the tail but never the closing bracket.
            for (let continuation = 1;
              continuation <= MAX_IDENTITY_CONTINUATION && at < parts.length;
              continuation += 1) {
              const rest = parts.slice(at).join("");
              if (continuation === MAX_IDENTITY_CONTINUATION &&
                width(rest) > continuationRoom) {
                chunks.push(takeChunk(Math.max(0, continuationRoom - 2)) + "…]");
                break;
              }
              chunks.push(takeChunk(continuationRoom));
            }
            if (chunks.length > 1 && chunks.at(-1) === "]") {
              const previous = [...segmenter.segment(chunks.at(-2))].map((part) => part.segment);
              const moved = previous.pop();
              chunks[chunks.length - 2] = previous.join("");
              chunks[chunks.length - 1] = `${moved}]`;
            }
            for (const [index, chunk] of chunks.entries()) {
              pushIdentity(`${index === 0 ? "" : "  "}${paint(chunk, "badge", color)}`,
                (index === 0 ? 0 : 2) + width(chunk));
            }
          }
          addTail(tail);
        }
        for (const identity of identities) lines.push(`${bar}${identity.styled}`);
      }
    } else {
      lines.push(`${bar}${paint(fit(t(language, "workers.background"), rowRoom, false, "…"),
        "dim", color)}`);
    }
  }
  if (statsRow) {
    // The model leads the row whenever it could not ride on row 2, ahead of the metrics it
    // introduces (`gpt-5.5 · 48K tok · ...`) and of a time that moved off row 1.
    const segments = [];
    const add = (value, token) => {
      if (value === "") return;
      segments.push({ text: `${segments.length ? " · " : ""}${value}`, token });
    };
    add(statsModel, "model");
    if (!timeInTitle) add(elapsed, timeToken);
    add(metrics, "muted");
    lines.push(`${bar}${paintSegments(segments, columns - 1, color)}`);
  }
  if (alert) {
    lines.push(`${bar}${paint(fit(alert, columns - 1, false, "…"), "time", color)}`);
  }
  return lines;
}

// Body rows for every drawn card, in projection order. Each card keeps its row range
// so a caller can scroll the selected card into view without re-deriving the fold
// rules; hidden completed cards have no range and are not selectable.
function body(cards, { columns, color, language, now, spin, view, selection }) {
  const bodyLines = [], ranges = Object.create(null);
  let drawnCards = 0;
  for (const card of cards) {
    const id = String(card?.id ?? "");
    const status = statusOf(card?.status);
    // OMO packages/dag/src/render.mjs:568-579: one dim full-width divider between
    // consecutive drawn cards, never before the first or after the last. It is not
    // part of any card's range, so click/selection ranges still start at the title.
    if (drawnCards++) bodyLines.push(divider(columns, color));
    const start = bodyLines.length;
    bodyLines.push(...cardLines(card, { columns, color, language, now, spin, selection,
      selected: id !== "" && id === selection,
      expanded: expandedFlag(view?.expanded, id) }));
    if (view?.detail === true && id !== "" && id === selection) {
      bodyLines.push(...detailRows(card, { columns, color, language, now }));
    }
    if (id !== "") ranges[id] = { start, end: bodyLines.length, status };
  }
  return { bodyLines, ranges };
}

function headerSummary(cards, language, showCompleted, room = Infinity) {
  const at = (status) => cards.filter((card) => statusOf(card?.status) === status).length;
  const entries = [{ status: "running",
    text: t(language, "workers.tally.running", { count: at("running") }) }];
  for (const status of tallied.slice(1)) {
    const found = at(status);
    if (found > 0) {
      entries.push({ status, text: t(language, `workers.tally.${status}`, { count: found }) });
    }
  }
  const done = at("completed");
  if (done > 0) {
    entries.push({ status: "done",
      text: `${t(language, "workers.tally.done", { count: done })} ` +
        `${showCompleted ? "▾" : "▸"}` });
  }
  // Narrow-header priority: drop the secondary tallies before the fold segment, so
  // `done N ▸/▾` survives a mixed 34-column header while the always-present run
  // count stays. Any remaining overflow is ordinary OMO-style fitting by the caller.
  let kept = entries;
  const summary = (list) => list.map((entry) => entry.text).join(" · ");
  if (width(summary(kept)) > room) {
    for (const status of ["paused", "aborted", "failed"]) {
      kept = kept.filter((entry) => entry.status !== status);
      if (width(summary(kept)) <= room) break;
    }
  }
  return summary(kept);
}

function headerPlain(cards, language, showCompleted) {
  const done = cards.filter((card) => statusOf(card?.status) === "completed").length;
  return `${t(language, "workers.title")} [${done}/${cards.length}]  ` +
    headerSummary(cards, language, showCompleted);
}

// The body of a projection with nothing to draw: a source error, a source that has
// not published yet, and a genuinely empty scope are three different sentences.
const emptyLabel = ({ sourceError, waiting }) =>
  (sourceError ? "workers.errorBody" : waiting ? "workers.waitingBody" : "workers.emptyBody");

export function renderWorkers(projection, {
  columns = 80, rows = 24, color = true, language = "ko", now = Date.now(),
  spin = 0, connection: link = null, view = {}, footer = [],
} = {}) {
  const languageCode = languageOf(language);
  // Keep the terminal's final cell free: ConPTY can otherwise wrap a wide glyph.
  columns = Math.max(1, Math.floor(columns) - 1);
  rows = Math.max(1, Math.floor(rows));
  const cards = Array.isArray(projection?.cards) ? projection.cards : [];
  const sourceError = typeof projection?.sourceError === "string" && projection.sourceError !== ""
    ? projection.sourceError : "";
  const waiting = projection === null || projection === undefined;
  const empty = projection?.empty === true || (cards.length === 0 && !waiting && !sourceError);
  // The caller's live link outranks the projection-derived state: only the viewer
  // knows that the owner is gone or the slot unreadable while the last projection
  // still looks healthy (todo 5 passes `{ kind, at }`).
  const derived = connectionOf({ sourceError, waiting, empty });
  const kind = link && typeof link === "object" && connections.has(link.kind) ? link.kind : derived;
  const showCompleted = view?.showCompleted === true;
  const requested = view?.selection;
  // A completed card stays drawn while it is selected (OMO `:574`), so Space can
  // always act on the card the selection points at. Failed and aborted never fold.
  const drawn = cards.filter((card) => {
    const id = String(card?.id ?? "");
    const status = statusOf(card?.status);
    if (status !== "completed") return true;
    return showCompleted || expandedFlag(view?.expanded, id) ||
      (typeof requested === "string" && requested !== "" && requested === id);
  }).sort((left, right) => bandOf(statusOf(left?.status)) - bandOf(statusOf(right?.status)));
  const selectable = idsOf(drawn);
  const selection = resolveSelection(selectable, requested);

  const title = t(languageCode, "workers.title");
  const tally = `[${cards.filter((card) => statusOf(card?.status) === "completed").length}/` +
    `${cards.length}]`;
  const edge = columns > 1 ? " " : "";
  const room = columns - edge.length;
  const rest = room - width(`${title} ${tally}`) - 2;
  const summary = headerSummary(cards, languageCode, showCompleted, rest);
  const header = rest < 0
    ? `${edge}${paint(fit(`${title} ${tally}`, room, false, "…"), "accent", color, true)}`
    : `${edge}${paint(title, "accent", color, true)} ${paint(tally, "time", color, true)}` +
      (rest >= 2 ? `  ${paint(fit(summary, rest, false, "…"), "dim", color)}` : "");
  const errorLine = sourceError
    ? paint(fit(t(languageCode, "workers.readError", { error: clean(sourceError) }),
      columns, false, "…"), "failed", color)
    : "";
  // The footer is already final and is never truncated, at any width: the follow
  // token and the connection label are the caller's content contract (AC-F1/AC-F3).
  // The inset is added only when it fits; EMPTY is a connected state, so it shares
  // the live colour, exactly as the OMO footer does.
  const footerToken = kind === "live" || kind === "empty" ? "accent" : "time";
  const footerLines = (Array.isArray(footer) ? footer : []).map((line) => {
    const value = row(line);
    const prefix = width(value) + 1 <= columns ? " " : "";
    return `${prefix}${paint(value, footerToken, color)}`;
  });
  const drawnBody = body(drawn, { columns, color, language: languageCode, now, spin, view, selection });
  if (cards.length === 0) {
    if (sourceError || waiting) {
      drawnBody.bodyLines.push("", fit(`  ○  ${t(languageCode,
        emptyLabel({ sourceError, waiting }))}`, columns, false, "…"));
    } else {
      drawnBody.bodyLines.push("",
        fit(`  ○  ${t(languageCode, "workers.emptyBody")}`, columns, false, "…"), "",
        paint(fit(`  ${t(languageCode, "workers.emptyHint1")}`, columns, false, "…"), "dim", color),
        paint(fit(`  ${t(languageCode, "workers.emptyHint2")}`, columns, false, "…"), "dim", color));
    }
  }

  // Header + divider are unconditional; the error row and the caller's footer rows
  // follow their own contracts.
  const fixed = 2 + (errorLine ? 1 : 0) + 1 + footerLines.length;
  if (columns < layout.fallbackColumns || rows <= layout.fallbackRows || fixed >= rows) {
    const lead = rows === 1 ? []
      : [columns === 1 ? "" : fit(headerPlain(cards, languageCode, showCompleted), columns, false, "…")];
    const roomLeft = Math.max(0, rows - lead.length);
    const tail = footerLines.length <= roomLeft ? footerLines
      : footerLines.slice(footerLines.length - roomLeft);
    while (lead.length + tail.length < rows) lead.push("");
    const lines = [...lead, ...tail];
    return { text: lines.join("\n"), lines, bodyLines: drawnBody.bodyLines,
      ranges: drawnBody.ranges, selectable, selection, scroll: 0, maxScroll: 0,
      bodyStart: lines.length - tail.length, bodyRows: 0, empty, connection: kind };
  }

  const bodyRows = rows - fixed;
  const maxScroll = Math.max(0, drawnBody.bodyLines.length - bodyRows);
  let scroll = clamp(view?.scroll, maxScroll);
  // follow ON pulls the selected card back into the window; follow OFF (a manual j/k)
  // leaves the scroll exactly where the caller asked for it.
  const range = drawnBody.ranges[selection];
  if (view?.follow !== false && range && (range.start < scroll || range.start >= scroll + bodyRows)) {
    scroll = clamp(range.start, maxScroll);
  }
  const visible = drawnBody.bodyLines.slice(scroll, scroll + bodyRows);
  while (visible.length < bodyRows) visible.push("");

  const lines = [header, divider(columns, color)];
  if (errorLine) lines.push(errorLine);
  lines.push(...visible, divider(columns, color), ...footerLines);
  return { text: lines.join("\n"), lines, bodyLines: drawnBody.bodyLines,
    ranges: drawnBody.ranges, selectable, selection, scroll, maxScroll,
    bodyStart: 2 + (errorLine ? 1 : 0), bodyRows, empty, connection: kind };
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
