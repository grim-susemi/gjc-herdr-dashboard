// Shared viewer helper tests: footer, heartbeat, slot watch, fence, owner label, q.
//
// These helpers have no omo counterpart test: omo kept the same logic inside its
// viewer/controller and only exercised it through the pty suite. They are tested
// directly here because both role viewers depend on them.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clockTime, closeOwnPane, connectionLabel, createHeartbeat, createSlotWatcher,
  fenceDecision, footerText, generationOf, ownerLiveness, readyRecord } from "../../src/viewers/common.mjs";

const fakeClock = () => {
  let now = 0, id = 0;
  const intervals = new Map();
  return {
    now: () => now,
    setInterval(fn, ms) { const key = ++id; intervals.set(key, { fn, ms }); return key; },
    clearInterval: (key) => intervals.delete(key),
    setTimeout(fn, ms) { const key = ++id; intervals.set(key, { fn, ms, kind: "timeout" }); return key; },
    clearTimeout: (key) => intervals.delete(key),
    advance(ms) { now += ms; },
    tick(ms) { for (const timer of intervals.values()) if (ms === undefined || timer.ms === ms) timer.fn(); },
    intervalCount: (ms) => [...intervals.values()].filter((timer) => timer.ms === ms).length,
    get size() { return intervals.size; },
  };
};

test("clockTime is a zero-padded local HH:MM and survives a bad value", () => {
  assert.equal(clockTime(new Date(2026, 0, 2, 9, 5).getTime()), "09:05");
  assert.equal(clockTime(new Date(2026, 0, 2, 23, 59).getTime()), "23:59");
  assert.match(clockTime(Number.NaN), /^\d{2}:\d{2}$/);
});

test("the five connection labels are pairwise distinct in every language", () => {
  const at = new Date(2026, 0, 2, 9, 5).getTime();
  for (const language of ["ko", "en", "zh-cn"]) {
    const labels = ["live", "waiting", "empty", "disconnected", "source-error"]
      .map((kind) => connectionLabel(language, { kind, at }));
    assert.equal(new Set(labels).size, 5, labels.join(" | "));
    // An unknown kind degrades to live rather than throwing mid-frame.
    assert.equal(connectionLabel(language, { kind: "nonsense" }), labels[0]);
    assert.equal(connectionLabel(language, {}), labels[0]);
    assert.equal(connectionLabel(language), labels[0]);
    // An unsupported language is the ko catalogue, per policy.
    assert.equal(connectionLabel("de", { kind: "live" }), "실시간");
  }
});

test("the footer always leads with follow then connection, notices last", () => {
  assert.equal(footerText("en", { follow: true, connection: { kind: "live" } }), "Follow ON · Live");
  assert.equal(footerText("en", { follow: false, connection: { kind: "empty" } }), "Follow OFF · Empty");
  assert.equal(footerText("en", { connection: { kind: "live" }, notices: ["a", "b"] }),
    "Follow ON · Live · a · b");
  // Empty and non-string notices are dropped rather than printed as separators.
  assert.equal(footerText("en", { connection: { kind: "live" }, notices: ["", null, undefined, 7] }),
    "Follow ON · Live");
  // No keyboard legend may appear in any footer (AC-F1).
  for (const language of ["ko", "en", "zh-cn"]) {
    assert.doesNotMatch(footerText(language, { connection: { kind: "live" } }), /j\/k|q |Tab|Space|↑|↓/);
  }
});

test("generation comes from the viewer's own ROOT config.json, else 'dev'", () => {
  const dir = mkdtempSync(join(tmpdir(), "gjc-gen-"));
  const rootUrl = new URL(`file:///${dir.replaceAll("\\", "/")}/`);
  assert.equal(generationOf(rootUrl), "dev", "no config.json yet");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ lang: "ko", generation: "generation-000007" }));
  assert.equal(generationOf(rootUrl), "generation-000007");
  // A malformed or unhelpful config is a dev tree, not a crash.
  writeFileSync(join(dir, "config.json"), "{oops");
  assert.equal(generationOf(rootUrl), "dev");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ generation: 7 }));
  assert.equal(generationOf(rootUrl), "dev");
  rmSync(dir, { recursive: true, force: true });
});

