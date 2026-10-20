// Unit tests for the 2-role band layout (plan 7.8). The module under test is pure geometry, so
// every case here is a rect arithmetic assertion plus the two shape predicates; nothing touches
// Herdr, the filesystem or the clock.
//
// The numeric expectations are written out by hand (not recomputed with the module's own
// helpers) so that a wrong ratio, a wrong rounding rule or a swapped child order fails the test.
// The rounding path is Herdr's `round(fround(length * fround(ratio)))`: 90 rows at ratio 0.35 gives
// 32 first-child rows, where a plain double `round(90 * 0.35)` would give 31.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAND_LAYOUT,
  bandSizes,
  childRects,
  foreignPanes,
  isBandShape,
  planBand,
} from '../../src/core/layout.mjs';

const IDS = { parent: 'pane-parent', todo: 'pane-todo', workers: 'pane-workers' };
const ROLES = Object.keys(IDS);
const KEYS = ['x', 'y', 'width', 'height'];

const rect = ([x, y, width, height]) => ({ x, y, width, height });
const paneOf = (layout, role) => layout.panes.find((pane) => pane.pane_id === IDS[role]);
// A whole tab of `width` x `height` columns holding the fresh band. `parentRect` is the pane the
// band splits — here the parent pane owns the whole tab before the band exists — so the parent
// keeps the left `chatShare` (2/3) and Todo + Workers take the right third (the module's internal
// `freshBandRegion`). Exact numbers are hand-asserted in 'fresh 2-role band geometry matches
// Herdr rounding at 200x50 and 120x40'.
function tabOf([width, height], ids = IDS, roles = ROLES) {
  const area = rect([0, 0, width, height]);
  const [parent, region] = childRects(area, 'right', BAND_LAYOUT.chatShare);
  const [todo, workers] = childRects(region, 'down', BAND_LAYOUT.todoHeight);
  const rectOf = { parent, todo, workers };
  return { area, panes: roles.map((role) => ({ pane_id: ids[role], rect: rectOf[role] })) };
}

test('BAND_LAYOUT carries the contract values and is frozen', () => {
  assert.deepEqual(BAND_LAYOUT, {
    chatShare: 2 / 3,
    todoHeight: 0.35,
    minTodoRows: 8,
    minLowerRows: 12,
    minWorkersColumns: 24,
    readableWorkersColumns: 40,
  });
  assert.equal(Object.isFrozen(BAND_LAYOUT), true);
});

test('childRects rounds a Herdr split as round(fround(length * fround(ratio)))', () => {
  // 90 rows at 0.35: the float32 product is exactly 31.5, so Herdr's first child is 32 rows. A
  // plain double would compute 90 * 0.35 = 31.499999999999996 and round to 31.
  assert.deepEqual(childRects(rect([0, 0, 80, 90]), 'down', 0.35), [
    { x: 0, y: 0, width: 80, height: 32 },
    { x: 0, y: 32, width: 80, height: 58 },
  ]);
  // 'right': the first child keeps the left part, the second child starts at its right edge.
  assert.deepEqual(childRects(rect([10, 5, 200, 50]), 'right', 0.5), [
    { x: 10, y: 5, width: 100, height: 50 },
    { x: 110, y: 5, width: 100, height: 50 },
  ]);
  // The product's chatShare 2/3 at the same width: parent 133, dashboard 67.
  assert.deepEqual(childRects(rect([10, 5, 200, 50]), 'right', BAND_LAYOUT.chatShare), [
    { x: 10, y: 5, width: 133, height: 50 },
    { x: 143, y: 5, width: 67, height: 50 },
  ]);
  // 79 columns at 0.5 rounds down to 40/39 in float32.
  assert.deepEqual(childRects(rect([0, 0, 79, 4]), 'right', 0.5), [
    { x: 0, y: 0, width: 40, height: 4 },
    { x: 40, y: 0, width: 39, height: 4 },
  ]);
  // At chatShare 2/3 the same 79 columns give 53/26, so the dashboard stays about one third.
  assert.deepEqual(childRects(rect([0, 0, 79, 4]), 'right', BAND_LAYOUT.chatShare), [
    { x: 0, y: 0, width: 53, height: 4 },
    { x: 53, y: 0, width: 26, height: 4 },
  ]);
});

