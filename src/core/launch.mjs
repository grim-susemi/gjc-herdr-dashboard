// Launch: preflight plus plan 7.3's ordered pane sequence, as amended by stage-05 R1/R3/R4 and by
// the A-29/C-14 delta.
//
// This is the ONLY module allowed to call `pane run` (SR7, LT-8), and the only place besides
// `scripts/dev-shim.mjs` that may contain a FAILPOINT literal (SR9). `pane run` is never called
// on a pane this module did not receive from a `pane split` result in the same pass: the split
// result is the single source of the run target (LT-8, plan 7.3 item 3).
//
// Preflight runs before any split (plan 7.3 item 1) and fails coded, with zero panes:
//   failed:node    the injected checkNode() said no, or no absolute node path is available
//   failed:viewer  the viewer entry point for this role is not an absolute, readable file
//   failed:herdr   the Herdr argv vector cannot be resolved
//   failed:failpoint  GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT / ..._VIEWER_FAILPOINT holds a value
//                     this build does not know (stage-05 R3: "any other value fails before the
//                     split"), so a typo can never produce a half-launched pane
//
// Sequence (plan 7.3 item 2; the FP table in plan 8 is defined against these exact steps):
//   1 preflight  2 lock (the caller holds it)  3 intent.json  4 pane split --no-focus
//   5 pane process-info (shell_pid)  6 pending record in slot.json  7 delete intent.json
//   8 pane rename  9 pane run (viewer)  10 focus check
// U12 would fuse 4/8/9 into one command; L0 G7/U12 measured no such command (split has no
// `--label`/direct-command option), so this module issues the separate calls.
//
// Crash failpoints (FP1-FP5) are simulated through GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT so the
// unit tests can stop the sequence exactly where a process death would, and then assert what a
// later pass inherits (plan 8 FP table):
//   fp1 after split, before the record        -> label-less pane + intent, next pass T19
//   fp2 after the record, before rename       -> default-label pane + pending, next pass T5
//   fp3 after rename, before run              -> our-label empty shell, next pass T9/T10/T11
//   fp4 after run, before the focus check     -> viewer starting, next pass T13
//   fp5 viewer ready 25 s late (R3)            -> `--failpoint ready-delay-25s`, next pass T10/T13
// Failures that are not crashes clean up after themselves where that is provably safe: a
// preflight or split failure leaves no pane, so the intent file is removed and the next pass
// starts from T1 (LT-1). A failure after the split keeps the intent (or relies on the pending
// record) so the next pass sees T19 / T5 / T9 exactly as the FP table says.
//
// Focus (plan 7.3 item 8): the split is `--no-focus`, so focus normally never moves and no focus
// command is issued. When another client did move the focus inside the parent tab, the pass
// restores it with `pane focus --pane <current> --direction <toward parent>` — the tab-level focus
// verb is forbidden product-wide (SR6) — and records {before, after, restored}.
//
// Exported signatures
//   LAUNCH_FAILPOINT_ENV, VIEWER_FAILPOINT_ENV, CRASH_FAIL_POINTS, VIEWER_FAILPOINTS
//   readFailpoints(env)            -> {ok, crash, viewerFailpoint, detail?}
//   viewerArgs(options)            -> ['--state',…,'--pane',…,(--lang …),(--failpoint …)]
//   shellTrailer(shell)            -> '; exit' | '& exit'
//   viewerCommand(options, platform) -> single-line shell command with the trailer
//   resolveRoleViewerPath({viewerPath, role}) -> absolute path | throws {code:'viewer'}
//   preflight(options)             -> {ok:true, nodePath, viewerPath, vector, crash, viewerFailpoint}
//                                  | {ok:false, code, detail}
//   launchRole(options)            -> {ok, code, paneId?, tabId?, shellPid?, token, label, record?,
//                                      slot?, splitPaneIds, focus, detail?}
//     L2 adds `anchorPaneId` (default: the parent pane), `direction` (default 'right') and `ratio`
//     (default null = no `--ratio` flag). The reconciler passes the band geometry explicitly:
//     Todo uses the parent as anchor with `--direction right --ratio 2/3` (layout chatShare, so
//     the dashboard keeps 1/3) and Workers uses the Todo record's paneId with `--direction down
//     --ratio 0.35`. The null default keeps direct L1 callers byte-for-byte compatible.
import { accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolveHerdrVector, shellCommand } from '../herdr.mjs';
import { clearIntent, intentRecord, writeIntent, writeSlot } from './slot.mjs';

