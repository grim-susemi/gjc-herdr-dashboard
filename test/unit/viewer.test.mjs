// Todo viewer tests: CLI, projection and prefs contracts, keys, fence, scope switch.
//
// Rewritten from omo-herdr-dashboard @4082c750 `packages/todo/test/viewer.test.mjs`.
// Kept as behaviour: argument parsing, the `--once` frame, preference persistence
// across a reopen (with follow always returning ON), the q/close path and the
// key-driven frame updates. Replaced, because the features are gone: the presence
// pipe fixture, the ACK handshake, custody/retirement servers, the display cache
// and the strike animation. Added, per this phase: the token fence, scope
// rebinding on slot.json change, the owner-liveness labels and the ready-delay
// environment variable.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { EMPTY_PREFS, loadPreferences, main, parseViewerArgs, readProjection, savePreferences,
  startViewer } from "../../src/viewers/todo/viewer.mjs";
import { viewerArgs } from "../../src/core/launch.mjs";

const slotFor = ({ layoutKey = "a".repeat(24), scopeKey = "b".repeat(24), role = "todo",
  state = "pending", token = "tok", pane = "w1:p9" } = {}) => ({
  schema: "gjc-herdr-dashboard/slot/1", layoutKey,
  parent: { socket: "sock", paneId: "w1:p1", tabId: "t1" }, herdr: ["herdr"],
  scope: { sessionId: "sess", scopeKey, scopeEpoch: 1, language: "ko" },
  roles: { [role]: { state, token, paneId: pane, tabId: "t1", shellPid: 12, label: "GJC Todo · aaaaaaaa" } },
});

const projectionFor = (phases, extra = {}) => ({ schema: "gjc-herdr-dashboard/todo/1",
  updatedAt: 1, phases, empty: false, sourceError: null, ...extra });

function fakeClock() {
  let now = 1_000_000;
  let id = 0;
  const timers = new Map(), intervals = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimeout: (key) => timers.delete(key),
    setInterval(fn, ms) { const key = ++id; intervals.set(key, { fn, ms }); return key; },
    clearInterval: (key) => intervals.delete(key),
    advance(ms) {
      now += ms;
      for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn(); }
    },
    tick(ms) { for (const timer of intervals.values()) if (ms === undefined || timer.ms === ms) timer.fn(); },
    intervalCount: (ms) => [...intervals.values()].filter((timer) => timer.ms === ms).length,
  };
}

