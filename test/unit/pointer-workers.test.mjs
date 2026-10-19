// Workers viewer pointer + focus tests (L3 contract AC3.1-AC3.3).
//
// Mirrors test/unit/pointer-todo.test.mjs for the workers role: the viewer decodes SGR
// pointer reports and DEC 1004 focus reports through the shared `terminalInput` decoder
// and subscribes to the Herdr lifecycle stream through an injected `watchFocus` (default
// `watchHerdrFocus`). These tests drive the fake stdin of the viewer fixture with raw SGR
// byte strings, so they cover the wiring the direct `viewer.key()` API cannot: wheel
// scrolling, click select + fold, drag panning, blur, and the best-effort focus
// subscription.
//
// No live Herdr: `watchFocus` is always a fake and both viewers are fakes.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { startViewer } from "../../src/viewers/workers/viewer.mjs";
import { writeJson } from "../../src/storage.mjs";

const slotFor = ({ layoutKey = "a".repeat(24), scopeKey = "b".repeat(24), role = "workers",
  state = "pending", token = "tok", pane = "w1:p9" } = {}) => ({
  schema: "gjc-herdr-dashboard/slot/1", layoutKey,
  parent: { socket: "sock", paneId: "w1:p1", tabId: "t1" }, herdr: ["herdr"],
  scope: { sessionId: "sess", scopeKey, scopeEpoch: 1, language: "ko" },
  roles: { [role]: { state, token, paneId: pane, tabId: "t1", shellPid: 12, label: "GJC Workers · aaaaaaaa" } },
});

const card = (id, extra = {}) => ({ id, agent: "subagent", title: `card ${id}`, status: "running",
  background: false, currentTool: null, lastIntent: null, lastOutput: null, toolCount: 0,
  tokens: 0, contextPercent: null, cost: null, durationMs: 0, retry: null, startedAt: null,
  endedAt: null, ...extra });

// 12 running cards at three body rows each: 36 body lines against 21 body rows at the
// fixture's 24 rows, so the wheel and drag clamps are observable rather than theoretical.
const projectionFor = (cards) => ({ schema: "gjc-herdr-dashboard/workers/1",
  updatedAt: 1, cards, empty: false, sourceError: null });

const running = (count) => Array.from({ length: count }, (unused, index) => card(`c${index}`));

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

// A controllable stand-in for `watchHerdrFocus`: it records its arguments and only
// settles when the test says so, which is what makes the "subscription lands after
// finish" and "subscription failed" cases deterministic.
function fakeFocus() {
  const calls = [];
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return {
    calls,
    promise,
    watchFocus: (pane, blur, failed, env) => { calls.push({ pane, blur, failed, env }); return promise; },
    resolve: (dispose) => settle.resolve(dispose),
    reject: (cause) => settle.reject(cause),
  };
}

function fixture(t) {
  const state = mkdtempSync(join(tmpdir(), "gjc-pointer-workers-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const clock = fakeClock();
  const writes = [];
  const output = Object.assign(new EventEmitter(), { columns: 80, rows: 24, isTTY: true,
    write: (text) => { output.writes.push(text); return true; }, writes: [] });
  const input = new EventEmitter();
  input.isTTY = true;
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
      writes.push({ path, value });
      await writeJson(path, value);
    },
  };
  const layout = "a".repeat(24), scopeKey = "b".repeat(24);
  const slots = join(state, "slots", layout);
  mkdirSync(join(slots, "roles"), { recursive: true });
  mkdirSync(join(state, "data", scopeKey), { recursive: true });
  mkdirSync(join(state, "prefs", scopeKey), { recursive: true });
  writeFileSync(join(slots, "slot.json"), JSON.stringify(slotFor()));
  writeFileSync(join(state, "data", scopeKey, "workers.json"),
    JSON.stringify(projectionFor(running(12))));
  return { state, layout, scopeKey, slots, clock, output, input, port, writes,
    options: { state, layout, role: "workers", token: "tok", pane: "w1:p9", lang: "ko",
      width: null, once: false },
    slotText: () => readFileSync(join(slots, "slot.json"), "utf8"),
    lastPrefs: () => writes.filter((entry) => entry.path.endsWith("workers.json")).at(-1)?.value,
  };
}

const tick = () => new Promise((done) => setImmediate(done));
const click = (y, x = 5) => `\x1b[<0;${x};${y}M`;
const release = (y, x = 5) => `\x1b[<0;${x};${y}m`;
const motion = (y, x = 5) => `\x1b[<32;${x};${y}M`;
const wheelUp = (y = 10) => `\x1b[<64;5;${y}M`;
const wheelDown = (y = 10) => `\x1b[<65;5;${y}M`;
const blur = "\x1b[O", focusIn = "\x1b[I";