export const LAUNCH_FAILPOINT_ENV = 'GJC_HERDR_DASHBOARD_LAUNCH_FAILPOINT';
export const VIEWER_FAILPOINT_ENV = 'GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT';
export const CRASH_FAIL_POINTS = ['fp1', 'fp2', 'fp3', 'fp4', 'fp5'];
export const VIEWER_FAILPOINTS = ['ready-delay-25s'];
// The L1 default: Todo is the first role, it is split to the right of the parent, and a direct
// caller that passes no ratio gets Herdr's own default (0.5). The reconciler always states the
// band ratio explicitly (contract "Launch parameters").
const SPLIT_DIRECTION = 'right';

// `fp5` is the viewer-side delay, not a crash: the launch itself completes normally.
export function readFailpoints(env = process.env) {
  const crash = String(env[LAUNCH_FAILPOINT_ENV] ?? '').trim();
  const viewer = String(env[VIEWER_FAILPOINT_ENV] ?? '').trim();
  if (crash !== '' && !CRASH_FAIL_POINTS.includes(crash)) {
    return { ok: false, detail: `${LAUNCH_FAILPOINT_ENV}=${crash}` };
  }
  if (viewer !== '' && !VIEWER_FAILPOINTS.includes(viewer)) {
    return { ok: false, detail: `${VIEWER_FAILPOINT_ENV}=${viewer}` };
  }
  const resolved = viewer !== '' ? viewer : (crash === 'fp5' ? VIEWER_FAILPOINTS[0] : null);
  return { ok: true, crash: crash === '' ? null : crash, viewerFailpoint: resolved };
}

export function viewerArgs({ stateDir, layoutKey, role, token, paneId, language = null,
  failpoint = null } = {}) {
  const args = ['--state', stateDir, '--layout', layoutKey, '--role', role, '--token', token,
    '--pane', paneId];
  if (language) args.push('--lang', language);
  if (failpoint) args.push('--failpoint', failpoint);
  return args;
}

// U11 measured Windows PowerShell 5.1 as the pane shell; the trailer keeps the pane from staying
// open as an idle shell after the viewer exits (plan 7.3 item 4).
export function shellTrailer(shell = 'powershell') {
  return shell === 'cmd' ? '& exit' : '; exit';
}

export function viewerCommand(options, platform = process.platform) {
  const shell = platform === 'win32' ? 'powershell' : 'sh';
  const tokens = [options.nodePath, options.viewerPath, ...viewerArgs(options)];
  return `${shellCommand(tokens, platform)}${shellTrailer(shell)}`;
}

export function resolveRoleViewerPath({ viewerPath, role } = {}) {
  const resolved = viewerPath?.[role];
  if (typeof resolved !== 'string' || !isAbsolute(resolved)) {
    throw Object.assign(new Error(`No absolute viewer path for role ${String(role)}`),
      { code: 'viewer', detail: `viewer:${String(role)}` });
  }
  return resolved;
}

function readableViewer(path) {
  try { accessSync(path, constants.R_OK); return true; }
  catch {
    // outcome: an unreadable viewer entry point is simply not launchable.
    return null;
  }
}

