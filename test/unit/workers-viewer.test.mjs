// Workers viewer tests: CLI, projection and prefs contracts, keys, fence, scope switch.
//
// Mirrors test/unit/viewer.test.mjs (the Todo role) so both roles are pinned by the
// same behaviour: argument parsing, the `--once` frame at 34/52 columns, preference
// persistence across a reopen (with follow always returning ON), the q/close path,
// the token fence, scope rebinding, the owner-liveness labels and the ready delay.
// The workers-specific differences are asserted in their own tests: selection is a
// card id, folds are per card, `c` toggles completed cards, `d` shows detail without
// ever writing it to prefs, and Space/Enter fold the selected card.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { width } from "../../src/viewers/common.mjs";
import { EMPTY_PREFS, loadPreferences, main, parseViewerArgs, readProjection, savePreferences,
  startViewer } from "../../src/viewers/workers/viewer.mjs";
import * as todoViewer from "../../src/viewers/todo/viewer.mjs";
import * as workersViewer from "../../src/viewers/workers/viewer.mjs";
import { viewerArgs } from "../../src/core/launch.mjs";
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

const projectionFor = (cards, extra = {}) => ({ schema: "gjc-herdr-dashboard/workers/1",
  updatedAt: 1, cards, empty: false, sourceError: null, ...extra });

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
function fixture(t = { after: () => {} }, { role = "workers", env = {} } = {}) {
  const state = mkdtempSync(join(tmpdir(), "gjc-workers-viewer-"));
  t.after?.(() => rmSync(state, { recursive: true, force: true }));
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
    write: (path, value) => writeJson(path, value),
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
      writeFileSync(join(state, "data", scope, "workers.json"), JSON.stringify(value));
    },
    writePrefs: (value, scope = scopeKey, name = role) => {
      mkdirSync(join(state, "prefs", scope), { recursive: true });
      writeFileSync(join(state, "prefs", scope, `${name}.json`), JSON.stringify(value));
    },
    readPrefs: (scope = scopeKey, name = role) =>
      JSON.parse(readFileSync(join(state, "prefs", scope, `${name}.json`), "utf8")),
    prefsText: (scope = scopeKey, name = role) =>
      readFileSync(join(state, "prefs", scope, `${name}.json`), "utf8"),
    readReady: () => JSON.parse(readFileSync(join(slots, "roles", `${role}.ready.json`), "utf8")),
  };
}

const options = (f, extra = {}) => ({ state: f.state, layout: f.layout, role: f.role,
  token: "tok", pane: "w1:p9", lang: "ko", width: null, once: false, ...extra });

const deps = (f, extra = {}) => ({ port: f.port, clock: f.clock, env: f.env, output: f.output,
  input: f.input, herdr: f.herdr, exit: () => {}, ...extra });

const plain = (viewer) => stripVTControlCharacters(viewer.text);
const footerOf = (viewer) => stripVTControlCharacters(viewer.frame.lines.at(-1));

test("the exported surface is exactly the Todo viewer's, specialised to the workers role", () => {
  assert.deepEqual(Object.keys(workersViewer).sort(), Object.keys(todoViewer).sort());
  for (const name of ["USAGE", "EMPTY_PREFS", "defaultPort", "parseViewerArgs", "readProjection",
    "loadPreferences", "savePreferences", "startViewer", "main"]) {
    assert.ok(name in workersViewer, name);
  }
  assert.match(workersViewer.USAGE, /--role <role>/);
});

test("parseViewerArgs defaults to role workers and rejects malformed input", () => {
  const parsed = parseViewerArgs(["--state", "/tmp/s", "--layout", "a".repeat(24), "--role", "workers",
    "--token", "t", "--pane", "w1:p2", "--lang", "ko", "--width", "52", "--once"]);
  assert.deepEqual(parsed, { once: true, state: "/tmp/s", layout: "a".repeat(24), role: "workers",
    token: "t", pane: "w1:p2", lang: "ko", width: "52", failpoint: null });
  // R3: the exact argv the launcher builds for the workers role must be accepted by this parser.
  const launched = viewerArgs({ stateDir: "/tmp/s", layoutKey: "a".repeat(24), role: "workers", token: "t",
    paneId: "w1:p2", language: "ko", failpoint: "ready-delay-25s" });
  assert.equal(parseViewerArgs(launched).failpoint, "ready-delay-25s");
  assert.throws(() => parseViewerArgs(["--state", "/tmp/s", "--token", "t", "--pane", "p",
    "--failpoint", "bogus"]), /unknown viewer failpoint/);
  assert.equal(parseViewerArgs(["--state", "/tmp/s", "--token", "t", "--pane", "p"]).role, "workers");
  for (const args of [[], ["--state", "/tmp/s", "--token", "t"], ["--state", "relative", "--token", "t", "--pane", "p"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--width", "wide"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--role", "Workers!"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--layout", "short"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--nope", "x"],
    ["--state", "/tmp/s", "--token", "t", "--pane", "p", "--lang"]]) {
    assert.throws(() => parseViewerArgs(args), /Usage: node viewer\.mjs/, JSON.stringify(args));
  }
});

