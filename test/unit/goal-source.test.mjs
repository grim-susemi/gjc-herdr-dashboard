// L5b goal source tests: the projection contract, the event normalizer and the never-throw
// boundary for the measured 0.18.11 surface.
//
// Shapes are the ones recorded in `.evidence/L5/goalsurface/summary.json`:
//   getGoalState() -> undefined without a goal, else {enabled, mode, goal:{...}}
//   goal_updated   -> {type, goal, state} (state is the same wrapper)
// Only objective, status, tokensUsed and timeUsedSeconds may cross the boundary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GOAL_SCHEMA, GOAL_STATUSES, normalizeGoal, projectGoal }
  from "../../src/host/sources/goal.mjs";

const goal = { id: "goal-1", objective: "ship the goal line", status: "active",
  tokensUsed: 214181, timeUsedSeconds: 14, createdAt: 1, updatedAt: 2,
  provenance: { internal: "do-not-copy" } };
const wrapper = { enabled: true, mode: "goal", goal };
const expected = { objective: "ship the goal line", status: "active",
  tokensUsed: 214181, timeUsedSeconds: 14 };

test("the goal contract names its schema and the statuses the renderer labels", () => {
  assert.equal(GOAL_SCHEMA, "gjc-herdr-dashboard/goal/1");
  assert.deepEqual([...GOAL_STATUSES], ["active", "paused", "completed", "cancelled",
    "abandoned", "failed"]);
});

test("a getGoalState wrapper is projected to exactly the four rendered fields", () => {
  const projection = projectGoal({ getGoalState: () => wrapper }, { now: 1234 });
  assert.deepEqual(projection, { schema: GOAL_SCHEMA, updatedAt: 1234, goal: expected,
    sourceError: null });
  const serialized = JSON.stringify(projection);
  for (const forbidden of ["goal-1", "provenance", "do-not-copy", "createdAt"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("the event normalizer accepts the event, the state wrapper and a bare goal object", () => {
  assert.deepEqual(normalizeGoal({ type: "goal_updated", goal, state: wrapper }),
    { goal: expected, error: "" });
  assert.deepEqual(normalizeGoal({ goal, state: wrapper }), { goal: expected, error: "" });
  assert.deepEqual(normalizeGoal({ enabled: true, mode: "goal", goal }), { goal: expected, error: "" });
  assert.deepEqual(normalizeGoal({ state: { enabled: false, mode: "none", goal } }),
    { goal: expected, error: "" });
  assert.deepEqual(normalizeGoal(goal), { goal: expected, error: "" });
});

test("no goal is null without an error, never a fabricated row", () => {
  for (const value of [undefined, null, { enabled: false, mode: "none", goal: null },
    { type: "goal_updated", goal: null, state: { goal: null } }]) {
    assert.deepEqual(normalizeGoal(value), { goal: null, error: "" }, JSON.stringify(value));
  }
  for (const ctx of [{}, null, { getGoalState: () => undefined }]) {
    assert.deepEqual(projectGoal(ctx, { now: 9 }),
      { schema: GOAL_SCHEMA, updatedAt: 9, goal: null, sourceError: null });
  }
});

test("a throwing accessor is a source error and never an exception", () => {
  const projection = projectGoal({ getGoalState: () => { throw new Error("host gone"); } }, { now: 5 });
  assert.deepEqual(projection.goal, null);
  assert.match(projection.sourceError, /getGoalState: host gone/);
  assert.equal(projection.updatedAt, 5);
});

test("a malformed goal is reported field by field and never half-converted", () => {
  const broken = [
    [{ goal: { objective: 7, status: "active", tokensUsed: 1, timeUsedSeconds: 1 } }, "goal objective"],
    [{ goal: { objective: "x", status: 7, tokensUsed: 1, timeUsedSeconds: 1 } }, "goal status"],
    [{ goal: { objective: "x", status: "  ", tokensUsed: 1, timeUsedSeconds: 1 } }, "goal status"],
    [{ goal: { objective: "x", status: "active", tokensUsed: -1, timeUsedSeconds: 1 } }, "goal tokensUsed"],
    [{ goal: { objective: "x", status: "active", tokensUsed: 1, timeUsedSeconds: Number.NaN } }, "goal timeUsedSeconds"],
    [{ goal: "not-an-object" }, "goal payload"],
    [{ type: "goal_updated" }, "goal payload"],
    ["not an object", "goal payload"],
  ];
  for (const [value, reason] of broken) {
    const normalized = normalizeGoal(value);
    assert.equal(normalized.goal, null, JSON.stringify(value));
    assert.equal(normalized.error, reason, JSON.stringify(value));
    const projection = projectGoal({ getGoalState: () => value }, { now: 1 });
    assert.equal(projection.goal, null);
    assert.match(projection.sourceError, new RegExp(reason));
  }
});

test("the event payload is the fallback when the accessor is absent or throws", () => {
  const event = { type: "goal_updated", goal, state: wrapper };
  assert.deepEqual(projectGoal({}, { now: 2, event }).goal, expected);
  assert.deepEqual(projectGoal({ getGoalState: () => { throw new Error("gone"); } },
    { now: 2, event }).goal, expected);
  // A malformed accessor answer also falls back to a valid event instead of losing the line.
  assert.deepEqual(projectGoal({ getGoalState: () => ({ goal: 7 }) }, { now: 2, event }).goal, expected);
});

test("a valid accessor answer wins over the event, including an explicit no-goal", () => {
  const other = { ...goal, objective: "newer", tokensUsed: 1 };
  const fromCtx = projectGoal({ getGoalState: () => ({ enabled: true, mode: "goal", goal: other }) },
    { now: 3, event: { goal, state: wrapper } });
  assert.equal(fromCtx.goal.objective, "newer");
  const cleared = projectGoal({ getGoalState: () => undefined }, { now: 3,
    event: { goal, state: wrapper } });
  assert.equal(cleared.goal, null, "a stale event may not resurrect a cleared goal");
});

test("status is normalized to the renderer's key spelling and values stay numeric", () => {
  const projection = projectGoal({ getGoalState: () => ({ goal: { ...goal,
    status: " Active " } }) });
  assert.equal(projection.goal.status, "active");
  assert.equal(projection.goal.tokensUsed, 214181);
  assert.equal(projection.goal.timeUsedSeconds, 14);
});
