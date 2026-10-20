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
// The body follows Gajae Code's own todo list (`#renderTodoList` in
// `src/modes/interactive-mode.ts`): a phase divider row `── I. <name>  <closed>/<total> ─────`
// and tree task rows `├─ ☐ <content>` / `└─ ☐ <content>`, where the roman numeral is the
// phase's one-based position among ALL phases and folding never renumbers it. Colours are the
// GJC `red-claw` 24-bit palette, so the pane reads as GJC's own chrome: dropped rows are struck
// through (`9;` + dangerRed), completed rows are kelp, in-progress is bold claw and pending is
// mutedShell. With follow ON the phase that holds the in-progress task is pinned to the top of
// the body. `color: false` stays free of every escape sequence.
//
// Exported signatures
//   marks: Record<status, string>                  // ☐ pending/in_progress/abandoned, ☑ completed
//   phaseRomanNumeral(oneBasedIndex): string       // I, II, III, … ; "" for <= 0
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
// the frame carries exactly one goal row directly under the header divider; when it is null
// there is no row and no blank. (Amended L5b: the goal row is no longer row 0.)
import { clean, compactCount, fit, footerText, languageOf, t, width, wrap } from "../common.mjs";
// GJC's default theme is `red-claw`. Each body is a 24-bit SGR colour usable directly as
// `\x1b[${body}m`: claw accent (live, in progress), coral (badge/phase, goal), dimShell
// (dividers), kelp (completed), dangerRed (abandoned, source error), warningAmber
// (offline/waiting) and mutedShell (secondary text and pending work).
const style = { accent: "38;2;255;106;61", phase: "38;2;255;138;101", muted: "38;2;111;71;67",
  completed: "38;2;110;231;183", abandoned: "38;2;255;77;94",
  in_progress: "38;2;255;106;61", warning: "38;2;245;184;75",
  error: "38;2;255;77;94", activePhase: "38;2;255;106;61", goal: "38;2;255;138;101",
  secondary: "38;2;185;143;134" };
// GJC row ink: only abandoned work strikes the row through (SGR 9); in-progress work is bold
// claw, completed work is kelp and pending work is mutedShell (dimShell is too dark to read).
// `strike`/`bold` are combinable flags on `paint`.
const rowInk = { pending: { token: "secondary" }, in_progress: { token: "in_progress", bold: true },
  completed: { token: "completed" }, abandoned: { token: "abandoned", strike: true } };
// No lead indent: the tree starts at column 0 so a narrow pane spends its cells on the task text.
const taskIndent = "";
export const marks = { pending: "☐", in_progress: "☐", completed: "☑", abandoned: "☐" };
// A task row is `├─ ☐ <content>`, and the last task of its phase closes the branch with
// `└─`. A wrapped row keeps the rail of a middle task (`│  ` plus blanks) and blanks only
// under the last one, so every continuation line starts under the task text.
const railPrefix = `${taskIndent}│  `;
const layout = { taskInset: width(`${taskIndent}├─ ${marks.pending} `),
  fallbackColumns: 16, fallbackRows: 3 };

const paint = (text, token, enabled, { bold = false, strike = false } = {}) =>
  enabled && style[token]
    ? `\x1b[${bold ? "1;" : ""}${strike ? "9;" : ""}${style[token]}m${text}\x1b[0m` : text;