test("readProjection maps missing, corrupt and empty workers files to distinct availability", (t) => {
  const f = fixture(t);
  const path = join(f.state, "data", f.scopeKey, "workers.json");
  assert.deepEqual(readProjection(path), { projection: null, availability: "waiting", error: "" });
  mkdirSync(join(f.state, "data", f.scopeKey), { recursive: true });
  writeFileSync(path, "{oops");
  const corrupt = readProjection(path);
  assert.equal(corrupt.availability, "source-error");
  assert.match(corrupt.error, /Invalid JSON|JSON/);
  // The Todo projection (or any foreign schema) is not a workers projection.
  writeFileSync(path, JSON.stringify({ schema: "gjc-herdr-dashboard/todo/1", phases: [] }));
  assert.equal(readProjection(path).availability, "source-error");
  writeFileSync(path, JSON.stringify(projectionFor([], { empty: true })));
  assert.equal(readProjection(path).availability, "empty");
  writeFileSync(path, JSON.stringify(projectionFor([card("c1")])));
  assert.equal(readProjection(path).availability, "live");
  // A source error reported by the host is surfaced as such, not as live (AC2.7).
  writeFileSync(path, JSON.stringify(projectionFor([card("c1")], { sourceError: "workers_write failed" })));
  const failed = readProjection(path);
  assert.equal(failed.availability, "source-error");
  assert.equal(failed.error, "workers_write failed");
});

test("prefs round-trip per scope, never restore follow OFF, and report a bad file", (t) => {
  const f = fixture(t);
  const path = join(f.state, "prefs", f.scopeKey, "workers.json");
  assert.deepEqual(loadPreferences(path, f.scopeKey), { prefs: { ...EMPTY_PREFS, expanded: {} }, error: "" });
  mkdirSync(join(f.state, "prefs", f.scopeKey), { recursive: true });
  writeFileSync(path, "{bad");
  const bad = loadPreferences(path, f.scopeKey);
  assert.deepEqual(bad.prefs, { ...EMPTY_PREFS, expanded: {} });
  assert.notEqual(bad.error, "");
  // A file written for another scope is ignored rather than applied to this one.
  writeFileSync(path, JSON.stringify({ schema: "gjc-herdr-dashboard/prefs/1", scopeKey: "z".repeat(24),
    scroll: 9, expanded: { c1: true }, selection: "c1", showCompleted: true }));
  assert.deepEqual(loadPreferences(path, f.scopeKey).prefs, { ...EMPTY_PREFS, expanded: {} });
});

test("savePreferences persists folds, selection, scroll and the completed filter but drops follow", async (t) => {
  const f = fixture(t);
  const path = join(f.state, "prefs", f.scopeKey, "workers.json");
  const written = await savePreferences(path, { scopeKey: f.scopeKey, scroll: 7,
    expanded: { c1: true, bad: "yes" }, selection: "c2", showCompleted: true, follow: false });
  assert.equal("follow" in written, false, "follow is not persisted");
  assert.equal("detail" in written, false, "the detail view is never persisted");
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(onDisk, { schema: "gjc-herdr-dashboard/prefs/1", scopeKey: f.scopeKey,
    scroll: 7, expanded: { c1: true }, selection: "c2", showCompleted: true });
  // Reloading it restores everything except follow, which comes back ON (AC1.3).
  assert.deepEqual(loadPreferences(path, f.scopeKey).prefs,
    { scroll: 7, expanded: { c1: true }, selection: "c2", follow: true, showCompleted: true });
});

