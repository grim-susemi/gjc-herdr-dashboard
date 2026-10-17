// Todo source tests: the projection contract that the viewer reads and the fallback
// replay over the session branch.
//
// The shapes here are the measured L0 G4 shapes: `ctx.getTodoState()` returns
// `[{name, tasks:[{content,status}]}]`, `todo_write` tool results carry `details.phases`,
// and `/todo` edits append a `custom` entry of type `user_todo_edit` whose `data.phases`
// holds the same phase list. No live GJC, no live Herdr and no owner file is touched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { STATUS_ALIASES, TODO_SCHEMA, TODO_STATUSES, normalizeTodo, phasesFromBranch,
  projectTodo } from "../../src/host/sources/todo.mjs";
import { readProjection } from "../../src/viewers/todo/viewer.mjs";

const phase = (name, tasks) => ({ name, tasks });
const task = (content, status) => ({ content, status });

// A ctx whose branch is a real array, so a fallback only fires when a test wants it.
const ctxOf = (todoState, branch = []) => ({
  getTodoState: () => todoState,
  sessionManager: { getBranch: () => branch, getSessionId: () => "S1" },
});

const customEdit = (phases, id = "e1") => ({ id, type: "custom",
  customType: "user_todo_edit", data: { phases } });
const toolResult = (phases, { id = "e2", isError = false } = {}) => ({ id, type: "message",
  message: { role: "toolResult", toolName: "todo_write", isError, details: { phases } } });

test("the projection carries the contract schema and status vocabulary", () => {
  assert.equal(TODO_SCHEMA, "gjc-herdr-dashboard/todo/1");
  assert.deepEqual([...TODO_STATUSES], ["pending", "in_progress", "completed", "abandoned"]);
  assert.equal(STATUS_ALIASES.cancelled, "abandoned");
});

test("getTodoState is the primary source and its shape is converted verbatim", () => {
  const phases = [phase("Foundation", [task("Confirm", "completed"), task("Retire", "abandoned")]),
    phase("Implementation", [task("현재 작업", "in_progress"), task("Next", "pending")])];
  const projection = projectTodo(ctxOf(phases), { now: 1234 });
  assert.deepEqual(projection, { schema: TODO_SCHEMA, updatedAt: 1234, phases,
    empty: false, sourceError: null });
  // The projection round-trips through the viewer's own reader: one contract, not two.
  const read = readProjection("ignored.json", { read: () => projection });
  assert.equal(read.availability, "live");
  assert.equal(read.error, "");
  assert.deepEqual(read.projection.phases, phases);
});

test("the projection never carries notes, ids, assignment text or transcript bodies", () => {
  const projection = projectTodo(ctxOf([{ name: "P", tasks: [{ content: "keep", status: "pending",
    notes: ["secret note"], id: "native-id", assignee: "someone" }] }]));
  assert.deepEqual(projection.phases, [{ name: "P", tasks: [{ content: "keep", status: "pending" }] }]);
  const serialized = JSON.stringify(projection);
  for (const forbidden of ["secret note", "native-id", "assignee", "someone"]) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }
});

test("an empty source is reported as empty, never as a missing source", () => {
  assert.deepEqual(projectTodo(ctxOf([]), { now: 99 }),
    { schema: TODO_SCHEMA, updatedAt: 99, phases: [], empty: true, sourceError: null });
  const withEmptyPhase = projectTodo(ctxOf([phase("Shell", [])]));
  assert.equal(withEmptyPhase.empty, true);
  assert.equal(readProjection("x", { read: () => withEmptyPhase }).availability, "empty");
});

test("a cancelled status renders as abandoned, matching the renderer's mark table", () => {
  const projection = projectTodo(ctxOf([phase("P", [task("a", "cancelled"), task("b", "done"),
    task("c", "in-progress"), task("d", "TODO")])]));
  assert.deepEqual(projection.phases[0].tasks.map((entry) => entry.status),
    ["abandoned", "completed", "in_progress", "pending"]);
});

test("the branch replay takes the newest eligible payload, scanning backwards", () => {
  const older = [phase("Old", [task("stale", "completed")])];
  const newer = [phase("New", [task("fresh", "in_progress")])];
  // Newest wins whether it is a custom /todo edit or a todo_write tool result.
  assert.deepEqual(phasesFromBranch([customEdit(older, "e1"), toolResult(newer, { id: "e2" })]),
    { phases: newer, entryId: "e2", error: "" });
  assert.deepEqual(phasesFromBranch([toolResult(older, { id: "e1" }), customEdit(newer, "e2")]),
    { phases: newer, entryId: "e2", error: "" });
  // A failed tool result is not evidence of anything and is skipped.
  assert.deepEqual(phasesFromBranch([toolResult(newer, { id: "e1" }),
    toolResult(older, { id: "e2", isError: true })]), { phases: newer, entryId: "e1", error: "" });
  // Entries of other types, an unrelated tool and a missing payload are skipped.
  assert.equal(phasesFromBranch([{ type: "message", message: { role: "user" } },
    { type: "custom", customType: "other", data: { phases: older } },
    { type: "message", message: { role: "toolResult", toolName: "todo", isError: false,
      details: { phases: older } } }]), null);
  assert.equal(phasesFromBranch([]), null);
  assert.equal(phasesFromBranch(null), null);
  assert.equal(phasesFromBranch("nope"), null);
});

