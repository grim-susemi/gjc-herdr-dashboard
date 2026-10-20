// Todo role viewer entry point for the GJC Herdr dashboard.
//
// Rewritten from omo-herdr-dashboard @4082c750 `packages/todo/src/viewer.mjs`.
// Kept: the CLI shape, atomic prefs, the `f`/`c`/`j`/`k`/`q` keys and `--once`.
// Removed: the presence/ACK protocol, the producer-custody and retirement servers,
// the native-display cache and every omo role-binding field. Added: the slot watch
// with the token fence, the owner-liveness label, the projection read from
// `<state>/data/<scopeKey>/todo.json`, scope rebinding when slot.json changes, and
// the `ready-delay-25s` launcher argument used by the 25s-late-ready live test (R3).
//
// CLI: node viewer.mjs --state <dir> [--layout <layoutKey>] --role todo
//        --token <token> --pane <paneId> [--once] [--lang ko|en|zh-cn] [--width N]
//
// Without `--once` and on a TTY the viewer runs interactively: raw mode, pointer
// modes, the SGR pointer/focus decoder, the Herdr focus subscription, a repaint
// timer, the slot watcher and the ready heartbeat. `--once` prints
// one frame to stdout and exits 0, which is what the snapshot tests use.
//
// Every side effect is injected through one `port` (raw UTF-8 file read, JSON read,
// async atomic write, clock, Herdr argv vector, output, exit), so the unit tests
// never touch a real Herdr, a real clock, the owner's home or a real process exit.
// The viewer writes exactly one file of the state directory, its own
// `roles/<role>.ready.json`; `slot.json` and `owner.json` are read-only here.
//
// Exported signatures
//   USAGE: string
//   parseViewerArgs(args): Options
//   EMPTY_PREFS: Readonly<Prefs>
//   defaultPort: Port
//   readProjection(path, deps?): { projection, availability, error }
//   loadPreferences(path, scopeKey, deps?): { prefs, error }
//   savePreferences(path, prefs, deps?): Promise<record>
//   startViewer(options, deps?): Promise<Viewer>
//   main(argv?, deps?): Promise<number>
//
// `deps.watchFocus(paneId, blur, failed, env)` is the focus watcher (AC3.2/AC3.3);
// it defaults to `watchHerdrFocus` and is only ever called for an interactive viewer.
//
// Viewer = { events, closed, refresh, key, close, stop, draw, setOwner, exit,
//            frame, text, state }
import { EventEmitter } from "node:events";
import { readFileSync, watch } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { closeOwnPane, createHeartbeat, createSlotWatcher, fenceDecision, generationOf,
  isViewerFailpoint, ownerLiveness, readyRecord, t, VIEWER_FP_FLAG,
  viewerFailpointDelayMs } from "../common.mjs";
import { disablePointer, enablePointer, terminalInput, watchHerdrFocus }
  from "../../terminal-input.mjs";
import { ROOT_URL, createI18n } from "../../i18n.mjs";
import { writeJson } from "../../storage.mjs";
import { createHerdr } from "../../herdr.mjs";
import { pidAlive as probePid } from "../../core/liveness.mjs";

// null (unknowable) is treated as alive: a viewer must never claim a disconnect it cannot prove.
const defaultPidAlive = (pid) => probePid(pid) !== false;
import { renderFrame, stepSelection, taskKeys } from "./render.mjs";

export const USAGE =
  "Usage: node viewer.mjs --state <dir> [--layout <layoutKey>] --role <role> " +
  "--token <token> --pane <paneId> [--once] [--lang ko|en|zh-cn] [--width N]";

const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const KEY_PATTERN = /^[0-9a-f]{8,24}$/;
const SLOT_SCHEMA = "gjc-herdr-dashboard/slot/1";
const OWNER_SCHEMA = "gjc-herdr-dashboard/owner/1";
const PREFS_SCHEMA = "gjc-herdr-dashboard/prefs/1";
const PROJECTION_SCHEMA = "gjc-herdr-dashboard/todo/1";
const GOAL_SCHEMA = "gjc-herdr-dashboard/goal/1";

