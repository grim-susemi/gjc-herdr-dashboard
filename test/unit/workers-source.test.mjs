// Workers source tests: the projection contract the workers viewer reads, the bus facts the
// host actually emits, and the two rules that are easy to get wrong — K1 (a reported cost of 0
// is "unknown", not "free") and AC-G4/AC2.5 (assignment text never crosses this boundary).
//
// Every shape here is the measured L0 G5 shape: the main bus emits
// `task:subagent:lifecycle` / `task:subagent:progress` payloads straight out of the host's
// task/types.ts, and `ctx.getJobs()` answers `{running, recent, delivery}`. `task:subagent:event`
// carries one raw child event per payload; only its model evidence is read. No live GJC, no
// live Herdr, no owner file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { LIFECYCLE_STATUSES, WORKERS_MAX, WORKERS_SCHEMA, WORKERS_STATUSES,
  createWorkersTracker } from "../../src/host/sources/workers.mjs";

const SENTINEL = "SENTINEL-ASSIGNMENT-7c1";

// The two clocks the tests inject. `tickingClock` advances 1s per read, so a test that does not
// care about the timeline still gets ordered, never-coincident stamps; `manualClock` is moved by
// hand where the exact stamp sequence is the assertion (the lifecycle test reads as a timeline).
function tickingClock(start = 1_000_000) {
  let value = start;
  return { now: () => (value += 1000) };
}

const trackerOf = (options = {}) => createWorkersTracker({ now: tickingClock().now, ...options });

function manualClock(start = 1_000_000) {
  let value = start;
  return { now: () => value, at: (next) => { value = next; } };
}

// The lifecycle payload the host emits on `task:subagent:lifecycle` (SubagentLifecyclePayload).
const lifecycle = (id, status, extra = {}) => ({ id, agent: "loader",
  agentSource: "bundled", status, index: 0, ...extra });

// A progress payload wrapper (SubagentProgressPayload) plus its AgentProgress. Only the fields
// the projection consumes are spelled out; the host sends many more.
const progress = (id, status, extra = {}) => ({ agent: "loader", agentSource: "bundled",
  task: "do the thing", index: 0, progress: { index: 0, id, agent: "loader", status,
    task: "do the thing", recentTools: [], recentOutput: [], toolCount: 0, tokens: 0, cost: 0,
    durationMs: 0, ...extra } });

test("the module exports the contract schema, cap and vocabularies", () => {
  assert.equal(WORKERS_SCHEMA, "gjc-herdr-dashboard/workers/1");
  assert.equal(WORKERS_MAX, 50);
  assert.deepEqual([...WORKERS_STATUSES],
    ["pending", "running", "completed", "failed", "aborted", "paused"]);
  assert.deepEqual([...LIFECYCLE_STATUSES], ["started", "completed", "failed", "aborted",
    "paused"]);
  const tracker = trackerOf();
  assert.deepEqual(Object.keys(tracker).sort(),
    ["fail", "onEvent", "onLifecycle", "onProgress", "reset", "snapshot", "syncJobs"]);
  // An empty scope is a valid, explicit projection, not a missing file.
  assert.deepEqual(tracker.snapshot(), { schema: WORKERS_SCHEMA, updatedAt: 1_001_000,
    empty: true, sourceError: null, cards: [], ignored: 0 });
});

test("a lifecycle sequence walks pending -> running -> completed on one card", () => {
  const clock = manualClock(1_000_000);
  const tracker = createWorkersTracker({ now: clock.now });
  // `started` is the only non-terminal spelling and it maps to the card status `running`.
  tracker.onLifecycle(lifecycle("a1", "started", { description: "Audit the parser" }));
  const running = tracker.snapshot();
  assert.deepEqual(running.cards.map((card) => card.status), ["running"]);
  assert.equal(running.cards[0].id, "a1");
  assert.equal(running.cards[0].agent, "loader");
  assert.equal(running.cards[0].title, "Audit the parser");
  assert.equal(running.cards[0].background, false);
  assert.equal(running.empty, false);
  assert.equal(running.cards[0].startedAt, 1_000_000);
  // A running card has no end stamp and counts up to the snapshot's own clock.
  assert.equal(running.cards[0].endedAt, null);
  assert.equal(running.cards[0].durationMs, 0);
  clock.at(1_012_000);
  assert.equal(tracker.snapshot().cards[0].durationMs, 12_000);
  // Terminal: the end stamp freezes and the duration stops counting.
  tracker.onLifecycle(lifecycle("a1", "completed"));
  const done = tracker.snapshot();
  assert.equal(done.cards[0].status, "completed");
  assert.equal(done.cards[0].startedAt, 1_000_000);
  assert.equal(done.cards[0].endedAt, 1_012_000);
  assert.equal(done.cards[0].durationMs, 12_000);
  // A duplicate terminal event must not stretch a finished card's duration.
  clock.at(2_000_000);
  tracker.onLifecycle(lifecycle("a1", "completed"));
  const again = tracker.snapshot();
  assert.equal(again.cards[0].endedAt, 1_012_000);
  assert.equal(again.cards[0].durationMs, 12_000);
  // A re-run restarts the card: `started` clears the frozen end, the new run stamps afresh.
  tracker.onLifecycle(lifecycle("a1", "started"));
  const rerun = tracker.snapshot();
  assert.equal(rerun.cards[0].status, "running");
  assert.equal(rerun.cards[0].startedAt, 2_000_000);
  assert.equal(rerun.cards[0].endedAt, null);
  assert.equal(rerun.cards[0].durationMs, 0);
  // `paused` is terminal-shaped but keeps its own label and its frozen end.
  clock.at(2_030_000);
  tracker.onLifecycle(lifecycle("a1", "paused"));
  const paused = tracker.snapshot();
  assert.equal(paused.cards[0].status, "paused");
  assert.equal(paused.cards[0].endedAt, 2_030_000);
  assert.equal(paused.cards[0].durationMs, 30_000);
  assert.equal(paused.cards.length, 1);
  assert.equal(paused.ignored, 0);
});