// The port keeps real files on disk (a temp state dir) but a fake process table,
// clock and Herdr vector, so no live Herdr is ever contacted.
function fixture(t, { role = "todo", env = {}, interactive = false } = {}) {
  const state = mkdtempSync(join(tmpdir(), "gjc-viewer-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const calls = [], clock = fakeClock();
  const output = { columns: 80, rows: 24, writes: [], write: (text) => { output.writes.push(text); return true; },
    on: () => {}, off: () => {} };
  const input = new EventEmitter();
  input.isTTY = false;
  input.setRawMode = () => {};
  input.resume = () => {};
  const port = {
    read(path) {
      const text = readFileSync(path, "utf8");
      try { return JSON.parse(text); }
      catch (cause) { throw Object.assign(cause, { code: "INVALID_JSON" }); }
    },
    readRaw: (path) => readFileSync(path, "utf8"),
    async write(path, value) {
      const { writeJson } = await import("../../src/storage.mjs");
      await writeJson(path, value);
    },
  };
  const herdr = async (argv) => { calls.push(argv); return { ok: true }; };
  const layout = "a".repeat(24), scopeKey = "b".repeat(24);
  const slots = join(state, "slots", layout);
  mkdirSync(join(slots, "roles"), { recursive: true });
  return { state, layout, scopeKey, slots, calls, clock, output, input, port, herdr, role,
    env: { ...env },
    writeSlot: (value) => writeFileSync(join(slots, "slot.json"), JSON.stringify(value)),
    writeOwner: (value) => writeFileSync(join(slots, "owner.json"), JSON.stringify(value)),
    writeProjection: (value, scope = scopeKey) => {
      mkdirSync(join(state, "data", scope), { recursive: true });
      writeFileSync(join(state, "data", scope, "todo.json"), JSON.stringify(value));
    },
    writePrefs: (value, scope = scopeKey, name = role) => {
      mkdirSync(join(state, "prefs", scope), { recursive: true });
      writeFileSync(join(state, "prefs", scope, `${name}.json`), JSON.stringify(value));
    },
    readPrefs: (scope = scopeKey, name = role) =>
      JSON.parse(readFileSync(join(state, "prefs", scope, `${name}.json`), "utf8")),
    readReady: () => JSON.parse(readFileSync(join(slots, "roles", `${role}.ready.json`), "utf8")),
  };
}

const options = (f, extra = {}) => ({ state: f.state, layout: f.layout, role: f.role,
  token: "tok", pane: "w1:p9", lang: "ko", width: null, once: false, ...extra });

test("parseViewerArgs accepts the contract CLI and rejects malformed input", () => {
  const parsed = parseViewerArgs(["--state", "/tmp/s", "--layout", "a".repeat(24), "--role", "todo",
    "--token", "t", "--pane", "w1:p2", "--lang", "ko", "--width", "52", "--once"]);
  assert.deepEqual(parsed, { once: true, state: "/tmp/s", layout: "a".repeat(24), role: "todo",
    token: "t", pane: "w1:p2", lang: "ko", width: "52", failpoint: null });
  // R3: the exact argv the launcher builds for fp5 must be accepted by the real viewer parser.
  const launched = viewerArgs({ stateDir: "/tmp/s", layoutKey: "a".repeat(24), role: "todo", token: "t",
    paneId: "w1:p2", language: "ko", failpoint: "ready-delay-25s" });
  assert.equal(parseViewerArgs(launched).failpoint, "ready-delay-25s");
  assert.throws(() => parseViewerArgs(["--state", "/tmp/s", "--token", "t", "--pane", "p",
    "--failpoint", "bogus"]), /unknown viewer failpoint/);
  // The defaults: role todo, no layout, no language override, one frame not requested.
  assert.equal(parseViewerArgs(["--state", "/tmp/s", "--token", "t", "--pane", "p"]).role, "todo");
  for (const args of [[], ["--state", "/tmp/s", "--token", "t"], ["--state", "relative", "--token", "t", "--pane", "p"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--width", "wide"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--role", "Todo!"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--layout", "short"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--nope", "x"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--lang"]]) {
    assert.throws(() => parseViewerArgs(args), /Usage: node viewer\.mjs/, JSON.stringify(args));
  }
});

test("readProjection maps missing, corrupt and empty files to distinct availability", () => {
  const f = fixture({ after: () => {} }, {});
  const path = join(f.state, "data", f.scopeKey, "todo.json");
  assert.deepEqual(readProjection(path), { projection: null, availability: "waiting", error: "" });
  mkdirSync(join(f.state, "data", f.scopeKey), { recursive: true });
  writeFileSync(path, "{oops");
  const corrupt = readProjection(path);
  assert.equal(corrupt.availability, "source-error");
  assert.match(corrupt.error, /Invalid JSON|JSON/);
  writeFileSync(path, JSON.stringify({ schema: "other/1", phases: [] }));
  assert.equal(readProjection(path).availability, "source-error");
  writeFileSync(path, JSON.stringify(projectionFor([], { empty: true })));
  assert.equal(readProjection(path).availability, "empty");
  writeFileSync(path, JSON.stringify(projectionFor([{ name: "P", tasks: [{ content: "c", status: "pending" }] }])));
  assert.equal(readProjection(path).availability, "live");
  // A source error reported by the host is surfaced as such, not as live.
  writeFileSync(path, JSON.stringify(projectionFor([], { sourceError: "todo_write failed" })));
  const failed = readProjection(path);
  assert.equal(failed.availability, "source-error");
  assert.equal(failed.error, "todo_write failed");
});

test("prefs round-trip per scope, never restore follow OFF, and report a bad file", () => {
  const f = fixture({ after: () => {} }, {});
  const path = join(f.state, "prefs", f.scopeKey, "todo.json");
  assert.deepEqual(loadPreferences(path, f.scopeKey), { prefs: { ...EMPTY_PREFS }, error: "" });
  mkdirSync(join(f.state, "prefs", f.scopeKey), { recursive: true });
  writeFileSync(path, "{bad");
  const bad = loadPreferences(path, f.scopeKey);
  assert.deepEqual(bad.prefs, { ...EMPTY_PREFS });
  assert.notEqual(bad.error, "");
  // A file written for another scope is ignored rather than applied to this one.
  writeFileSync(path, JSON.stringify({ schema: "gjc-herdr-dashboard/prefs/1", scopeKey: "z".repeat(24),
    scroll: 9, expanded: true, selection: null }));
  assert.deepEqual(loadPreferences(path, f.scopeKey).prefs, { ...EMPTY_PREFS });
});

test("savePreferences persists fold, selection and scroll but deliberately drops follow", async () => {
  const f = fixture({ after: () => {} }, {});
  const path = join(f.state, "prefs", f.scopeKey, "todo.json");
  const written = await savePreferences(path, { scopeKey: f.scopeKey, scroll: 7, expanded: true,
    selection: "[\"P\",0,\"c\",0]", follow: false });
  assert.equal("follow" in written, false, "follow is not persisted");
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(onDisk, { schema: "gjc-herdr-dashboard/prefs/1", scopeKey: f.scopeKey,
    scroll: 7, expanded: true, selection: "[\"P\",0,\"c\",0]" });
  // Reloading it restores everything except follow, which comes back ON (AC1.3).
  assert.deepEqual(loadPreferences(path, f.scopeKey).prefs,
    { scroll: 7, expanded: true, selection: "[\"P\",0,\"c\",0]", follow: true });
});

test("startViewer writes its ready file, renders the projection and shows the footer", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "Build", tasks: [
    { content: "ship it", status: "in_progress" }, { content: "queued", status: "pending" }] }]));
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  const ready = f.readReady();
  assert.equal(ready.token, "tok");
  assert.equal(ready.paneId, "w1:p9");
  assert.equal(ready.pid, process.pid);
  assert.equal(ready.heartbeatAt, f.clock.now());
  assert.equal(typeof ready.gen, "string");
  const text = stripVTControlCharacters(viewer.text);
  assert.match(text, /ship it/);
  assert.match(text, /자동 추적 ON/);
  assert.match(text, /실시간/);
  assert.equal(viewer.state.availability, "live");
  assert.deepEqual(f.calls, [], "opening the viewer never calls Herdr");
});

