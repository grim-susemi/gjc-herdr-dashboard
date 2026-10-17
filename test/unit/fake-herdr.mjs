// Deterministic fakes shared by the L1 lifecycle tests: a stateful Herdr pane table, a fake
// clock, and a fake process table. Nothing here touches a real Herdr, a real clock or a real
// process; the only real resource is a temporary state directory created by the caller.
//
// The pane table models exactly what the product reads (L0 G6/G7 measured shapes):
//   pane list          -> { panes:[{pane_id, tab_id, focused, label}] }
//   pane layout        -> { layout:{ tab_id, focused_pane_id, area, panes:[{pane_id, rect}] } }
//   pane process-info  -> { process_info:{ pane_id, shell_pid } }
//   pane split         -> { pane:{ pane_id, tab_id }, type:'pane_info' }
//   pane rename/run/close/focus -> {}
// `send-text`, `send-keys` and every other verb are unimplemented and throw `unknown_command`
// AFTER being recorded, so a test can prove the count is zero (LT-8) rather than trusting a scan.
//
// The fake records every call in `calls` ({seq, argv}) so the tests can assert ordering, counts
// and — with the tracer below — the exact verb set an automatic pass used (A-32).

export function createFakeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance(ms) { current += ms; return current; },
    set(ms) { current = ms; return current; },
  };
}

// `alive` is the set of live pids. A pid absent from the set answers `false` (ESRCH); a pid in
// `unknown` answers `null` (liveness unavailable, R1's fail-closed case).
export function createFakeProcesses({ alive = [], unknown = [] } = {}) {
  const live = new Set(alive);
  const unknowable = new Set(unknown);
  return {
    alive: pid => (unknowable.has(pid) ? null : live.has(pid)),
    add(pid) { live.add(pid); },
    kill(pid) { live.delete(pid); },
    freeze(pid) { live.delete(pid); unknowable.add(pid); },
  };
}

const fail = (code, message) => Object.assign(new Error(message ?? code), { code });

