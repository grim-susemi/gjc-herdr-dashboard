// native-todo.mjs: hides GJC's chat-side Todo panel while the dashboard Todo viewer is alive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { WIDGET_KEY, createNativeTodoMask, locateNativeTodo } from "../../src/host/native-todo.mjs";

// A container the way the host's TUI builds it: real render/invalidate/detachAll on the prototype.
class FakeContainer {
  children = [];
  invalidations = 0;
  render() { return ["native todo row"]; }
  renderWithViewportAnchors() { return { lines: this.render(), anchors: [null] }; }
  invalidate() { this.invalidations += 1; }
  detachAll() { this.children = []; }
}

// The TUI child order is status, todo, btw, statusLine (the only child with setPlanModeStatus).
function fakeTui() {
  const status = new FakeContainer(), todo = new FakeContainer(), btw = new FakeContainer();
  const rail = Object.assign(new FakeContainer(), { setPlanModeStatus() {} });
  const tui = { children: [status, todo, btw, rail], renders: 0, requestRender() { this.renders += 1; } };
  return { tui, todo, status, btw, rail };
}

// A ctx whose ui.setWidget behaves like the host: the factory runs at once, undefined disposes.
function fakeCtx(tui, { hasUI = true } = {}) {
  const widgets = new Map();
  const ui = { setWidget(key, content) {
    widgets.get(key)?.dispose?.();
    widgets.delete(key);
    if (content !== undefined) widgets.set(key, content(tui, {}));
  } };
  return { ctx: { hasUI, ui }, widgets };
}

test("locateNativeTodo finds the container two children before the status rail", () => {
  const { tui, todo } = fakeTui();
  assert.equal(locateNativeTodo(tui), todo);
});

test("locateNativeTodo refuses a shape it does not recognise", () => {
  assert.equal(locateNativeTodo(null), null);
  assert.equal(locateNativeTodo({ children: [] }), null);
  assert.equal(locateNativeTodo({ children: [new FakeContainer(), new FakeContainer()] }), null);
  const { tui } = fakeTui();
  tui.children[1] = { render() { return []; } };
  assert.equal(locateNativeTodo(tui), null, "a todo slot that is not a container is left alone");
});

test("apply(true) silences the native panel and invalidates its cache; apply(false) restores it", () => {
  const { tui, todo } = fakeTui();
  const { ctx } = fakeCtx(tui);
  const mask = createNativeTodoMask();
  assert.deepEqual(todo.render(), ["native todo row"]);
  assert.equal(mask.apply(ctx, true), "hidden");
  assert.deepEqual(todo.render(), []);
  assert.deepEqual(todo.renderWithViewportAnchors(), { lines: [], anchors: [] });
  assert.ok(todo.invalidations >= 1, "the TUI frame cache is dropped");
  assert.equal(mask.state().hidden, true);
  assert.equal(mask.apply(ctx, false), "shown");
  assert.deepEqual(todo.render(), ["native todo row"], "the prototype method is back");
  assert.equal(Object.hasOwn(todo, "render"), false, "no own override is left behind");
  assert.equal(mask.state().hidden, false);
  assert.ok(tui.renders >= 1, "the restore asks for a repaint");
});

test("a repeated apply is a no-op and never stacks a second widget", () => {
  const { tui } = fakeTui();
  const { ctx, widgets } = fakeCtx(tui);
  const mask = createNativeTodoMask();
  assert.equal(mask.apply(ctx, true), "hidden");
  assert.equal(mask.apply(ctx, true), "unchanged");
  assert.equal(widgets.size, 1);
  assert.ok(widgets.has(WIDGET_KEY));
  assert.equal(mask.apply(ctx, false), "shown");
  assert.equal(mask.apply(ctx, false), "unchanged");
  assert.equal(widgets.size, 0);
});

test("a host that disposes the widget by itself restores the panel and lets apply re-hide it", () => {
  const { tui, todo } = fakeTui();
  const { ctx, widgets } = fakeCtx(tui);
  const mask = createNativeTodoMask();
  mask.apply(ctx, true);
  widgets.get(WIDGET_KEY).dispose();
  widgets.clear();
  assert.deepEqual(todo.render(), ["native todo row"]);
  assert.equal(mask.state().hidden, false);
  assert.equal(mask.apply(ctx, true), "hidden", "the next pass hides it again");
  assert.deepEqual(todo.render(), []);
});

test("an unknown TUI shape hides nothing and says why", () => {
  const tui = { children: [new FakeContainer()], requestRender() {} };
  const { ctx } = fakeCtx(tui);
  const mask = createNativeTodoMask();
  assert.equal(mask.apply(ctx, true), "unavailable");
  assert.equal(mask.state().hidden, false);
  assert.equal(mask.state().failure, "native-todo-not-found");
});

test("no UI or no setWidget is unavailable, and a throwing host never escapes", () => {
  const { tui } = fakeTui();
  const mask = createNativeTodoMask();
  assert.equal(mask.apply(fakeCtx(tui, { hasUI: false }).ctx, true), "unavailable");
  assert.equal(mask.apply({ hasUI: true, ui: {} }, true), "unavailable");
  assert.equal(mask.apply(undefined, true), "unavailable");
  const hostile = { hasUI: true, ui: { setWidget() { throw new Error("host broke"); } } };
  assert.equal(mask.apply(hostile, true), "unavailable");
  assert.equal(mask.state().failure, "host broke");
});

test("release hands the panel back and a second release is harmless", () => {
  const { tui, todo } = fakeTui();
  const { ctx } = fakeCtx(tui);
  const mask = createNativeTodoMask();
  mask.apply(ctx, true);
  assert.equal(mask.release(ctx), "shown");
  assert.deepEqual(todo.render(), ["native todo row"]);
  assert.equal(mask.release(ctx), "unchanged");
});
