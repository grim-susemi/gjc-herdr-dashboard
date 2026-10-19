// Todo viewer frame renderer for the GJC Herdr dashboard.
//
// Adapted from omo-herdr-dashboard @4082c750 `packages/todo/src/render.mjs`.
// Kept: phase grouping, fold of closed phases, scrolling and selection ranges,
// narrow 34/52-column layouts, CJK/Korean cell width, truncation that never cuts
// the footer. Removed: the native-host/`ask` panel, presence, the CLI binding,
// the strike reveal animation and the availability vocabulary that only omo's
// own projection produced.
//
// The input is the shared projection contract (`gjc-herdr-dashboard/todo/1`):
//   { schema, updatedAt, phases: [{ name, tasks: [{ content, status }] }],
//     empty: boolean, sourceError: string | null }
// with `status` exactly one of pending | in_progress | completed | abandoned.
//
// MIT License, Copyright (c) 2026 omo-herdr-dag contributors (see PROVENANCE.md).
//
// Exported signatures
//   marks: Record<status, string>
//   counts(tasks): { total, closed, completed, dropped }
//   isClosedPhase(phase): boolean
//   taskKeys(projection): string[]                 // render order, all phases
//   renderFrame(projection, options?): Frame
//   render(projection, options?): string
//   stepSelection(frame, delta): { selection, scroll }
//
// Frame = { text, lines, bodyLines, taskRanges, phaseRanges, scroll, bodyStart,
//           bodyRows, selectableKeys, selectionIndex, footer, footerFits,
//           connection, selection, empty, goal }
// `options` = { columns, rows, language, color, expanded, scroll, selection, follow,
//               connection, notices, revealSelection, goal }
// `goal` = { objective, status, tokensUsed, timeUsedSeconds } | null. When it is present
// the frame starts with exactly one goal row; when it is null there is no row and no blank.
import { clean, compactCount, fit, footerText, languageOf, t, width, wrap } from "../common.mjs";
const style = { accent: "36", phase: "35", muted: "90", completed: "90", abandoned: "90",
  in_progress: "36", warning: "33", error: "31", activePhase: "33", goal: "35" };
const layout = { taskInset: 5, fallbackColumns: 16, fallbackRows: 3 };
export const marks = { pending: "[ ]", in_progress: "[•]", completed: "[✓]", abandoned: "[×]" };

const paint = (text, token, enabled, heading = false) => enabled && style[token]
  ? `\x1b[${heading ? "1;" : ""}${style[token]}m${text}\x1b[0m` : text;

export function counts(tasks) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const dropped = tasks.filter((task) => task.status === "abandoned").length;
  return { total: tasks.length, closed: completed + dropped, completed, dropped };
}

export const isClosedPhase = (phase) => phase.tasks.length > 0 &&
  phase.tasks.every((task) => task.status === "completed" || task.status === "abandoned");

const clamp = (value, max) => Math.min(Math.max(0, Math.floor(value || 0)), Math.max(0, max));
const phaseKeyOf = (name, occurrence) => JSON.stringify([name, occurrence]);
const taskKeyOf = (name, phaseOccurrence, content, contentOccurrence) =>
  JSON.stringify([name, phaseOccurrence, content, contentOccurrence]);
const phasesOf = (projection) => (Array.isArray(projection?.phases) ? projection.phases : []);

// Render order for every task, including folded and closed ones, so a caller can
// step a selection without re-implementing the fold rules.
export function taskKeys(projection) {
  const keys = [];
  const occurrences = new Map();
  for (const phase of phasesOf(projection)) {
    const name = String(phase?.name ?? "");
    const phaseOccurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, phaseOccurrence + 1);
    const contents = new Map();
    for (const task of phase?.tasks ?? []) {
      const content = String(task?.content ?? "");
      const contentOccurrence = contents.get(content) ?? 0;
      contents.set(content, contentOccurrence + 1);
      keys.push(taskKeyOf(name, phaseOccurrence, content, contentOccurrence));
    }
  }
  return keys;
}