test("the replay is the fallback when the host accessor is absent or throws", () => {
  const phases = [phase("FromBranch", [task("one", "pending")])];
  // No accessor at all: the branch still tells the truth.
  const noAccessor = { sessionManager: { getBranch: () => [customEdit(phases)] } };
  assert.deepEqual(projectTodo(noAccessor).phases, phases);
  // A throwing accessor must not lose the branch data, and must not throw either.
  const throwing = { getTodoState() { throw new Error("host gone"); },
    sessionManager: { getBranch: () => [toolResult(phases)] } };
  // `now` is injected: two wall-clock reads can straddle a millisecond and make this flaky.
  assert.deepEqual(projectTodo(throwing, { now: 1234 }), { schema: TODO_SCHEMA,
    updatedAt: 1234, phases, empty: false, sourceError: null });
  // A throwing accessor with no usable branch is a source error, not an exception.
  const both = { getTodoState() { throw new Error("host gone"); },
    sessionManager: { getBranch() { throw new Error("no branch"); } } };
  const result = projectTodo(both);
  assert.deepEqual(result.phases, []);
  assert.match(result.sourceError, /host gone/);
  assert.equal(readProjection("x", { read: () => result }).availability, "source-error");
});

test("a malformed payload is reported and never throws", () => {
  const broken = [
    [{ name: "P", tasks: [{ content: "x", status: "nonsense" }] }],
    [{ name: 7, tasks: [] }],
    [{ name: "P" }],
    [{ name: "P", tasks: [{ status: "pending" }] }],
    [{ name: "P", tasks: [{ content: "x" }] }],
    "not a list", 42, { phases: "no" },
  ];
  for (const value of broken) {
    const projection = projectTodo(ctxOf(value, [toolResult([phase("Fallback",
      [task("saved", "pending")])])]));
    // The branch fallback still supplies rows when it has any.
    assert.deepEqual(projection.phases, [phase("Fallback", [task("saved", "pending")])],
      JSON.stringify(value));
    // With no fallback the projection is an explicit source error.
    const alone = projectTodo(ctxOf(value, []));
    assert.deepEqual(alone.phases, [], JSON.stringify(value));
    assert.equal(typeof alone.sourceError, "string");
    assert.ok(alone.sourceError.length > 0, JSON.stringify(value));
  }
});

test("the legacy todos shape and a raw phases payload are both accepted", () => {
  assert.deepEqual(normalizeTodo({ todos: [{ content: "a", status: "pending" }] }),
    { phases: [{ name: "Tasks", tasks: [{ content: "a", status: "pending" }] }], error: "" });
  assert.deepEqual(normalizeTodo({ phases: [phase("P", [task("a", "done")])] }),
    { phases: [phase("P", [task("a", "completed")])], error: "" });
  assert.deepEqual(normalizeTodo(null), { phases: [], error: "todo payload" });
});

test("a payload that does not normalize is reported rather than silently skipped", () => {
  // The entry is newer than the valid one, so the live state is unknown: report it, and do
  // not fall back to an older payload that would look authoritative.
  const replay = phasesFromBranch([toolResult([phase("Good", [task("a", "pending")])], { id: "old" }),
    customEdit([{ name: "Broken", tasks: [{ content: "x", status: "???" }] }], "new")]);
  assert.deepEqual(replay.phases, []);
  assert.match(replay.error, /user_todo_edit: todo status: \?\?\?/);
  assert.equal(replay.entryId, "new");
});

test("an unreadable branch is a source error, but an absent branch is not", () => {
  const noBranch = { getTodoState: () => undefined, sessionManager: {} };
  const projection = projectTodo(noBranch);
  assert.deepEqual(projection.phases, []);
  assert.equal(projection.empty, true);
  assert.equal(typeof projection.sourceError, "string");
});

test("the projection is stamped from the injected clock and defaults to now", () => {
  assert.equal(projectTodo(ctxOf([]), { now: 777 }).updatedAt, 777);
  const stamped = projectTodo(ctxOf([])).updatedAt;
  assert.ok(stamped > 1_600_000_000_000 && stamped <= Date.now(), String(stamped));
});