test("'f', 'c' and 'j' change only this role's view and persist it", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([
    { name: "Closed", tasks: [{ content: "done one", status: "completed" }] },
    { name: "Open", tasks: [{ content: "first", status: "in_progress" },
      { content: "second", status: "pending" }] }]));
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  assert.match(stripVTControlCharacters(viewer.text), /자동 추적 ON/);
  await viewer.key("f");
  assert.equal(viewer.state.prefs.follow, false);
  assert.match(stripVTControlCharacters(viewer.text), /자동 추적 OFF/);
  // 'c' expands closed phases and pauses follow, as in omo.
  await viewer.key("c");
  assert.equal(viewer.state.prefs.expanded, true);
  assert.match(stripVTControlCharacters(viewer.text), /done one/);
  // 'j' moves the selection and pauses follow.
  const before = viewer.frame.selection;
  await viewer.key("j");
  assert.notEqual(viewer.frame.selection, before);
  assert.equal(viewer.state.prefs.follow, false);
  const saved = f.readPrefs();
  assert.equal(saved.expanded, true);
  assert.equal(saved.selection, viewer.frame.selection);
  assert.equal("follow" in saved, false);
  // An unhandled key changes nothing at all.
  await viewer.key("x");
  assert.deepEqual(f.readPrefs(), saved);
});