// `key` returns the viewer's pending preference-save chain, so a pair of `f` presses
// awaits every write queued before them and leaves the follow state where it was.
async function flushPrefs(viewer) {
  await viewer.key("f");
  await viewer.key("f");
}

// The SGR row that lands on a card, derived from the frame the viewer actually drew
// (1-based y = bodyLines index - scroll + bodyStart + 1).
const rowOfCard = (viewer, id) => {
  const frame = viewer.frame;
  return frame.ranges[id].start - frame.scroll + frame.bodyStart + 1;
};

const lastFooter = (viewer) => stripVTControlCharacters(viewer.frame.lines.at(-1));

async function open(t, { fake = fakeFocus(), options = {}, deps = {} } = {}) {
  const f = fixture(t);
  const viewer = await startViewer({ ...f.options, ...options }, { port: f.port, clock: f.clock,
    env: {}, output: f.output, input: f.input, exit: () => {}, interactive: true,
    watchFn: () => ({ close() {} }), watchFocus: fake.watchFocus, ...deps });
  t.after(() => viewer.stop());
  return { f, viewer, fake };
}

test("the body really scrolls, so the wheel clamps are observable", async (t) => {
  const { viewer } = await open(t);
  const frame = viewer.frame;
  assert.equal(frame.bodyLines.length - frame.bodyRows, 15, "12 cards x 3 rows over 21 body rows");
  assert.equal(frame.bodyStart, 1, "the header is the only row above the body");
  assert.deepEqual(frame.ranges.c0, { start: 0, end: 3, status: "running" });
});

test("wheel down scrolls +3 and wheel up -3, clamped to [0, maxScroll]", async (t) => {
  const { f, viewer } = await open(t);
  assert.equal(viewer.frame.scroll, 0);
  f.input.emit("data", wheelUp());
  assert.equal(viewer.frame.scroll, 0, "the top of the body is a hard floor");
  f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, 3);
  f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, 6);
  f.input.emit("data", wheelUp());
  assert.equal(viewer.frame.scroll, 3);
  for (let step = 0; step < 6; step++) f.input.emit("data", wheelDown());
  const max = viewer.frame.bodyLines.length - viewer.frame.bodyRows;
  assert.equal(viewer.frame.scroll, max);
  f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, max, "the bottom never overruns");
});

test("a wheel turns follow off and persists the scroll it landed on", async (t) => {
  const { f, viewer } = await open(t);
  assert.equal(viewer.state.prefs.follow, true);
  f.input.emit("data", wheelDown());
  assert.equal(viewer.state.prefs.follow, false);
  await flushPrefs(viewer);
  const written = f.lastPrefs();
  assert.equal(written.scroll, 3);
  assert.equal("follow" in written, false, "follow is never persisted off");
  assert.match(lastFooter(viewer), /Follow OFF/);
  // The viewer writes its own prefs file and its ready file, and nothing else: pointer
  // input never reaches slot.json or owner.json (contract item 7).
  assert.deepEqual([...new Set(f.writes.map((entry) => entry.path.split(/[\\/]/).pop()))].sort(),
    ["workers.json", "workers.ready.json"]);
  assert.equal(f.slotText(), JSON.stringify(slotFor()), "slot.json stays read-only");
  assert.match(f.slotText(), /"roles"/, "the slot record is byte-identical, not rewritten");
});

test("a click on a card selects it and a second click folds it, like Space/Enter", async (t) => {
  const { f, viewer } = await open(t);
  const target = "c5";
  const y = rowOfCard(viewer, target);
  f.input.emit("data", click(y));
  assert.equal(viewer.frame.selection, target);
  assert.equal(viewer.state.prefs.selection, target);
  assert.equal(viewer.state.prefs.follow, false, "every click turns follow off");
  assert.equal(viewer.state.prefs.expanded[target], true, "the click folds the card it hit");
  await flushPrefs(viewer);
  assert.equal(f.lastPrefs().selection, target);
  assert.deepEqual(f.lastPrefs().expanded, { [target]: true });

  // The fold added a context row to that card; its title row is still the same row.
  f.input.emit("data", click(y));
  assert.equal(viewer.state.prefs.expanded[target], false, "the second click unfolds it again");
  const untouched = Object.keys(viewer.state.prefs.expanded).filter((id) => id !== target);
  assert.deepEqual(untouched, [], "no other card's fold was touched");
});