test("two parallel subagents both reach completed and both keep their identity", () => {
  const tracker = trackerOf();
  tracker.onLifecycle(lifecycle("p1", "started", { description: "First lane", index: 1 }));
  tracker.onLifecycle(lifecycle("p2", "started", { description: "Second lane", index: 2 }));
  tracker.onProgress(progress("p1", "running", { toolCount: 3, tokens: 1200, currentTool: "bash",
    lastIntent: "run the unit tests", recentOutput: ["booting", "3 tests pass"] }));
  tracker.onProgress(progress("p2", "running", { toolCount: 7, tokens: 2400,
    recentOutput: ["reading src/a.mjs"] }));
  const live = tracker.snapshot();
  // Newest first: p2 was created second, so it leads.
  assert.deepEqual(live.cards.map((card) => card.id), ["p2", "p1"]);
  assert.deepEqual(live.cards.map((card) => card.status), ["running", "running"]);
  assert.deepEqual(live.cards.map((card) => card.toolCount), [7, 3]);
  assert.deepEqual(live.cards.map((card) => card.tokens), [2400, 1200]);
  assert.equal(live.cards[1].currentTool, "bash");
  assert.equal(live.cards[1].lastIntent, "run the unit tests");
  assert.equal(live.cards[1].lastOutput, "3 tests pass");
  tracker.onProgress(progress("p1", "completed", { toolCount: 9, tokens: 5000 }));
  tracker.onProgress(progress("p2", "completed", { toolCount: 11, tokens: 9000 }));
  const done = tracker.snapshot();
  assert.deepEqual(done.cards.map((card) => card.status), ["completed", "completed"]);
  assert.deepEqual(done.cards.map((card) => card.toolCount), [11, 9]);
  assert.deepEqual(done.cards.map((card) => card.background), [false, false]);
  assert.ok(done.cards.every((card) => card.endedAt !== null));
});

test("failed and aborted are distinct statuses and distinct cards", () => {
  const tracker = trackerOf();
  tracker.onLifecycle(lifecycle("f1", "started", { description: "Will fail" }));
  tracker.onLifecycle(lifecycle("b1", "started", { description: "Will abort" }));
  tracker.onLifecycle(lifecycle("f1", "failed"));
  tracker.onLifecycle(lifecycle("b1", "aborted"));
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.cards.map((card) => card.status), ["aborted", "failed"]);
  assert.notEqual(snapshot.cards[1].status, snapshot.cards[0].status);
  // The progress channel spells the same two outcomes; neither collapses into the other.
  tracker.onProgress(progress("f1", "failed"));
  tracker.onProgress(progress("b1", "aborted"));
  assert.deepEqual(tracker.snapshot().cards.map((card) => card.status), ["aborted", "failed"]);
  assert.equal(tracker.snapshot().ignored, 0);
});

test("a background task job becomes a card through syncJobs and stays updated in place", () => {
  const tracker = trackerOf();
  // An absent jobs surface is not a malformed payload: nothing changes and nothing is counted.
  tracker.syncJobs(undefined);
  tracker.syncJobs(null);
  assert.deepEqual(tracker.snapshot().cards, []);
  assert.equal(tracker.snapshot().ignored, 0);
  tracker.syncJobs({ running: [
    { id: "j1", label: "Background audit", type: "task", status: "running", startTime: 900_000,
      metadata: { agent: "auditor" } },
    // Only subagent jobs have a card here; a bash job is out of scope and is not malformed.
    { id: "j2", label: "npm test", type: "bash", status: "running", startTime: 900_000 },
  ], recent: [
    { id: "j3", label: "Finished audit", type: "task", status: "completed", startTime: 800_000,
      endTime: 850_000 },
  ], delivery: { queued: 0, delivering: false } });
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.cards.map((card) => card.id), ["j3", "j1"]);
  assert.deepEqual(snapshot.cards.map((card) => card.background), [true, true]);
  assert.deepEqual(snapshot.cards.map((card) => card.status), ["completed", "running"]);
  assert.deepEqual(snapshot.cards.map((card) => card.title), ["Finished audit",
    "Background audit"]);
  assert.equal(snapshot.cards[1].agent, "auditor");
  assert.equal(snapshot.cards[1].startedAt, 900_000);
  assert.equal(snapshot.cards[1].endedAt, null);
  // A job's frozen endTime is authoritative, and a later pass updates the same card.
  tracker.syncJobs({ running: [], recent: [
    { id: "j1", label: "Background audit", type: "task", status: "completed", startTime: 900_000,
      endTime: 990_000 },
  ] });
  const updated = tracker.snapshot();
  assert.equal(updated.cards.length, 2);
  assert.equal(updated.cards.find((card) => card.id === "j1").status, "completed");
  assert.equal(updated.cards.find((card) => card.id === "j1").endedAt, 990_000);
  assert.equal(updated.cards.find((card) => card.id === "j1").durationMs, 90_000);
  // The async job manager calls a cancelled job `cancelled`; the projection's one spelling for
  // that outcome is `aborted`, matching the bus vocabulary.
  tracker.syncJobs({ running: [{ id: "j4", label: "Cancelled", type: "task",
    status: "cancelled", startTime: 1, endTime: 2 }], recent: [] });
  assert.equal(tracker.snapshot().cards.find((card) => card.id === "j4").status, "aborted");
  assert.equal(tracker.snapshot().ignored, 0);
});

