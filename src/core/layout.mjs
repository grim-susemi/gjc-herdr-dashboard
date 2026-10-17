// The 2-role band layout (plan 7.8; decision F1 omits Progress, so the band is parent + Todo +
// Workers). This module is pure geometry: it never calls Herdr, never touches the filesystem and
// never waits for space (LT-5 forbids a waiting state) — it only decides what may be opened and
// whether an observed tab layout has the band shape.
//
// ADAPTED from `packages/dag/src/controller.mjs` (BAND_LAYOUT, bandSizes, childRects,
// isBandDashboard, freshBandRegion) of the pinned read-only copy; see PROVENANCE.md.
// MIT License, Copyright (c) 2026 omo-herdr-dashboard contributors.
//
// Fresh shape: the parent is split right once and keeps `chatShare` of the width on the left;
// Todo keeps the new right half, and Todo is then split down with ratio `todoHeight`, so Todo
// keeps 35% of the rows on top and Workers gets the row below at Todo's full width.
//
//   +-------------+-------------------+
//   |             |        Todo       |
//   |   parent    +-------------------+
//   |   (chat)    |      Workers      |
//   +-------------+-------------------+
//
// Rounding is Herdr's: `first child = round(fround(length * fround(ratio)))`. `childRects`
// returns [first, second], where the FIRST child is the original pane — so `right` puts the new
// pane on the right and `down` puts it below (measured against the L0 split evidence, which the
// Reconciler's `fake-herdr` fixture also encodes).
//
// Floors (BAND_LAYOUT): creating Workers needs Todo >= minTodoRows rows after the split, Workers
// >= minLowerRows rows and Workers >= minWorkersColumns columns; the Workers columns are the
// dashboard region width. A Todo-only band keeps the whole region height, so only its own row
// floor applies to it. `readable` is reporting only and is never a refusal reason.
//
// Ladder (plan 7.8): Todo + Workers -> Todo only -> nothing, reported by the caller as
// `partial:size`. `planBand` therefore returns `lowered` + `reason` instead of throwing, and
// `reason` is 'size' for every step of that ladder — including the terminal "nothing fits" step
// and the degenerate "the caller gave no measurable parent rect and no existing Todo" case.
// `planBand` answers the floor question only: it never invents the caller's `partial:no-anchor`
// (Workers without a Todo record) and never drops a pane that is already open.
// Shape (`isBandShape`) and foreign siblings (`foreignPanes`) stay separate predicates so the
// caller can tell `partial:size` from `partial:shape`; a pane this module does not own is never
// closed, moved, resized or renamed here (that is the caller's O+ rule).
//
// Exported signatures
//   BAND_LAYOUT                       frozen constants (the single place for the band numbers)
//   childRects(rect, direction, ratio) -> [first, second] child rects of a Herdr split
//   bandSizes({width,height})         -> {todoRows, lowerRows, workersColumns, fits, readable}
//   planBand({parentRect, roles, existing}) -> {roles, lowered, reason}
//                                        `roles` is always in the product's order (todo, workers)
//   isBandShape(layout, ids)          -> boolean (ids.workers optional: then parent + Todo only)
//   foreignPanes(layout, ids)         -> pane ids in the tab that are not ours, in layout order
// The fresh region is an internal step of `planBand` (the second child of the parent split at
// `chatShare`), not an export: nothing outside this module needs the intermediate rect.

export const BAND_LAYOUT = Object.freeze({
  chatShare: 0.5,
  todoHeight: 0.35,
  minTodoRows: 8,
  minLowerRows: 12,
  minWorkersColumns: 24,
  readableWorkersColumns: 40,
});