test('childRects children tile the whole rect and leave no gap', () => {
  for (const direction of ['right', 'down']) {
    for (const ratio of [0, 0.1, 0.35, 0.5, 0.99, 1]) {
      for (const length of [1, 2, 7, 23, 24, 40, 46, 47, 120, 200]) {
        const base = direction === 'right' ? rect([3, 4, length, 9]) : rect([3, 4, 9, length]);
        const [first, second] = childRects(base, direction, ratio);
        const axis = direction === 'right' ? 'width' : 'height';
        const coordinate = direction === 'right' ? 'x' : 'y';
        assert.equal(first[axis] + second[axis], base[axis], `${direction} ${ratio} ${length}`);
        assert.equal(second[coordinate], base[coordinate] + first[axis], `${direction} ${ratio} ${length}`);
        assert.equal(first[coordinate], base[coordinate]);
        assert.ok(first[axis] >= 0 && second[axis] >= 0, `${direction} ${ratio} ${length} non-negative`);
      }
    }
  }
});

test('childRects reproduces the recorded live pane split at 120x40', () => {
  // `.evidence/L0/lv1-layout.json` (live `herdr pane layout` at a 120x40 tab, right split at 0.5)
  // recorded area {0,0,120,40} with panes p1 {0,0,60,40} and p2 {60,0,60,40}. Inlined here so the
  // test stays self-contained: the module's first/second children must reproduce those exact cells.
  const measured = { area: rect([0, 0, 120, 40]), panes: { first: rect([0, 0, 60, 40]), second: rect([60, 0, 60, 40]) } };
  assert.deepEqual(childRects(measured.area, 'right', 0.5), [measured.panes.first, measured.panes.second]);
});

test('the fresh region is the right third of the parent at chatShare, floors measured on it', () => {
  // 200 columns: the parent keeps 133, the fresh region is 67 columns at the parent's full height.
  // 79 columns split 53/26 — a 26-column region is above the 24-column hard floor.
  const cases = [[[0, 0, 200, 50], [133, 0, 67, 50]], [[0, 0, 120, 40], [80, 0, 40, 40]],
    [[0, 0, 79, 24], [53, 0, 26, 24]], [[5, 3, 48, 50], [37, 3, 16, 50]]];
  for (const [input, expected] of cases) {
    const [, region] = childRects(rect(input), 'right', BAND_LAYOUT.chatShare);
    assert.deepEqual(region, rect(expected), input.join(','));
  }
  // The floors are measured on that region: 71 parent columns leave exactly 24 dashboard columns,
  // which is the minimum, and 70 leave 23, which lowers the band to Todo only.
  assert.equal(bandSizes(childRects(rect([0, 0, 71, 50]), 'right', BAND_LAYOUT.chatShare)[1]).fits, true);
  assert.equal(bandSizes(childRects(rect([0, 0, 70, 50]), 'right', BAND_LAYOUT.chatShare)[1]).fits, false);
});

test('the dashboard region is one third of the window at 120, 160 and 240 columns', () => {
  // Exact float32/Herdr cells for chatShare 2/3. 120 and 240 are exact thirds; 160 rounds the
  // parent to 107 and leaves 53, which is within one cell of 160/3 and within 1/160 of 1/3.
  for (const [width, parentWidth, dashboardWidth] of [[120, 80, 40], [160, 107, 53],
    [240, 160, 80]]) {
    const [parent, region] = childRects(rect([0, 0, width, 40]), 'right', BAND_LAYOUT.chatShare);
    assert.equal(parent.width, parentWidth, `${width}: parent`);
    assert.equal(region.width, dashboardWidth, `${width}: dashboard`);
    assert.ok(Math.abs(region.width / width - 1 / 3) <= 1 / width,
      `${width}: dashboard is within one cell of one third`);
  }
});

