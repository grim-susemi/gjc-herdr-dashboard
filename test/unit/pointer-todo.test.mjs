// Todo viewer pointer + focus tests (L3 contract AC3.1-AC3.3).
//
// The Todo viewer decodes SGR pointer reports and DEC 1004 focus reports through the
// shared `terminalInput` decoder and subscribes to the Herdr lifecycle stream through
// an injected `watchFocus` (default `watchHerdrFocus`). These tests drive the fake
// stdin of the viewer unit fixture with raw SGR byte strings, so they cover the wiring
// the direct `viewer.key()` API cannot: wheel scrolling, click selection, drag panning,
// blur, and the best-effort focus subscription.
//
// No live Herdr: `watchFocus` is always a fake and both viewers are fakes.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { startViewer } from "../../src/viewers/todo/viewer.mjs";

const slotFor = ({ layoutKey = "a".repeat(24), scopeKey = "b".repeat(24), role = "todo",
  state = "pending", token = "tok", pane = "w1:p9" } = {}) => ({
  schema: "gjc-herdr-dashboard/slot/1", layoutKey,
  parent: { socket: "sock", paneId: "w1:p1", tabId: "t1" }, herdr: ["herdr"],
  scope: { sessionId: "sess", scopeKey, scopeEpoch: 1, language: "ko" },
  roles: { [role]: { state, token, paneId: pane, tabId: "t1", shellPid: 12, label: "GJC Todo · aaaaaaaa" } },
});

// 30 one-line pending tasks: 31 body lines against 21 body rows, so the body really
// scrolls and the wheel/drag clamps are observable.
const projectionFor = (count = 30) => ({ schema: "gjc-herdr-dashboard/todo/1",
  updatedAt: 1, empty: false, sourceError: null,
  phases: [{ name: "P", tasks: Array.from({ length: count }, (unused, index) =>
    ({ content: `t${index}`, status: "pending" })) }] });

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
  const state = mkdtempSync(join(tmpdir(), "gjc-pointer-todo-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const clock = fakeClock();
  const writes = [];
  // A real EventEmitter so the resize path is exercised, not just the write path.
  const output = Object.assign(new EventEmitter(), { columns: 80, rows: 24, isTTY: true,
    writes: [], write(text) { output.writes.push(text); return true; } });
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
      const { writeJson } = await import("../../src/storage.mjs");
      await writeJson(path, value);
    },
  };
  const layout = "a".repeat(24), scopeKey = "b".repeat(24);
  const slots = join(state, "slots", layout);
  mkdirSync(join(slots, "roles"), { recursive: true });
  mkdirSync(join(state, "data", scopeKey), { recursive: true });
  mkdirSync(join(state, "prefs", scopeKey), { recursive: true });
  writeFileSync(join(slots, "slot.json"), JSON.stringify(slotFor()));
  writeFileSync(join(state, "data", scopeKey, "todo.json"), JSON.stringify(projectionFor()));
  return { state, layout, scopeKey, slots, clock, output, input, port, writes,
    options: { state, layout, role: "todo", token: "tok", pane: "w1:p9", lang: "ko",
      width: null, once: false },
    // The viewer builds its paths with `/`; `join` here would be `\` on Windows.
    lastPrefs: () => writes.filter((entry) => entry.path === `${state}/prefs/${scopeKey}/todo.json`)
      .at(-1)?.value,
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

// The SGR row that lands on a task, derived from the frame the viewer actually drew
// (1-based y = bodyLines index - scroll + bodyStart + 1).
const rowOfTask = (viewer, key) => {
  const frame = viewer.frame;
  return frame.taskRanges[key].start - frame.scroll + frame.bodyStart + 1;
};

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
  assert.equal(frame.bodyLines.length - frame.bodyRows, 11, "30 tasks over 20 body rows");
  assert.equal(frame.bodyStart, 2, "the header and its divider are the only rows above the body");
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
  // The bottom is the frame's own last scroll position, not an invented constant.
  for (let step = 0; step < 6; step++) f.input.emit("data", wheelDown());
  const max = viewer.frame.bodyLines.length - viewer.frame.bodyRows;
  assert.equal(viewer.frame.scroll, max);
  f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, max, "the bottom never overruns");
});