// Body rows. `expanded` only ever reveals fully closed phases: a phase that still
// holds pending or in-progress work always lists its tasks, because hiding pending
// work would defeat the point of a todo list. Closed phases collapse to nothing
// until `c` expands them, and their counts stay visible in the header.
function body(projection, { columns, expanded, color, language, selection }) {
  const bodyLines = [];
  const taskRanges = Object.create(null), phaseRanges = Object.create(null);
  const selectableKeys = [];
  const phases = phasesOf(projection);
  const occurrences = new Map();
  for (const [phaseIndex, phase] of phases.entries()) {
    const name = String(phase?.name ?? "");
    const phaseOccurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, phaseOccurrence + 1);
    const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
    const closed = isClosedPhase(phase);
    if (closed && !expanded) continue;
    const start = bodyLines.length;
    const count = counts(tasks);
    const summary = `${count.closed}/${count.total}` +
      `${count.dropped ? ` ${t(language, "dropped")}:${count.dropped}` : ""}`;
    const nameRoom = columns - width(summary) - 5;
    const label = fit(nameRoom > 0 ? `${fit(name, nameRoom)} ${summary}` : summary, Math.max(1, columns - 3));
    const tail = "─".repeat(Math.max(0, columns - width(label) - 3));
    const holdsCurrent = tasks.some((task) => task.status === "in_progress");
    bodyLines.push(holdsCurrent && !closed
      ? `${paint("─ ", "muted", color)}${paint(label, "activePhase", color, true)}${paint(` ${tail}`, "muted", color)}`
      : paint(`─ ${label} ${tail}`, "muted", color));
    const contents = new Map();
    for (const task of tasks) {
      const content = String(task?.content ?? "");
      const contentOccurrence = contents.get(content) ?? 0;
      contents.set(content, contentOccurrence + 1);
      const key = taskKeyOf(name, phaseOccurrence, content, contentOccurrence);
      const taskStart = bodyLines.length;
      const prefix = `${key === selection ? ">" : " "}${marks[task.status] ?? " ? "} `;
      const wrapped = wrap(content, Math.max(1, columns - layout.taskInset));
      for (const [index, line] of wrapped.entries()) {
        const inset = index === 0 ? prefix : " ".repeat(layout.taskInset);
        bodyLines.push(paint(`${inset}${line}`, task.status, color, task.status === "in_progress"));
      }
      taskRanges[key] = { start: taskStart, end: bodyLines.length, phaseStart: start, status: task.status };
      selectableKeys.push(key);
    }
    if (!tasks.length) bodyLines.push(fit(t(language, "emptyPhase"), columns));
    phaseRanges[phaseKeyOf(name, phaseOccurrence)] = { start, end: bodyLines.length };
  }
  return { bodyLines, taskRanges, phaseRanges, selectableKeys };
}

// L5b: one compact goal row. The four required fields are objective, status, tokens and
// elapsed time; the objective is the only field that may truncate. The token word is dropped
// first when a narrow pane would leave no room for an objective, and the marker is the last
// thing to go, so 34 columns still shows all four values.
const goalStatuses = new Set(["active", "paused", "completed", "cancelled", "abandoned", "failed"]);

function goalStatusText(language, status) {
  const code = String(status ?? "").trim().toLowerCase();
  if (goalStatuses.has(code)) return t(language, `goal.status.${code}`);
  // outcome: a status this build does not know is shown verbatim instead of blanking the row.
  try { return t(language, "goal.status.unknown", { status: clean(status) }); }
  catch { return clean(status); }
}

function elapsedText(language, seconds) {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3_600), minutes = Math.floor(total / 60) % 60;
  const rest = total % 60;
  if (hours > 0) return `${t(language, "goal.elapsedHours", { count: hours })} ` +
    `${t(language, "goal.elapsedMinutes", { count: minutes })}`;
  if (minutes > 0) return `${t(language, "goal.elapsedMinutes", { count: minutes })} ` +
    `${t(language, "goal.elapsedSeconds", { count: rest })}`;
  return t(language, "goal.elapsedSeconds", { count: rest });
}