test("startViewer writes its ready file, renders the cards and shows the footer", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "ship it", status: "running" }),
    card("c2", { title: "queued", status: "pending" })]));
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  const ready = f.readReady();
  assert.equal(ready.token, "tok");
  assert.equal(ready.paneId, "w1:p9");
  assert.equal(ready.pid, process.pid);
  assert.equal(ready.heartbeatAt, f.clock.now());
  assert.equal(typeof ready.gen, "string");
  const text = plain(viewer);
  assert.match(text, /ship it/);
  assert.match(text, /queued/);
  assert.match(footerOf(viewer), /자동 추적 ON/);
  assert.match(footerOf(viewer), /실시간/);
  assert.equal(viewer.state.availability, "live");
  assert.deepEqual(viewer.frame.selectable, ["c1", "c2"]);
  assert.deepEqual(f.calls, [], "opening the viewer never calls Herdr");
  // The ready file is the only state file this viewer writes: slot.json is untouched and
  // no owner.json appears (the viewer only ever reads it).
  assert.equal(readFileSync(join(f.slots, "slot.json"), "utf8"), JSON.stringify(slotFor()));
  const slotsOnDisk = readdirSync(f.slots).sort();
  assert.deepEqual(slotsOnDisk, ["roles", "slot.json"]);
  assert.deepEqual(readdirSync(join(f.slots, "roles")), ["workers.ready.json"]);
});

test("AC-F3: the footer keeps follow and the connection label at 34 and 52 columns in all three languages", async () => {
  const languages = [["ko", /자동 추적 ON/, /실시간/], ["en", /Follow ON/, /Live/],
    ["zh-cn", /自动跟随 ON/, /实时/]];
  for (const [lang, follow, live] of languages) {
    for (const columns of [34, 52]) {
      const f = fixture();
      f.writeSlot(slotFor());
      f.writeProjection(projectionFor([card("c1", { title: "ship it" })]));
      f.output.columns = columns;
      const codes = [];
      const code = await main(["--state", f.state, "--layout", f.layout, "--role", "workers",
        "--token", "tok", "--pane", "w1:p9", "--lang", lang, "--once"],
        deps(f, { exit: (value) => codes.push(value) }));
      assert.equal(code, 0, `${lang}/${columns}`);
      assert.deepEqual(codes, []);
      const printed = f.output.writes.filter((text) => text.includes("ship it"));
      assert.equal(printed.length, 1, `${lang}/${columns}: ${JSON.stringify(f.output.writes)}`);
      const lines = stripVTControlCharacters(printed[0]).split("\n");
      while (lines.length > 0 && lines.at(-1) === "") lines.pop();
      const footer = lines.at(-1);
      assert.match(footer, follow, `${lang}/${columns} footer: ${footer}`);
      assert.match(footer, live, `${lang}/${columns} footer: ${footer}`);
      assert.ok(!/keyboard|키보드|legend/i.test(footer), "no key legend in the footer (AC-F1)");
      assert.ok(width(footer) <= columns, `${lang}/${columns} footer fits: ${footer}`);
      rmSync(f.state, { recursive: true, force: true });
    }
  }
});

test("AC-F4: a 24-column card still shows its title and its status word", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "ship it", status: "running" }),
    card("c2", { title: "broke", status: "failed" })]));
  const viewer = await startViewer(options(f, { width: "24" }), deps(f));
  t.after(() => viewer.stop());
  const text = plain(viewer);
  assert.match(text, /ship it/);
  assert.match(text, /실행 중/);
  assert.match(text, /broke/);
  assert.match(text, /실패/);
  for (const line of viewer.frame.lines) assert.ok(width(line) <= 24, `row too wide: ${line}`);
  assert.match(footerOf(viewer), /자동 추적 ON/);
});

test("AC2.2: a failed card and an aborted card differ in glyph and in word", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "failed one", status: "failed" }),
    card("c2", { title: "aborted one", status: "aborted" })]));
  const viewer = await startViewer(options(f, { width: "40" }), deps(f));
  t.after(() => viewer.stop());
  const failedRow = viewer.frame.lines.find((line) => line.includes("failed one"));
  const abortedRow = viewer.frame.lines.find((line) => line.includes("aborted one"));
  assert.match(failedRow, /✗/);
  assert.match(failedRow, /실패/);
  assert.match(abortedRow, /⊘/);
  assert.match(abortedRow, /중단/);
  assert.ok(!failedRow.includes("중단") && !abortedRow.includes("실패"),
    "neither word leaks into the other card's row");
});