test("a click on the footer or header row only turns follow off", async (t) => {
  const { f, viewer } = await open(t);
  f.input.emit("data", wheelDown());
  const scrolled = viewer.frame.scroll;
  const footerY = viewer.frame.bodyStart + viewer.frame.bodyRows + 2;
  f.input.emit("data", click(footerY));
  assert.equal(viewer.state.prefs.selection, null, "a non-body row never selects");
  assert.equal(viewer.frame.scroll, scrolled, "a press is not a scroll");
  assert.equal(viewer.state.prefs.follow, false);
  f.input.emit("data", click(1));
  assert.equal(viewer.state.prefs.selection, null);
  assert.equal(viewer.frame.scroll, scrolled);
});

test("a drag pans the body and a release ends it", async (t) => {
  const { f, viewer } = await open(t);
  const press = rowOfCard(viewer, "c4");
  f.input.emit("data", click(press));
  f.input.emit("data", motion(press - 2));
  assert.equal(viewer.frame.scroll, 2, "dragging up by two rows scrolls down by two");
  f.input.emit("data", motion(press - 4));
  assert.equal(viewer.frame.scroll, 4, "the anchor follows the pointer");
  f.input.emit("data", release(press - 4));
  f.input.emit("data", motion(press - 20));
  assert.equal(viewer.frame.scroll, 4, "after a release there is no drag to continue");
});

test("a drag clamps at the bottom of the body", async (t) => {
  const { f, viewer } = await open(t);
  // Scroll a little so a low row is on screen, press it, then drag above the pane top:
  // the body holds its own last row rather than running past it.
  for (let step = 0; step < 3; step++) f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, 9);
  const press = viewer.frame.bodyStart + viewer.frame.bodyRows;
  f.input.emit("data", click(press));
  f.input.emit("data", motion(1));
  const max = viewer.frame.bodyLines.length - viewer.frame.bodyRows;
  assert.equal(viewer.frame.scroll, max);
  f.input.emit("data", motion(1));
  assert.equal(viewer.frame.scroll, max, "the bottom never overruns");
});

test("a motion report without a press is ignored, and a non-left button never scrolls", async (t) => {
  const { f, viewer } = await open(t);
  f.input.emit("data", motion(20));
  assert.equal(viewer.frame.scroll, 0);
  assert.equal(viewer.state.prefs.follow, true);
  // Middle (button 1) and right (button 2) presses are not this viewer's business.
  f.input.emit("data", "\x1b[<1;5;20M");
  f.input.emit("data", "\x1b[<2;5;20M");
  assert.equal(viewer.frame.scroll, 0);
  assert.equal(viewer.state.prefs.follow, true);
});

test("blur returns follow ON, closes the detail view and re-arms the reveal; focus in does nothing", async (t) => {
  const { f, viewer } = await open(t);
  const press = rowOfCard(viewer, "c4");
  f.input.emit("data", click(press));
  assert.equal(viewer.frame.selection, "c4");
  assert.equal(viewer.state.prefs.follow, false);
  await viewer.key("d");
  assert.equal(viewer.state.detail, true);
  // Drag the selected card out of the window, then leave the pane: follow ON pulls it back.
  f.input.emit("data", motion(2));
  f.input.emit("data", motion(1));
  assert.equal(viewer.frame.scroll, 13, "the drag panned past the selected card");
  assert.equal(viewer.frame.scroll > viewer.frame.ranges.c4.start, true);
  const writes = f.writes.length;

  f.input.emit("data", focusIn);
  assert.equal(viewer.state.prefs.follow, false, "gaining focus changes nothing");
  assert.equal(viewer.state.detail, true);
  assert.equal(viewer.frame.scroll, 13);
  assert.equal(f.writes.length, writes, "and writes nothing");

  f.input.emit("data", blur);
  assert.equal(viewer.state.prefs.follow, true, "losing focus resumes follow");
  assert.equal(viewer.state.detail, false, "the transient detail view closes");
  assert.equal(viewer.frame.scroll, viewer.frame.ranges.c4.start, "follow ON re-arms the reveal");
  // The drag ended with the blur: a later motion report is a no-op.
  const after = viewer.frame.scroll;
  f.input.emit("data", motion(1));
  assert.equal(viewer.frame.scroll, after);
  assert.equal(f.slotText(), JSON.stringify(slotFor()), "slot.json stays read-only");
});

test("blur without a follow change still redraws but writes no preference", async (t) => {
  const { f, viewer } = await open(t);
  let frames = 0;
  viewer.events.on("frame", () => { frames++; });
  const writes = f.writes.length;
  f.input.emit("data", blur);
  await tick();
  assert.equal(viewer.state.prefs.follow, true);
  assert.equal(frames, 1, "the frame is redrawn even when nothing changed");
  assert.equal(f.writes.length, writes, "nothing changed, so nothing was saved");
});