test('bandSizes reports the split of the dashboard region, with the floors and readability', () => {
  assert.deepEqual(bandSizes({ width: 100, height: 50 }), {
    todoRows: 18, lowerRows: 32, workersColumns: 100, fits: true, readable: true,
  });
  assert.deepEqual(bandSizes({ width: 60, height: 40 }), {
    todoRows: 14, lowerRows: 26, workersColumns: 60, fits: true, readable: true,
  });
  // Minimum width: 24 columns fit, 23 do not; 40 columns are the readability threshold.
  assert.deepEqual(bandSizes({ width: 24, height: 50 }), {
    todoRows: 18, lowerRows: 32, workersColumns: 24, fits: true, readable: false,
  });
  assert.deepEqual(bandSizes({ width: 23, height: 50 }), {
    todoRows: 18, lowerRows: 32, workersColumns: 23, fits: false, readable: false,
  });
  assert.deepEqual(bandSizes({ width: 39, height: 50 }), {
    todoRows: 18, lowerRows: 32, workersColumns: 39, fits: true, readable: false,
  });
  assert.deepEqual(bandSizes({ width: 40, height: 50 }), {
    todoRows: 18, lowerRows: 32, workersColumns: 40, fits: true, readable: true,
  });
  // 90 rows at 0.35 is 32 Todo rows in Herdr's float32 rounding (the float32 product lands exactly
  // on 31.5), where the naive double rule `round(90 * 0.35)` would give 31.
  assert.deepEqual(bandSizes({ width: 100, height: 90 }), {
    todoRows: 32, lowerRows: 58, workersColumns: 100, fits: true, readable: true,
  });
});

test('bandSizes fits only when all three floors pass, and readability is reporting only', () => {
  let probes = 0;
  for (const width of [23, 24, 30, 39, 40, 80, 200]) {
    for (let height = 6; height <= 30; height++) {
      const sizes = bandSizes({ width, height });
      const fits = width >= BAND_LAYOUT.minWorkersColumns &&
        sizes.todoRows >= BAND_LAYOUT.minTodoRows && sizes.lowerRows >= BAND_LAYOUT.minLowerRows;
      assert.equal(sizes.fits, fits, `${width}x${height}`);
      assert.equal(sizes.readable, width >= BAND_LAYOUT.readableWorkersColumns, `${width}x${height}`);
      assert.equal(sizes.workersColumns, width, `${width}x${height}`);
      assert.equal(sizes.todoRows + sizes.lowerRows, height, `${width}x${height}`);
      probes++;
    }
  }
  assert.equal(probes, 7 * 25);
  // A 22-row region is the smallest one that satisfies the Todo and lower floors; 21 rows fail
  // on the Todo row floor, and 17 rows also drop the lower row below its floor.
  assert.equal(bandSizes({ width: 100, height: 22 }).fits, true);
  assert.equal(bandSizes({ width: 100, height: 21 }).fits, false);
  assert.equal(bandSizes({ width: 100, height: 21 }).lowerRows >= BAND_LAYOUT.minLowerRows, true);
  assert.equal(bandSizes({ width: 100, height: 17 }).lowerRows, 11);
});

test('bandSizes does not throw on a missing or malformed region', () => {
  for (const input of [{}, { width: undefined, height: undefined }, { width: 'x', height: null }]) {
    const sizes = bandSizes(input);
    assert.equal(sizes.fits, false);
    assert.equal(sizes.readable, false);
  }
  assert.equal(bandSizes().fits, false);
  assert.equal(bandSizes().todoRows, NaN);
});

test('the lower-row floor cannot bind alone at this ratio, but bandSizes still enforces it', () => {
  // At todoHeight 0.35 with minTodoRows 8, `todoRows >= 8` already implies `lowerRows >= 14 > 12`
  // (the first region height whose Todo row reaches 8 rows is 22, which leaves 14). So the ladder
  // never lowers because of the lower row alone; the constant is still part of `fits` and would
  // bind if the ratio changed, which is why it stays. This test states that honestly instead of
  // claiming a reachable branch.
  let binding = 0;
  for (let height = 1; height <= 200; height++) {
    const sizes = bandSizes({ width: 100, height });
    if (sizes.todoRows >= BAND_LAYOUT.minTodoRows) {
      assert.ok(sizes.lowerRows >= BAND_LAYOUT.minLowerRows, `height ${height}`);
      binding++;
    }
  }
  assert.equal(binding, 179, 'heights 22..200 pass the Todo row floor');
  assert.equal(bandSizes({ width: 100, height: 22 }).fits, true, 'the first height that fits');
  assert.equal(bandSizes({ width: 100, height: 21 }).fits, false, 'one row less does not');
});