test("a bus card is never re-projected from the jobs surface, but a job card updates in place", () => {
  const tracker = trackerOf();
  tracker.onLifecycle(lifecycle("x1", "started", { description: "Bus card" }));
  tracker.onProgress(progress("x1", "running", { toolCount: 3, tokens: 42 }));
  tracker.syncJobs({ running: [{ id: "x1", label: "Job label", type: "task", status: "completed",
    startTime: 5, endTime: 6, metadata: { agent: "job-agent" } }], recent: [] });
  const card = tracker.snapshot().cards[0];
  // The bus card keeps its own title, agent, status and metrics: the job row is ignored.
  assert.equal(card.background, false);
  assert.equal(card.title, "Bus card");
  assert.equal(card.agent, "loader");
  assert.equal(card.status, "running");
  assert.equal(card.toolCount, 3);
  // A card the jobs surface created is still updated by a later pass, or it would stay running
  // forever; progress rows reach it too, keyed by the same id.
  const other = trackerOf();
  other.syncJobs({ running: [{ id: "y1", label: "Job card", type: "task", status: "running",
    startTime: 5 }], recent: [] });
  assert.equal(other.snapshot().cards[0].background, true);
  other.onProgress(progress("y1", "running", { toolCount: 4, tokens: 77 }));
  const merged = other.snapshot().cards[0];
  // The host reports the same run on the jobs surface AND the bus; once the bus has named it, it is a
  // foreground-tracked run, not a job-only background card (live LV-7 showed every card marked).
  assert.equal(merged.background, false);
  assert.equal(merged.toolCount, 4);
  assert.equal(merged.tokens, 77);
  assert.equal(merged.title, "Job card");
});

test("K1: a reported cost of 0 is unknown, a positive cost is kept", () => {
  const tracker = trackerOf();
  tracker.onProgress(progress("c1", "running", { cost: 0 }));
  tracker.onProgress(progress("c2", "running", { cost: 0.0123 }));
  tracker.onProgress(progress("c3", "running", { cost: undefined }));
  tracker.onProgress(progress("c4", "running", { cost: -1 }));
  const byId = new Map(tracker.snapshot().cards.map((card) => [card.id, card.cost]));
  assert.equal(byId.get("c1"), null);
  assert.equal(byId.get("c2"), 0.0123);
  assert.equal(byId.get("c3"), null);
  assert.equal(byId.get("c4"), null);
  // A card that never saw a usable cost reports unknown, never a fabricated zero.
  tracker.onLifecycle(lifecycle("c5", "started"));
  assert.equal(tracker.snapshot().cards.find((card) => card.id === "c5").cost, null);
});

test("assignment text, transcripts and session files never reach the projection", () => {
  const tracker = trackerOf();
  tracker.onLifecycle(lifecycle("s1", "started", { description: "Safe description",
    sessionFile: `C:/tmp/${SENTINEL}.jsonl` }));
  tracker.onProgress({ ...progress("s1", "running", { recentOutput: ["safe line"],
    lastIntent: "safe intent", currentTool: "bash" }), assignment: `Do the work. ${SENTINEL}`,
    sessionFile: `C:/tmp/${SENTINEL}.jsonl`, task: `Task body ${SENTINEL}` });
  const snapshot = tracker.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(SENTINEL), serialized);
  assert.ok(!serialized.includes("sessionFile"), serialized);
  assert.ok(!serialized.includes("assignment"), serialized);
  assert.equal(snapshot.cards[0].title, "Safe description");
  // The card shape is exactly the contract's, with no room for an accidental field.
  assert.deepEqual(Object.keys(snapshot.cards[0]),
    ["id", "agent", "title", "status", "background", "model", "currentTool", "lastIntent",
      "lastOutput", "toolCount", "tokens", "contextPercent", "cost", "durationMs", "retry",
      "startedAt", "endedAt"]);
  // The description is the title source; the task text is only a fallback when the host sent
  // no description at all.
  const fallback = trackerOf();
  fallback.onProgress(progress("s2", "running", { description: undefined }));
  assert.equal(fallback.snapshot().cards[0].title, "do the thing");
});