export function parseViewerArgs(args) {
  const result = { once: false, state: null, layout: null, role: "todo", token: null,
    pane: null, lang: null, width: null, failpoint: null };
  const fields = { "--state": "state", "--layout": "layout", "--role": "role",
    "--token": "token", "--pane": "pane", "--lang": "lang", "--width": "width",
    [VIEWER_FP_FLAG]: "failpoint" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--once") { result.once = true; continue; }
    const field = fields[flag];
    const value = args[index + 1];
    if (!field || value === undefined || value.startsWith("--")) {
      throw new TypeError(`${USAGE} (bad argument: ${flag})`);
    }
    result[field] = value;
    index++;
  }
  if (!isAbsolute(result.state ?? "") || !result.token || !result.pane) {
    throw new TypeError(`${USAGE} (--state must be an absolute directory)`);
  }
  if (!ROLE_PATTERN.test(result.role)) throw new TypeError(`${USAGE} (bad role)`);
  if (result.layout !== null && !KEY_PATTERN.test(result.layout)) {
    throw new TypeError(`${USAGE} (--layout must be a layout key)`);
  }
  if (result.width !== null && !/^\d{1,4}$/.test(result.width)) throw new TypeError(`${USAGE} (bad --width)`);
  if (result.failpoint !== null && !isViewerFailpoint(result.failpoint)) {
    throw new TypeError(`${USAGE} (unknown viewer failpoint)`);
  }
  return result;
}

// `collapsed` hides fully closed phases; the default keeps them listed so finished work stays on record
// until a new todo list replaces it.
export const EMPTY_PREFS = Object.freeze({ scroll: 0, collapsed: false, selection: null, follow: true });

const message = (cause) => String(cause?.message ?? cause ?? "error");
const enoent = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

const readJsonSync = (path) => {
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (cause) { throw cause.code === "ENOENT" ? enoent(path) : cause; }
  try { return JSON.parse(text); }
  catch (cause) { throw Object.assign(new TypeError(`Invalid JSON in ${path}: ${cause.message}`), { code: "INVALID_JSON" }); }
};

// Default port. `write` is the shared atomic writer (tmp + rename, EPERM retry).
export const defaultPort = {
  read: readJsonSync,
  readRaw: (path) => readFileSync(path, "utf8"),
  write: (path, value) => writeJson(path, value),
};

export function readProjection(path, { read = defaultPort.read } = {}) {
  let value;
  try {
    value = read(path);
  } catch (cause) {
    return cause?.code === "ENOENT"
      ? { projection: null, availability: "waiting", error: "" }
      : { projection: null, availability: "source-error", error: message(cause) };
  }
  if (!value || typeof value !== "object" || value.schema !== PROJECTION_SCHEMA || !Array.isArray(value.phases)) {
    return { projection: null, availability: "source-error", error: "projection schema" };
  }
  const sourceError = typeof value.sourceError === "string" && value.sourceError !== "" ? value.sourceError : "";
  return { projection: value,
    availability: sourceError ? "source-error" : value.empty ? "empty" : "live",
    error: sourceError };
}

// L5b: the goal line is auxiliary, so a missing, corrupt or malformed file is reported here and
// never changes the Todo pane's connection label. A `goal: null` projection is the host saying
// "there is no goal", which is exactly the no-line state; only a shape we cannot read is an error.
function readGoal(path, { read = defaultPort.read } = {}) {
  let value;
  try {
    value = read(path);
  } catch (cause) {
    return cause?.code === "ENOENT"
      ? { goal: null, error: "" }
      : { goal: null, error: message(cause) };
  }
  if (!value || typeof value !== "object" || value.schema !== GOAL_SCHEMA) {
    return { goal: null, error: "goal schema" };
  }
  if (value.goal === null) return { goal: null, error: "" };
  const goal = value.goal;
  if (!goal || typeof goal !== "object" || typeof goal.objective !== "string" ||
    typeof goal.status !== "string" || !Number.isFinite(goal.tokensUsed) ||
    !Number.isFinite(goal.timeUsedSeconds)) {
    return { goal: null, error: "goal shape" };
  }
  return { goal: { objective: goal.objective, status: goal.status,
    tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds }, error: "" };
}