test('fresh 2-role band geometry matches Herdr rounding at 200x50 and 120x40', () => {
  // parent keeps round(200 * 2/3) = 133 columns; Todo takes round(50 * 0.35) = 18 of the 50 rows.
  assert.deepEqual(tabOf([200, 50]).panes, [
    { pane_id: IDS.parent, rect: { x: 0, y: 0, width: 133, height: 50 } },
    { pane_id: IDS.todo, rect: { x: 133, y: 0, width: 67, height: 18 } },
    { pane_id: IDS.workers, rect: { x: 133, y: 18, width: 67, height: 32 } },
  ]);
  assert.deepEqual(tabOf([120, 40]).panes, [
    { pane_id: IDS.parent, rect: { x: 0, y: 0, width: 80, height: 40 } },
    { pane_id: IDS.todo, rect: { x: 80, y: 0, width: 40, height: 14 } },
    { pane_id: IDS.workers, rect: { x: 80, y: 14, width: 40, height: 26 } },
  ]);
  // The fresh region is the right-hand region of that first split, and the floors are measured on
  // exactly that region.
  for (const size of [[200, 50], [120, 40], [100, 30]]) {
    const area = rect([0, 0, size[0], size[1]]);
    const region = childRects(area, 'right', BAND_LAYOUT.chatShare)[1];
    const [todo, workers] = childRects(region, 'down', BAND_LAYOUT.todoHeight);
    const sizes = bandSizes(region);
    assert.equal(todo.height, sizes.todoRows, size.join('x'));
    assert.equal(workers.height, sizes.lowerRows, size.join('x'));
    assert.equal(workers.width, sizes.workersColumns, size.join('x'));
  }
});

test('planBand allows Todo and Workers on a fresh band that fits', () => {
  for (const parent of [rect([0, 0, 200, 50]), rect([0, 0, 120, 40]), rect([0, 0, 100, 30])]) {
    assert.deepEqual(planBand({ parentRect: parent, roles: ['todo', 'workers'], existing: {} }),
      { roles: ['todo', 'workers'], lowered: false, reason: null }, `${parent.width}x${parent.height}`);
  }
  // The parent's origin does not change the floors: only the region's width and height matter.
  assert.deepEqual(planBand({ parentRect: rect([100, 10, 200, 50]), roles: ['todo', 'workers'] }),
    { roles: ['todo', 'workers'], lowered: false, reason: null });
  // 71 columns is exactly the minimum parent width: the fresh region is 24 columns, which fits
  // (readable false) and is still allowed.
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 71, 50]), roles: ['todo', 'workers'] }),
    { roles: ['todo', 'workers'], lowered: false, reason: null });
});

test('planBand lowers to Todo only when the region fails a floor, and to nothing when tiny', () => {
  // 70 parent columns leave 23 dashboard columns, below the 24-column floor: nothing for Workers.
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 70, 50]), roles: ['todo', 'workers'] }),
    { roles: ['todo'], lowered: true, reason: 'size' });
  // 20 parent rows leave round(20 * 0.35) = 7 Todo rows, below the 8-row floor: Todo keeps the
  // whole 20-row region (its own row floor passes), Workers is dropped.
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 20]), roles: ['todo', 'workers'] }),
    { roles: ['todo'], lowered: true, reason: 'size' });
  // A tiny terminal cannot even host Todo (7 rows in the whole region).
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 7]), roles: ['todo', 'workers'] }),
    { roles: [], lowered: true, reason: 'size' });
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 10, 4]), roles: ['todo', 'workers'] }),
    { roles: [], lowered: true, reason: 'size' });
  // No measurable parent rect and no existing Todo: nothing to place, still reported as size.
  assert.deepEqual(planBand({ parentRect: null, roles: ['todo', 'workers'] }),
    { roles: [], lowered: true, reason: 'size' });
  assert.equal(bandSizes(childRects(rect([0, 0, 70, 50]), 'right', BAND_LAYOUT.chatShare)[1]).fits, false);
});