test("Tab/n/p move the card selection by card id in projection order and persist it", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1"), card("c2"), card("c3")]));
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.deepEqual(viewer.frame.selectable, ["c1", "c2", "c3"]);
  // The renderer resolves an unset selection to the newest card; Tab then steps one on.
  assert.equal(viewer.frame.selection, "c1");
  await viewer.key("\t");
  assert.equal(viewer.state.prefs.selection, "c2");
  assert.equal(viewer.state.prefs.follow, false, "stepping the selection pauses follow");
  await viewer.key("n");
  assert.equal(viewer.state.prefs.selection, "c3");
  await viewer.key("n");
  assert.equal(viewer.state.prefs.selection, "c3", "the last card is the end of the list");
  await viewer.key("p");
  assert.equal(viewer.state.prefs.selection, "c2", "p steps back to the same card");
  assert.equal(f.readPrefs().selection, "c2");
  assert.equal(viewer.frame.selection, "c2");
});

test("Space/Enter fold the selected card into a per-card map and persist it", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "running one", lastIntent: "alpha intent" }),
    card("c2", { title: "done one", status: "completed", lastIntent: "beta intent" })]));
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  // The completed card starts folded to one row (auto-fold), so its content is not shown.
  const listFrame = plain(viewer);
  assert.ok(!listFrame.includes("beta intent"), "a completed card is folded to one row");
  await viewer.key("n");
  assert.equal(viewer.state.prefs.selection, "c2");
  // Freeze the frame with c2 selected: `n` paused follow, so nothing else moves below.
  const selectedFrame = plain(viewer);
  assert.ok(!selectedFrame.includes("beta intent"), "still folded to one row");
  await viewer.key(" ");
  assert.equal(viewer.state.prefs.expanded.c2, true, "Space unfolds the selected card");
  assert.equal(viewer.state.prefs.follow, false,
    "the fold is a content toggle: it leaves follow exactly as stepping left it");
  assert.match(plain(viewer), /beta intent/, "the unfolded card shows its content row");
  assert.equal(f.readPrefs().expanded.c2, true);
  await viewer.key("\r");
  assert.equal(viewer.state.prefs.expanded.c2, false, "Enter folds it again");
  assert.equal(plain(viewer), selectedFrame, "folding again restores the frame");
  // Only the selected card's fold changes: the others are untouched.
  assert.deepEqual(Object.keys(viewer.state.prefs.expanded), ["c2"]);
  // Space with no cards at all is a no-op rather than a crash.
  f.writeProjection(projectionFor([]));
  viewer.refresh();
  await viewer.key(" ");
  assert.deepEqual(viewer.frame.selectable, []);
});

test("c toggles completed cards and persists the filter; f toggles follow", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "running one" }),
    card("c2", { title: "done one", status: "completed", lastIntent: "finished work" })]));
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.equal(viewer.state.prefs.showCompleted, false);
  assert.match(footerOf(viewer), /자동 추적 ON/);
  const folded = plain(viewer);
  await viewer.key("c");
  assert.equal(viewer.state.prefs.showCompleted, true);
  assert.equal(viewer.state.prefs.follow, false, "c pauses follow like the Todo viewer");
  assert.equal(f.readPrefs().showCompleted, true);
  assert.match(plain(viewer), /done one/);
  await viewer.key("f");
  assert.equal(viewer.state.prefs.follow, true);
  assert.match(footerOf(viewer), /자동 추적 ON/);
  await viewer.key("f");
  assert.match(footerOf(viewer), /자동 추적 OFF/);
  assert.notEqual(plain(viewer), folded, "the completed filter changes the frame");
  // An unhandled key changes nothing at all.
  const saved = f.prefsText();
  await viewer.key("x");
  assert.equal(f.prefsText(), saved);
});

test("d shows the detail view of the selected card without ever writing it to prefs", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "alpha", currentTool: "read",
    lastIntent: "reading the plan", toolCount: 3 })]));
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  // Materialise the prefs file first (f twice writes and then restores follow), so the
  // `d` assertion below compares bytes against a file that really exists.
  await viewer.key("f");
  await viewer.key("f");
  const listFrame = plain(viewer);
  const before = f.prefsText();
  assert.equal(viewer.state.detail, false);
  assert.doesNotMatch(listFrame, /^\s*id: c1$/m, "the list view is not the detail view");
  await viewer.key("d");
  assert.equal(viewer.state.detail, true);
  assert.notEqual(plain(viewer), listFrame, "the detail view changes the frame");
  assert.match(plain(viewer), /id: c1/, "the detail view lists the card's own fields");
  assert.match(plain(viewer), /reading the plan/);
  assert.equal(f.prefsText(), before, "the detail toggle is not saved");
  assert.equal("detail" in JSON.parse(f.prefsText()), false);
  await viewer.key("d");
  assert.equal(viewer.state.detail, false);
  assert.equal(plain(viewer), listFrame);
  assert.equal(f.prefsText(), before);
  // A reopen never restores the detail view (it was never persisted).
  const reopened = await startViewer(options(f), deps(f));
  t.after(() => reopened.stop());
  assert.equal(reopened.state.detail, false);
  assert.equal(plain(reopened), listFrame);
});

