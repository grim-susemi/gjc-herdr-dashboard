// Goal projection source for the GJC Herdr dashboard (L5b, plan stage-03 §7.6 row Goal).
//
// The measured 0.18.11 host surface (`.evidence/L5/goalsurface/summary.json`):
//   * `ctx.getGoalState()` is a function and returns `undefined` while the session has no goal;
//   * with a goal it returns `{enabled, mode, goal: {id, objective, status, tokensUsed,
//     timeUsedSeconds, createdAt, updatedAt, provenance}}`;
//   * `goal_updated` carries `{type, goal, state}` where `state` has the same wrapper shape.
// `ctx.session.getGoalModeState` is NOT exposed, so these two surfaces are the only source.
//
// Contract: this module NEVER throws. A broken accessor or a malformed payload becomes
// `sourceError` on an otherwise valid projection, because a throwing producer would leave the
// Todo pane on stale bytes. No goal is not an error: it is `goal: null`, and the renderer then
// draws no line and no blank row.
//
// Privacy (AC-G4): only objective, status, tokensUsed and timeUsedSeconds cross this boundary.
// The goal id, provenance, created/updated timestamps, mode and every transcript body are
// dropped at the normalizer, so the file under `data/<scopeKey>/goal.json` cannot carry them.
//
// Exported signatures
//   GOAL_SCHEMA: 'gjc-herdr-dashboard/goal/1'
//   GOAL_STATUSES: readonly string[]                 // the statuses the renderer labels
//   normalizeGoal(raw): { goal, error }
//     raw may be the `getGoalState()` wrapper, the `goal_updated` event, a `{state}` wrapper or a
//     bare goal object. `goal` is `{objective, status, tokensUsed, timeUsedSeconds}` or null.
//   projectGoal(ctx, { now?, event? }): Projection
//     Projection = { schema, updatedAt, goal, sourceError }
//     `event` is the `goal_updated` payload. It is a fallback for a host surface that is absent,
//     throws or answers with a malformed payload; the accessor is always tried first.

export const GOAL_SCHEMA = "gjc-herdr-dashboard/goal/1";

// The native vocabulary measured on 0.18.11 is `active`; the others are the states a goal build
// can plausibly add, and an unknown status is rendered verbatim rather than blanked.
export const GOAL_STATUSES = Object.freeze(["active", "paused", "completed", "cancelled",
  "abandoned", "failed"]);

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const message = (cause) => String(cause?.message ?? cause ?? "error");
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const cleanStatus = (value) => value.trim().toLowerCase();

// A goal object is accepted only when every rendered field is present and typed. A half-read
// goal would paint a line with a wrong token count or a missing status, which is worse than the
// explicit source error that tells the user the projection is unavailable.
function normalizeGoalObject(goal) {
  if (!record(goal)) return { goal: null, error: "goal payload" };
  if (typeof goal.objective !== "string") return { goal: null, error: "goal objective" };
  if (typeof goal.status !== "string" || cleanStatus(goal.status) === "") {
    return { goal: null, error: "goal status" };
  }
  if (!finite(goal.tokensUsed)) return { goal: null, error: "goal tokensUsed" };
  if (!finite(goal.timeUsedSeconds)) return { goal: null, error: "goal timeUsedSeconds" };
  return { goal: {
    objective: goal.objective,
    status: cleanStatus(goal.status),
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
  }, error: "" };
}

// Accepts all four shapes the host can hand us. An explicit `goal: null` (or `state.goal: null`)
// is the host saying "no goal", not a malformed payload; a wrapper with no goal key at all is
// only accepted when the caller passed a bare goal object.
export function normalizeGoal(raw) {
  if (raw === undefined || raw === null) return { goal: null, error: "" };
  if (!record(raw)) return { goal: null, error: "goal payload" };
  if (Object.hasOwn(raw, "goal")) {
    return raw.goal === null ? { goal: null, error: "" } : normalizeGoalObject(raw.goal);
  }
  if (record(raw.state) && Object.hasOwn(raw.state, "goal")) {
    return raw.state.goal === null ? { goal: null, error: "" } : normalizeGoalObject(raw.state.goal);
  }
  if (typeof raw.objective === "string") return normalizeGoalObject(raw);
  return { goal: null, error: "goal payload" };
}

// `now` is injected so tests can assert the stamp; it is the only clock read here.
//
// Source order: the live accessor is primary (it is what the pass sees after the event), and the
// event payload is the fallback for a host surface that is missing, throws or does not normalize.
// A valid primary answer always wins, including an explicit "no goal", so a stale event payload
// cannot resurrect a goal the host has already cleared.
export function projectGoal(ctx, { now = Date.now(), event = null } = {}) {
  const updatedAt = Number.isFinite(now) ? now : Date.now();
  const shape = (goal, sourceError) => ({ schema: GOAL_SCHEMA, updatedAt, goal,
    sourceError: sourceError || null });

  let primaryError = "";
  let hasAccessor = false;
  if (typeof ctx?.getGoalState === "function") {
    hasAccessor = true;
    let raw;
    try {
      raw = ctx.getGoalState();
    } catch (cause) {
      // outcome: a throwing host accessor is reported as a source error, never rethrown.
      primaryError = `getGoalState: ${message(cause)}`;
      raw = undefined;
      hasAccessor = false;
    }
    if (hasAccessor && (raw === undefined || raw === null)) return shape(null, "");
    if (hasAccessor) {
      const normalized = normalizeGoal(raw);
      if (!normalized.error) return shape(normalized.goal, "");
      primaryError = normalized.error;
    }
  }

  if (event !== null && event !== undefined) {
    const normalized = normalizeGoal(event);
    if (!normalized.error) return shape(normalized.goal, "");
    return shape(null, primaryError || normalized.error);
  }
  return shape(null, primaryError);
}