const KEYS = ['x', 'y', 'width', 'height'];
// A rect we can reason about: all four numbers finite and a non-empty area.
const isRect = (value) => Boolean(value) &&
  KEYS.every((key) => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;

// A Herdr split's two child rectangles, rounded like Herdr: the first child is the original pane
// and takes `round(fround(length * fround(ratio)))`, the second child takes the remainder. Only
// 'right' (horizontal) and 'down' (vertical) are used by this product.
export function childRects(rect, direction, ratio) {
  const axis = direction === 'right' ? 'width' : 'height';
  const coordinate = direction === 'right' ? 'x' : 'y';
  const size = Math.round(Math.fround(rect[axis] * Math.fround(ratio)));
  return [
    { ...rect, [axis]: size },
    { ...rect, [coordinate]: rect[coordinate] + size, [axis]: rect[axis] - size },
  ];
}

// The dashboard region of a fresh band: the second child of one right split at `chatShare`.
function freshBandRegion(parentRect) {
  return childRects(parentRect, 'right', BAND_LAYOUT.chatShare)[1];
}

// Cell sizes of the band inside a dashboard region. `fits` is the hard floor for opening Todo AND
// Workers; `readable` is reporting only and never a refusal reason.
export function bandSizes({ width, height } = {}) {
  const todoRows = Math.round(Math.fround(height * Math.fround(BAND_LAYOUT.todoHeight)));
  const lowerRows = height - todoRows;
  const workersColumns = width;
  return {
    todoRows,
    lowerRows,
    workersColumns,
    fits: workersColumns >= BAND_LAYOUT.minWorkersColumns &&
      todoRows >= BAND_LAYOUT.minTodoRows &&
      lowerRows >= BAND_LAYOUT.minLowerRows,
    readable: workersColumns >= BAND_LAYOUT.readableWorkersColumns,
  };
}

// Which roles a pass may open, given the parent pane and what is already open.
//
//   parentRect  the parent (chat) pane rect, the region a fresh band splits
//   roles       the roles the caller wants; only 'todo' and 'workers' exist in this layer
//   existing    {todo?, workers?} rects of records that are already open in this tab
//
// The floors are always measured on the rect the split will actually happen in: an existing Todo
// pane when there is one, otherwise the fresh region to the right of the parent. `roles` in the
// result is the subset of the REQUESTED roles this plan permits; a requested role that already has
// a pane is permitted and returned unchanged (this function never drops an open pane), and the
// caller tells "may open" from "already open" by its own `existing` map. A requested role that
// cannot be placed at all is left out, `lowered` becomes true and `reason` becomes 'size'.
export function planBand({ parentRect, roles = ['todo', 'workers'], existing = {} } = {}) {
  const requested = Array.isArray(roles) ? roles.filter((role) => role === 'todo' || role === 'workers') : [];
  const hasTodo = isRect(existing?.todo);
  const hasWorkers = isRect(existing?.workers);
  const anchor = hasTodo ? existing.todo : (isRect(parentRect) ? freshBandRegion(parentRect) : null);
  const fits = anchor ? bandSizes(anchor).fits : false;
  // Decide one role at a time in the product's role order, so the result keeps that order whatever
  // order the caller used. An open pane is always kept (this function never drops a pane); a pane
  // that has to be CREATED needs its floor: Todo its own row floor in the anchor, Workers the whole
  // floor of the rect the down-split will happen in.
  const todoAllowed = hasTodo || Boolean(anchor) && anchor.height >= BAND_LAYOUT.minTodoRows;
  const workersAllowed = hasWorkers || fits;
  const allowed = ['todo', 'workers'].filter((role) => requested.includes(role) &&
    (role === 'todo' ? todoAllowed : workersAllowed));
  const lowered = allowed.length < new Set(requested).size;
  return { roles: allowed, lowered, reason: lowered ? 'size' : null };
}

// Shape of the band inside a tab layout (`pane layout` output: {area, panes:[{pane_id, rect}]}).
// Ratios are irrelevant — only the geometry is checked. The tab must hold exactly our panes: any
// other pane in the layout is a foreign sibling, and the caller reports `partial:shape` for it.
// `ids.workers` may be omitted; the shape is then parent left, Todo right at full height.
export function isBandShape(layout, ids) {
  if (!layout || typeof layout !== 'object' || !Array.isArray(layout.panes)) return false;
  if (!ids || typeof ids !== 'object' || !isRect(layout.area)) return false;
  const names = ['parent', 'todo'];
  if (ids.workers !== undefined && ids.workers !== null) names.push('workers');
  if (!names.every((role) => typeof ids[role] === 'string' && ids[role] !== '')) return false;
  if (new Set(names.map((role) => ids[role])).size !== names.length) return false;
  // Exactly our panes: any other pane in the tab is a foreign sibling (the caller's partial:shape).
  const owned = new Set(names.map((role) => ids[role]));
  if (layout.panes.some((pane) => !owned.has(pane?.pane_id))) return false;

  const rects = {};
  for (const role of names) {
    const matches = layout.panes.filter((pane) => pane?.pane_id === ids[role]);
    if (matches.length !== 1 || !isRect(matches[0].rect)) return false;
    rects[role] = matches[0].rect;
  }

  const { parent, todo, workers } = rects;
  const { area } = layout;
  if (parent.x !== area.x || parent.y !== area.y || parent.height !== area.height) return false;
  if (todo.x !== parent.x + parent.width || todo.y !== area.y) return false;
  if (todo.x + todo.width !== area.x + area.width) return false;
  if (!workers) return todo.height === area.height;
  return workers.x === todo.x && workers.width === todo.width &&
    workers.y === todo.y + todo.height && todo.height + workers.height === area.height;
}

// Pane ids in the tab that are not ours, in layout order; used for the `partial:shape` reason and
// never as a licence to touch them. Without usable ids nothing is provably ours, so every pane in
// the layout is reported (fail closed: the caller then treats the tab as a foreign shape).
export function foreignPanes(layout, ids) {
  if (!layout || !Array.isArray(layout.panes)) return [];
  const usable = ids && typeof ids === 'object' ? ids : {};
  const owned = new Set(Object.values(usable).filter((id) => typeof id === 'string' && id !== ''));
  const foreign = [];
  for (const pane of layout.panes) {
    const id = pane?.pane_id;
    if (typeof id === 'string' && id !== '' && !owned.has(id) && !foreign.includes(id)) foreign.push(id);
  }
  return foreign;
}