test("j/k scroll the card list without moving the selection", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor(Array.from({ length: 12 }, (_, index) => card(`c${index}`))));
  f.output.rows = 8;
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.ok(viewer.frame.maxScroll > 0, "the fixture really is scrollable");
  await viewer.key("n");
  const selected = viewer.state.prefs.selection;
  const at = viewer.state.prefs.scroll;
  await viewer.key("j");
  assert.equal(viewer.state.prefs.follow, false, "manual scrolling pauses follow");
  assert.equal(viewer.state.prefs.selection, selected, "j does not move the selection");
  assert.equal(viewer.state.prefs.scroll, at + 1, "j scrolls down one row");
  assert.equal(f.readPrefs().scroll, at + 1);
  await viewer.key("k");
  assert.equal(viewer.state.prefs.scroll, at, "k scrolls back up");
  // k at the top is a clamped no-op, never a negative scroll.
  await viewer.key("k");
  await viewer.key("k");
  assert.equal(viewer.state.prefs.scroll, 0);
});

test("AC1.3: f(OFF) then q then reopen comes back FOLLOW ON with folds and selection restored", async (t) => {
  const f = fixture(t, { env: { HERDR_PANE_ID: "w1:p9" } });
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "running one" }),
    card("c2", { title: "done one", status: "completed", lastIntent: "beta intent" })]));
  const first = await startViewer(options(f), deps(f));
  await first.key("f");
  assert.equal(first.state.prefs.follow, false);
  await first.key("c");
  await first.key("n");
  const wantSelection = first.state.prefs.selection;
  assert.equal(wantSelection, "c2");
  // Fold state: the completed card starts auto-folded, so Space unfolds it explicitly.
  await first.key(" ");
  assert.equal(first.state.prefs.expanded.c2, true);
  await first.close();
  // q wrote closing:'q' and asked Herdr to close exactly our own pane.
  assert.deepEqual(f.calls, [["pane", "close", "w1:p9"]]);
  assert.equal(f.readReady().closing, "q");
  assert.equal(f.readPrefs().selection, wantSelection);
  assert.deepEqual(f.readPrefs().expanded, { c2: true }, "the per-card fold is flushed before the close");

  const second = await startViewer(options(f), deps(f));
  t.after(() => second.stop());
  assert.equal(second.state.prefs.follow, true, "follow is never restored OFF");
  assert.equal(second.state.prefs.showCompleted, true, "the completed filter is restored");
  assert.equal(second.state.prefs.selection, wantSelection, "the selection is restored");
  assert.deepEqual(second.state.prefs.expanded, { c2: true }, "the per-card fold is restored");
  assert.match(footerOf(second), /자동 추적 ON/);
  assert.match(plain(second), /done one/);
  assert.match(plain(second), /beta intent/, "the restored fold still shows the card's content row");
});

test("q closes the own pane only when HERDR_PANE_ID matches", async (t) => {
  const owner = fixture(t, { env: { HERDR_PANE_ID: "w1:p9" } });
  owner.writeSlot(slotFor());
  owner.writeProjection(projectionFor([card("c1")]));
  const first = await startViewer(options(owner), deps(owner));
  const retired = new Promise((done) => first.events.once("retired", done));
  await first.key("q");
  const info = await retired;
  assert.equal(info.closed, true, `close outcome: ${info.closeReason}`);
  assert.deepEqual(owner.calls, [["pane", "close", "w1:p9"]]);
  assert.equal(owner.readReady().closing, "q");
  await first.closed;

  const other = fixture(t, { env: { HERDR_PANE_ID: "w1:pOTHER" } });
  other.writeSlot(slotFor());
  other.writeProjection(projectionFor([card("c1")]));
  const second = await startViewer(options(other), deps(other));
  const secondRetired = new Promise((done) => second.events.once("retired", done));
  await second.key("q");
  assert.equal((await secondRetired).closed, false);
  assert.deepEqual(other.calls, [], "no Herdr call when the pane is not ours");
  await second.closed;
});