test("titles trim to 120 characters and lastOutput is the last non-empty line, capped at 200", () => {
  const tracker = trackerOf();
  const long = "가".repeat(300);
  tracker.onLifecycle(lifecycle("t1", "started", { description: `  ${long}\nsecond line ` }));
  const title = tracker.snapshot().cards[0].title;
  assert.equal(title.length, 120);
  // Control sequences are stripped, not rendered: a child cannot retitle the pane.
  tracker.onLifecycle(lifecycle("t2", "started",
    { description: "safe\x1b[2Jtitle\u202e" }));
  assert.equal(tracker.snapshot().cards.find((card) => card.id === "t2").title, "safe[2Jtitle");
  // A trailing blank line never blanks the card: the newest non-empty line wins.
  tracker.onProgress(progress("t1", "running", {
    recentOutput: ["older line", "  ", "", "the last line\ntrailing"] }));
  const card = tracker.snapshot().cards.find((entry) => entry.id === "t1");
  assert.equal(card.lastOutput, "trailing");
  tracker.onProgress(progress("t1", "running", { recentOutput: [`x${"y".repeat(400)}`] }));
  assert.equal(tracker.snapshot().cards.find((entry) => entry.id === "t1").lastOutput.length, 200);
  // A bound is never applied through the middle of a code point: no lone surrogate in the file.
  const emoji = trackerOf();
  emoji.onLifecycle(lifecycle("t3", "started", { description: "🙂".repeat(200) }));
  const clipped = emoji.snapshot().cards.find((card) => card.id === "t3").title;
  assert.ok(clipped.length <= 120);
  assert.equal(/[\ud800-\udbff]$/.test(clipped), false);
  assert.equal(JSON.parse(JSON.stringify(clipped)), clipped);
  // No output at all is unknown, not an empty string.
  tracker.onProgress(progress("t1", "running", { recentOutput: ["", "   "] }));
  assert.equal(tracker.snapshot().cards.find((entry) => entry.id === "t1").lastOutput, null);
});

test("contextPercent is contextTokens over contextWindow, and unknown when either is missing", () => {
  const tracker = trackerOf();
  tracker.onProgress(progress("k1", "running", { contextTokens: 50_000, contextWindow: 200_000 }));
  tracker.onProgress(progress("k2", "running", { contextTokens: 10_000 }));
  tracker.onProgress(progress("k3", "running", { contextWindow: 200_000 }));
  tracker.onProgress(progress("k4", "running", { contextTokens: 10, contextWindow: 0 }));
  const byId = new Map(tracker.snapshot().cards.map((card) => [card.id, card.contextPercent]));
  assert.equal(byId.get("k1"), 25);
  assert.equal(byId.get("k2"), null);
  assert.equal(byId.get("k3"), null);
  assert.equal(byId.get("k4"), null);
});

test("retry state maps attempt and delayMs when present, else stays null", () => {
  const tracker = trackerOf();
  tracker.onProgress(progress("r1", "running", { retryState: { attempt: 2, maxAttempts: 5,
    kind: "provider_error", delayMs: 1500, errorMessage: "429", startedAtMs: 1 } }));
  tracker.onProgress(progress("r2", "running", { retryState: undefined }));
  tracker.onProgress(progress("r3", "running", { retryState: { attempt: "2", delayMs: null } }));
  const byId = new Map(tracker.snapshot().cards.map((card) => [card.id, card.retry]));
  assert.deepEqual(byId.get("r1"), { attempt: 2, delayMs: 1500 });
  assert.equal(byId.get("r2"), null);
  assert.deepEqual(byId.get("r3"), { attempt: null, delayMs: null });
  // The projection hands out a copy: a consumer mutating it cannot corrupt the tracker.
  const snapshot = tracker.snapshot();
  snapshot.cards.find((card) => card.id === "r1").retry.attempt = 99;
  assert.equal(tracker.snapshot().cards.find((card) => card.id === "r1").retry.attempt, 2);
});

test("a card always carries a model key, unknown until a source names one", () => {
  const tracker = trackerOf();
  // A lifecycle-only card, a progress-only card and a background job card all project the
  // field: `null` is "unknown", never a missing key.
  tracker.onLifecycle(lifecycle("m0", "started"));
  tracker.onProgress(progress("m1", "running"));
  tracker.syncJobs({ running: [{ id: "m2", label: "job", type: "task", status: "running",
    startTime: 1 }], recent: [] });
  const cards = tracker.snapshot().cards;
  assert.deepEqual(cards.map((card) => card.id), ["m2", "m1", "m0"]);
  for (const card of cards) {
    assert.ok(Object.hasOwn(card, "model"), JSON.stringify(card));
    assert.equal(card.model, null, JSON.stringify(card));
  }
});

// `task:subagent:event` is the only source of the model a run actually uses. It carries no card
// id, so the card is the newest running/pending card of that `agent` + `index`; an event never
// creates a card, and the ordinary event firehose is dropped without touching `ignored`.
const subagentEvent = (event, extra = {}) => ({ index: 0, agent: "loader",
  agentSource: "bundled", task: "work", assignment: SENTINEL, event, ...extra });
const assistantEnd = (provider, model) => ({ type: "message_end",
  message: { role: "assistant", provider, model, content: SENTINEL } });