test('planBand floors an existing Todo band on the Todo rect itself', () => {
  // Todo already open at 40 rows: round(40 * 0.35) = 14 Todo rows and 26 Workers rows fit.
  assert.deepEqual(planBand({
    parentRect: rect([0, 0, 200, 50]), roles: ['workers'], existing: { todo: rect([100, 0, 100, 40]) },
  }), { roles: ['workers'], lowered: false, reason: null });
  // The same open Todo at 20 rows yields 7 Todo rows: below the floor, so Workers is refused.
  assert.deepEqual(planBand({
    parentRect: rect([0, 0, 200, 50]), roles: ['workers'], existing: { todo: rect([100, 0, 100, 20]) },
  }), { roles: [], lowered: true, reason: 'size' });
  // 21 rows: 7 Todo rows after the split, still below the floor; Todo itself is already open, so
  // the ladder's remaining rung keeps it and drops Workers only.
  assert.deepEqual(planBand({
    parentRect: rect([0, 0, 200, 50]), roles: ['todo', 'workers'], existing: { todo: rect([100, 0, 100, 21]) },
  }), { roles: ['todo'], lowered: true, reason: 'size' });
  // The same Todo rect at the 22-row boundary fits: 8 Todo rows and 14 lower rows.
  assert.deepEqual(planBand({
    parentRect: rect([0, 0, 200, 50]), roles: ['todo', 'workers'], existing: { todo: rect([100, 0, 100, 22]) },
  }), { roles: ['todo', 'workers'], lowered: false, reason: null });
  // An existing Todo anchors the plan even when the caller passes no parent rect.
  assert.deepEqual(planBand({ roles: ['workers'], existing: { todo: rect([100, 0, 100, 30]) } }),
    { roles: ['workers'], lowered: false, reason: null });
  // The contract's existing-Todo sentence says to check "the floors" against the Todo pane's own
  // rect. Read as all three floors, the Workers columns floor is the Todo rect's width, which is
  // the width a down split would give Workers. A Todo narrower than 24 columns therefore refuses
  // Workers even when its rows would fit; this is the strict reading, pinned here on purpose.
  assert.deepEqual(planBand({ roles: ['workers'], existing: { todo: rect([100, 0, 23, 40]) } }),
    { roles: [], lowered: true, reason: 'size' });
  assert.deepEqual(planBand({ roles: ['workers'], existing: { todo: rect([100, 0, 24, 40]) } }),
    { roles: ['workers'], lowered: false, reason: null });
  // A Todo rect too small to be a region at all is not an anchor: the fresh region decides.
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 50]), roles: ['workers'], existing: { todo: rect([0, 0, 0, 0]) } }),
    { roles: ['workers'], lowered: false, reason: null });
  // Boundary pinned on purpose: `planBand` answers the FLOOR question only. A Workers-only plan is
  // measured against the region the split will happen in (an existing Todo, else the fresh region
  // right of the parent), so it can report `lowered: false` for a slot whose Workers row must still
  // report `partial:no-anchor` because no live Todo record exists (contract, Roles/ordering).
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 50]), roles: ['workers'] }),
    { roles: ['workers'], lowered: false, reason: null });
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 70, 50]), roles: ['workers'] }),
    { roles: [], lowered: true, reason: 'size' });
  // The result always follows the product's role order (Todo then Workers) and counts a role the
  // caller named twice only once.
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 50]), roles: ['workers', 'todo'] }),
    { roles: ['todo', 'workers'], lowered: false, reason: null });
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 50]), roles: ['todo', 'todo', 'workers', 'workers'] }),
    { roles: ['todo', 'workers'], lowered: false, reason: null });
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 50]), roles: ['todo', 'todo'] }),
    { roles: ['todo'], lowered: false, reason: null });
});

test('planBand keeps open panes and ignores roles this layer does not have', () => {
  // Both panes already open: the plan never drops them, whatever their size.
  assert.deepEqual(planBand({
    parentRect: rect([0, 0, 200, 50]),
    roles: ['todo', 'workers'],
    existing: { todo: rect([100, 0, 100, 4]), workers: rect([100, 4, 100, 3]) },
  }), { roles: ['todo', 'workers'], lowered: false, reason: null });
  // Progress is not a role in this layer (decision F1): it is neither planned nor reported lost.
  assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 50]), roles: ['todo', 'progress'] }),
    { roles: ['todo'], lowered: false, reason: null });
  for (const roles of [[], 'todo', null]) {
    assert.deepEqual(planBand({ parentRect: rect([0, 0, 200, 50]), roles }),
      { roles: [], lowered: false, reason: null }, JSON.stringify(roles));
  }
  // No roles argument means the two roles of this layer (the module default), so an unusable or
  // absent region reports the size ladder for both of them.
  assert.deepEqual(planBand({}), { roles: [], lowered: true, reason: 'size' });
  assert.deepEqual(planBand(), { roles: [], lowered: true, reason: 'size' });
  assert.deepEqual(planBand({ parentRect: null }), { roles: [], lowered: true, reason: 'size' });
});