test("q without an injected client closes the own pane through the slot's recorded herdr vector", async (t) => {
  const f = fixture(t);
  const logPath = join(f.state, "herdr-calls.jsonl");
  const fake = join(f.state, "fake-herdr.mjs");
  writeFileSync(fake, "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + '\\n');\nconsole.log('{\"id\":\"x\",\"result\":{}}');\n");
  f.writeSlot({ ...slotFor(), herdr: [process.execPath, fake, logPath] });
  f.writeProjection(projectionFor([card("c1")]));
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

test("connection labels: live, disconnected, source-error and empty are pairwise distinct", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1")]));
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  const live = footerOf(viewer);
  assert.match(live, /실시간/);
  // A cooperative exit that just recorded stoppedAt is already disconnected.
  viewer.setOwner({ schema: "gjc-herdr-dashboard/owner/1", pid: 4321,
    heartbeatAt: f.clock.now(), stoppedAt: f.clock.now() });
  const disconnected = footerOf(viewer);
  assert.match(disconnected, /연결 끊김/);
  // A source error reported by the host is the source-error label (AC2.7); the owner
  // evidence is cleared first so each label is read on its own.
  viewer.setOwner(null);
  f.writeProjection(projectionFor([card("c1")], { sourceError: "bus handler exploded" }));
  viewer.refresh();
  const sourceError = footerOf(viewer);
  assert.match(sourceError, /원천 오류/);
  // An empty projection is its own label.
  f.writeProjection(projectionFor([], { empty: true }));
  viewer.refresh();
  const empty = footerOf(viewer);
  assert.match(empty, /원본 비어 있음/);
  assert.equal(new Set([live, disconnected, sourceError, empty]).size, 4);
});

test("owner.json is read as liveness evidence on the first refresh", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1")]));
  // The owner recorded a cooperative stop before the viewer ever read the file.
  f.writeOwner({ schema: "gjc-herdr-dashboard/owner/1", pid: 4321,
    heartbeatAt: f.clock.now(), stoppedAt: f.clock.now() });
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.match(footerOf(viewer), /연결 끊김/, "owner.json is picked up on the first refresh");
  assert.equal(viewer.state.owner, "disconnected");
  assert.match(plain(viewer), /c1/, "a disconnected owner still shows the last published cards");
  // A foreign schema in owner.json is ignored rather than trusted as liveness evidence.
  f.writeOwner({ schema: "someone-else/1", pid: 1, stoppedAt: f.clock.now() });
  viewer.refresh();
  assert.match(footerOf(viewer), /연결 끊김/, "the last valid record still stands");
});

test("owner liveness keeps the live label until the killed heartbeat is 10 s old", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1")]));
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  viewer.setOwner({ schema: "gjc-herdr-dashboard/owner/1", pid: 4321, heartbeatAt: f.clock.now() },
    { alive: () => false });
  f.clock.advance(5000);
  viewer.refresh();
  assert.match(footerOf(viewer), /실시간/);
  f.clock.advance(10000);
  viewer.refresh();
  assert.match(footerOf(viewer), /연결 끊김/);
  assert.deepEqual(f.calls, []);
  assert.equal(viewer.frame.connection, "disconnected");
  assert.equal(viewer.state.owner, "disconnected");
});

test("token fence: a different token retires the viewer and closes only our pane", async (t) => {
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
  assert.deepEqual(f.calls, [], "no Herdr call when the pane is not ours");
  await viewer.closed;
});

test("token fence: a missing role retires, an unreadable slot does not", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1")]));
  const viewer = await startViewer(options(f), deps(f));
  // An unreadable slot keeps the last state and only reports the source error.
  rmSync(join(f.slots, "slot.json"));
  viewer.refresh();
  assert.equal(viewer.state.availability, "live");
  assert.notEqual(viewer.state.slotError, "");
  assert.match(footerOf(viewer), /원천 오류/);
  // A corrupt slot is likewise not a retire reason.
  writeFileSync(join(f.slots, "slot.json"), "{not json");
  viewer.refresh();
  assert.notEqual(viewer.state.slotError, "");
  // A valid slot that no longer carries our role does retire.
  const retired = new Promise((done) => viewer.events.once("retired", done));
  f.writeSlot(slotFor({ role: "todo" }));
  viewer.refresh();
  assert.equal((await retired).reason, "role-missing");
  await viewer.closed;
});