const ROMAN_PAIRS = Object.freeze([[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"],
  [4, "IV"], [1, "I"]]);

// Same algorithm as GJC's `phaseRomanNumeral`: ASCII display-only numerals, never state.
export function phaseRomanNumeral(oneBasedIndex) {
  if (!(oneBasedIndex > 0)) return "";
  let out = "", rem = Math.floor(oneBasedIndex);
  for (const [value, symbol] of ROMAN_PAIRS) {
    while (rem >= value) { out += symbol; rem -= value; }
  }
  return out;
}

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

// Body rows, in Gajae Code's own todo shape: one `── I. <name>  <closed>/<total>[ drop:n] ────`
// divider row per drawn phase and tree task rows `├─ ☐ <content>` / `└─ ☐ <content>`
// under it, where the last task of a phase closes the branch. The roman numeral is the
// phase's one-based position among ALL phases of the projection, so folding a closed phase
// never renumbers its neighbours, and it is display-only: selection and preference keys stay
// `[phase, occurrence, content, occurrence]`.
// `expanded` only ever reveals fully closed phases: a phase that still
// holds pending or in-progress work always lists its tasks, because hiding pending
// work would defeat the point of a todo list. Closed phases collapse to nothing unless
// `expanded`; the viewer passes `expanded` by default so finished work stays on record, and
// `c` collapses them (their counts stay visible in the header either way).
function body(projection, { columns, expanded, color, language }) {
  const bodyLines = [];
  const taskRanges = Object.create(null), phaseRanges = Object.create(null);
  // Drawn phases in body order, so the follow anchor can be chosen without re-doing the fold.
  const drawnPhases = [];
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
    // Divider row: `── <ROMAN>. <name>  <closed>/<total>` then one space and dashes to the pane's
    // edge. The name is what gives up room first, so the counts stay readable; with no room for
    // dashes the row is just the title, and it never exceeds `columns` cells (CJK width included).
    // The lead shrinks only for a pane narrower than the three cells it needs; the fallback
    // layout replaces the body below 16 columns anyway, so that row is never seen at a real width.
    const lead = columns >= 3 ? "── " : "─".repeat(columns);
    const room = Math.max(0, columns - width(lead));
    const roman = `${phaseRomanNumeral(phaseIndex + 1)}. `, gap = "  ";
    // Untrusted phase names are stripped before they are measured, so a control sequence can never
    // widen the row or leave an escape in a colour-free frame.
    const label = clean(name);
    const nameRoom = room - width(roman) - width(gap) - width(summary);
    const title = width(roman) + width(label) + width(gap) + width(summary) <= room
      ? `${roman}${label}${gap}${summary}`
      : nameRoom > 0 ? `${roman}${fit(label, nameRoom)}${gap}${summary}`
        : fit(`${roman}${summary}`, room);
    const dashes = Math.max(0, columns - width(lead) - width(title) - 1);
    const holdsCurrent = tasks.some((task) => task.status === "in_progress");
    // Ink: the phase holding the in-progress task is bold claw, any other open phase is bold
    // coral, a fully closed phase is mutedShell and not bold. The dashes stay dimShell.
    const ink = closed ? { token: "secondary" }
      : holdsCurrent ? { token: "activePhase", bold: true } : { token: "phase", bold: true };
    bodyLines.push(paint(lead, "muted", color) + paint(title, ink.token, color, ink) +
      (dashes > 0 ? paint(` ${"─".repeat(dashes)}`, "muted", color) : ""));
    const contents = new Map();
    for (const [taskIndex, task] of tasks.entries()) {
      const content = String(task?.content ?? "");
      const contentOccurrence = contents.get(content) ?? 0;
      contents.set(content, contentOccurrence + 1);
      const key = taskKeyOf(name, phaseOccurrence, content, contentOccurrence);
      const taskStart = bodyLines.length;
      // Tree rows: `├─` while the phase has a later task and `└─` on its last one, so the
      // checkboxes of a phase line up in one column and the branch visibly closes.
      const last = taskIndex === tasks.length - 1;
      const prefix = `${taskIndent}${last ? "└" : "├"}─ ${marks[task.status] ?? marks.pending} `;
      const ink = rowInk[task.status] ?? rowInk.pending;
      // A wrapped row keeps the rail of a middle task (`│  ` plus blanks) and blanks only
      // under the last one, so every continuation line starts under the task text. Wrapping
      // uses the shared inset, the widest prefix, so every row of the body fits.
      const continuation = last ? " ".repeat(width(prefix))
        : railPrefix + " ".repeat(Math.max(0, width(prefix) - width(railPrefix)));
      const wrapped = wrap(content, Math.max(1, columns - layout.taskInset));
      for (const [index, line] of wrapped.entries()) {
        bodyLines.push(paint(`${index === 0 ? prefix : continuation}${line}`, ink.token, color, ink));
      }
      taskRanges[key] = { start: taskStart, end: bodyLines.length, phaseStart: start, status: task.status };
      selectableKeys.push(key);
    }
    if (!tasks.length) bodyLines.push(fit(t(language, "emptyPhase"), columns));
    const range = { start, end: bodyLines.length };
    phaseRanges[phaseKeyOf(name, phaseOccurrence)] = range;
    drawnPhases.push({ ...range, closed, holdsCurrent, openWork: !closed && tasks.length > 0 });
  }
  return { bodyLines, taskRanges, phaseRanges, selectableKeys, drawnPhases };
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
// `inset` adds the pane's one-column inset and counts it inside `columns`, so a frame can
// pass its full pane width and let the goal row keep the same usable edge as the header.
export function goalLine(goal, { columns = 80, language = "ko", color = true, inset = false } = {}) {
  if (!goal || typeof goal !== "object" || typeof goal.objective !== "string" ||
    typeof goal.status !== "string" || goal.status.trim() === "") return null;
  const languageCode = languageOf(language);
  const lead = inset ? " " : "";
  columns = Math.max(1, columns - width(lead));
  const status = goalStatusText(languageCode, goal.status);
  const elapsed = elapsedText(languageCode, goal.timeUsedSeconds);
  const compact = compactCount(goal.tokensUsed);
  const fullTokens = t(languageCode, "goal.tokens", { count: compact });
  const prefix = "◎ ";
  const suffix = (tokens) => ` · ${status} · ${tokens} · ⧖ ${elapsed}`;
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
  return paint(`${lead}${line}`, "goal", color, { bold: true });
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
  // whether that happened so a test can assert it precisely. The one-column inset is
  // used only when the whole row, inset included, fits.
  const footerLine = (width(footer) + 1 <= columns ? " " : "") +
    paint(footer, kind === "live" || kind === "empty" ? "accent" : "warning", color);

  const drawn = body(projection, { columns, expanded, color, language: languageCode });
  const { bodyLines, taskRanges, phaseRanges, selectableKeys, drawnPhases } = drawn;
  const isEmpty = projection?.empty === true || (phases.length === 0 && kind === "empty");
  if (phases.length === 0) {
    const key = sourceError ? "errorBody" : kind === "empty" ? "emptyBody" : "waitingBody";
    for (const line of wrap(t(languageCode, key), columns)) bodyLines.push(line);
  }
  const detail = `${t(languageCode, "completed")}:${total.completed} · ${t(languageCode, "dropped")}:${total.dropped}`;
  const name = `${t(languageCode, "todo")} [${total.closed}/${total.total}]`;
  // Header-first grammar mirrors OMO packages/todo/src/render.mjs:202 at 3242ad4:
  // bold accent (claw) for live/waiting/empty, warning amber for disconnected,
  // dangerRed for a source error. The tally is a coral badge, the summary mutedShell.
  const headStyle = kind === "source-error" ? "error" : kind === "disconnected" ? "warning" : "accent";
  const inset = columns > 1 ? " " : "", edge = columns - inset.length;
  const headerCore = width(`${name}  ${detail}`) <= edge
    ? `${paint(t(languageCode, "todo"), headStyle, color, { bold: true })} ` +
      `${paint(`[${total.closed}/${total.total}]`, "phase", color, { bold: true })}  ` +
      `${paint(detail, "secondary", color)}`
    : paint(fit(name, edge), headStyle, color, { bold: true });
  const header = inset + headerCore;
  // The Todo divider is dimShell, as GJC's own dividers are.
  const divider = paint("─".repeat(columns), "muted", color);
  // A goal row exists only when `goal.json` carries a goal. There is no placeholder row and no
  // blank spacer when the host reports none, so an ordinary Todo frame keeps its header and divider.
  const goalRow = goalLine(goal, { columns, inset: Boolean(inset),
    language: languageCode, color });
  const errorLine = sourceError
    ? paint(fit(t(languageCode, "readError", { error: clean(sourceError) }), columns), "error", color) : "";

  // Only the footer is unconditional. Everything above it loses space in this
  // order when the pane is too short: the divider, the error row, the goal row.
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

  // Priority when rows run out: keep as many PRESENT optional rows as the room above
  // the body permits, in the order goal, error, header divider. Ranks are not
  // capacity: an absent optional row must not consume a slot and leave a gap. The
  // footer and the bottom divider are never dropped (AC-F1); the body gives up rows first.
  const extraRoom = Math.max(0, rows - 3);
  const present = [];
  if (goalRow !== null) present.push("goal");
  if (errorLine) present.push("error");
  present.push("divider");
  const kept = new Set(present.slice(0, extraRoom));
  const top = [header];
  if (kept.has("divider")) top.push(divider);
  if (kept.has("goal")) top.push(goalRow);
  if (kept.has("error")) top.push(errorLine);
  const bodyRows = Math.max(0, extraRoom - kept.size);
  // Follow pins the current phase to the top of the body: the phase holding the in-progress
  // task, else the first phase that still has pending work, else the last drawn phase. Finished
  // phases above it scroll out of view instead of being deleted, and the revealed selection may
  // push the window down a little further. A follow frame is not clamped to the end of the body:
  // the empty rows below the last phase are padded, so a short list still pins its phase.
  const followOn = follow !== false && bodyRows > 0 && phases.length > 0;
  const selected = taskRanges[resolved];
  if (followOn) {
    // Anchor order: the phase holding the in-progress task, else the first drawn phase that still
    // has pending work, else the last drawn phase. The frame scrolls finished phases above it away
    // rather than deleting them; the wheel and j/k set follow OFF and show them again.
    const anchor = drawnPhases.find((range) => range.holdsCurrent) ??
      drawnPhases.find((range) => range.openWork) ?? drawnPhases.at(-1);
    scroll = anchor?.start ?? 0;
    // Only raise the window, never lower it below the pinned divider, and stop at the selected
    // task's own first row so a wrapped task still shows its beginning.
    if (selected && selected.end > scroll + bodyRows) {
      scroll = Math.max(scroll, Math.min(selected.end - bodyRows, selected.start));
    }
  } else if (revealSelection && selected && bodyRows > 0) {
    // Reveal keeps the selected task AND its phase title on screen. The window is moved the least
    // that satisfies both, so a selection that is already visible never makes the pane jump:
    //   * the phase head through the selected task fits: scroll lands in [end - rows, phaseStart];
    //   * it does not fit: the title cannot share the window with the selection, so one row is
    //     reserved above the selection and the sticky title below fills it.
    if (selected.end - selected.phaseStart <= bodyRows) {
      scroll = Math.min(Math.max(scroll, selected.end - bodyRows), selected.phaseStart);
    } else {
      const span = Math.min(selected.end - selected.start, bodyRows);
      const reserve = bodyRows >= 2 && span <= bodyRows - 1 ? 1 : 0;
      scroll = Math.min(Math.max(scroll, selected.start + span - bodyRows), selected.start - reserve);
    }
  }
  if (!followOn) scroll = clamp(scroll, bodyLines.length - bodyRows);
  const visible = bodyLines.slice(scroll, scroll + bodyRows);
  // Sticky phase title: when the first visible row is a task row of some phase, that phase's title
  // takes its place, so a title scrolled out of the window is never the cause of an anonymous task.
  // It only ever replaces a row, never the scroll the frame returns. Under follow ON the pinned
  // divider is already the first row, so this only fires after the selection pushed the window
  // down — and then it must not replace a row of the selected task itself.
  if (bodyRows >= 2 && scroll > 0) {
    const keepSelected = followOn && selected && scroll >= selected.start && scroll < selected.end;
    if (!keepSelected) {
      for (const range of Object.values(phaseRanges)) {
        if (scroll > range.start && scroll < range.end) { visible[0] = bodyLines[range.start]; break; }
      }
    }
  }
  while (visible.length < bodyRows) visible.push("");

  const lines = [...top, ...visible, divider, footerLine];
  return { text: lines.join("\n"), lines, bodyLines, taskRanges, phaseRanges,
    scroll, bodyStart: top.length, bodyRows, selectableKeys,
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