export async function preflight({ env = process.env, checkNode, nodePath = null, viewerPath,
  vector = null, resolveVector = resolveHerdrVector, viewerAccess = readableViewer } = {}) {
  const failpoints = readFailpoints(env);
  if (!failpoints.ok) {
    // stage-05 R3: an unknown failpoint value fails before the split, with zero panes.
    return { ok: false, code: 'failed:failpoint', detail: failpoints.detail };
  }
  if (typeof viewerPath !== 'string' || !isAbsolute(viewerPath)) {
    return { ok: false, code: 'failed:viewer', detail: 'viewer:not-absolute' };
  }
  let resolvedNode = nodePath;
  if (typeof checkNode === 'function') {
    let checked;
    try { checked = await checkNode(); }
    catch (error) {
      return { ok: false, code: 'failed:node', detail: error.code ?? error.message };
    }
    if (!checked || checked.ok !== true) {
      return { ok: false, code: 'failed:node', detail: checked?.reason ?? 'check-failed' };
    }
    if (typeof checked.nodePath === 'string' && checked.nodePath !== '') resolvedNode = checked.nodePath;
  }
  if (typeof resolvedNode !== 'string' || resolvedNode === '' || !isAbsolute(resolvedNode)) {
    return { ok: false, code: 'failed:node', detail: 'node:unresolved' };
  }
  if (!viewerAccess(viewerPath)) {
    return { ok: false, code: 'failed:viewer', detail: 'viewer:unreadable' };
  }
  let resolvedVector = vector;
  if (!Array.isArray(resolvedVector)) {
    try { resolvedVector = resolveVector(env); }
    catch (error) { return { ok: false, code: 'failed:herdr', detail: error.code ?? error.message }; }
  }
  if (!Array.isArray(resolvedVector) || resolvedVector.length === 0) {
    return { ok: false, code: 'failed:herdr', detail: 'herdr:empty-vector' };
  }
  return { ok: true, nodePath: resolvedNode, viewerPath, vector: resolvedVector,
    crash: failpoints.crash, viewerFailpoint: failpoints.viewerFailpoint };
}

/**
 * A pass that lost its generation (`fence`) or ran out of budget must stop as that code, not as a
 * launch failure: the reconciler reports `busy` / `partial:timeout` and no cleanup is run for a
 * pass that no longer owns the slot.
 */
const isControlFailure = error => error?.code === 'fence' || error?.code === 'budget';

const paneIdOf = pane => pane?.pane_id ?? pane?.paneId ?? null;
const tabIdOf = pane => pane?.tab_id ?? pane?.tabId ?? null;
const shellPidOf = info => (info?.process_info ?? info)?.shell_pid ?? null;

function focusedInTab(panes, tabId) {
  if (!Array.isArray(panes)) return null;
  const focused = panes.filter(pane => pane?.focused === true && (tabId === undefined || tabIdOf(pane) === tabId));
  return focused.length === 1 ? paneIdOf(focused[0]) : null;
}

// The direction to walk from `from` to `to` inside one tab, read from the layout rectangles.
export function directionBetween(from, to) {
  if (!from || !to) return null;
  if (to.x < from.x) return 'left';
  if (to.x > from.x) return 'right';
  if (to.y < from.y) return 'up';
  if (to.y > from.y) return 'down';
  return null;
}