// Exported for the render matrix tests and for a drill that wants the row without a frame.
export function goalLine(goal, { columns = 80, language = "ko", color = true } = {}) {
  if (!goal || typeof goal !== "object" || typeof goal.objective !== "string" ||
    typeof goal.status !== "string" || goal.status.trim() === "") return null;
  const languageCode = languageOf(language);
  const status = goalStatusText(languageCode, goal.status);
  const elapsed = elapsedText(languageCode, goal.timeUsedSeconds);
  const compact = compactCount(goal.tokensUsed);
  const fullTokens = t(languageCode, "goal.tokens", { count: compact });
  const prefix = "◎ ";
  const suffix = (tokens) => ` · ${status} · ${tokens} · ${elapsed}`;
  let tokens = fullTokens;
  let head = prefix;
  let room = columns - width(head) - width(suffix(tokens));
  if (room < 4) {
    tokens = compact;
    room = columns - width(head) - width(suffix(tokens));
  }
  if (room < 1) {
    head = "";
    room = columns - width(suffix(tokens));
  }
  const objective = goal.objective === "" ? t(languageCode, "goal.untitled") : goal.objective;
  let line = `${head}${fit(objective, Math.max(1, room))}${suffix(tokens)}`;
  if (width(line) > columns) line = fit(line, columns);
  return paint(line, "goal", color, true);
}

function defaultSelection(projection) {
  const phases = phasesOf(projection);
  for (const phase of phases) for (const task of phase?.tasks ?? []) {
    if (task?.status === "in_progress") return { task };
  }
  for (const phase of phases) for (const task of phase?.tasks ?? []) return { task };
  return { task: null };
}

// Resolve the requested selection key against the projection, falling back to the
// first in-progress task and then to the first task, so a stale prefs key cannot
// leave a viewer with nothing selected.
function resolveSelection(projection, requested) {
  const keys = taskKeys(projection);
  if (requested && keys.includes(requested)) return requested;
  const phases = phasesOf(projection);
  const keysInOrder = [];
  const occurrences = new Map();
  for (const phase of phases) {
    const name = String(phase?.name ?? "");
    const phaseOccurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, phaseOccurrence + 1);
    const contents = new Map();
    for (const task of phase?.tasks ?? []) {
      const content = String(task?.content ?? "");
      const contentOccurrence = contents.get(content) ?? 0;
      contents.set(content, contentOccurrence + 1);
      keysInOrder.push({ key: taskKeyOf(name, phaseOccurrence, content, contentOccurrence),
        status: task?.status });
    }
  }
  const active = keysInOrder.find((entry) => entry.status === "in_progress");
  return (active ?? keysInOrder[0])?.key ?? null;
}