test("onEvent reads the model from message_end and model_fallback_switched", () => {
  const tracker = trackerOf();
  tracker.onLifecycle(lifecycle("e1", "started"));
  tracker.onEvent(subagentEvent(assistantEnd("openai", "gpt-5.5")));
  assert.equal(tracker.snapshot().cards[0].model, "openai/gpt-5.5");
  // A fallback switch replaces it with the host's own provider/model target.
  tracker.onEvent(subagentEvent({ type: "model_fallback_switched", from: "openai/gpt-5.5",
    to: "anthropic/claude-sonnet-4.6" }));
  assert.equal(tracker.snapshot().cards[0].model, "anthropic/claude-sonnet-4.6");
  // Privacy: the event bodies and the assignment never reach the projection, and the field is a
  // single sanitized, bounded line even for a hostile model name.
  tracker.onEvent(subagentEvent(assistantEnd("openai", "gpt\u001b[2Jx\n/y".repeat(80))));
  const snapshot = tracker.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(SENTINEL), serialized);
  assert.ok(!serialized.includes("assignment"), serialized);
  const model = snapshot.cards[0].model;
  assert.ok(model.length <= 120, String(model.length));
  assert.doesNotMatch(model, /\u001b|\n/);
  assert.ok(model.startsWith("openai/gpt[2Jx /y"), model);
  assert.equal(tracker.snapshot().ignored, 0);
});

test("onEvent ignores unrelated events and malformed payloads without inventing cards", () => {
  const tracker = trackerOf();
  tracker.onLifecycle(lifecycle("i1", "started"));
  // The normal firehose: every other event kind, and a message_end that is not an assistant
  // message carrying both strings, is dropped silently (never counted).
  for (const event of [
    { type: "message_start", message: { role: "assistant" } },
    { type: "tool_call", name: "bash", arguments: { command: SENTINEL } },
    { type: "message_end", message: { role: "user", provider: "openai", model: "gpt-5.5" } },
    { type: "message_end", message: { role: "assistant", provider: 7, model: "gpt-5.5" } },
    { type: "message_end", message: { role: "assistant", provider: "openai" } },
    { type: "message_end", message: "not a message" },
    { type: "model_fallback_switched", to: 7 },
    { type: "model_fallback_switched" },
    {},
  ]) tracker.onEvent(subagentEvent(event));
  const quiet = tracker.snapshot();
  assert.equal(quiet.ignored, 0, "the firehose is not counted");
  assert.equal(quiet.cards[0].model, null);
  // A payload with no usable `event` object is structurally malformed and is counted.
  for (const payload of [null, "nope", [], { index: 0, agent: "loader" },
    { index: 0, agent: "loader", event: null }]) {
    tracker.onEvent(payload);
  }
  assert.equal(tracker.snapshot().ignored, 5);
  assert.equal(tracker.snapshot().cards.length, 1, "an event never creates a card");
  // An event that names no known card is ignored silently too: it is not malformed.
  tracker.onEvent(subagentEvent(assistantEnd("openai", "gpt-5.5"), { agent: "stranger" }));
  tracker.onEvent(subagentEvent(assistantEnd("openai", "gpt-5.5"), { index: 9 }));
  tracker.onEvent(subagentEvent(assistantEnd("openai", "gpt-5.5"), { index: undefined }));
  const unmatched = tracker.snapshot();
  assert.equal(unmatched.ignored, 5);
  assert.equal(unmatched.cards.length, 1);
  assert.equal(unmatched.cards[0].model, null);
});

test("onEvent matches the newest live card and never a finished one", () => {
  const tracker = trackerOf();
  // Two cards of the same agent at the same index: the newest (highest order) is the target.
  tracker.onLifecycle(lifecycle("n1", "started", { description: "older" }));
  tracker.onLifecycle(lifecycle("n2", "started", { description: "newer" }));
  tracker.onEvent(subagentEvent(assistantEnd("openai", "gpt-5.5")));
  const byId = new Map(tracker.snapshot().cards.map((card) => [card.id, card.model]));
  assert.equal(byId.get("n2"), "openai/gpt-5.5");
  assert.equal(byId.get("n1"), null);
  // A terminal card is not live: the next switch goes to the remaining running card, and the
  // finished run keeps the model it actually ended on.
  tracker.onLifecycle(lifecycle("n2", "completed"));
  tracker.onEvent(subagentEvent({ type: "model_fallback_switched", to: "openai/o4" }));
  const after = new Map(tracker.snapshot().cards.map((card) => [card.id, card.model]));
  assert.equal(after.get("n1"), "openai/o4");
  assert.equal(after.get("n2"), "openai/gpt-5.5");
  // A pending card counts as live, and a fractional payload index is floored to the card row.
  const pending = trackerOf();
  pending.onProgress(progress("p1", "pending", { index: 3 }));
  pending.onEvent(subagentEvent(assistantEnd("anthropic", "claude-sonnet-4.6"),
    { index: 3.9 }));
  assert.equal(pending.snapshot().cards[0].model, "anthropic/claude-sonnet-4.6");
  assert.equal(pending.snapshot().cards[0].id, "p1");
});