export async function launchRole(options = {}) {
  const {
    herdr, paths, parent = {}, scope = {}, role = 'todo', layoutKey,
    slot = null, stateDir, viewerPath, nodePath = null, language = null, label, token,
    env = process.env, now = () => Date.now(), platform = process.platform,
    checkNode, viewerAccess, resolveVector, vector = null,
    failpoint = undefined, focusCheck = true,
    // L2 (contract "Launch parameters"): which pane this role splits, in which direction, and at
    // what ratio. The defaults reproduce the L1 argv for direct callers: anchor = the parent pane,
    // direction `right`, no `--ratio` flag at all. The reconciler passes the band geometry
    // explicitly (Todo chatShare = 2/3, Workers 0.35) so the dashboard is one third of the tab.
    anchorPaneId = null, direction = SPLIT_DIRECTION, ratio = null,
    // The reconciler passes guarded writers so the pass's budget check and generation re-check
    // also cover the state writes this sequence makes (steps 3, 6, 7). Defaults keep the module
    // usable on its own in the launch tests.
    writeSlotFn = writeSlot, clearIntentFn = clearIntent, writeIntentFn = writeIntent,
  } = options;
  const splitPaneIds = [];
  const focus = { before: null, after: null, restored: true };
  const abort = (code, detail, extra = {}) => ({ ok: false, code, detail, token, label,
    splitPaneIds, focus, ...extra });
  const pre = await preflight({ env, checkNode, nodePath, viewerPath, vector, resolveVector, viewerAccess });
  if (!pre.ok) return abort(pre.code, pre.detail);

  const crash = failpoint === undefined ? pre.crash : failpoint;
  // fp5 is the viewer-side 25 s delay: an explicit `fp5` crash name implies it, and R3's own env
  // variable names it directly.
  const viewerFailpoint = pre.viewerFailpoint ?? (crash === 'fp5' ? VIEWER_FAILPOINTS[0] : null);
  const parentPaneId = parent?.paneId;
  const parentTabId = parent?.tabId;
  // The split anchor is the caller's explicit pane when it has one, the parent pane otherwise. A
  // missing anchor must not become the string 'undefined' in the argv: it fails before any pane is
  // touched, exactly like a bad viewer path (the caller can only report `failed:herdr-split`).
  const anchorOf = typeof anchorPaneId === 'string' && anchorPaneId !== ''
    ? anchorPaneId : parentPaneId;
  if (typeof anchorOf !== 'string' || anchorOf === '') {
    return abort('failed:herdr-split', 'split:no-anchor');
  }
  const splitDirection = direction === 'down' || direction === 'up' || direction === 'left' ||
    direction === 'right' ? direction : SPLIT_DIRECTION;
  // `ratio` is a Herdr split ratio in (0, 1); anything else is treated as "no flag" so a bad value
  // cannot produce an argv Herdr would read as something else.
  const splitRatio = typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 && ratio < 1
    ? ratio : null;
  const at = () => (typeof now === 'function' ? now() : Date.now());

  if (focusCheck) {
    try {
      const listed = await herdr('pane', 'list');
      focus.before = focusedInTab(listed?.panes, parentTabId);
    } catch (error) {
      // outcome: an unreadable focus snapshot cannot be restored afterwards, so it stays null.
      focus.before = null;
      focus.detail = error.code ?? error.message;
    }
  }

  // 3. intent.json before the split (plan 7.3; T19 depends on it). It is a slot-state write like
  // the record, so it fails under the same code: without it a later pass could not tell an
  // interrupted launch from a plain T1, and the launch must not split first and ask later.
  try { await writeIntentFn(paths.intent, intentRecord({ role, label, tabId: parentTabId, now: at() })); }
  catch (error) {
    if (isControlFailure(error)) throw error;
    return abort('failed:herdr-record', error.code ?? error.message, { step: 'intent' });
  }

  // 4. split. The result of THIS call is the only source of the run target.
  const splitArgv = ['pane', 'split', anchorOf, '--direction', splitDirection];
  if (splitRatio !== null) splitArgv.push('--ratio', String(splitRatio));
  splitArgv.push('--no-focus');
  let split;
  try {
    split = await herdr(...splitArgv);
  } catch (error) {
    if (isControlFailure(error)) throw error;
    if (error.code === 'timeout') {
      // A split that never answered may have created a pane. The intent is kept so the next pass
      // reports T19 (interrupted launch) instead of silently orphaning an unlabelled pane.
      return abort('partial:timeout', 'split:timeout');
    }
    // A coded refusal created nothing, so the intent is cleared and the next pass starts from T1
    // (LT-1). This is the R1 "no-effect refusal created nothing" case.
    await clearIntentFn(paths.intent);
    return abort('failed:herdr-split', error.code ?? error.message);
  }
  const paneId = paneIdOf(split?.pane ?? split);
  if (typeof paneId !== 'string' || paneId === '') {
    // The call answered without a pane id: unlike a timeout this is a definite refusal, so the
    // intent goes away and the next pass is a plain T1.
    await clearIntentFn(paths.intent);
    return abort('failed:herdr-split', 'split:no-pane-id');
  }
  splitPaneIds.push(paneId);
  const tabId = tabIdOf(split?.pane ?? split) ?? parentTabId ?? null;
  if (crash === 'fp1') return abort('failed:failpoint', 'fp1:after-split', { paneId, tabId });

  // 5. shell identity evidence for O+.
  let shellPid = null;
  try {
    const info = await herdr('pane', 'process-info', '--pane', paneId);
    shellPid = shellPidOf(info);
  } catch (error) {
    if (isControlFailure(error)) throw error;
    // The pane exists but has no record: the intent stays, so the next pass reports T19.
    return abort('failed:herdr-process-info', error.code ?? error.message, { paneId, tabId });
  }

  // 6. the pending record.
  const record = { state: 'pending', token, paneId, tabId, shellPid,
    label: label ?? null, pendingSince: at() };
  const base = slot && typeof slot === 'object' ? slot : {
    schema: 'gjc-herdr-dashboard/slot/1', layoutKey,
    parent: { socket: parent?.socket ?? null, paneId: parentPaneId, tabId: parentTabId },
    herdr: Array.isArray(pre.vector) ? pre.vector : [],
    scope, roles: {},
  };
  const nextSlot = { ...base, roles: { ...(base.roles ?? {}), [role]: record } };
  try { await writeSlotFn(paths.slot, nextSlot); }
  catch (error) {
    if (isControlFailure(error)) throw error;
    return abort('failed:herdr-record', error.code ?? error.message, { paneId, tabId });
  }

  // 7. the record exists, so a later pass classifies the pane from the record, not the intent. The
  // deletion is a slot-state write too: if it fails, the record still names the pane and the next
  // pass reports T19 `partial:interrupted-launch`, so the failure is surfaced rather than hidden.
  try { await clearIntentFn(paths.intent); }
  catch (error) {
    if (isControlFailure(error)) throw error;
    return abort('failed:herdr-record', error.code ?? error.message,
      { paneId, tabId, shellPid, record, slot: nextSlot, step: 'clear-intent' });
  }
  if (crash === 'fp2') return abort('failed:failpoint', 'fp2:after-record',
    { paneId, tabId, shellPid, record, slot: nextSlot });

  // 8. rename to the role label. The label is a real, exact string because isO/O+ compare it with
  // the record on every later pass (slot.mjs uses an invisible role marker: Herdr renders no title
  // for it, but the equality fence is unchanged).
  try { await herdr('pane', 'rename', paneId, label); }
  catch (error) {
    if (isControlFailure(error)) throw error;
    return abort('failed:herdr-rename', error.code ?? error.message,
      { paneId, tabId, shellPid, record, slot: nextSlot });
  }
  if (crash === 'fp3') return abort('failed:failpoint', 'fp3:after-rename',
    { paneId, tabId, shellPid, record, slot: nextSlot });

  // 9. run the viewer. Only ever on `paneId` from THIS pass's split result (LT-8).
  const command = viewerCommand({ nodePath: pre.nodePath, viewerPath: pre.viewerPath, stateDir,
    layoutKey, role, token, paneId, language, failpoint: viewerFailpoint }, platform);
  try { await herdr('pane', 'run', paneId, command); }
  catch (error) {
    if (isControlFailure(error)) throw error;
    return abort('failed:herdr-run', error.code ?? error.message,
      { paneId, tabId, shellPid, record, slot: nextSlot });
  }
  if (crash === 'fp4') return abort('failed:failpoint', 'fp4:after-run',
    { paneId, tabId, shellPid, record, slot: nextSlot });

  // 10. focus: restore only when the focused pane of the parent tab actually changed.
  if (focusCheck) {
    try {
      const listed = await herdr('pane', 'list');
      focus.after = focusedInTab(listed?.panes, parentTabId);
      if (focus.before !== null && focus.after !== null && focus.before !== focus.after &&
          typeof parentPaneId === 'string') {
        const layout = await herdr('pane', 'layout', '--pane', parentPaneId);
        const rects = layout?.layout?.panes ?? [];
        const rectOf = id => rects.find(pane => paneIdOf(pane) === id)?.rect ?? null;
        const direction = directionBetween(rectOf(focus.after), rectOf(parentPaneId));
        if (direction) {
          await herdr('pane', 'focus', '--pane', focus.after, '--direction', direction);
          const settled = await herdr('pane', 'list');
          focus.after = focusedInTab(settled?.panes, parentTabId);
        } else {
          focus.detail = 'focus:no-direction';
        }
      }
      focus.restored = focus.after === focus.before;
    } catch (error) {
      focus.restored = false;
      focus.detail = error.code ?? error.message;
    }
  }

  return { ok: true, code: 'opened', paneId, tabId, shellPid, token, label, record,
    slot: nextSlot, splitPaneIds, focus };
}