test("a wheel turns follow off and persists scroll without persisting follow", async (t) => {
  const { f, viewer } = await open(t);
  assert.equal(viewer.state.prefs.follow, true);
  f.input.emit("data", wheelDown());
  assert.equal(viewer.state.prefs.follow, false);
  await flushPrefs(viewer);
  const written = f.lastPrefs();
  assert.equal(written.scroll, 3);
  assert.equal("follow" in written, false, "follow is never persisted off");
  assert.match(stripVTControlCharacters(viewer.text), /Follow OFF/);
});

test("a click selects the task under the cursor and turns follow off", async (t) => {
  const { f, viewer } = await open(t);
  const target = "[\"P\",0,\"t5\",0]";
  const y = rowOfTask(viewer, target);
  f.input.emit("data", click(y));
  assert.equal(viewer.frame.selection, target);
  assert.equal(viewer.state.prefs.follow, false);
  await flushPrefs(viewer);
  assert.equal(f.lastPrefs().selection, target);
  // The task rows on screen are exactly the ones a click can reach.
  assert.ok(y > viewer.frame.bodyStart && y <= viewer.frame.bodyStart + viewer.frame.bodyRows);
});

test("a click on the footer row only turns follow off", async (t) => {
  const { f, viewer } = await open(t);
  const before = viewer.frame.selection;
  const footerY = viewer.frame.bodyStart + viewer.frame.bodyRows + 2;
  f.input.emit("data", click(footerY));
  assert.equal(viewer.frame.selection, before, "a non-body row never selects");
  assert.equal(viewer.state.prefs.follow, false);
  // A click above the body (the header) behaves the same way.
  f.input.emit("data", wheelDown());
  const scrolled = viewer.frame.scroll;
  f.input.emit("data", click(1));
  assert.equal(viewer.frame.selection, before);
  assert.equal(viewer.frame.scroll, scrolled, "a press is not a scroll");
});

test("a drag pans the body and a release ends it", async (t) => {
  const { f, viewer } = await open(t);
  const press = rowOfTask(viewer, "[\"P\",0,\"t19\",0]");
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
  const press = rowOfTask(viewer, "[\"P\",0,\"t19\",0]");
  f.input.emit("data", click(press));
  f.input.emit("data", motion(1));
  const max = viewer.frame.bodyLines.length - viewer.frame.bodyRows;
  assert.equal(viewer.frame.scroll, max);
});

test("a motion report without a press is ignored", async (t) => {
  const { f, viewer } = await open(t);
  f.input.emit("data", motion(20));
  assert.equal(viewer.frame.scroll, 0);
  assert.equal(viewer.state.prefs.follow, true);
});