export function createFakeHerdr(options = {}) {
  const tabId = options.tabId ?? 'w1:t1';
  const workspaceId = options.workspaceId ?? 'w1';
  const parentPaneId = options.parentPaneId ?? 'w1:p1';
  const parentRect = options.parentRect ?? { x: 0, y: 0, width: 400, height: 80 };
  const prefix = options.panePrefix ?? 'w1:p';
  const firstNumber = options.firstPaneNumber ?? 2;
  const shellPid = options.shellPid ?? 500;
  const splitMovesFocus = options.splitMovesFocus === true;
  const failures = new Map();
  for (const [verb, spec] of Object.entries(options.failures ?? {})) {
    failures.set(verb, Array.isArray(spec) ? [...spec] : [{ ...spec }]);
  }
  const delays = options.delays ?? {};
  const hanging = new Set(options.hang ?? []);
  const panes = new Map();
  const rects = new Map();
  const shells = new Map();
  const calls = [];
  let number = firstNumber - 1;
  let focus = parentPaneId;

  const add = (paneId, { label = null, shell = shellPid, rect = null } = {}) => {
    panes.set(paneId, { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId, focused: false,
      label });
    rects.set(paneId, rect ?? { ...parentRect });
    shells.set(paneId, shell);
    return paneId;
  };
  add(parentPaneId, { label: options.parentLabel ?? 'shell', shell: options.parentShellPid ?? 100 });

  // Each pane keeps the shell pid it was created with. A test can overwrite it to model the
  // "a different process owns this pane now" case that turns T16 into T17 (or T11 into T12).
  let createdShellPid = shellPid;

  const takeFailure = verb => {
    const queue = failures.get(verb);
    if (!queue || queue.length === 0) return null;
    const spec = queue[0];
    if (spec.skip > 0) { spec.skip -= 1; return null; }
    if (spec.times !== undefined) {
      spec.times -= 1;
      if (spec.times <= 0) queue.shift();
    } else queue.shift();
    return spec;
  };

  const list = () => [...panes.values()].map(pane => ({ pane_id: pane.pane_id, tab_id: tabId,
    focused: pane.pane_id === focus, label: pane.label }));

  const layout = () => ({
    tab_id: tabId, workspace_id: workspaceId, focused_pane_id: focus, zoomed: false,
    area: { ...parentRect },
    panes: [...panes.keys()].map(pane_id => ({ pane_id, rect: { ...rects.get(pane_id) } })),
  });

  const verbs = {
    list: () => ({ panes: list() }),
    layout: args => {
      const paneId = args[1] === '--pane' ? args[2] : args[1];
      if (!panes.has(paneId)) throw fail('pane_not_found', `pane ${paneId} not found`);
      return { layout: layout() };
    },
    'process-info': args => {
      const paneId = args[1] === '--pane' ? args[2] : args[1];
      if (!panes.has(paneId)) throw fail('pane_not_found', `pane ${paneId} not found`);
      return { process_info: { pane_id: paneId, shell_pid: shells.get(paneId) ?? shellPid } };
    },
    split: args => {
      const parent = args[1];
      if (!panes.has(parent)) throw fail('pane_not_found', `pane ${parent} not found`);
      number += 1;
      const paneId = `${prefix}${number.toString(36).toUpperCase()}`;
      const base = rects.get(parent);
      const half = Math.max(1, Math.round(base.width / 2));
      const direction = args[args.indexOf('--direction') + 1] ?? 'right';
      // Measured Herdr split geometry (omo split-tree helper, calibrated at L0): the source pane
      // keeps the first child with `--ratio`, and the new pane takes the second child. So a
      // `right` split puts the new pane to the RIGHT of the source.
      if (direction === 'down') {
        const halfRow = Math.max(1, Math.round(base.height / 2));
        rects.set(parent, { ...base, height: halfRow });
        add(paneId, { rect: { x: base.x, y: base.y + halfRow, width: base.width,
          height: base.height - halfRow } });
      } else {
        rects.set(parent, { ...base, width: half });
        add(paneId, { rect: { x: base.x + half, y: base.y, width: base.width - half,
          height: base.height } });
      }
      shells.set(paneId, createdShellPid);
      if (splitMovesFocus) focus = paneId;
      return { pane: { pane_id: paneId, tab_id: tabId }, type: 'pane_info' };
    },
    rename: args => {
      const paneId = args[1];
      if (!panes.has(paneId)) throw fail('pane_not_found', `pane ${paneId} not found`);
      panes.get(paneId).label = args[2] ?? null;
      return {};
    },
    run: args => {
      const paneId = args[1];
      if (!panes.has(paneId)) throw fail('pane_not_found', `pane ${paneId} not found`);
      panes.get(paneId).command = args[2] ?? null;
      return {};
    },
    close: args => {
      const paneId = args[1];
      if (!panes.has(paneId)) throw fail('pane_not_found', `pane ${paneId} not found`);
      const closed = rects.get(paneId);
      panes.delete(paneId);
      rects.delete(paneId);
      shells.delete(paneId);
      // Closing a pane gives the freed space back to the sibling (measured: "close gives the
      // sibling subtree the whole parent rect"). Every pane in this fake is split off the parent,
      // so the parent takes the space back.
      const base = rects.get(parentPaneId);
      if (base) {
        const x = Math.min(base.x, closed.x), y = Math.min(base.y, closed.y);
        rects.set(parentPaneId, { x, y,
          width: Math.max(base.x + base.width, closed.x + closed.width) - x,
          height: Math.max(base.y + base.height, closed.y + closed.height) - y });
      }
      if (focus === paneId) focus = parentPaneId;
      return {};
    },
    focus: args => {
      // `pane focus --pane X --direction D` focuses the NEIGHBOUR of X in direction D (herdr pane
      // help: "focus - Focus a neighboring pane").
      const paneId = args[args.indexOf('--pane') + 1];
      const direction = args[args.indexOf('--direction') + 1];
      if (!panes.has(paneId)) throw fail('pane_not_found', `pane ${paneId} not found`);
      const next = neighbourOf(paneId, direction);
      if (!next) throw fail('invalid_argument', `no neighbor ${direction} of ${paneId}`);
      focus = next;
      return {};
    },
  };

  const neighbourOf = (paneId, direction) => {
    const from = rects.get(paneId);
    const horizontal = direction === 'left' || direction === 'right';
    const forward = direction === 'right' || direction === 'down';
    const overlap = other => horizontal
      ? Math.min(other.y + other.height, from.y + from.height) - Math.max(other.y, from.y)
      : Math.min(other.x + other.width, from.x + from.width) - Math.max(other.x, from.x);
    const edge = forward ? (horizontal ? from.x + from.width : from.y + from.height)
      : (horizontal ? from.x : from.y);
    return [...panes.keys()].filter(candidate => candidate !== paneId).map(candidate =>
      ({ pane_id: candidate, rect: rects.get(candidate) })).filter(candidate => overlap(candidate.rect) > 0)
      .filter(candidate => (forward ? candidate.rect[horizontal ? 'x' : 'y'] :
        candidate.rect[horizontal ? 'x' : 'y'] + candidate.rect[horizontal ? 'width' : 'height']) === edge)
      .map(candidate => candidate.pane_id)[0] ?? null;
  };

  const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });

  const herdr = async (...args) => {
    calls.push({ seq: calls.length + 1, argv: args });
    const verb = args[0] === 'pane' ? args[1] : args[0];
    const spec = takeFailure(verb);
    if (spec?.hang) return new Promise(() => {});
    if (hanging.has(verb)) return new Promise(() => {});
    if (delays[verb]) await wait(delays[verb]);
    // `remove: '<paneId>'` models an external actor (or the viewer itself) that closes the pane
    // while our call is in flight: the pane is gone before the verb can report anything.
    if (typeof spec?.remove === 'string') { panes.delete(spec.remove); rects.delete(spec.remove); shells.delete(spec.remove); }
    const handler = verbs[verb];
    if (typeof handler !== 'function') throw fail('unknown_command', `unexpected command: ${args.join(' ')}`);
    if (spec) throw fail(spec.code ?? 'herdr_error', spec.message);
    return handler(args.slice(1));
  };

  return {
    herdr,
    calls,
    panes,
    rects,
    shells,
    tabId,
    parentPaneId,
    // ---- observation helpers for the assertions -------------------------------------------
    ids: () => [...panes.keys()],
    paneIds: () => [...panes.keys()],
    labelOf: paneId => panes.get(paneId)?.label ?? null,
    commandOf: paneId => panes.get(paneId)?.command ?? null,
    shellOf: paneId => shells.get(paneId) ?? null,
    has: paneId => panes.has(paneId),
    setLabel: (paneId, label) => { if (!panes.has(paneId)) throw fail('pane_not_found'); panes.get(paneId).label = label; },
    setShell: (paneId, pid) => { shells.set(paneId, pid); },
    setPaneRect: (paneId, rect) => { rects.set(paneId, { ...rect }); },
    addPane: (paneId, { label = null, shell = shellPid, rect = null } = {}) =>
      add(paneId, { label, shell, rect }),
    // `spec` may carry `{code, message, times}`, `{skip:N}` (let the first N calls through),
    // `{hang:true}` (never answer) or `{remove:'<paneId>'}` (the pane vanishes during the call).
    // A `times` count is decremented per matching call.
    setFailures: map => {
      failures.clear();
      for (const [verb, spec] of Object.entries(map ?? {})) {
        failures.set(verb, Array.isArray(spec) ? spec.map(value => ({ ...value })) : [{ ...spec }]);
      }
    },
    layout,
    verbsOf: slice => slice.map(entry => entry.argv.slice(0, 2).join(' ')),
  };
}