test("modelOverride fills a card until an event-derived model overrides it", () => {
  const tracker = trackerOf();
  // A non-empty string shows the model before the first assistant message ends.
  tracker.onProgress(progress("o1", "running", { modelOverride: "openai/gpt-5.5" }));
  assert.equal(tracker.snapshot().cards[0].model, "openai/gpt-5.5");
  // The event-derived model always wins, and a later weaker override never degrades it.
  tracker.onEvent(subagentEvent(assistantEnd("anthropic", "claude-sonnet-4.6")));
  assert.equal(tracker.snapshot().cards[0].model, "anthropic/claude-sonnet-4.6");
  tracker.onProgress(progress("o1", "running", { modelOverride: "openai/gpt-5.5" }));
  assert.equal(tracker.snapshot().cards[0].model, "anthropic/claude-sonnet-4.6");
  // A non-empty array yields its first string element; an empty or non-string one is no
  // evidence, and neither is a blank string.
  const list = trackerOf();
  list.onProgress(progress("o2", "running", { modelOverride: ["openai/gpt-5.5", "x"] }));
  assert.equal(list.snapshot().cards[0].model, "openai/gpt-5.5");
  const none = trackerOf();
  for (const [id, modelOverride] of [["o3", []], ["o4", [7]], ["o5", ""], ["o6", 7],
    ["o7", [""]], ["o8", null], ["o9", ["  "]]]) {
    none.onProgress(progress(id, "running", { modelOverride }));
  }
  for (const card of none.snapshot().cards) assert.equal(card.model, null, JSON.stringify(card));
  // A hostile override is sanitized and bounded like any other text.
  const hostile = trackerOf();
  hostile.onProgress(progress("o10", "running",
    { modelOverride: `openai/${"m".repeat(300)}\u001b[2J` }));
  const model = hostile.snapshot().cards[0].model;
  assert.ok(model.length <= 120, String(model.length));
  assert.doesNotMatch(model, /\u001b/);
});

test("titles prefer the description and fall back to the task text", () => {
  const tracker = trackerOf();
  // A lifecycle event with no description: the progress row's task text is the best available
  // title, and the description that arrives later still wins.
  tracker.onProgress(progress("u1", "running", { description: undefined }));
  assert.equal(tracker.snapshot().cards[0].title, "do the thing");
  tracker.onProgress(progress("u1", "running", { description: "Real description" }));
  assert.equal(tracker.snapshot().cards[0].title, "Real description");
  // ... and the reverse order must not degrade it back to the weaker source.
  tracker.onProgress(progress("u1", "running", { description: undefined }));
  assert.equal(tracker.snapshot().cards[0].title, "Real description");
  // A card with no text anywhere keeps the empty string, never a fabricated placeholder.
  tracker.onProgress({ agent: "loader", progress: { index: 0, id: "u2", agent: "loader",
    status: "running" } });
  assert.equal(tracker.snapshot().cards.find((card) => card.id === "u2").title, "");
});

test("an ambiguous agent + index pair never merges two cards", () => {
  const tracker = trackerOf();
  // Two cards of the same agent at the same index (the same agent, two parallel invocations).
  tracker.onLifecycle({ id: "d1", agent: "loader", agentSource: "bundled", status: "started",
    description: "First", index: 0 });
  tracker.onLifecycle({ id: "d2", agent: "loader", agentSource: "bundled", status: "started",
    description: "Second", index: 0 });
  // An id-less row cannot say which one it means, so it is counted rather than guessed at.
  tracker.onProgress({ agent: "loader", index: 0, progress: { index: 0, agent: "loader",
    status: "running", toolCount: 5 } });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.cards.length, 2);
  assert.deepEqual(snapshot.cards.map((card) => card.toolCount), [0, 0]);
  assert.equal(snapshot.ignored, 1);
});

test("progress falls back to agent + index when the progress payload has no id", () => {
  const tracker = trackerOf();
  tracker.onLifecycle({ id: "n1", agent: "loader", agentSource: "bundled", status: "started",
    description: "Named card", index: 4 });
  // No id in the progress payload: the agent+index pair identifies the card, and the card keeps
  // the key it was created with (a row that carries no id cannot rename anything).
  tracker.onProgress({ agent: "loader", agentSource: "bundled", index: 4,
    progress: { index: 4, agent: "loader", status: "running", task: "work", recentTools: [],
      recentOutput: [], toolCount: 6, tokens: 42, cost: 0, durationMs: 0 } });
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.cards[0].id, "n1");
  assert.equal(snapshot.cards[0].toolCount, 6);
  assert.equal(snapshot.ignored, 0);
  // A payload that does carry the id lands on the same card.
  tracker.onProgress(progress("n1", "running", { toolCount: 8 }));
  assert.equal(tracker.snapshot().cards[0].toolCount, 8);
  // An unmatched progress row is ignored and counted rather than invented as a card.
  tracker.onProgress({ agent: "stranger", agentSource: "bundled", index: 9,
    progress: { index: 9, agent: "stranger", status: "running", task: "work", recentTools: [],
      recentOutput: [], toolCount: 1, tokens: 1, cost: 0, durationMs: 0 } });
  snapshot = tracker.snapshot();
  assert.equal(snapshot.cards.length, 1);
  assert.equal(snapshot.ignored, 1);
});