test('isBandShape accepts the fresh band at typical sizes, with and without Workers', () => {
  // The literal hand-computed 200x50 band, independent of the module's own arithmetic.
  assert.equal(isBandShape({ area: rect([0, 0, 200, 50]), panes: [
    { pane_id: IDS.parent, rect: { x: 0, y: 0, width: 133, height: 50 } },
    { pane_id: IDS.todo, rect: { x: 133, y: 0, width: 67, height: 18 } },
    { pane_id: IDS.workers, rect: { x: 133, y: 18, width: 67, height: 32 } },
  ] }, IDS), true);
  for (const size of [[200, 50], [120, 40], [100, 30]]) {
    assert.equal(isBandShape(tabOf(size), IDS), true, size.join('x'));
  }
  // Workers is optional: parent left, Todo right at the full height.
  const todoOnly = { area: rect([0, 0, 200, 50]), panes: [
    { pane_id: IDS.parent, rect: { x: 0, y: 0, width: 133, height: 50 } },
    { pane_id: IDS.todo, rect: { x: 133, y: 0, width: 67, height: 50 } },
  ] };
  assert.equal(isBandShape(todoOnly, { parent: IDS.parent, todo: IDS.todo }), true);
  assert.equal(isBandShape(todoOnly, { parent: IDS.parent, todo: IDS.todo, workers: undefined }), true);
  assert.equal(isBandShape(todoOnly, IDS), false, 'ids name a Workers pane the layout does not have');
  // Shape only: ratios and pane order are irrelevant, and a band that does not start at the tab
  // origin is accepted as long as the parent sits at the area origin.
  assert.equal(isBandShape({ ...tabOf([200, 50]), splits: [{ direction: 'right', ratio: 0.9 }] }, IDS), true);
  const reversed = tabOf([200, 50]);
  reversed.panes.reverse();
  assert.equal(isBandShape(reversed, IDS), true, 'pane order does not matter');
  const shifted = { area: rect([20, 10, 200, 50]), panes: [
    { pane_id: IDS.parent, rect: { x: 20, y: 10, width: 133, height: 50 } },
    { pane_id: IDS.todo, rect: { x: 153, y: 10, width: 67, height: 18 } },
    { pane_id: IDS.workers, rect: { x: 153, y: 28, width: 67, height: 32 } },
  ] };
  assert.equal(isBandShape(shifted, IDS), true, 'a band inside an offset tab area');
  const wrongOrigin = tabOf([200, 50]);
  wrongOrigin.area.x = 1;
  assert.equal(isBandShape(wrongOrigin, IDS), false, 'parent not at the area origin');
});

test('isBandShape rejects any role shifted by one cell in any dimension', () => {
  let probes = 0;
  for (const size of [[200, 50], [120, 40]]) {
    for (const role of ROLES) {
      for (const key of KEYS) {
        for (const delta of [-1, 1]) {
          const layout = tabOf(size);
          paneOf(layout, role).rect[key] += delta;
          assert.equal(isBandShape(layout, IDS), false, `${size.join('x')} ${role}.${key}${delta > 0 ? '+1' : '-1'}`);
          probes++;
        }
      }
      for (const key of KEYS) {
        const missing = tabOf(size);
        delete paneOf(missing, role).rect[key];
        assert.equal(isBandShape(missing, IDS), false, `${size.join('x')} ${role}.${key} missing`);
      }
      probes += KEYS.length;
    }
  }
  assert.equal(probes, 2 * 3 * 4 * 2 + 2 * 3 * 4);
});