test("the Herdr focus callback goes through the same blur path", async (t) => {
  const { f, viewer, fake } = await open(t);
  f.input.emit("data", wheelDown());
  assert.equal(viewer.state.prefs.follow, false);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].pane, "w1:p9");
  assert.equal(typeof fake.calls[0].blur, "function");
  assert.equal(typeof fake.calls[0].failed, "function");
  fake.calls[0].blur();
  assert.equal(viewer.state.prefs.follow, true);
  assert.deepEqual(fake.calls[0].env, {}, "the viewer passes its own environment through");
});

test("a rejected focus subscription shows exactly one notice and the viewer keeps working", async (t) => {
  const { f, viewer, fake } = await open(t);
  fake.reject(new Error("no socket"));
  await tick();
  const notice = "Focus subscription failed: no socket";
  assert.deepEqual(viewer.state.notices, [notice]);
  assert.match(stripVTControlCharacters(viewer.text), /Focus subscription failed: no socket/);
  // A second failure never repeats the line, and nothing throws out of the view.
  fake.calls[0].failed(new Error("again"));
  await tick();
  assert.deepEqual(viewer.state.notices, [notice]);
  // The viewer still handles keys and still repaints on the timer.
  f.input.emit("data", "f");
  assert.equal(viewer.state.prefs.follow, false);
  f.clock.tick(1000);
  assert.match(stripVTControlCharacters(f.output.writes.at(-1)), /Focus subscription failed/);
});

test("a failed() report alone shows the notice once, and the dispose lands on finish", async (t) => {
  const fake = fakeFocus();
  const { f, viewer } = await open(t, { fake, deps: {
    // The real watcher reports through `failed` and also rejects; this fake reports
    // synchronously and settles normally, so only the callback path is exercised.
    watchFocus: (pane, blurCallback, failed) => { fake.calls.push({ pane, blurCallback, failed }); return fake.promise; },
  } });
  const calls = fake.calls;
  const dispose = { count: 0, dispose() { this.count++; } };
  calls[0].failed(new Error("subscribe denied"));
  await tick();
  assert.deepEqual(viewer.state.notices, ["Focus subscription failed: subscribe denied"]);
  fake.resolve(() => dispose.dispose());
  await tick();
  const writes = f.writes.length;
  viewer.stop();
  assert.equal(dispose.count, 1);
  viewer.stop();
  assert.equal(dispose.count, 1, "finish is idempotent");
  assert.equal(f.writes.length, writes, "the notice itself never writes a preference");
});

test("a subscription that lands after finish is disposed immediately", async (t) => {
  const { viewer, fake } = await open(t);
  const dispose = { count: 0, dispose() { this.count++; } };
  viewer.stop();
  fake.resolve(() => dispose.dispose());
  await tick();
  assert.equal(dispose.count, 1);
});

test("a watcher that throws synchronously is reported, not propagated", async (t) => {
  const thrown = new Error("socket path rejected");
  const calls = [];
  const { viewer } = await open(t, { deps: {
    watchFocus: (pane, onBlur, onFailed) => { calls.push({ pane, onBlur, onFailed }); throw thrown; } } });
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(viewer.state.notices, ["Focus subscription failed: socket path rejected"]);
});

test("a non-interactive viewer never subscribes to the Herdr focus stream", async (t) => {
  const f = fixture(t);
  f.input.isTTY = false;
  f.output.isTTY = false;
  const fake = fakeFocus();
  const viewer = await startViewer(f.options, { port: f.port, clock: f.clock, env: {},
    output: f.output, input: f.input, exit: () => {}, watchFocus: fake.watchFocus,
    watchFn: () => ({ close() {} }) });
  t.after(() => viewer.stop());
  assert.equal(fake.calls.length, 0);
  assert.equal(f.input.listenerCount("data"), 0, "no decoder was attached either");
});

test("an SGR report split across two chunks is decoded exactly once", async (t) => {
  const { f, viewer } = await open(t);
  f.input.emit("data", "\x1b[<65;5");
  assert.equal(viewer.frame.scroll, 0, "a partial report is buffered, not guessed");
  f.input.emit("data", ";10M");
  assert.equal(viewer.frame.scroll, 3, "the report landed exactly once, not twice");
  // Keys still flow through readline after a fragmented report.
  f.input.emit("data", "\x1b[<64;5;10");
  f.input.emit("data", "M");
  assert.equal(viewer.frame.scroll, 0, "the wheel-up half of the fragment landed once");
  assert.equal(viewer.state.prefs.follow, false);
});