test("AC1.3: f(OFF) then q then reopen comes back FOLLOW ON with fold and selection restored", async (t) => {
  const f = fixture(t, { env: { HERDR_PANE_ID: "w1:p9" } });
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([
    { name: "Closed", tasks: [{ content: "done one", status: "completed" }] },
    { name: "Open", tasks: [{ content: "first", status: "in_progress" },
      { content: "second", status: "pending" }] },
  ]));
  const deps = { port: f.port, clock: f.clock, env: f.env, output: f.output, input: f.input,
    herdr: f.herdr, exit: () => {} };
  const first = await startViewer(options(f), deps);
  await first.key("f");
  assert.equal(first.state.prefs.follow, false);
  await first.key("c");
  await first.key("j");
  const wantSelection = first.frame.selection;
  await first.close();
  // q wrote closing:'q' and asked Herdr to close exactly our own pane.
  assert.deepEqual(f.calls, [["pane", "close", "w1:p9"]]);
  assert.equal(f.readReady().closing, "q");
  // The preference save was flushed before the pane was closed.
  assert.equal(f.readPrefs().selection, wantSelection);

  const second = await startViewer(options(f), deps);
  t.after(() => second.stop());
  assert.equal(second.state.prefs.follow, true, "follow is never restored OFF");
  assert.equal(second.state.prefs.expanded, true, "the fold toggle is restored");
  assert.equal(second.state.prefs.selection, wantSelection, "the selection is restored");
  assert.match(stripVTControlCharacters(second.text), /자동 추적 ON/);
  assert.match(stripVTControlCharacters(second.text), /done one/);
});

test("the ready-delay-25s failpoint postpones the first ready write", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([]));
  // The viewer is started without awaiting it: the ready write is gated on the fake
  // clock, which this test drives by hand.
  const starting = startViewer({ ...options(f), failpoint: "ready-delay-25s" }, { port: f.port, clock: f.clock,
    env: f.env, output: f.output, input: f.input, herdr: f.herdr, exit: () => {}, interactive: false });
  await new Promise((done) => setImmediate(done));
  assert.throws(() => f.readReady(), /ENOENT/, "nothing is written before the delay");
  f.clock.advance(24999);
  await new Promise((done) => setImmediate(done));
  assert.throws(() => f.readReady(), /ENOENT/, "24999ms is not yet 25000ms");
  f.clock.advance(1);
  const viewer = await starting;
  t.after(() => viewer.stop());
  assert.equal(f.readReady().paneId, "w1:p9");
  assert.equal(f.readReady().closing, undefined);
});

test("a bad --lang value falls back to Korean with a one-time footer notice", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "work", status: "pending" }] }]));
  const viewer = await startViewer(options(f, { lang: "de" }), { port: f.port, clock: f.clock,
    env: f.env, output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  assert.equal(viewer.state.language, "ko");
  assert.equal(viewer.state.notices.length, 1);
  const text = stripVTControlCharacters(viewer.text);
  assert.match(text, /자동 추적 ON/);
  assert.match(text, /언어 값이 올바르지 않아/);
  // A valid value produces no notice.
  const clean = await startViewer(options(f, { lang: "zh-cn" }), { port: f.port, clock: f.clock,
    env: f.env, output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => clean.stop());
  assert.deepEqual(clean.state.notices, []);
  assert.match(stripVTControlCharacters(clean.text), /自动跟随 ON/);
});

test("token fence: a different token retires the viewer only when HERDR_PANE_ID matches", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([]));
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock,
    env: { HERDR_PANE_ID: "w1:p9" }, output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  const retired = new Promise((done) => viewer.events.once("retired", done));
  f.writeSlot(slotFor({ token: "other-token" }));
  viewer.refresh();
  const result = await retired;
  assert.equal(result.reason, "token-mismatch");
  assert.equal(result.closed, true);
  assert.deepEqual(f.calls, [["pane", "close", "w1:p9"]]);
  await viewer.closed;
});

test("token fence: a viewer may never close a pane it does not own", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([]));
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock,
    env: { HERDR_PANE_ID: "w1:pOTHER" }, output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  const retired = new Promise((done) => viewer.events.once("retired", done));
  f.writeSlot(slotFor({ token: "other-token" }));
  viewer.refresh();
  const result = await retired;
  assert.equal(result.reason, "token-mismatch");
  assert.equal(result.closed, false);
  assert.equal(result.reason === "token-mismatch" && result.closed === false, true);
  assert.deepEqual(f.calls, [], "no Herdr call when the pane is not ours");
  await viewer.closed;
});