test("refresh drops a selection and a fold whose card left the projection", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1"), card("c2")]));
  f.writePrefs({ schema: "gjc-herdr-dashboard/prefs/1", scopeKey: f.scopeKey, scroll: 99,
    expanded: { c1: true, gone: true }, selection: "gone", showCompleted: false });
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.equal(viewer.state.prefs.selection, null, "a stale selection is dropped");
  assert.deepEqual(viewer.state.prefs.expanded, { c1: true }, "a stale fold entry is dropped");
  // A scroll position past the end of the (shorter) list is clamped to the frame.
  assert.equal(viewer.state.prefs.scroll, viewer.frame.maxScroll);
  // The renderer then resolves the (now null) selection to the newest card.
  assert.equal(viewer.frame.selection, viewer.frame.selectable[0]);
});

test("scope switch: a new scopeKey rebinds data and prefs without touching the pane", async (t) => {
  const f = fixture(t);
  const otherScope = "c".repeat(24);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "OLD_SCOPE_CARD" })]));
  f.writeProjection(projectionFor([card("c9", { title: "NEW_SCOPE_CARD" })]), otherScope);
  f.writePrefs({ schema: "gjc-herdr-dashboard/prefs/1", scopeKey: otherScope, scroll: 3,
    expanded: { c9: true }, selection: "c9", showCompleted: true }, otherScope);
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.match(plain(viewer), /OLD_SCOPE_CARD/);
  assert.equal(viewer.state.prefs.scopeKey, f.scopeKey);
  const switched = new Promise((done) => viewer.events.once("scope", done));
  f.writeSlot(slotFor({ scopeKey: otherScope }));
  viewer.refresh();
  assert.deepEqual(await switched, { scopeKey: otherScope });
  assert.equal(viewer.state.prefs.scopeKey, otherScope);
  assert.match(plain(viewer), /NEW_SCOPE_CARD/);
  assert.doesNotMatch(plain(viewer), /OLD_SCOPE_CARD/);
  assert.equal(viewer.state.prefs.selection, "c9");
  assert.equal(viewer.state.prefs.showCompleted, true);
  assert.equal(viewer.state.prefs.follow, true);
  assert.deepEqual(f.calls, []);
});

test("a bad prefs file shows a notice but never crashes the viewer", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1")]));
  mkdirSync(join(f.state, "prefs", f.scopeKey), { recursive: true });
  writeFileSync(join(f.state, "prefs", f.scopeKey, "workers.json"), "{broken prefs");
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.match(plain(viewer), /화면 설정/);
  assert.deepEqual(viewer.state.prefs, { ...EMPTY_PREFS, expanded: {}, scopeKey: f.scopeKey });
  assert.equal(viewer.state.availability, "live");
});

test("the ready-delay-25s failpoint postpones the first ready write", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([]));
  // The viewer is started without awaiting it: the ready write is gated on the fake
  // clock, which this test drives by hand.
  const starting = startViewer({ ...options(f), failpoint: "ready-delay-25s" },
    deps(f, { interactive: false }));
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
  f.writeProjection(projectionFor([card("c1", { title: "work" })]));
  const viewer = await startViewer(options(f, { lang: "de" }), deps(f));
  t.after(() => viewer.stop());
  assert.equal(viewer.state.language, "ko");
  assert.equal(viewer.state.notices.length, 1);
  assert.match(plain(viewer), /자동 추적 ON/);
  assert.match(plain(viewer), /언어 값이 올바르지 않아/);
  // A valid value produces no notice.
  const clean = await startViewer(options(f, { lang: "zh-cn" }), deps(f));
  t.after(() => clean.stop());
  assert.deepEqual(clean.state.notices, []);
  assert.match(stripVTControlCharacters(clean.text), /自动跟随 ON/);
});

test("--once prints exactly one frame to stdout and exits 0", async () => {
  const f = fixture();
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "once frame" })]));
  const codes = [];
  const code = await main(["--state", f.state, "--layout", f.layout, "--role", "workers",
    "--token", "tok", "--pane", "w1:p9", "--once"],
    deps(f, { exit: (value) => codes.push(value) }));
  assert.equal(code, 0);
  const printed = f.output.writes.filter((text) => text.includes("once frame"));
  assert.equal(printed.length, 1, JSON.stringify(f.output.writes));
  assert.equal(printed[0].endsWith("\n"), true);
  assert.deepEqual(f.calls, []);
  rmSync(f.state, { recursive: true, force: true });
});

test("interactive mode: a projection that lands after the first paint appears on the next timer tick", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.input.isTTY = true;
  f.output.isTTY = true;
  const viewer = await startViewer(options(f), deps(f, { interactive: true,
    watchFn: () => ({ close() {}, on() {} }) }));
  t.after(async () => { await viewer.close(); });
  assert.ok(!f.output.writes.at(-1).includes("late arrival"), "nothing to show yet");
  // The owner publishes a workers projection after the viewer already painted its empty frame.
  f.writeProjection(projectionFor([card("c1", { title: "late arrival" })]));
  f.clock.tick(1000);
  assert.ok(f.output.writes.at(-1).includes("late arrival"), "the timer tick re-reads the projection");
});

