// Todo projection source for the GJC Herdr dashboard.
//
// Plan stage-03 §7.6 row Todo, amended by R2 (no behaviour change here) and by the
// measured L0 G4 fact: `ctx.getTodoState()` returns `[{name, tasks:[{content,status}]}]`
// in this 0.18.11 build, so it is the primary source. The transcript replay is the
// documented fallback: the newest `custom` entry of type `user_todo_edit` (`data.phases`)
// or the newest successful `todo_write` tool result (`details.phases`), scanning the
// branch backwards. Both shapes are the same as the binary's own
// `getLatestTodoPhasesFromEntries` replay, which this module mirrors (content+status only,
// `cancelled` renders as `abandoned`, notes are display-only and dropped here).
//
// Contract: this module NEVER throws. A broken host surface or a malformed payload is
// reported as `sourceError` on an otherwise valid projection, because the viewer shows
// the source error label for exactly that case (AC1.9) and a throwing producer would
// leave the pane on stale bytes.
//
// Privacy (AC-G4): assignment text, transcript bodies, tool arguments and notes are
// never copied. Only phase name, task content and status cross this boundary.
//
// Exported signatures
//   TODO_SCHEMA: 'gjc-herdr-dashboard/todo/1'
//   TODO_STATUSES: readonly string[]
//   STATUS_ALIASES: Readonly<Record<string, string>>
//   normalizeTodo(raw): { phases, error }
//   phasesFromBranch(branch): { phases, entryId, error } | null
//   projectTodo(ctx, deps?): Projection
//     Projection = { schema, updatedAt, phases, empty, sourceError }

export const TODO_SCHEMA = "gjc-herdr-dashboard/todo/1";
export const TODO_STATUSES = Object.freeze(["pending", "in_progress", "completed", "abandoned"]);

// `cancelled` is the native spelling for a task the user dropped; the shared contract
// spells it `abandoned`, and so does the renderer's mark table.
export const STATUS_ALIASES = Object.freeze({
  cancelled: "abandoned", canceled: "abandoned", dropped: "abandoned",
  done: "completed", completed: "completed", in_progress: "in_progress",
  inprogress: "in_progress", doing: "in_progress", pending: "pending", todo: "pending",
  abandoned: "abandoned", open: "pending",
});

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const message = (cause) => String(cause?.message ?? cause ?? "error");

function statusOf(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return STATUS_ALIASES[normalized] ?? null;
}

// Accepts the three shapes the host can hand us: the `getTodoState()` array, a bare
// `{phases}` payload, and the `{todos:[…]}` legacy spelling. Returns `error` (a string)
// instead of throwing, and never returns a half-converted phase.
export function normalizeTodo(raw) {
  const source = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.phases) ? raw.phases
    : record(raw) && Array.isArray(raw.todos)
      ? [{ name: "Tasks", tasks: raw.todos }] : null;
  if (!source) return { phases: [], error: "todo payload" };
  const phases = [];
  for (const phase of source) {
    if (!record(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) {
      return { phases: [], error: "todo phase" };
    }
    const tasks = [];
    for (const task of phase.tasks) {
      if (!record(task) || typeof task.content !== "string") {
        return { phases: [], error: "todo task" };
      }
      const status = statusOf(task.status);
      if (!status) return { phases: [], error: `todo status: ${String(task.status)}` };
      tasks.push({ content: task.content, status });
    }
    phases.push({ name: phase.name, tasks });
  }
  return { phases, error: "" };
}

// Transcript replay (fallback). The newest eligible entry wins, scanning backwards, and
// an entry whose payload does not normalize is reported rather than skipped silently:
// a newer broken payload means the live state is unknown, not that an older one is true.
export function phasesFromBranch(branch) {
  if (!Array.isArray(branch)) return null;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!record(entry)) continue;
    let payload;
    let payloadName;
    if (entry.type === "custom" && entry.customType === "user_todo_edit") {
      payload = entry.data;
      payloadName = "user_todo_edit";
    } else if (entry.type === "message" && record(entry.message) &&
      entry.message.role === "toolResult" && entry.message.toolName === "todo_write" &&
      entry.message.isError !== true) {
      payload = entry.message.details;
      payloadName = "todo_write";
    } else {
      continue;
    }
    if (!record(payload) || !Array.isArray(payload.phases)) continue;
    const normalized = normalizeTodo(payload);
    const entryId = typeof entry.id === "string" ? entry.id : null;
    return normalized.error
      ? { phases: [], entryId, error: `${payloadName}: ${normalized.error}` }
      : { phases: normalized.phases, entryId, error: "" };
  }
  return null;
}

function readTodoState(ctx) {
  try {
    const value = ctx?.getTodoState?.();
    if (value === undefined || value === null) return null;
    return value;
  } catch (cause) {
    // outcome: a throwing host accessor is reported as a source error, never rethrown.
    throw new Error(`getTodoState: ${message(cause)}`);
  }
}

function readBranch(ctx) {
  try {
    const value = ctx?.sessionManager?.getBranch?.();
    return Array.isArray(value) ? value : null;
  } catch (cause) {
    // outcome: an unreadable branch is reported as a source error, never rethrown.
    throw new Error(`getBranch: ${message(cause)}`);
  }
}

// `now` is injected so tests can assert the stamp; it is the only clock read here.
//
// Source order (plan §7.6, G4 measured): `ctx.getTodoState()` is primary and authoritative,
// including its `[]` answer (this build returns `[]` only while the session really has no
// todos: L0 G4 recorded `todoKeys: []` before the first `todo_write` and `["0"]` after). The
// transcript replay is the fallback for a host surface that is absent, throws or answers with
// a payload that does not normalize; in those cases the newest accepted payload beats both an
// empty pane and a dead source.
export function projectTodo(ctx, { now = Date.now() } = {}) {
  const updatedAt = Number.isFinite(now) ? now : Date.now();
  const shape = (phases, sourceError) => ({
    schema: TODO_SCHEMA,
    updatedAt,
    phases,
    empty: phases.every((phase) => phase.tasks.length === 0),
    sourceError: sourceError || null,
  });

  // The replay reports its own failure (a throwing getBranch, an absent branch) so the caller
  // can keep the primary reason when the replay cannot supply any rows at all.
  const replay = () => {
    let branch;
    try {
      branch = readBranch(ctx);
    } catch (cause) {
      return { phases: [], error: message(cause) };
    }
    const replayed = phasesFromBranch(branch);
    return replayed ?? { phases: [], error: branch === null ? "todo source" : "" };
  };

  let primary;
  let primaryError = "";
  try {
    primary = readTodoState(ctx);
  } catch (cause) {
    primaryError = message(cause);
  }

  if (primary !== undefined && primary !== null) {
    const normalized = normalizeTodo(primary);
    if (!normalized.error) return shape(normalized.phases, "");
    primaryError = normalized.error;
  }

  const replayed = replay();
  if (replayed.phases.length) return shape(replayed.phases, replayed.error);
  return shape([], primaryError || replayed.error);
}