test("raw mouse bytes never reach the key handler", async (t) => {
  const { f, viewer } = await open(t);
  // Every byte of a report is a printable character readline would deliver as a key, and
  // the wheel step is clamped at the top: if the bytes were typed instead of decoded,
  // follow would still be ON.
  f.input.emit("data", wheelUp());
  assert.equal(viewer.frame.scroll, 0, "the wheel step is clamped at the top");
  assert.equal(viewer.state.prefs.follow, false, "but the wheel was decoded, not typed");
  // The key path is untouched by a report that came before it, and no byte of the report
  // is left behind to join the next key sequence.
  f.input.emit("data", "f");
  assert.equal(viewer.state.prefs.follow, true);
  f.input.emit("data", "f");
  assert.equal(viewer.state.prefs.follow, false);
  // A report with out-of-range coordinates is still consumed whole: the viewer stays open,
  // the wheel step is decoded rather than typed, and nothing after it is misread as a key.
  let closed = null;
  viewer.events.once("closed", (info) => { closed = info; });
  f.input.emit("data", "\x1b[<65;9999;9999M");
  f.input.emit("data", "f");
  await tick();
  assert.equal(closed, null, "the viewer is still open");
  assert.equal(viewer.state.prefs.follow, true, "the following f was the only key");
  assert.equal(viewer.frame.scroll, 0, "follow ON pulled the selection back into view");
  f.input.emit("data", "f");
  assert.equal(viewer.state.prefs.follow, false);
  assert.equal(viewer.frame.scroll, 3, "the off-screen wheel did scroll, three rows down");
});

test("dispose detaches the input decoder, so post-dispose bytes are inert", async (t) => {
  const { f, viewer } = await open(t);
  viewer.stop();
  const before = viewer.frame.scroll;
  f.input.emit("data", wheelDown());
  f.input.emit("data", "f");
  assert.equal(viewer.frame.scroll, before);
  assert.equal(viewer.state.prefs.follow, true);
  assert.equal(f.input.listenerCount("data"), 0, "the decoder released its listener");
});

test("a resize repaint is the geometry a click is judged against", async (t) => {
  const { f, viewer } = await open(t);
  assert.equal(viewer.frame.bodyRows, 21);
  // A shorter pane: the frame drawn after the resize has a body that ends two rows above
  // the divider, so a row below it is no longer a card hit.
  f.output.rows = 10;
  f.output.emit("resize");
  await tick();
  assert.equal(viewer.frame.bodyRows, 7, "the resize repainted with the new geometry");
  const dividerY = viewer.frame.bodyStart + viewer.frame.bodyRows + 1;
  f.input.emit("data", click(dividerY));
  assert.equal(viewer.state.prefs.selection, null, "the divider is not a card row");
  f.input.emit("data", click(viewer.frame.bodyStart + 1));
  assert.equal(viewer.state.prefs.selection, "c0", "the first body row still is");
});

test("a wheel after blur starts from the scroll position the frame shows, not the stale pref", async (t) => {
  const { f, viewer } = await open(t);
  for (let step = 0; step < 3; step++) f.input.emit("data", "\x1b[<65;5;10M");
  const scrolled = viewer.frame.scroll;
  assert.ok(scrolled > 0);
  f.input.emit("data", "\x1b[O");
  const shown = viewer.frame.scroll;
  f.input.emit("data", "\x1b[<65;5;10M");
  assert.equal(viewer.frame.scroll, Math.min(shown + 3, viewer.frame.maxScroll));
});

test("stop pauses the stdin the viewer resumed, so the process can exit", async (t) => {
  const f = fixture(t);
  let paused = 0;
  f.input.pause = () => { paused += 1; };
  const viewer = await startViewer(f.options, { port: f.port, clock: f.clock, env: {}, output: f.output,
    input: f.input, exit: () => {}, interactive: true, watchFn: () => ({ close() {} }),
    watchFocus: fakeFocus().watchFocus });
  viewer.stop();
  assert.equal(paused, 1);
});

test("a click after blur keeps the scroll position that was on screen", async (t) => {
  const { f, viewer } = await open(t);
  for (let step = 0; step < 3; step++) f.input.emit("data", "\x1b[<65;5;10M");
  f.input.emit("data", "\x1b[O");
  const shown = viewer.frame.scroll;
  f.input.emit("data", "\x1b[<0;5;1M");
  assert.equal(viewer.frame.scroll, shown);
});