test("blur returns follow ON, re-arms the reveal and ends the drag; focus in does nothing", async (t) => {
  const { f, viewer } = await open(t);
  // Scroll away from the selection, so "reveal re-armed" is observable as the frame
  // snapping the selection back into the body window.
  for (let step = 0; step < 4; step++) f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, 11, "the wheel scroll stuck, so a manual scroll is not snapped back");
  const selected = viewer.frame.selection;
  const range = viewer.frame.taskRanges[selected];
  assert.ok(range.start < viewer.frame.scroll, "the selection is off screen");
  // A press on the footer only turns follow off and starts a drag (AC3.1).
  const footerY = viewer.frame.bodyStart + viewer.frame.bodyRows + 2;
  f.input.emit("data", click(footerY));
  assert.equal(viewer.frame.selection, selected, "a footer press never selects");
  f.input.emit("data", motion(footerY + 2));
  assert.equal(viewer.frame.scroll, 9);
  assert.equal(viewer.state.prefs.follow, false);
  const writes = f.writes.length;

  f.input.emit("data", focusIn);
  assert.equal(viewer.state.prefs.follow, false, "gaining focus changes nothing");
  assert.equal(f.writes.length, writes, "and writes nothing");

  f.input.emit("data", blur);
  assert.equal(viewer.state.prefs.follow, true, "losing focus resumes follow");
  assert.equal(viewer.frame.selection, selected, "blur never changes the selection");
  const revealed = viewer.frame;
  assert.ok(range.start >= revealed.scroll &&
    range.start < revealed.scroll + revealed.bodyRows, "the selection is revealed again");
  assert.notEqual(revealed.scroll, 9, "and the drag scroll was replaced by the reveal");
  // Follow is not persisted, so the visible evidence of the save is the scroll it wrote.
  await flushPrefs(viewer);
  assert.equal(f.lastPrefs().scroll, 9, "the drag scroll is still the persisted one");
  // The drag ended with the blur: a later motion report is a no-op.
  const afterBlur = viewer.frame.scroll;
  f.input.emit("data", motion(1));
  assert.equal(viewer.frame.scroll, afterBlur);
});

test("blur without a follow change still redraws but writes no preference", async (t) => {
  const { f, viewer } = await open(t);
  const writes = f.writes.length;
  f.input.emit("data", blur);
  await tick();
  assert.equal(viewer.state.prefs.follow, true);
  assert.equal(f.writes.length, writes, "nothing changed, so nothing was saved");
});

test("the Herdr focus callback goes through the same blur path", async (t) => {
  const { f, viewer, fake } = await open(t);
  f.input.emit("data", wheelDown());
  assert.equal(viewer.state.prefs.follow, false);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].pane, "w1:p9");
  assert.equal(typeof fake.calls[0].blur, "function");
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

test("a failed() report alone shows the notice once, and the dispose lands on stop", async (t) => {
  const fake = fakeFocus();
  const { f, viewer } = await open(t, { fake, deps: {
    // The real watcher reports through `failed` and also rejects; this fake reports
    // synchronously and settles normally, so only the callback path is exercised.
    watchFocus: (pane, blurCallback, failed) => { fake.calls.push({ pane, blurCallback, failed }); return fake.promise; },
  } });
  const calls = fake.calls;
  const dispose = { count: 0, dispose() { this.count++; } };
  // The subscription is only observed after the first paint.
  await tick();
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
});

test("an SGR report split across two chunks is decoded exactly once", async (t) => {
  const { f, viewer } = await open(t);
  f.input.emit("data", "\x1b[<65;5");
  assert.equal(viewer.frame.scroll, 0, "a partial report is buffered, not guessed");
  f.input.emit("data", ";10M");
  assert.equal(viewer.frame.scroll, 3, "the report landed exactly once, not twice");
  // Keys still flow through readline after a fragmented report.
  f.input.emit("data", "\x1b[");
  f.input.emit("data", "B");
  assert.equal(viewer.state.prefs.follow, false, "a real key still reaches the key handler");
});

test("resize repaints, and the click mapping uses the frame drawn after the resize", async (t) => {
  const { f, viewer } = await open(t);
  const before = viewer.frame;
  assert.equal(before.bodyRows, f.output.rows - 4);
  // A taller pane adds body rows; the mapping must use the new geometry.
  f.output.columns = 80;
  f.output.rows = 14;
  f.output.emit("resize");
  assert.equal(viewer.frame.bodyRows, 10, "the frame was redrawn for the new size");
  const target = "[\"P\",0,\"t3\",0]";
  const y = rowOfTask(viewer, target);
  assert.ok(y <= viewer.frame.bodyStart + viewer.frame.bodyRows, "the target row is visible");
  f.input.emit("data", click(y));
  assert.equal(viewer.frame.selection, target);
});