test('isBandShape rejects flipped layouts and foreign siblings', () => {
  const spec = rect([0, 0, 200, 50]);
  const flippedVertical = { area: spec, panes: [
    { pane_id: IDS.parent, rect: { x: 0, y: 0, width: 133, height: 50 } },
    { pane_id: IDS.workers, rect: { x: 133, y: 0, width: 67, height: 32 } },
    { pane_id: IDS.todo, rect: { x: 133, y: 32, width: 67, height: 18 } },
  ] };
  assert.equal(isBandShape(flippedVertical, IDS), false, 'Workers above Todo');
  // The old columns shape: Workers to the right of Todo instead of below it.
  const flippedHorizontal = { area: spec, panes: [
    { pane_id: IDS.parent, rect: { x: 0, y: 0, width: 133, height: 50 } },
    { pane_id: IDS.todo, rect: { x: 133, y: 0, width: 34, height: 50 } },
    { pane_id: IDS.workers, rect: { x: 167, y: 0, width: 33, height: 50 } },
  ] };
  assert.equal(isBandShape(flippedHorizontal, IDS), false, 'Workers beside Todo');
  const parentRight = { area: spec, panes: [
    { pane_id: IDS.parent, rect: { x: 67, y: 0, width: 133, height: 50 } },
    { pane_id: IDS.todo, rect: { x: 0, y: 0, width: 67, height: 18 } },
    { pane_id: IDS.workers, rect: { x: 0, y: 18, width: 67, height: 32 } },
  ] };
  assert.equal(isBandShape(parentRight, IDS), false, 'parent on the right');
  const parentShort = tabOf([200, 50]);
  paneOf(parentShort, 'parent').rect.height = 49;
  assert.equal(isBandShape(parentShort, IDS), false, 'parent shorter than the area');
  // Workers narrower than Todo, or not starting at Todo's left edge, breaks the band.
  const workersNarrow = tabOf([200, 50]);
  paneOf(workersNarrow, 'workers').rect.width = 66;
  assert.equal(isBandShape(workersNarrow, IDS), false, 'Workers narrower than Todo');
  const workersGap = tabOf([200, 50]);
  paneOf(workersGap, 'workers').rect.x = 134;
  assert.equal(isBandShape(workersGap, IDS), false, 'Workers not aligned with Todo');
  const todoShort = tabOf([200, 50]);
  paneOf(todoShort, 'todo').rect.width = 66;
  assert.equal(isBandShape(todoShort, IDS), false, 'Todo does not reach the area edge');
  const heightsGap = tabOf([200, 50]);
  paneOf(heightsGap, 'workers').rect.height = 31;
  assert.equal(isBandShape(heightsGap, IDS), false, 'Todo + Workers rows do not fill the area');

  // A foreign sibling, extra or in place of one of our panes, is never a band shape.
  const extra = tabOf([200, 50]);
  extra.panes.push({ pane_id: 'foreign', rect: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(isBandShape(extra, IDS), false, 'extra pane');
  const replaced = tabOf([200, 50]);
  paneOf(replaced, 'workers').pane_id = 'foreign';
  assert.equal(isBandShape(replaced, IDS), false, 'a foreign pane in place of Workers');
  const duplicated = tabOf([200, 50]);
  duplicated.panes.push({ pane_id: IDS.workers, rect: { x: 133, y: 18, width: 67, height: 32 } });
  assert.equal(isBandShape(duplicated, IDS), false, 'our pane twice');
});

test('isBandShape rejects malformed input and duplicate ids without throwing', () => {
  const spec = tabOf([200, 50]);
  for (const layout of [undefined, null, {}, { area: spec.area }, { panes: [] }, { area: null, panes: spec.panes },
    { area: spec.area, panes: 'nope' }, { area: spec.area, panes: [null, null, null] }]) {
    assert.equal(isBandShape(layout, IDS), false, JSON.stringify(layout));
  }
  for (const ids of [undefined, null, {}, { parent: IDS.parent }, { ...IDS, todo: undefined },
    { ...IDS, workers: '' }, { ...IDS, parent: IDS.todo }, { parent: 1, todo: 2, workers: 3 }]) {
    assert.equal(isBandShape(spec, ids), false, JSON.stringify(ids));
  }
  const bad = [NaN, -1, 0, Infinity, '100', null, undefined];
  for (const role of ROLES) {
    for (const key of KEYS) {
      for (const value of bad) {
        if (value === 0 && (key === 'x' || key === 'y')) continue; // 0 is a valid origin
        const layout = tabOf([200, 50]);
        paneOf(layout, role).rect[key] = value;
        assert.equal(isBandShape(layout, IDS), false, `${role}.${key}=${String(value)}`);
      }
      const missing = tabOf([200, 50]);
      delete paneOf(missing, role).rect[key];
      assert.equal(isBandShape(missing, IDS), false, `${role}.${key} missing`);
    }
    const noRect = tabOf([200, 50]);
    delete paneOf(noRect, role).rect;
    assert.equal(isBandShape(noRect, IDS), false, `${role} without rect`);
  }
  for (const key of KEYS) {
    const layout = tabOf([200, 50]);
    layout.area[key] = NaN;
    assert.equal(isBandShape(layout, IDS), false, `area.${key}=NaN`);
  }
  const negativeArea = tabOf([200, 50]);
  negativeArea.area.width = -200;
  assert.equal(isBandShape(negativeArea, IDS), false, 'negative area');
});

test('isBandShape, planBand and foreignPanes do not mutate their inputs', () => {
  const layout = tabOf([200, 50]);
  const ids = { ...IDS };
  const layoutBefore = structuredClone(layout);
  const idsBefore = structuredClone(ids);
  const input = { parentRect: rect([0, 0, 200, 50]), roles: ['todo', 'workers'], existing: { todo: rect([100, 0, 100, 40]) } };
  const inputBefore = structuredClone(input);
  assert.equal(isBandShape(layout, ids), true);
  foreignPanes(layout, ids);
  planBand(input);
  assert.deepEqual(layout, layoutBefore);
  assert.deepEqual(ids, idsBefore);
  assert.deepEqual(input, inputBefore);
});

test('foreignPanes lists the panes we do not own, in layout order', () => {
  const layout = {
    area: rect([0, 0, 200, 50]),
    panes: [
      { pane_id: IDS.parent, rect: rect([0, 0, 100, 50]) },
      { pane_id: 'other-a', rect: rect([0, 0, 10, 10]) },
      { pane_id: IDS.todo, rect: rect([100, 0, 100, 18]) },
      { pane_id: 'other-b', rect: rect([0, 0, 10, 10]) },
      { pane_id: IDS.workers, rect: rect([100, 18, 100, 32]) },
    ],
  };
  assert.deepEqual(foreignPanes(layout, IDS), ['other-a', 'other-b']);
  assert.deepEqual(foreignPanes(layout, { parent: IDS.parent, todo: IDS.todo }), ['other-a', 'other-b', IDS.workers]);
  assert.deepEqual(foreignPanes(tabOf([200, 50]), IDS), []);
  // A pane listed twice is reported once; ids that are not in the layout add nothing.
  const duplicated = { area: layout.area, panes: [...layout.panes, { pane_id: 'other-a', rect: rect([0, 0, 1, 1]) }] };
  assert.deepEqual(foreignPanes(duplicated, IDS), ['other-a', 'other-b']);
  // An id that is not in the layout shields nothing: the real pane is still foreign. Extra ids
  // that match no pane add nothing.
  assert.deepEqual(foreignPanes(layout, { parent: IDS.parent, todo: 'gone', workers: IDS.workers }),
    ['other-a', IDS.todo, 'other-b']);
  assert.deepEqual(foreignPanes(layout, { ...IDS, progress: 'gone' }), ['other-a', 'other-b']);
});

test('foreignPanes tolerates malformed layouts and entries without throwing', () => {
  for (const layout of [undefined, null, {}, { panes: null }, { panes: 'x' }, { panes: [null, {}, { pane_id: '' }] }]) {
    const foreign = foreignPanes(layout, IDS);
    assert.equal(Array.isArray(foreign), true);
    assert.equal(foreign.filter((id) => !['other-a', 'other-b'].includes(id)).length, 0, JSON.stringify(layout));
  }
  assert.deepEqual(foreignPanes({ panes: [{ pane_id: 'a' }, { pane_id: 'b' }] }, undefined), ['a', 'b']);
  assert.deepEqual(foreignPanes({ panes: [null] }, null), []);
});