test("malformed payloads are ignored and counted instead of guessed at", () => {
  const tracker = trackerOf();
  const malformed = [
    ["lifecycle", null],
    ["lifecycle", "not a payload"],
    ["lifecycle", lifecycle("", "started")],
    ["lifecycle", { agent: "loader", status: "started" }],
    ["lifecycle", lifecycle("m1", "spawned")],
    ["lifecycle", lifecycle("m1", undefined)],
    ["progress", null],
    ["progress", { progress: null }],
    ["progress", progress("m1", "zombie")],
    ["progress", { agent: "loader", progress: { index: 0, agent: "loader", status: "running",
      recentTools: [] } }],
    ["jobs", []],
    ["jobs", {}],
    ["jobs", { running: "nope" }],
    ["jobs", { running: [null] }],
    ["jobs", { running: [{ label: "no id", type: "task", status: "running" }] }],
    // An event payload without an `event` object carries nothing to read.
    ["event", null],
    ["event", "not a payload"],
    ["event", { index: 0, agent: "loader" }],
    ["event", { index: 0, agent: "loader", event: null }],
  ];
  let expected = 0;
  for (const [channel, payload] of malformed) {
    if (channel === "lifecycle") tracker.onLifecycle(payload);
    else if (channel === "progress") tracker.onProgress(payload);
    else if (channel === "event") tracker.onEvent(payload);
    else tracker.syncJobs(payload);
    // Each rejected payload adds exactly one to the counter and changes nothing else.
    expected += 1;
    const snapshot = tracker.snapshot();
    assert.equal(snapshot.ignored, expected, `${channel}: ${JSON.stringify(payload)}`);
    assert.deepEqual(snapshot.cards, [], `${channel}: ${JSON.stringify(payload)}`);
  }
  // Not one of them invented a card.
  assert.equal(tracker.snapshot().empty, true);
  // A well-formed payload right after the noise still lands, and the counter is honest.
  tracker.onLifecycle(lifecycle("ok", "started"));
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.cards.map((card) => card.id), ["ok"]);
  assert.equal(snapshot.ignored, malformed.length);
  // The jobs surface reports `{running, recent}` on the measured host; a `recent`-only answer
  // is still a real answer.
  const recentOnly = trackerOf();
  recentOnly.syncJobs({ recent: [{ id: "z1", label: "old", type: "task", status: "failed",
    startTime: 1, endTime: 2 }] });
  assert.equal(recentOnly.snapshot().cards.length, 1);
  assert.equal(recentOnly.snapshot().ignored, 0);
});

test("the cap keeps 50 cards, dropping the oldest completed first and then the oldest", () => {
  const tracker = trackerOf();
  for (let index = 1; index <= 51; index += 1) tracker.onLifecycle(lifecycle(`c${index}`, "started"));
  const capped = tracker.snapshot();
  assert.equal(capped.cards.length, 50);
  assert.equal(capped.cards.at(0).id, "c51");
  assert.equal(capped.cards.at(-1).id, "c2");
  assert.ok(!capped.cards.some((card) => card.id === "c1"));

  // With a completed card in the window, the finished run is evicted before any live one.
  const completed = trackerOf({ max: 3 });
  completed.onLifecycle(lifecycle("done", "started"));
  completed.onLifecycle(lifecycle("done", "completed"));
  completed.onLifecycle(lifecycle("live1", "started"));
  completed.onLifecycle(lifecycle("live2", "started"));
  completed.onLifecycle(lifecycle("live3", "started"));
  assert.deepEqual(completed.snapshot().cards.map((card) => card.id),
    ["live3", "live2", "live1"]);

  // Oldest completed first among several: the newest finished work survives longest.
  const several = trackerOf({ max: 2 });
  several.onLifecycle(lifecycle("first", "started"));
  several.onLifecycle(lifecycle("first", "completed"));
  several.onLifecycle(lifecycle("second", "started"));
  several.onLifecycle(lifecycle("second", "completed"));
  several.onLifecycle(lifecycle("third", "started"));
  assert.deepEqual(several.snapshot().cards.map((card) => card.id), ["third", "second"]);
});

test("durationMs agrees with whatever the card actually knows", () => {
  const clock = manualClock(1_000_000);
  const tracker = createWorkersTracker({ now: clock.now });
  // Progress-only card (no lifecycle seen): there is no start stamp to count from, so the host's
  // own number is the only honest answer.
  tracker.onProgress(progress("d1", "running", { durationMs: 4321 }));
  assert.equal(tracker.snapshot().cards[0].durationMs, 4321);
  assert.equal(tracker.snapshot().cards[0].startedAt, null);
  // Lifecycle-stamped card: the stamps win, and `now` moves the running duration.
  tracker.onLifecycle(lifecycle("d2", "started"));
  assert.equal(tracker.snapshot().cards[0].durationMs, 0);
  clock.at(1_007_000);
  assert.equal(tracker.snapshot().cards[0].durationMs, 7000);
  // Once terminal, the duration is frozen against the end stamp and ignores the clock.
  clock.at(1_009_000);
  tracker.onLifecycle(lifecycle("d2", "failed"));
  clock.at(9_999_999);
  const finished = tracker.snapshot().cards[0];
  assert.equal(finished.durationMs, 9000);
  assert.equal(finished.durationMs, finished.endedAt - finished.startedAt);
  // A nonsense host number is never rendered: unreadable means 0 elapsed, not a negative or NaN.
  const junk = trackerOf();
  junk.onProgress(progress("d3", "running", { durationMs: -5 }));
  assert.equal(junk.snapshot().cards[0].durationMs, 0);
  assert.ok(Number.isFinite(junk.snapshot().cards[0].durationMs));
});