// `follow` is never restored as OFF (AC1.3): reopening always restores follow ON,
// while fold and selection persist. A bad file is reported, never fatal.
export function loadPreferences(path, scopeKey, { read = defaultPort.read } = {}) {
  const fresh = { prefs: { ...EMPTY_PREFS }, error: "" };
  let value;
  try {
    value = read(path);
  } catch (cause) {
    return cause?.code === "ENOENT" ? fresh : { prefs: { ...EMPTY_PREFS }, error: message(cause) };
  }
  if (!value || typeof value !== "object" || value.schema !== PREFS_SCHEMA || value.scopeKey !== scopeKey) {
    return { prefs: { ...EMPTY_PREFS }, error: "prefs schema" };
  }
  const integer = (candidate) => (Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0);
  return { prefs: { scroll: integer(value.scroll), collapsed: value.collapsed === true,
    selection: typeof value.selection === "string" ? value.selection : null, follow: true }, error: "" };
}

export async function savePreferences(path, prefs, { write = defaultPort.write } = {}) {
  const record = { schema: PREFS_SCHEMA, scopeKey: prefs.scopeKey, scroll: prefs.scroll,
    collapsed: prefs.collapsed === true, selection: prefs.selection };
  await write(path, record);
  return record;
}

const defaultClock = { now: () => Date.now(), setInterval, clearInterval, setTimeout, clearTimeout };