test("token fence: a missing role or a closed record retires, an unreadable slot does not", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([]));
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  // An unreadable slot keeps the last state and only reports the source error.
  rmSync(join(f.slots, "slot.json"));
  viewer.refresh();
  assert.equal(viewer.state.availability, "live");
  assert.notEqual(viewer.state.slotError, "");
  assert.match(stripVTControlCharacters(viewer.text), /원천 오류/);
  // A corrupt slot is likewise not a retire reason.
  writeFileSync(join(f.slots, "slot.json"), "{not json");
  viewer.refresh();
  assert.notEqual(viewer.state.slotError, "");
  // A valid slot that no longer carries our role does retire.
  const retired = new Promise((done) => viewer.events.once("retired", done));
  f.writeSlot(slotFor({ role: "workers" }));
  viewer.refresh();
  assert.equal((await retired).reason, "role-missing");
  await viewer.closed;
});

test("scope switch: a new scopeKey rebinds data and prefs without touching the pane", async (t) => {
  const f = fixture(t);
  const otherScope = "c".repeat(24);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "First", tasks: [{ content: "OLD_SCOPE_TASK", status: "pending" }] }]));
  f.writeProjection(projectionFor([{ name: "Second", tasks: [{ content: "NEW_SCOPE_TASK", status: "pending" }] }]), otherScope);
  f.writePrefs({ schema: "gjc-herdr-dashboard/prefs/1", scopeKey: otherScope, scroll: 3,
    expanded: true, selection: null }, otherScope);
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  assert.match(stripVTControlCharacters(viewer.text), /OLD_SCOPE_TASK/);
  assert.equal(viewer.state.prefs.scopeKey, f.scopeKey);
  // /new or /resume rewrote slot.json with a new scopeKey; the pane stays ours.
  const switched = new Promise((done) => viewer.events.once("scope", done));
  f.writeSlot(slotFor({ scopeKey: otherScope }));
  viewer.refresh();
  assert.deepEqual(await switched, { scopeKey: otherScope });
  assert.equal(viewer.state.prefs.scopeKey, otherScope);
  assert.match(stripVTControlCharacters(viewer.text), /NEW_SCOPE_TASK/);
  assert.doesNotMatch(stripVTControlCharacters(viewer.text), /OLD_SCOPE_TASK/);
  // The new scope's prefs were loaded, and follow came back ON.
  assert.equal(viewer.state.prefs.expanded, true);
  assert.equal(viewer.state.prefs.follow, true);
  assert.deepEqual(f.calls, []);
});

test("a bad prefs file shows a notice but never crashes the viewer", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "work", status: "pending" }] }]));
  mkdirSync(join(f.state, "prefs", f.scopeKey), { recursive: true });
  writeFileSync(join(f.state, "prefs", f.scopeKey, "todo.json"), "{broken prefs");
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  assert.match(stripVTControlCharacters(viewer.text), /화면 설정/);
  assert.deepEqual(viewer.state.prefs, { ...EMPTY_PREFS, scopeKey: f.scopeKey });
  assert.equal(viewer.state.availability, "live");
});

test("owner liveness labels: cooperative exit within 5s and a kill within 20s", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "work", status: "pending" }] }]));
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  assert.match(stripVTControlCharacters(viewer.text), /실시간/);
  // A cooperative exit that just recorded stoppedAt is already disconnected.
  viewer.setOwner({ schema: "gjc-herdr-dashboard/owner/1", pid: 4321,
    heartbeatAt: f.clock.now(), stoppedAt: f.clock.now() });
  assert.match(stripVTControlCharacters(viewer.text), /연결 끊김/);
  // A killed owner keeps the live label until its heartbeat is 20s old.
  const killed = { schema: "gjc-herdr-dashboard/owner/1", pid: 4321, heartbeatAt: f.clock.now() };
  viewer.setOwner(killed, { alive: () => false });
  f.clock.advance(5000);
  viewer.refresh();
  assert.match(stripVTControlCharacters(viewer.text), /실시간/);
  f.clock.advance(20000);
  viewer.refresh();
  assert.match(stripVTControlCharacters(viewer.text), /연결 끊깁니다|연결 끊김/);
  // The pane stays: no Herdr call, and the viewer is still open.
  assert.deepEqual(f.calls, []);
  assert.equal(viewer.frame.connection, "disconnected");
});