// Wrap a fake herdr so every call is tagged with the pass that issued it. The tests use this to
// prove A-32 (an automatic pass may only list / process-info / layout), A-31 ("at least one pane
// list means the pass really ran") and LT-8 (the run target belongs to the same pass's split).
export function createPassTracer(herdr) {
  let label = 'idle';
  const trace = [];
  const log = [];
  const record = { splitPaneIds: [], runTargets: [], mutationCalls: 0 };
  const wrapped = async (...args) => {
    const entry = { label, argv: args };
    log.push(entry);
    // The record is appended even when the call fails: a rejected call is still a call, and the
    // zero-call assertions (A-32, LT-7, LT-8) must not be satisfiable by making every call fail.
    let result;
    try {
      result = await herdr(...args);
    } catch (error) {
      entry.failed = error?.code ?? 'error';
      trace.push(entry);
      throw error;
    }
    if (args[0] === 'pane' && args[1] === 'split') {
      const paneId = result?.pane?.pane_id ?? result?.pane_id ?? null;
      entry.paneId = paneId;
      record.splitPaneIds.push(paneId);
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      entry.paneId = args[2];
      record.runTargets.push(args[2]);
    }
    if (args[0] === 'pane' && ['split', 'rename', 'run', 'close', 'focus'].includes(args[1])) {
      entry.mutation = true;
      if (label !== 'explicit') record.mutationCalls += 1;
    }
    trace.push(entry);
    return result;
  };
  return {
    herdr: wrapped,
    trace,
    record,
    async inPass(next, fn) {
      const previous = label;
      label = next;
      trace.length = 0;
      record.splitPaneIds.length = 0;
      record.runTargets.length = 0;
      try { return await fn(); }
      finally { label = previous; }
    },
    set(next) { label = next; },
    clear() { trace.length = 0; record.splitPaneIds.length = 0; record.runTargets.length = 0; record.mutationCalls = 0; },    verbs: kind => trace.filter(entry => kind === undefined || entry.label === kind)
      .map(entry => entry.argv.slice(0, 2).join(' ')),
    mutations: kind => trace.filter(entry => entry.mutation === true &&
      (kind === undefined || entry.label === kind)),
    failures: kind => trace.filter(entry => entry.failed !== undefined &&
      (kind === undefined || entry.label === kind)),
    // Verbs counted across the WHOLE tracer lifetime, so a test can total the cost of several
    // passes even though `inPass` clears the per-pass trace.
    totals: () => {
      const counts = {};
      for (const entry of log) {
        const verb = entry.argv.slice(0, 2).join(' ');
        counts[verb] = (counts[verb] ?? 0) + 1;
      }
      return counts;
    },
    resetTotals: () => { log.length = 0; },
    lists: kind => trace.filter(entry => entry.argv[0] === 'pane' && entry.argv[1] === 'list' &&
      (kind === undefined || entry.label === kind)),
  };
}