export async function startViewer(options, {
  port = defaultPort, clock = defaultClock, env = process.env, output = process.stdout,
  input = process.stdin, herdr, i18n = createI18n(ROOT_URL), watchFn = watch,
  watchFocus = watchHerdrFocus,
  pid = process.pid, exit = (code) => process.exit(code),
  interactive = Boolean(input?.isTTY && output?.isTTY),
} = {}) {
  const language = i18n.decision(options.lang ?? null);
  const notices = language.invalidValue === null
    ? [] : [t(language.language, "invalidLanguage", { value: language.invalidValue })];
  const gen = generationOf(ROOT_URL, { readFile: (path) => {
    try { return port.readRaw(path); }
    catch (cause) { throw cause; }
  } });

  const events = new EventEmitter();
  const layoutKey = options.layout ?? "unknown";
  const slotsDir = `${options.state}/slots/${layoutKey}`;
  const slotPath = `${slotsDir}/slot.json`;
  const ownerPath = `${slotsDir}/owner.json`;
  const readyPath = `${slotsDir}/roles/${options.role}.ready.json`;
  const startedAt = clock.now();
  const readyDelay = viewerFailpointDelayMs(options.failpoint);
  const isInteractive = interactive && !options.once;
  // The ready file is written through the shared heartbeat helper so the periodic tick
  // and the closing mark cannot drift apart. It is the only state file this viewer
  // writes; slot.json and owner.json stay read-only here.
  const heartbeat = createHeartbeat({ path: readyPath, clock, heartbeat: isInteractive,
    build: (extra) => readyRecord({ pid, token: options.token, paneId: options.pane, gen,
      startedAt, now: clock.now(), ...extra }),
    write: (path, value) => port.write(path, value),
    onError: (cause) => events.emit("heartbeat-error", cause) });
  let projection = null, availability = "waiting", error = "", slot = null, slotError = "",
    goal = null, goalError = "",
    owner = null, ownerAlive = null, prefs = { ...EMPTY_PREFS, scopeKey: null }, frame = null,
    closing = false, disposed = false, closeJob = null, timer, watcher;
  // Pointer drag anchor (1-based SGR row), cleared by release and by blur (AC3.1).
  let dragY, disposeInput = null, disposeFocus = null;
  // Selection reveal is disarmed by every manual pointer action and re-armed by a
  // blur (AC3.2), so a wheel or drag can hold a scroll position the selection left behind.
  let revealSelection = true;
  let saving = Promise.resolve();
  let heartbeatTail = Promise.resolve();

  // Real runs have no injected client: use the Herdr argv vector the owner recorded in slot.json
  // (plan 7.10) so `q` and a token-fence retirement can close this viewer's own pane.
  function slotHerdr() {
    const vector = Array.isArray(slot?.herdr) && slot.herdr.length > 0 ? slot.herdr : null;
    if (vector === null) return undefined;
    const call = createHerdr({ vector, env });
    return (args) => call(...args);
  }

  let resolveClosed;
  const closed = new Promise((done) => { resolveClosed = done; });
  const columnsOf = () => (options.width !== null ? Number(options.width) : Number(output.columns ?? 80));
  const rowsOf = () => Number(output.rows ?? 24);
  // Production default: probe the owner pid (ESRCH = dead, EPERM = alive, anything else is
  // inconclusive and fails closed to live). Tests inject `alive` through setOwner.
  const pidAlive = (candidate) => (ownerAlive ? ownerAlive(candidate) : defaultPidAlive(candidate));

  function connection() {
    // Distinctness for AC1.9: read failure first, then owner liveness, then the
    // source's own empty/waiting state, and only then the live label.
    if (error || slotError || availability === "source-error") return { kind: "source-error", at: clock.now() };
    if (ownerLiveness(owner, { now: clock.now(), pidAlive }) === "disconnected") {
      return { kind: "disconnected", at: clock.now() };
    }
    if (availability === "empty") return { kind: "empty", at: clock.now() };
    if (availability === "waiting" || projection === null) return { kind: "waiting", at: clock.now() };
    return { kind: "live", at: clock.now() };
  }

  function draw() {
    frame = renderFrame(projection, { columns: columnsOf(), rows: rowsOf(),
      language: language.language, color: isInteractive, expanded: !prefs.collapsed,
      scroll: prefs.scroll, selection: prefs.selection, follow: prefs.follow,
      connection: connection(), notices, revealSelection, goal });
    return frame;
  }

  // The 1s timer and resize re-read slot, owner and projection before drawing; repainting the
  // last frame alone would never show a Todo update that landed after the first paint.
  //
  // The write is `\x1b[H` plus a per-line `\x1b[K`, never `\x1b[2J`: a full-screen clear every
  // second makes the pane visibly flicker and costs the terminal a whole repaint. An unchanged frame
  // is not written at all, so an idle dashboard sends no bytes. `lastWritten` is reset by the screen
  // enter and by a resize, because both leave the terminal content in an unknown state.
  let lastWritten = null, checkedStamp = null;
  const writeFrame = () => {
    if (!isInteractive || closing || disposed || !frame) return;
    if (frame.text === lastWritten) return;
    lastWritten = frame.text;
    output.write?.(`\x1b[H${frame.text.replaceAll("\n", "\x1b[K\r\n")}\x1b[K\x1b[J`);
  };
  const paint = async () => {
    refresh();
    writeFrame();
    return frame;
  };

  // Interactive frames live on the alternate screen with the cursor hidden and the
  // pointer modes on; leaving has to undo exactly that, or the pane is left unusable.
  const enterScreen = () => {
    if (!isInteractive) return;
    lastWritten = null;
    output.write?.(`\x1b[?1049h\x1b[?25l${enablePointer}`);
  };
  const leaveScreen = () => {
    if (!isInteractive) return;
    output.write?.(`${disablePointer}\x1b[?25h\x1b[?1049l`);
  };

  // Preferences are saved in the order the keys were pressed, and the returned promise
  // resolves once this snapshot's bytes have landed, so nothing is silently reordered.
  function savePrefs() {
    if (typeof prefs.scopeKey !== "string" || closing) return Promise.resolve();
    const path = `${options.state}/prefs/${prefs.scopeKey}/${options.role}.json`;
    const snapshot = { ...prefs };
    saving = saving
      .then(() => savePreferences(path, snapshot, { write: port.write }))
      .catch((cause) => { events.emit("prefs-error", cause); });
    return saving;
  }

  // The ready file is written by the heartbeat helper; `events.emit("ready")` lets a
  // test observe the first write without reading the file.
  const writeReady = async (extra) => {
    const record = await heartbeat.write(extra);
    events.emit("ready", record);
    return record;
  };

  function finish(reason) {
    if (disposed) return;
    disposed = true;
    leaveScreen();
    input.setRawMode?.(false);
    // The viewer resumed stdin when it went interactive; leaving it flowing would keep the
    // TTY read handle (and the process) alive after the viewer closed.
    if (isInteractive) input.pause?.();
    watcher?.close?.();
    clock.clearInterval(timer);
    heartbeatTail = heartbeat.stop();
    disposeInput?.();
    disposeInput = null;
    // AC3.3: the focus subscription is released with the screen. A subscription that is
    // still in flight disposes itself as soon as it resolves (see subscribeFocus).
    disposeFocus?.();
    disposeFocus = null;
    output.off?.("resize", onResize);
    events.emit("closed", { reason });
    resolveClosed({ reason });
  }

  // Token fence and `q` both retire the viewer: mark the ready file closing:'q'
  // first, flush any pending preference save, then close our own pane. closeOwnPane
  // refuses unless HERDR_PANE_ID is exactly the pane we were given; the retire
  // reason stays the fence reason.
  async function retire(reason) {
    if (closing) return closeJob;
    closing = true;
    closeJob = (async () => {
      try { await writeReady({ closing: "q" }); }
      catch (cause) { events.emit("heartbeat-error", cause); }
      await saving;
      const result = await closeOwnPane({ paneId: options.pane, env, herdr: herdr ?? slotHerdr(),
        onClose: () => events.emit("pane-closed", reason) });
      events.emit("retired", { reason, closed: result.closed, closeReason: result.reason });
      finish("retired");
      return { reason, ...result };
    })();
    return closeJob;
  }
  const close = () => retire("q");

  function stop() {
    if (disposed) return Promise.resolve();
    closing = true;
    finish("stopped");
    // The pending preference save is part of the viewer’s lifetime: a caller that removes the state
    // directory after `stop()` must not race a write that was already queued (the teardown
    // `ENOTEMPTY` this used to cause), so the save chain is returned for the caller to await.
    return Promise.all([saving, heartbeatTail]).then(() => undefined);
  }

  // Slot change: rebind the scope and data when the layout stayed ours, and retire
  // on a fence decision. An unreadable or invalid slot is not a retire reason.
  function applySlotText(text) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (cause) {
      slotError = message(cause);
      events.emit("slot-error", cause);
      return;
    }
    if (!parsed || typeof parsed !== "object" || parsed.schema !== SLOT_SCHEMA) {
      if (parsed && typeof parsed === "object" && parsed.schema !== undefined) {
        slotError = "slot schema";
        events.emit("slot-error", new TypeError(`Unknown slot schema: ${String(parsed.schema)}`));
      }
      return;
    }
    slot = parsed;
    slotError = "";
    const decision = fenceDecision(parsed, { role: options.role, token: options.token });
    if (decision.retire) {
      events.emit("retire", decision);
      void retire(decision.reason);
      return;
    }
    rebind(parsed?.scope?.scopeKey);
  }

  function rebind(scopeKey) {
    if (typeof scopeKey !== "string" || scopeKey === prefs.scopeKey) return;
    const path = `${options.state}/prefs/${scopeKey}/${options.role}.json`;
    const loaded = loadPreferences(path, scopeKey, { read: port.read });
    prefs = { ...loaded.prefs, scopeKey };
    events.emit("scope", { scopeKey });
    if (loaded.error) {
      events.emit("prefs-error", loaded.error);
      const notice = t(language.language, "prefsError", { error: loaded.error });
      if (!notices.includes(notice)) notices.push(notice);
    }
  }

  function readSlot() {
    let text;
    try { text = port.readRaw(slotPath); }
    catch (cause) {
      // outcome: an unreadable slot is not a retire reason; the last state stays and
      // the footer shows the source-error label.
      slotError = message(cause);
      events.emit("slot-error", cause);
      return;
    }
    applySlotText(text);
  }

  function readOwner() {
    // owner.json is written once for the layout and then only updated in place, so an
    // absent or unreadable file means "no new evidence": the last record is kept and
    // the label does not flap. Only a well-formed record replaces it.
    try {
      const value = port.read(ownerPath);
      if (value && typeof value === "object" && value.schema === OWNER_SCHEMA) owner = value;
    } catch (cause) {
      // outcome: a missing owner.json is not by itself a connection failure, and the
      // previous liveness evidence still stands.
      void cause;
    }
  }

  function refresh() {
    if (closing || disposed) return;
    readSlot();
    if (closing) return;
    readOwner();
    const scopeKey = prefs.scopeKey ?? slot?.scope?.scopeKey ?? null;
    if (typeof scopeKey !== "string") {
      goal = null;
      goalError = "";
      draw();
      events.emit("frame", frame);
      return;
    }
    const result = readProjection(`${options.state}/data/${scopeKey}/todo.json`, { read: port.read });
    if (result.availability === "source-error" && projection !== null) {
      error = result.error;
    } else {
      projection = result.projection;
      availability = result.availability;
      error = result.error;
    }
    // L5b: the goal row is read on every refresh, so the 1 s repaint is the worst-case latency
    // after the owner writes goal.json. A bad auxiliary file never touches the Todo availability.
    const goalResult = readGoal(`${options.state}/data/${scopeKey}/goal.json`, { read: port.read });
    goal = goalResult.goal;
    goalError = goalResult.error;
    // The selection check walks every task, and the projection only changes when the owner writes
    // it, so the walk runs once per distinct stamp (or selection) instead of once per second.
    const stamp = `${projection?.updatedAt ?? ""}|${prefs.selection ?? ""}`;
    if (projection !== null && prefs.selection !== null && stamp !== checkedStamp) {
      checkedStamp = stamp;
      if (!taskKeys(projection).includes(prefs.selection)) prefs.selection = null;
    }
    draw();
    writeFrame();
    events.emit("frame", frame);
  }

  // Returns the pending preference save, so a caller can await the write. The key
  // still takes effect synchronously on the frame.
  function key(sequence) {
    if (closing || !sequence) return Promise.resolve();
    if (sequence === "q") return Promise.resolve(close());
    if (sequence === "f") {
      prefs.follow = !prefs.follow;
    } else if (sequence === "c") {
      prefs.follow = false;
      prefs.collapsed = !prefs.collapsed;
    } else if (["j", "k", "\x1b[B", "\x1b[A"].includes(sequence)) {
      prefs.follow = false;
      const current = frame ?? draw();
      const stepped = stepSelection(current, sequence === "j" || sequence === "\x1b[B" ? 1 : -1);
      prefs.selection = stepped.selection;
      // A follow-ON frame may sit past the end of the body on purpose (it pins the current
      // phase); prefs only ever store a scroll the body can actually reach.
      prefs.scroll = Math.min(current.scroll, maxScrollOf());
    } else return Promise.resolve();
    // The keyboard always reveals the selection: only a pointer action holds a manual
    // scroll position, and any key that redraws hands it back to the selection.
    revealSelection = true;
    const saved = savePrefs();
    draw();
    writeFrame();
    events.emit("frame", frame);
    return saved;
  }

  // A resize leaves stale cells outside the new frame, so the next write must not be skipped.
  const onResize = () => { lastWritten = null; void paint(); };

  // The wheel and the drag clamp against the last drawn frame: it carries both the row
  // count and the body height, so a pointer can never scroll past the body (AC3.1).
  const maxScrollOf = () => {
    const current = frame ?? draw();
    return Math.max(0, (current.bodyLines?.length ?? 0) - (current.bodyRows ?? 0));
  };

  // The shared tail of every pointer action: the frame is redrawn and the new scroll
  // and follow state are persisted before the caller sees them.
  function commit() {
    const saved = savePrefs();
    draw();
    writeFrame();
    events.emit("frame", frame);
    return saved;
  }

  // SGR pointer reports (AC3.1). Wheel turns follow off and steps the body by three
  // rows; a left press selects the task under the cursor and starts a drag; a motion
  // report with the left button pans the body; a release only ends the drag.
  function onPointer(mouse) {
    if (closing || disposed) return;
    if (mouse.release) { dragY = undefined; return; }
    // The drawn frame owns the scroll position the user sees: follow, resize and a list that
    // shrank all correct it, so every pointer step starts from it, not from the stored pref.
    const shown = frame ?? draw();
    const at = shown.scroll ?? prefs.scroll;
    if (mouse.button & 64) {
      prefs.scroll = Math.min(Math.max(0, at + (mouse.button & 1 ? 3 : -3)), maxScrollOf());
      prefs.follow = false;
      revealSelection = false;
      void commit();
      return;
    }
    if ((mouse.button & 3) !== 0) return;
    if (mouse.button & 32) {
      if (dragY === undefined) return;
      prefs.scroll = Math.min(Math.max(0, at + dragY - mouse.y), maxScrollOf());
      dragY = mouse.y;
      prefs.follow = false;
      revealSelection = false;
      void commit();
      return;
    }
    // Left press. Only a body row can hit a task; every press (hit, miss or a header,
    // divider, footer or blank row) turns follow off and starts a drag.
    const current = frame ?? draw();
    const line = mouse.y - 1;
    const row = line - current.bodyStart + at;
    if (line >= current.bodyStart && line < current.bodyStart + current.bodyRows) {
      const hit = Object.entries(current.taskRanges ?? {})
        .find(([, range]) => row >= range.start && row < range.end);
      // Todo folds the closed phases as one group, so a click only selects the task.
      if (hit) prefs.selection = hit[0];
    }
    // A press commits the position it was aimed at: the screen must not jump back to a stale pref.
    // The clamped value is what a follow-ON frame can persist, not its off-body pin.
    prefs.scroll = Math.min(at, maxScrollOf());
    dragY = mouse.y;
    prefs.follow = false;
    revealSelection = false;
    void commit();
  }

  // AC3.2: losing the pane focus returns follow ON, ends any drag and re-arms the
  // selection reveal, so the pane is back on the live selection the moment it is left.
  // Gaining focus does nothing. Prefs are only written when the follow state changed.
  function onFocus(focused) {
    if (focused || closing || disposed) return;
    dragY = undefined;
    revealSelection = true;
    if (prefs.follow === false) {
      prefs.follow = true;
      void commit();
      return;
    }
    draw();
    events.emit("frame", frame);
  }

  // AC3.3: the Herdr lifecycle subscription is best-effort. A rejection or a
  // `failed(error)` callback shows exactly one footer notice and leaves the DEC 1004
  // reports as the only focus source; nothing here may throw out of the viewer.
  function subscribeFocus() {
    let failed = false;
    const report = (cause) => {
      if (failed || disposed) return;
      failed = true;
      const notice = t(language.language, "focusSubscriptionFailed", { error: message(cause) });
      if (!notices.includes(notice)) notices.push(notice);
      draw();
      events.emit("frame", frame);
    };
    let started;
    try {
      started = watchFocus(options.pane, () => onFocus(false), report, env);
    } catch (cause) {
      // outcome: a watcher that throws synchronously is the same failure as a rejected
      // subscription, and the viewer keeps running on DEC 1004 alone.
      report(cause);
      return;
    }
    Promise.resolve(started).then((dispose) => {
      if (typeof dispose !== "function") return;
      // The subscription can land after `finish()`; it is disposed immediately then.
      if (disposed) dispose();
      else disposeFocus = dispose;
    }, (cause) => { report(cause); });
  }

  try {
    if (isInteractive) {
      enterScreen();
      input.setRawMode?.(true);
      input.resume?.();
      // SGR pointer and DEC 1004 focus reports must be decoded before readline, or the
      // trailing "M" of a mouse report would arrive as a key (AC3.1). A stdin without
      // `on` (a one-shot process) has nothing to subscribe to.
      if (typeof input.on === "function") {
        disposeInput = terminalInput(input, {
          key: (text, pressed) => { void key(pressed?.sequence || pressed?.name || text || ""); },
          pointer: onPointer, focus: onFocus });
      }
      output.on?.("resize", onResize);
    }
    // The ready write AND the first data paint are deferred together (R3): the 1 s repaint
    // timer and the slot watcher start only after the delay, so a late viewer shows no data early.
    if (readyDelay > 0) await new Promise((done) => clock.setTimeout(done, readyDelay));
    // A `q` (or a token-fence retirement) during the delay already ran finish(): start nothing.
    // Nothing starts for a viewer that already finished.
    const alive = !(closing || disposed);
    if (alive && isInteractive) {
      timer = clock.setInterval(() => { void paint(); }, 1000);
      timer?.unref?.();
      watcher = createSlotWatcher({ slotPath, watchFn, clock,
        readFile: (path) => port.readRaw(path),
        onChange: (text) => { applySlotText(text); refresh(); },
        onError: (cause) => events.emit("watch-error", cause) });
      // The subscription is started, never awaited: the ready write and the first
      // paint must not wait for Herdr (AC3.3).
      subscribeFocus();
    }
    if (alive) {
      await writeReady();
      heartbeat.start();
      refresh();
    }
    // `--once` prints exactly one frame and exits 0; the interactive path paints on
    // the timer instead (and on every state change).
    if (alive && (options.once || !isInteractive)) output.write?.(`${draw().text}\n`);
  } catch (cause) {
    events.emit("error", cause);
    closing = true;
    finish("failed");
    throw cause;
  }
  events.emit("started", { language: language.language, gen });

  return {
    events, closed, refresh, key, close, stop, draw,
    get frame() { return frame; },
    get text() { return (frame ?? draw()).text; },
    get state() {
      return { options, language: language.language, gen, availability, error, slotError,
        owner: ownerLiveness(owner, { now: clock.now(), pidAlive }), prefs, notices, slot,
        goal, goalError };
    },
    setOwner(value, { alive } = {}) {
      owner = value;
      if (typeof alive === "function") ownerAlive = alive;
      draw();
      events.emit("frame", frame);
    },
    exit: () => exit(0),
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let options;
  try {
    options = parseViewerArgs(argv);
  } catch (cause) {
    (deps.stderr ?? process.stderr).write?.(`${cause.message}\n`);
    return 2;
  }
  const viewer = await startViewer(options, deps);
  // `--once` printed its frame while starting; there is no loop to run.
  if (options.once) { await viewer.stop(); return 0; }
  // TERM/HUP detach without closing the pane; INT is a user request to close it, the
  // same outcome as `q`.
  const detach = () => { void viewer.stop(); };
  const interrupt = () => { void viewer.close(); };
  process.once("SIGTERM", detach);
  process.once("SIGHUP", detach);
  process.once("SIGINT", interrupt);
  await viewer.closed;
  process.off("SIGTERM", detach);
  process.off("SIGHUP", detach);
  process.off("SIGINT", interrupt);
  return 0;
}

// The CLI entry point. `main` returns the intended exit code and, when run as a
// script, that code becomes the process exit code (0 for a served frame, 2 for a
// usage error).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