test("a keyboard action re-arms the reveal a pointer action disarmed", async (t) => {
  const { f, viewer } = await open(t);
  const selected = viewer.frame.selection;
  const range = viewer.frame.taskRanges[selected];
  // A press on the footer starts a drag without touching the selection; dragging up
  // then holds a manual scroll position well past it.
  const footerY = viewer.frame.bodyStart + viewer.frame.bodyRows + 2;
  f.input.emit("data", click(footerY));
  f.input.emit("data", motion(2));
  assert.equal(viewer.frame.scroll, 11, "clamped at the bottom of the body");
  assert.equal(viewer.frame.selection, selected, "the footer press selected nothing");
  assert.ok(range.start < viewer.frame.scroll, "the drag left the selection behind");
  // Any key that redraws hands the scroll back to the selection (the keyboard contract
  // was already 'the selected row is always visible').
  await viewer.key("f");
  const after = viewer.frame;
  assert.ok(range.start >= after.scroll && range.start < after.scroll + after.bodyRows);
});

test("an SGR report is decoded in place of the key path, and a real key in the same chunk still lands", async (t) => {
  const { f, viewer } = await open(t);
  // Every byte of a report is a character the old plain `on("data")` path fed to `key()`
  // one at a time. The decoder consumes the report and leaves the trailing arrow key on
  // the readline stream, which the old per-character path could not have delivered.
  f.input.emit("data", "\x1b[<64;5;10M\x1b[B");
  assert.equal(viewer.frame.scroll, 0, "the wheel step is clamped at the top");
  assert.equal(viewer.state.prefs.follow, false, "but the wheel was decoded, not typed");
  assert.equal(viewer.frame.selection, "[\"P\",0,\"t1\",0]", "the arrow key arrived as one key");
  assert.equal(viewer.state.prefs.expanded, false, "no report byte toggled the fold");
  assert.equal(f.input.listenerCount("data"), 1, "exactly one decoder listens (no second onData path)");
});

test("pointer and focus handling never writes slot.json or owner.json", async (t) => {
  const { f, viewer } = await open(t);
  f.input.emit("data", wheelDown());
  f.input.emit("data", click(rowOfTask(viewer, "[\"P\",0,\"t5\",0]")));
  f.input.emit("data", motion(2));
  f.input.emit("data", release(2));
  f.input.emit("data", blur);
  await flushPrefs(viewer);
  const paths = [...new Set(f.writes.map((entry) => entry.path))];
  assert.equal(paths.some((path) => path.endsWith("slot.json") || path.endsWith("owner.json")), false,
    `the viewer only writes its own role files: ${paths.join(", ")}`);
  assert.ok(paths.every((path) => path.includes("/prefs/") || path.endsWith("todo.ready.json")),
    "every write is a preference save or the ready heartbeat");
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

test("a wheel after blur starts from the scroll position the frame shows, not the stale pref", async (t) => {
  const { f, viewer } = await open(t);
  for (let step = 0; step < 3; step++) f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, 9);
  f.input.emit("data", blur);
  const shown = viewer.frame.scroll;
  assert.ok(shown < 9, "blur pulled the frame back to the live selection");
  f.input.emit("data", wheelDown());
  assert.equal(viewer.frame.scroll, shown + 3, "one wheel step moves 3 rows from what is on screen");
});

test("a click after blur selects the row drawn on screen", async (t) => {
  const { f, viewer } = await open(t);
  for (let step = 0; step < 3; step++) f.input.emit("data", wheelDown());
  f.input.emit("data", blur);
  const frame = viewer.frame;
  const [key] = Object.entries(frame.taskRanges).find(([, range]) => range.start >= frame.scroll + 2);
  f.input.emit("data", click(rowOfTask(viewer, key)));
  assert.equal(viewer.state.prefs.selection, key);
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
  for (let step = 0; step < 3; step++) f.input.emit("data", wheelDown());
  f.input.emit("data", blur);
  const shown = viewer.frame.scroll;
  f.input.emit("data", click(1));
  assert.equal(viewer.frame.scroll, shown, "the press did not jump back to the stale pref");
});