export function renderFrame(projection, {
  columns = 80, rows = 24, language = "ko", color = true, expanded = false,
  scroll = 0, selection = null, follow = true, connection,
  notices = [], revealSelection = true, goal = null,
} = {}) {
  const languageCode = languageOf(language);
  // Keep the terminal's final cell free: ConPTY can otherwise wrap a wide glyph.
  columns = Math.max(1, Math.floor(columns) - 1);
  rows = Math.max(1, Math.floor(rows));
  const phases = phasesOf(projection);
  const total = counts(phases.flatMap((phase) => (Array.isArray(phase?.tasks) ? phase.tasks : [])));
  const resolved = resolveSelection(projection, selection);
  const sourceError = typeof projection?.sourceError === "string" && projection.sourceError !== ""
    ? projection.sourceError : "";
  // The caller supplies the connection when it has a better source (owner liveness);
  // otherwise the projection itself is the source, and no projection is never live.
  const requested = connection?.kind ?? (projection === null ? "waiting" : projection.empty ? "empty" : "live");
  const kind = requested === "live" && (projection === null || sourceError)
    ? (sourceError ? "source-error" : "waiting") : requested;
  const footer = footerText(languageCode, { follow, connection: { ...connection, kind }, notices });
  // The footer is never truncated, at any width: the follow token and the
  // connection label are contractual (AC-F1, AC-F3), so a pane too narrow for them
  // overflows this one row instead of silently dropping them. `footerFits` reports
  // whether that happened so a test can assert it precisely.
  const footerLine = paint(footer, kind === "live" ? "accent" : "warning", color);

  const drawn = body(projection, { columns, expanded, color, language: languageCode, selection: resolved });
  const { bodyLines, taskRanges, phaseRanges, selectableKeys } = drawn;
  const isEmpty = projection?.empty === true || (phases.length === 0 && kind === "empty");
  if (phases.length === 0) {
    const key = sourceError ? "errorBody" : kind === "empty" ? "emptyBody" : "waitingBody";
    for (const line of wrap(t(languageCode, key), columns)) bodyLines.push(line);
  }
  const detail = `${t(languageCode, "completed")}:${total.completed} · ${t(languageCode, "dropped")}:${total.dropped}`;
  const name = `${t(languageCode, "todo")} [${total.closed}/${total.total}]`;
  const headStyle = ["disconnected", "source-error"].includes(kind) ? "warning"
    : kind === "empty" || kind === "waiting" ? "muted" : "accent";
  const header = width(`${name}  ${detail}`) <= columns
    ? `${paint(t(languageCode, "todo"), headStyle, color, true)} ` +
      `${paint(`[${total.closed}/${total.total}]`, "activePhase", color, true)}  ${paint(detail, "muted", color)}`
    : paint(fit(name, columns), headStyle, color, true);
  // A goal row exists only when `goal.json` carries a goal. There is no placeholder row and no
  // blank spacer when the host reports none, so an ordinary Todo frame is byte-identical to L4.
  const goalRow = goalLine(goal, { columns, language: languageCode, color });

  // Only the footer is unconditional. Everything above it loses space in this
  // order when the pane is too short: the divider, the error row, the body.
  if (columns < layout.fallbackColumns || rows <= layout.fallbackRows) {
    const glyph = kind === "empty" ? "0" : kind === "source-error" ? "!" :
      kind === "waiting" ? "?" : kind === "disconnected" ? "~" : "*";
    const lines = [];
    if (goalRow !== null && rows > 2) lines.push(fit(goalRow, columns));
    if (rows > 1) lines.push(columns === 1 ? glyph : fit(header, columns));
    while (lines.length < rows - 1) lines.push("");
    lines.push(footerLine);
    return { text: lines.join("\n"), lines, bodyLines, taskRanges, phaseRanges,
      scroll: clamp(scroll, bodyLines.length), bodyStart: lines.length - 1, bodyRows: 0,
      selectableKeys, selectionIndex: indexOf(selectableKeys, resolved),
      footer, footerFits: width(footer) <= columns, connection: kind, selection: resolved,
      empty: isEmpty, goal: goalRow };
  }

  const errorLine = sourceError && rows >= 5 ? fit(t(languageCode, "readError", { error: clean(sourceError) }), columns)
    : "";
  const bodyRows = Math.max(0, rows - 3 - (errorLine ? 1 : 0) - (goalRow ? 1 : 0));
  const selected = taskRanges[resolved];
  if (revealSelection && selected && bodyRows > 0 &&
    (selected.start < scroll || selected.start + Math.min(selected.end - selected.start, bodyRows) > scroll + bodyRows)) {
    scroll = selected.start - selected.phaseStart < bodyRows ? selected.phaseStart : selected.start;
  }
  scroll = clamp(scroll, bodyLines.length - bodyRows);
  const visible = bodyLines.slice(scroll, scroll + bodyRows);
  while (visible.length < bodyRows) visible.push("");

  const lines = [];
  if (goalRow !== null) lines.push(goalRow);
  lines.push(header);
  if (errorLine) lines.push(paint(errorLine, "error", color));
  lines.push(...visible,
    paint("─".repeat(columns), "muted", color),
    footerLine);
  return { text: lines.join("\n"), lines, bodyLines, taskRanges, phaseRanges,
    scroll, bodyStart: lines.length - bodyRows - 2, bodyRows, selectableKeys,
    selectionIndex: indexOf(selectableKeys, resolved), footer,
    footerFits: width(footer) <= columns, connection: kind, selection: resolved, empty: isEmpty,
    goal: goalRow };
}

const indexOf = (keys, key) => (key === null ? -1 : keys.indexOf(key));

export const render = (projection, options) => renderFrame(projection, options).text;

// Selection stepping used by the viewer: `j`/`k` walk the rendered task rows, and
// the returned scroll keeps the newly selected row visible.
export function stepSelection(frame, delta) {
  const keys = frame.selectableKeys;
  if (!keys.length) return { selection: null, scroll: frame.scroll };
  const current = frame.selectionIndex < 0 ? 0 : frame.selectionIndex;
  const next = clamp(current + delta, keys.length - 1);
  return { selection: keys[next], scroll: frame.scroll };
}