test("the ready record carries exactly the agreed fields, and closing only when asked", () => {
  const base = { pid: 10, token: "t", paneId: "w1:p2", startedAt: 1, now: 2 };
  assert.deepEqual(readyRecord(base), { pid: 10, token: "t", paneId: "w1:p2", gen: "dev",
    startedAt: 1, heartbeatAt: 2 });
  assert.deepEqual(readyRecord({ ...base, gen: "generation-000002", closing: "q" }),
    { pid: 10, token: "t", paneId: "w1:p2", gen: "generation-000002", startedAt: 1,
      heartbeatAt: 2, closing: "q" });
  assert.equal("closing" in readyRecord(base), false);
});

test("the heartbeat writer persists a fresh heartbeatAt on every 5s tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gjc-hb-"));
  mkdirSync(join(dir, "roles"), { recursive: true });
  const path = join(dir, "roles", "todo.ready.json");
  const clock = fakeClock();
  let heartbeatAt = 0;
  const writes = [];
  const heartbeat = createHeartbeat({ path, clock, heartbeat: true,
    build: ({ closing } = {}) => ({ pid: 1, paneId: "w1:p2", heartbeatAt: ++heartbeatAt, ...(closing ? { closing } : {}) }),
    write: async (target, value) => { writes.push(value.heartbeatAt); writeFileSync(target, JSON.stringify(value)); } });
  await heartbeat.write();
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { pid: 1, paneId: "w1:p2", heartbeatAt: 1 });
  heartbeat.start();
  assert.equal(clock.intervalCount(5000), 1, "exactly one 5s timer");
  clock.tick(5000); clock.tick(5000);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(writes, [1, 2, 3], "each tick writes a fresh heartbeat");
  // A non-interactive viewer runs no heartbeat timer at all.
  heartbeat.stop();
  assert.equal(clock.intervalCount(5000), 0, "stop() unregisters the 5s timer");
  const quiet = createHeartbeat({ path, clock, heartbeat: false, build: () => ({ pid: 1 }), write: async () => {} });
  quiet.start();
  assert.equal(clock.intervalCount(5000), 0);
  rmSync(dir, { recursive: true, force: true });
});

test("the heartbeat surfaces a write failure instead of swallowing it", async () => {
  const failures = [];
  const heartbeat = createHeartbeat({ path: "x", clock: fakeClock(), heartbeat: true,
    build: () => ({}), write: async () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
    onError: (cause) => failures.push(cause) });
  void heartbeat;
  await assert.rejects(heartbeat.write(), { code: "EPERM" });
});

test("the fence retires on a token change, a missing role or a closed record only", () => {
  const slot = (record) => ({ schema: "gjc-herdr-dashboard/slot/1", roles: { todo: record } });
  assert.deepEqual(fenceDecision(slot({ state: "ready", token: "t" }), { role: "todo", token: "t" }),
    { retire: false, reason: "ok" });
  assert.deepEqual(fenceDecision(slot({ state: "ready", token: "other" }), { role: "todo", token: "t" }),
    { retire: true, reason: "token-mismatch" });
  assert.deepEqual(fenceDecision(slot({ state: "closed", token: "t" }), { role: "todo", token: "t" }),
    { retire: true, reason: "closed" });
  assert.deepEqual(fenceDecision(slot(undefined), { role: "todo", token: "t" }),
    { retire: true, reason: "role-missing" });
  // An invalid or unreadable slot is never a retire reason: the viewer keeps its last
  // state and shows the source-error label instead (plan 7.3 item 6).
  for (const invalid of [null, undefined, {}, { schema: "other/1" }, { schema: "gjc-herdr-dashboard/slot/1" },
    { schema: "gjc-herdr-dashboard/slot/1", roles: null }, { schema: "gjc-herdr-dashboard/slot/1", roles: [] }]) {
    const decision = fenceDecision(invalid, { role: "todo", token: "t" });
    assert.equal(decision.retire, false, JSON.stringify(invalid));
    assert.equal(decision.reason, "invalid-slot");
  }
});