test("--once prints exactly one frame to stdout and exits 0", async () => {
  const f = fixture({ after: () => {} });
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "once frame", status: "pending" }] }]));
  const exitCodes = [];
  const code = await main(["--state", f.state, "--layout", f.layout, "--role", "todo",
    "--token", "tok", "--pane", "w1:p9", "--once"], { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: (value) => exitCodes.push(value) });
  assert.equal(code, 0);
  const printed = f.output.writes.filter((text) => text.includes("once frame"));
  assert.equal(printed.length, 1, JSON.stringify(f.output.writes));
  assert.equal(printed[0].endsWith("\n"), true);
  assert.deepEqual(f.calls, []);
  rmSync(f.state, { recursive: true, force: true });
});

test("R3 failpoint in interactive mode defers the ready write and the first data paint together", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "early row", status: "pending" }] }]));
  f.input.setRawMode = () => {};
  f.input.isTTY = true;
  f.output.isTTY = true;
  const starting = startViewer({ ...options(f), failpoint: "ready-delay-25s" }, { port: f.port,
    clock: f.clock, env: f.env, output: f.output, input: f.input, herdr: f.herdr, exit: () => {},
    interactive: true, watchFn: () => ({ close() {}, on() {} }) });
  await new Promise((done) => setImmediate(done));
  f.clock.advance(24999);
  f.clock.tick(1000);
  assert.ok(!f.output.writes.some((text) => text.includes("early row")), "no data frame before the delay");
  assert.throws(() => f.readReady(), /ENOENT/, "no ready file before the delay");
  f.clock.advance(1);
  const viewer = await starting;
  t.after(async () => { await viewer.close(); });
  assert.equal(f.readReady().token, "tok");
  f.clock.tick(1000);
  assert.ok(f.output.writes.at(-1).includes("early row"), "data appears after the delay");
});

test("the default owner probe reports a dead owner pid as disconnected once its heartbeat is 20 s old", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  // pid 999999 does not exist: the default probe (no injected `alive`) must see ESRCH.
  viewer.setOwner({ schema: "gjc-herdr-dashboard/owner/1", pid: 999999, heartbeatAt: f.clock.now() });
  assert.equal(viewer.state.owner, "live", "a fresh heartbeat still counts as live");
  f.clock.advance(20000);
  assert.equal(viewer.state.owner, "disconnected");
  viewer.refresh();
  assert.match(stripVTControlCharacters(viewer.text), /연결 끊김/);
});

test("a q during the failpoint delay retires the viewer and nothing starts afterwards", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([]));
  f.input.setRawMode = () => {};
  const starting = startViewer({ ...options(f), failpoint: "ready-delay-25s" }, { port: f.port,
    clock: f.clock, env: f.env, output: f.output, input: f.input, herdr: f.herdr, exit: () => {},
    interactive: true, watchFn: () => ({ close() {}, on() {} }) });
  await new Promise((done) => setImmediate(done));
  f.input.emit("data", "q");
  await new Promise((done) => setImmediate(done));
  f.clock.advance(25000);
  const viewer = await starting;
  await viewer.closed;
  const ready = f.readReady();
  assert.equal(ready.closing, "q", "the closing mark written by q is not overwritten after the delay");
  f.clock.tick(10000);
  assert.equal(f.readReady().closing, "q", "no heartbeat restarts after the delay");
});

test("q without an injected client closes the own pane through the slot's recorded herdr vector", async (t) => {
  const f = fixture(t);
  const logPath = join(f.state, "herdr-calls.jsonl");
  const fake = join(f.state, "fake-herdr.mjs");
  writeFileSync(fake, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');\nconsole.log('{\"id\":\"x\",\"result\":{}}');\n");
  f.writeSlot({ ...slotFor(), herdr: [process.execPath, fake, logPath] });
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "x", status: "pending" }] }]));
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock,
    env: { ...f.env, HERDR_PANE_ID: "w1:p9" }, output: f.output, input: f.input, exit: () => {} });
  const retired = new Promise((done) => viewer.events.once("retired", done));
  await viewer.key("q");
  const info = await retired;
  assert.equal(info.closed, true, `close outcome: ${info.closeReason}`);
  const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls, [["pane", "close", "w1:p9"]]);
  assert.equal(f.readReady().closing, "q");
});