test("interactive mode: pointer modes, raw mode, a repaint timer and the slot watcher", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "watch me" })]));
  const rawModes = [];
  f.input.setRawMode = (value) => rawModes.push(value);
  f.input.isTTY = true;
  f.output.isTTY = true;
  const watcher = { closed: 0, close() { this.closed++; }, on() {} };
  const viewer = await startViewer(options(f), deps(f, { interactive: true, watchFn: () => watcher }));
  t.after(async () => { await viewer.close(); });
  assert.deepEqual(rawModes, [true]);
  assert.ok(f.output.writes.some((text) => text.includes("\x1b[?1049h")), "alternate screen entered");
  assert.ok(f.output.writes.some((text) => text.includes("\x1b[?25l")), "cursor hidden");
  assert.ok(f.output.writes.some((text) => text.includes("\x1b[?1002h\x1b[?1006h\x1b[?1004h")),
    "the pointer modes come from src/terminal-input.mjs");
  assert.equal(f.clock.intervalCount(1000), 2, "one repaint timer and one slot poll");
  assert.equal(f.clock.intervalCount(5000), 1, "one heartbeat timer");
  // A key arriving on stdin reaches the same handler as the direct API.
  f.input.emit("data", "f");
  await new Promise((done) => setImmediate(done));
  assert.equal(viewer.state.prefs.follow, false);
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
  assert.ok(f.output.writes.at(-1).includes("\x1b[?1004l\x1b[?1006l\x1b[?1002l"), "pointer modes off");
  assert.ok(f.output.writes.at(-1).includes("\x1b[?25h"), "cursor shown again");
  assert.deepEqual(rawModes, [true, false], "raw mode restored");
  assert.equal(f.clock.intervalCount(1000), 0, "every 1s timer is released");
  assert.equal(f.clock.intervalCount(5000), 0, "the heartbeat timer is released");
});

// The `interactive` default follows the two isTTY flags, so a redirected stdout in
// the `--once` snapshot path can never enter raw mode.
test("a non-TTY process defaults to one-shot output even without --once", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "plain" })]));
  f.input.isTTY = false;
  f.output.isTTY = false;
  const viewer = await startViewer(options(f), deps(f));
  t.after(() => viewer.stop());
  assert.equal(f.clock.intervalCount(1000), 0, "no repaint timer without a TTY");
  assert.equal(f.clock.intervalCount(5000), 0, "no heartbeat timer without a TTY");
  assert.equal(f.output.writes.filter((text) => text.includes("plain")).length, 1);
});

test("R3 failpoint in interactive mode defers the ready write and the first data paint together", async (t) => {
  const f = fixture(t);
  f.writeSlot(slotFor());
  f.writeProjection(projectionFor([card("c1", { title: "early row" })]));
  f.input.isTTY = true;
  f.output.isTTY = true;
  const starting = startViewer({ ...options(f), failpoint: "ready-delay-25s" },
    deps(f, { interactive: true, watchFn: () => ({ close() {}, on() {} }) }));
  await new Promise((done) => setImmediate(done));
  f.clock.advance(24999);
  f.clock.tick(1000);
  assert.ok(!f.output.writes.some((text) => text.includes("early row")), "no data frame before the delay");
  assert.throws(() => f.readReady(), /ENOENT/, "no ready file before the delay");
  // q during the delay already retires: the closing mark is written, nothing restarts.
  f.input.emit("data", "q");
  await new Promise((done) => setImmediate(done));
  f.clock.advance(1);
  const viewer = await starting;
  await viewer.closed;
  assert.equal(f.readReady().closing, "q", "the closing mark written by q is not overwritten");
  f.clock.tick(10000);
  assert.equal(f.readReady().closing, "q", "no heartbeat restarts after the delay");
  assert.equal(f.clock.intervalCount(1000), 0, "no timers were armed after the delay");
});

test("a usage error is reported on stderr and returns 2 without starting a viewer", async () => {
  const errors = [];
  const code = await main(["--state", "relative"], { stderr: { write: (text) => errors.push(text) } });
  assert.equal(code, 2);
  assert.match(errors.join(""), /Usage: node viewer\.mjs/);
});