test("the slot watcher reports a change once and never hides a read error", () => {
  const dir = mkdtempSync(join(tmpdir(), "gjc-watch-"));
  const slotPath = join(dir, "slot.json");
  const clock = fakeClock();
  const seen = [], errors = [];
  writeFileSync(slotPath, "first");
  const watcher = createSlotWatcher({ slotPath, clock, watchFn: () => new EventEmitter(),
    onChange: (text) => seen.push(text), onError: (cause) => errors.push(cause?.code) });
  assert.deepEqual(seen, ["first"], "the first read happens immediately");
  // An unchanged 1s poll reports nothing.
  clock.tick(1000); clock.tick(1000);
  assert.deepEqual(seen, ["first"]);
  writeFileSync(slotPath, "second");
  clock.tick(1000);
  assert.deepEqual(seen, ["first", "second"]);
  // A file that disappears is a read error, not an empty slot.
  rmSync(slotPath);
  clock.tick(1000);
  assert.deepEqual(errors, ["ENOENT"]);
  assert.deepEqual(seen, ["first", "second"]);
  // After close, neither the poll nor a change reports anything.
  writeFileSync(slotPath, "third");
  watcher.close();
  clock.tick(1000);
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(clock.size, 0, "closing stops the poll timer");
  rmSync(dir, { recursive: true, force: true });
});

test("the watcher survives a watch that cannot start, relying on the poll", () => {
  const clock = fakeClock();
  const errors = [];
  const seen = [];
  // A reader whose content changes between polls proves the poll is what observes it.
  let reads = 0;
  const watcher = createSlotWatcher({ slotPath: "missing/slot.json", clock,
    watchFn: () => { throw new Error("watch unavailable"); },
    readFile: () => `text-${++reads}`,
    onChange: (text) => seen.push(text), onError: (cause) => errors.push(cause.message) });
  assert.deepEqual(errors, ["watch unavailable"]);
  assert.deepEqual(seen, ["text-1"]);
  clock.tick(1000);
  assert.deepEqual(seen, ["text-1", "text-2"], "the 1s poll keeps observing without fs.watch");
  watcher.close();
  assert.equal(clock.size, 0);
});

test("owner liveness: stoppedAt is immediate, a kill waits 10s, an unprobeable pid stays live", () => {
  const now = 100_000;
  assert.equal(ownerLiveness(null, { now }), "absent");
  // Cooperative exit: reported as soon as it is written, never as live.
  assert.equal(ownerLiveness({ pid: 1, heartbeatAt: now, stoppedAt: now }, { now }), "disconnected");
  assert.equal(ownerLiveness({ pid: 1, heartbeatAt: now - 1000, stoppedAt: now - 1000 }, { now }), "disconnected");
  // Killed: the boundary is exactly 10s, and just under it the owner still counts live.
  const gone = () => false;
  assert.equal(ownerLiveness({ pid: 1, heartbeatAt: now - 9999 }, { now, pidAlive: gone }), "live");
  assert.equal(ownerLiveness({ pid: 1, heartbeatAt: now - 10000 }, { now, pidAlive: gone }), "disconnected");
  assert.equal(ownerLiveness({ pid: 1 }, { now, pidAlive: gone }), "disconnected", "no heartbeat at all");
  // A live pid with a stale heartbeat is still live: G10 success is not evidence of death.
  assert.equal(ownerLiveness({ pid: 1, heartbeatAt: now - 600_000 }, { now, pidAlive: () => true }), "live");
  // Fail-closed when the pid cannot be probed (EPERM / G10 unavailable).
  assert.equal(ownerLiveness({ pid: 1, heartbeatAt: now - 600_000 }, { now }), "live");
});

test("q closes only the pane this process owns, and only when the env agrees", async () => {
  const calls = [];
  let onClose = 0;
  const herdr = async (argv) => { calls.push(argv); return { ok: true }; };
  assert.deepEqual(await closeOwnPane({ paneId: "w1:p2", env: {}, herdr, onClose: () => { onClose++; } }),
    { closed: false, reason: "not-owner" });
  assert.deepEqual(await closeOwnPane({ paneId: "w1:p2", env: { HERDR_PANE_ID: "w1:p9" }, herdr }),
    { closed: false, reason: "not-owner" });
  assert.deepEqual(await closeOwnPane({ paneId: "w1:p2", env: { HERDR_PANE_ID: "w1:p2" } }),
    { closed: false, reason: "no-herdr" });
  assert.deepEqual(await closeOwnPane({ paneId: "w1:p2", env: { HERDR_PANE_ID: "w1:p2" }, herdr,
    onClose: () => { onClose++; } }), { closed: true, reason: "closed" });
  assert.deepEqual(calls, [["pane", "close", "w1:p2"]]);
  assert.equal(onClose, 1);
});