test("interactive mode: a projection that lands after the first paint appears on the next timer tick", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.input.setRawMode = () => {};
  f.input.isTTY = true;
  f.output.isTTY = true;
  const watcher = { close() {}, on() {} };
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {}, interactive: true,
    watchFn: () => watcher });
  t.after(async () => { await viewer.close(); });
  assert.ok(!f.output.writes.at(-1).includes("late arrival"), "nothing to show yet");
  // The owner publishes a Todo after the viewer already painted its empty frame.
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "late arrival", status: "in_progress" }] }]));
  f.clock.tick(1000);
  assert.ok(f.output.writes.at(-1).includes("late arrival"), "the timer tick re-reads the projection");
});

test("interactive mode: pointer modes, raw mode, a repaint timer and the slot watcher", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "watch me", status: "pending" }] }]));
  const rawModes = [];
  f.input.setRawMode = (value) => rawModes.push(value);
  f.input.isTTY = true;
  f.output.isTTY = true;
  const raw = [];
  const watcher = { closed: 0, close() { this.closed++; }, on() {} };
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {}, interactive: true,
    watchFn: () => { void raw; return watcher; } });
  t.after(async () => { await viewer.close(); });
  // Raw mode on, alternate screen and pointer modes written, repaint timer armed.
  assert.deepEqual(rawModes, [true]);
  assert.ok(f.output.writes.some((text) => text.includes("\x1b[?1049h")));
  assert.equal(f.clock.intervalCount(1000), 2, "one repaint timer and one slot poll");
  assert.equal(f.clock.intervalCount(5000), 1, "one heartbeat timer");
  // A key arriving on stdin reaches the same handler as the direct API.
  f.input.emit("data", "f");
  await new Promise((done) => setImmediate(done));
  assert.equal(viewer.state.prefs.follow, false);
  // The timer repaints the current frame into the alternate screen.
  const before = f.output.writes.length;
  f.clock.tick(1000);
  assert.ok(f.output.writes.length > before);
  assert.ok(f.output.writes.at(-1).includes("자동 추적 OFF"));
  // q writes closing, closes the pane, restores the terminal and releases the watcher.
  f.input.emit("data", "q");
  const closed = await viewer.closed;
  assert.equal(closed.reason, "retired");
  assert.equal(watcher.closed, 1);
  assert.equal(f.readReady().closing, "q");
  assert.ok(f.output.writes.at(-1).includes("\x1b[?1049l"), "alternate screen left");
  assert.deepEqual(rawModes, [true, false], "raw mode restored");
  assert.equal(f.clock.intervalCount(1000), 0, "every 1s timer is released");
  assert.equal(f.clock.intervalCount(5000), 0, "the heartbeat timer is released");
});

// The `interactive` default follows the two isTTY flags, so a redirected stdout in
// the `--once` snapshot path can never enter raw mode.
test("a non-TTY process defaults to one-shot output even without --once", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([{ name: "P", tasks: [{ content: "plain", status: "pending" }] }]));
  f.input.isTTY = false;
  f.output.isTTY = false;
  const viewer = await startViewer(options(f), { port: f.port, clock: f.clock, env: f.env,
    output: f.output, input: f.input, herdr: f.herdr, exit: () => {} });
  t.after(() => viewer.stop());
  assert.equal(f.clock.intervalCount(1000), 0, "no repaint timer without a TTY");
  assert.equal(f.clock.intervalCount(5000), 0, "no heartbeat timer without a TTY");
  assert.equal(f.output.writes.filter((text) => text.includes("plain")).length, 1);
});

test("a usage error is reported on stderr and returns 2 without starting a viewer", async () => {
  const errors = [];
  const code = await main(["--state", "relative"], { stderr: { write: (text) => errors.push(text) } });
  assert.equal(code, 2);
  assert.match(errors.join(""), /Usage: node viewer\.mjs/);
});
