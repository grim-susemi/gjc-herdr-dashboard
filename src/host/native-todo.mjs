// Hides the chat-side Todo panel of Gajae Code while the dashboard Todo pane is open.
//
// GJC draws its own Todo panel into `InteractiveMode.todoContainer`, a direct child of the TUI, and
// ships no setting or extension API to switch it off. The only handle an extension gets on the TUI is
// the first argument of a widget factory, so this module installs one zero-height widget purely to
// receive that `tui`, finds the native container, and silences its rendering for as long as the
// widget lives. Disposing the widget (dashboard closed, viewer dead, session shutdown, host teardown)
// restores the container exactly as it was.
//
// How the container is found: the TUI adds `... statusContainer, todoContainer, btwContainer,
// statusLine, hookWidgetContainerAbove ...` in that order, and the status rail is the only child that
// has `setPlanModeStatus`. The Todo container is therefore two children before the rail. If the shape
// is not exactly that (a different GJC build), nothing is hidden and the reason is kept in `state()`:
// a missing mask is a cosmetic loss, a wrongly silenced component is not.
//
// The silencing is two own properties (`render`, `renderWithViewportAnchors`) on that one container
// instance, followed by `invalidate()` so the TUI drops any cached frame. Restoring deletes the own
// properties, which re-exposes the prototype methods untouched.
//
// Exported signatures
//   WIDGET_KEY: 'gjc-herdr-dashboard-native-todo-mask'
//   locateNativeTodo(tui): Container | null
//   createNativeTodoMask(): { apply(ctx, wanted), release(ctx), state() }
//     apply returns 'hidden' | 'shown' | 'unavailable' | 'unchanged'; it never throws.

export const WIDGET_KEY = 'gjc-herdr-dashboard-native-todo-mask';

const isContainer = (value) => value !== null && typeof value === 'object'
  && Array.isArray(value.children) && typeof value.render === 'function'
  && typeof value.invalidate === 'function' && typeof value.detachAll === 'function';

export function locateNativeTodo(tui) {
  const children = Array.isArray(tui?.children) ? tui.children : null;
  if (children === null) return null;
  const rail = children.findIndex((child) => typeof child?.setPlanModeStatus === 'function');
  if (rail < 2) return null;
  const candidate = children[rail - 2];
  return isContainer(candidate) && isContainer(children[rail - 1]) ? candidate : null;
}

const emptyFrame = () => ({ lines: [], anchors: [] });

function silence(target) {
  Object.defineProperty(target, 'render', { value: () => [], configurable: true, writable: true });
  Object.defineProperty(target, 'renderWithViewportAnchors',
    { value: emptyFrame, configurable: true, writable: true });
  target.invalidate();
}

function restore(target) {
  delete target.render;
  delete target.renderWithViewportAnchors;
  target.invalidate();
}

export function createNativeTodoMask() {
  // The live widget, or null. `alive` is flipped by the widget's own dispose, so a host that tears
  // the widget down by itself (session switch, reload) is noticed on the next `apply`.
  let handle = null;
  let located = null;
  let lastFailure = null;

  function mounted() {
    if (handle !== null && !handle.alive) handle = null;
    return handle !== null;
  }

  function install(ui) {
    const factory = (tui) => {
      const target = locateNativeTodo(tui);
      const created = { alive: true, silenced: false };
      if (target === null) lastFailure = 'native-todo-not-found';
      else {
        try { silence(target); created.silenced = true; located = target; lastFailure = null; }
        catch (error) { lastFailure = error?.message ?? 'silence-failed'; }
      }
      handle = created;
      return {
        render: () => [],
        invalidate: () => {},
        dispose: () => {
          created.alive = false;
          if (created.silenced && target !== null) {
            try { restore(target); }
            catch (error) { lastFailure = error?.message ?? 'restore-failed'; }
            if (located === target) located = null;
          }
          try { tui?.requestRender?.(); } catch { /* the TUI is already gone: nothing left to repaint */ }
        },
      };
    };
    ui.setWidget(WIDGET_KEY, factory, { placement: 'belowEditor' });
  }

  function apply(ctx, wanted) {
    try {
      const ui = ctx?.hasUI === true ? ctx.ui : null;
      if (ui === null || typeof ui.setWidget !== 'function') return 'unavailable';
      if (wanted) {
        if (mounted()) return 'unchanged';
        install(ui);
        return handle !== null && handle.silenced ? 'hidden' : 'unavailable';
      }
      if (!mounted()) return 'unchanged';
      ui.setWidget(WIDGET_KEY, undefined);
      handle = null;
      return 'shown';
    } catch (error) {
      lastFailure = error?.message ?? 'apply-failed';
      return 'unavailable';
    }
  }

  const release = (ctx) => apply(ctx, false);

  const state = () => ({ hidden: mounted() && handle.silenced, failure: lastFailure });

  return { apply, release, state };
}