test("fail() records the source error and leaves a valid projection behind", () => {
  // A frozen clock: this test is about the error surface, not about elapsed time, so the two
  // snapshots it compares must be otherwise identical byte for byte.
  const tracker = createWorkersTracker({ now: () => 1_234 });
  tracker.onLifecycle(lifecycle("e1", "started"));
  const before = tracker.snapshot();
  tracker.fail(new Error("bus handler exploded"), "onProgress");
  const after = tracker.snapshot();
  assert.equal(after.sourceError, "bus handler exploded");
  assert.deepEqual(after.cards, before.cards);
  assert.equal(after.empty, false);
  assert.equal(after.schema, WORKERS_SCHEMA);
  assert.ok(Number.isFinite(after.updatedAt));
  // A non-Error failure still yields a string, and `where` is the evidence when it has no
  // message of its own.
  tracker.fail("plain string", "onLifecycle");
  assert.equal(tracker.snapshot().sourceError, "plain string");
  tracker.fail(undefined, "syncJobs");
  assert.equal(tracker.snapshot().sourceError, "syncJobs");
  // An error object with no message falls back to the call site, never to "[object Object]".
  tracker.fail({ code: "EIO" }, "onProgress");
  assert.equal(tracker.snapshot().sourceError, "onProgress");
  tracker.fail(null, null);
  assert.equal(tracker.snapshot().sourceError, "error");
  // The projection is JSON-safe in every one of those states (the owner writes it verbatim).
  assert.equal(typeof JSON.stringify(tracker.snapshot()), "string");
});

test("reset() clears the scope: cards, source error and the ignore counter", () => {
  const tracker = createWorkersTracker({ now: () => 1_001_000 });
  tracker.onLifecycle(lifecycle("r1", "started"));
  tracker.onProgress(progress("r2", "running"));
  tracker.onProgress(null);
  tracker.fail(new Error("boom"), "onProgress");
  assert.equal(tracker.snapshot().ignored, 1);
  assert.equal(tracker.snapshot().sourceError, "boom");
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), { schema: WORKERS_SCHEMA, updatedAt: 1_001_000,
    empty: true, sourceError: null, cards: [], ignored: 0 });
  // The tracker is usable again after a reset, and the new scope counts from zero.
  tracker.onLifecycle(lifecycle("r3", "started"));
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.cards.map((card) => card.id), ["r3"]);
  assert.equal(snapshot.ignored, 0);
});

test("snapshot() never throws, and a hostile payload is the host wrapper's to catch", () => {
  const tracker = trackerOf();
  // The contract's boundary: a *malformed* payload is a data problem, so it is ignored and
  // counted here. A payload whose own getters raise is a fault, and it propagates to the host's
  // try/catch (AC2.7), which records it with `fail()` and keeps the rest of the pass running.
  // Swallowing it here would leave the pane claiming a healthy source.
  const hostile = (key) => ({ get [key]() { throw new Error(`hostile ${key}`); } });
  for (const [call, payload] of [
    [() => tracker.onLifecycle(hostile("id")), "lifecycle"],
    [() => tracker.onProgress(hostile("progress")), "progress"],
    [() => tracker.onProgress({ progress: hostile("status") }), "progress status"],
    [() => tracker.syncJobs(hostile("running")), "jobs"],
  ]) {
    assert.throws(call, { message: /hostile/ }, payload);
  }
  // The exception left the tracker untouched, and a well-formed payload still works.
  assert.deepEqual(tracker.snapshot().cards, []);
  assert.equal(tracker.snapshot().ignored, 0);
  tracker.onLifecycle(lifecycle("h", "started"));
  assert.deepEqual(tracker.snapshot().cards.map((card) => card.id), ["h"]);
  // And the host's recovery path produces exactly the documented source-error projection.
  tracker.fail(new Error("hostile progress"), "onProgress");
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.sourceError, "hostile progress");
  assert.deepEqual(snapshot.cards.map((card) => card.id), ["h"]);
});

test("the injected clock stamps every snapshot and survives a broken clock", () => {
  let value = 5_000;
  const tracker = createWorkersTracker({ now: () => value });
  assert.equal(tracker.snapshot().updatedAt, 5_000);
  value = 6_000;
  assert.equal(tracker.snapshot().updatedAt, 6_000);
  // A clock that raises must not break the module's one hard promise: `snapshot()` never throws.
  const hostile = createWorkersTracker({ now: () => { throw new Error("clock gone"); } });
  hostile.onLifecycle(lifecycle("h1", "started"));
  const salvaged = hostile.snapshot();
  assert.ok(Number.isFinite(salvaged.updatedAt));
  assert.ok(Number.isFinite(salvaged.cards[0].startedAt));
  // A clock that returns garbage must not put NaN in the projection.
  const broken = createWorkersTracker({ now: () => Number.NaN });
  broken.onLifecycle(lifecycle("b1", "started"));
  const snapshot = broken.snapshot();
  assert.ok(Number.isFinite(snapshot.updatedAt));
  assert.ok(Number.isFinite(snapshot.cards[0].startedAt));
  // The cap is configurable so a caller can keep the projection file smaller.
  const small = createWorkersTracker({ now: () => 1, max: 1 });
  small.onLifecycle(lifecycle("only", "started"));
  small.onLifecycle(lifecycle("next", "started"));
  assert.deepEqual(small.snapshot().cards.map((card) => card.id), ["next"]);
});
