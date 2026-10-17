// Host adapter for the GJC Herdr dashboard: eligibility gate, ctx binding, and the
// single notify message. Plan stage-03 §7.2 (as amended by stage-05 R1/R4/R6).
//
// Why this module exists: the instance (`src/host/instance.mjs`, another lane) owns
// arming and the registry, the reconciler (`src/core/reconciler.mjs`) owns panes and
// files. Everything that reads the GJC host surface (ctx, HERDR_* environment, the
// install layout) or turns a pass result into one user-visible line lives here, so it
// can be unit-tested without a live host, a live Herdr or the owner's home.
//
// Exported signatures
//   ELIGIBILITY_REASONS: readonly string[]      // exact order of §7.2
//   notifyCodes: readonly string[]              // every code §7.4 can produce
//   catalogueFor(rootUrl)                       // createI18n bound to a tree, cached per root
//   defaultStateDirResolver(rootPath, env?)     // absolute state dir or null (R4)
//   isNested(env?, hostPid?, pidAlive?)         // R1 nested rule
//   checkEligibility(ctx, env?, deps?)          // { ok: true, reason: null, rootPath,
//                                               //   rootUrl, stateDir, moduleUrl }
//                                               // | { ok: false, reason }
//   bindingOf(ctx, env?)                        // { socket, parentPaneId, tabId, sessionId }
//   notifyText(result, language, gen, deps?)    // one line, always includes the gen token
//
// `deps` for checkEligibility (every key optional; the instance passes them all):
//   isTTY            `process.stdout.isTTY === true`
//   hostPid          this process pid
//   pidAlive         `src/core/liveness.mjs` pidAlive (null means "cannot tell")
//   moduleUrl        the entry module's `import.meta.url`, or a ROOT directory URL
//                    ending in `/`. Assets resolve against this root (stage-05 R4).
//   tmpdir           `os.tmpdir()`
//   stateDirResolver (rootPath, env) -> absolute state dir or null
//   roles            released roles whose viewer entry must exist (default ['todo'])
//   access           `fs.accessSync` (injected so a test can fake a layout)
//   readFile         `fs.readFileSync`, used to parse `locale/ko.json`
//
// `deps` for notifyText: `rootUrl` selects the locale catalogue (defaults to this
// package root). notifyText never throws: a catalogue that cannot be read degrades to
// the raw code with the generation token still attached, because a pass must always
// produce exactly one message (LT-4).
//
// Message shape (R5): `ext <gen> · <role> <code>` plus, when the caller knows it,
// ` viewer <viewerGen>`; a role that is still pending reads `viewer pending`. A partial
// result also carries `pane <id>` when the pass kept an orphan, which is what makes the
// accepted-orphan branch readable to the user (A-29: the kept pane is the whole point).
// The role rows come from the reconciler's result
// (`roles: { todo: { code, id, paneId, keptPaneId, detail, failure } }`), so this module
// never formats a pass it did not receive, and it never invents a generation it was not
// told. The pass-level `code` is always shown too when no role row carries it, because
// LT-4 requires one message per result, not one message per role. A `busy` result appends
// R1's `pid <P|미확인> · g<N> · <path>` line from whatever the pass measured (`busy`, an
// object `detail`, or the reconciler's `lock`), which is the input to the README's
// manual-recovery step; when the holder pid was never read it is rendered as unknown
// rather than guessed.
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { ROLE_LABELS } from "../core/slot.mjs";
import { pidAlive as defaultPidAlive } from "../core/liveness.mjs";
import { createI18n, languageOf } from "../i18n.mjs";

// The eligibility order is contractual (stage-03 §7.2). LT-4 walks this list.
export const ELIGIBILITY_REASONS = Object.freeze([
  "session-kind", "no-ui", "tty", "outside-herdr", "disabled", "nested",
  "mirrored-install", "state-dir",
]);

// Every code stage-03 §7.4 can produce (plus the instance-level duplicate warning).
export const notifyCodes = Object.freeze([
  "opened", "adopted", "ready", "pending", "pending-slow", "partial", "busy",
  "busy:other-owner", "unresponsive", "replaced", "ineligible", "failed",
  "warn:duplicate-install",
]);

const DEFAULT_MODULE_URL = new URL("../../", import.meta.url);
const DEFAULT_ROLES = Object.freeze(["todo"]);
const ASSET_FILES = Object.freeze(["locale/ko.json", "locale/en.json", "locale/zh-cn.json",
  "src/viewers/common.mjs"]);

const text = (value) => (typeof value === "string" && value !== "" ? value : null);
const message = (cause) => String(cause?.message ?? cause ?? "error");

// Every entry point tolerates a degraded call: `null` where an object is expected is treated
// as `{}`, so a host that hands a handler an unexpected shape cannot make the extension throw
// inside an event (LT-1: a throw in `session_start` must not latch, and a throw in `/dashboard`
// would lose the one notify the user is owed).
const objectOr = (value) => (value && typeof value === "object" ? value : {});

const catalogues = new Map();

// One catalogue per root: the locale must come from the same tree as the entry
// module (stage-05 R4), and a generation tree has its own copy of `locale/`.
export function catalogueFor(rootUrl) {
  const key = rootUrl.href;
  const cached = catalogues.get(key);
  if (cached) return cached;
  const created = createI18n(rootUrl, { readFile: (path) => readFileSync(path, "utf8") });
  catalogues.set(key, created);
  return created;
}

// `moduleUrl` may be a file URL or a ROOT directory URL (trailing slash). Returns null when
// it is neither, which the caller reports as `mirrored-install`: a tree that cannot even be
// resolved is not an install, and R4 has no fallback path to guess one.
function rootUrlOf(moduleUrl) {
  try {
    const url = moduleUrl instanceof URL ? moduleUrl : new URL(String(moduleUrl));
    if (url.protocol !== "file:") return null;
    return url.href.endsWith("/") ? url : new URL("./", url);
  } catch {
    // outcome: an unparseable module URL cannot prove a real install tree.
    return null;
  }
}

// `fileURLToPath` of a directory URL keeps a trailing separator on win32; the paths this
// module reports and compares are normalized so callers can compare them with `join`.
function rootPathOf(rootUrl) {
  const path = fileURLToPath(rootUrl);
  return path.replace(/[\\/]+$/, "") || path;
}

// Real-path comparison, case-insensitive on win32 (stage-05 R4).
function realPathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    // outcome: an unresolvable path is compared as given; it can only make the
    // mirror check stricter, never weaker.
    return resolve(path);
  }
}

function underTmpdir(rootPath, tmpPath) {
  const root = realPathOf(rootPath).toLowerCase().replace(/[\\/]+$/, "");
  const tmp = realPathOf(tmpPath).toLowerCase().replace(/[\\/]+$/, "");
  return root === tmp || root.startsWith(`${tmp}${sep}`);
}

// stage-05 R4 mirror detection: a tree under the OS temp directory (an install that
// was copied into a scratch location) or one that is missing a shipped asset is a
// mirror, not an install. `ko.json` must parse as well as exist.
function isMirrored(rootPath, tmpPath, roles, access, readFile) {
  if (underTmpdir(rootPath, tmpPath)) return true;
  const required = [...ASSET_FILES, ...roles.map((role) => `src/viewers/${role}/viewer.mjs`)];
  for (const relative of required) {
    try {
      access(join(rootPath, relative), constants.R_OK);
    } catch {
      // outcome: a missing asset is a mirrored install, the caller returns ineligible.
      return true;
    }
  }
  try {
    const parsed = JSON.parse(readFile(join(rootPath, "locale/ko.json"), "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return true;
  } catch {
    // outcome: an unreadable or malformed ko catalogue is a mirrored install.
    return true;
  }
  return false;
}

// stage-05 R4 state-dir rule: the env override wins, then a `generation-NNNNNN` tree
// whose parent is `herdr-dashboard` uses `<parent>/state`, anything else is null and
// the caller reports `ineligible:state-dir`.
export function defaultStateDirResolver(rootPath, env = {}) {
  const override = text(objectOr(env).GJC_HERDR_DASHBOARD_STATE_DIR)?.trim();
  if (override) return resolve(override);
  const clean = String(rootPath ?? "").replace(/[\\/]+$/, "");
  if (!clean) return null;
  const base = basename(clean);
  if (/^generation-\d{6}$/.test(base) && basename(dirname(clean)) === "herdr-dashboard") {
    return join(dirname(clean), "state");
  }
  return null;
}

// R1 nested rule: a recorded host pid that is not provably dead means another GJC
// already owns this pane. A junk value is not provably dead either, so it is nested.
export function isNested(env = {}, hostPid = process.pid, pidAlive = defaultPidAlive) {
  const recorded = text(objectOr(env).GJC_HERDR_DASHBOARD_HOST);
  if (!recorded) return false;
  const pid = Number(recorded.trim());
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  if (pid === hostPid) return false;
  return (typeof pidAlive === "function" ? pidAlive(pid) : null) !== false;
}

// Every entry point tolerates a degraded call, see `objectOr` above.
export function checkEligibility(ctx, env = {}, deps = {}) {
  const {
    isTTY = Boolean(process.stdout?.isTTY),
    hostPid = process.pid,
    pidAlive = defaultPidAlive,
    moduleUrl = DEFAULT_MODULE_URL,
    tmpdir = osTmpdir(),
    stateDirResolver = defaultStateDirResolver,
    roles = DEFAULT_ROLES,
    access = accessSync,
    readFile = readFileSync,
  } = objectOr(deps);
  const environment = objectOr(env);
  const deny = (reason) => ({ ok: false, reason });

  if (ctx?.sessionMetadata?.kind !== "main") return deny("session-kind");
  if (ctx?.hasUI !== true) return deny("no-ui");
  if (isTTY !== true) return deny("tty");
  if (environment.HERDR_ENV !== "1" || !text(environment.HERDR_PANE_ID) ||
      !text(environment.HERDR_SOCKET_PATH)) {
    return deny("outside-herdr");
  }
  if (environment.GJC_HERDR_DASHBOARD === "0") return deny("disabled");
  if (isNested(environment, hostPid, pidAlive)) return deny("nested");

  const rootUrl = rootUrlOf(moduleUrl);
  if (!rootUrl) return deny("mirrored-install");
  const rootPath = rootPathOf(rootUrl);
  if (isMirrored(rootPath, tmpdir, roles, access, readFile)) return deny("mirrored-install");

  const stateDir = stateDirResolver(rootPath, environment);
  if (!text(stateDir)) return deny("state-dir");

  return { ok: true, reason: null, rootUrl, rootPath, stateDir, moduleUrl: String(moduleUrl) };
}

// §7.2 rebinding unit. `tabId` comes from the environment when Herdr exported it;
// otherwise it is null here and the reconciler resolves it through `pane get`, which
// is the only place that may talk to Herdr. `sessionId` is read defensively: a
// degraded ctx must not throw inside a handler.
export function bindingOf(ctx, env = {}) {
  const environment = objectOr(env);
  let sessionId = null;
  try {
    const value = ctx?.sessionManager?.getSessionId?.();
    if (typeof value === "string" && value !== "") sessionId = value;
  } catch {
    // outcome: an unreadable session id stays null; the caller decides (T18/T5 path).
    sessionId = null;
  }
  return {
    socket: text(environment.HERDR_SOCKET_PATH),
    parentPaneId: text(environment.HERDR_PANE_ID),
    tabId: text(environment.HERDR_TAB_ID),
    sessionId,
  };
}

// The machine token is kept verbatim next to its localized description, so a drill can
// grep the notify and a user can still read it: `ineligible (state dir: state-dir)`.
const REASON_KEYS = { "session-kind": "notify.reason.session-kind", "no-ui": "notify.reason.no-ui",
  tty: "notify.reason.tty", "outside-herdr": "notify.reason.outside-herdr",
  disabled: "notify.reason.disabled", nested: "notify.reason.nested",
  "mirrored-install": "notify.reason.mirrored-install", "state-dir": "notify.reason.state-dir" };
const WHY_KEYS = { size: "notify.why.size", shape: "notify.why.shape", timeout: "notify.why.timeout",
  dead: "notify.why.dead", stalled: "notify.why.stalled",
  "ownership-unproven": "notify.why.ownership-unproven" };
const FAILURE_KEYS = { node: "notify.failure.node", viewer: "notify.failure.viewer",
  herdr: "notify.failure.herdr", "herdr-split": "notify.failure.herdr-split",
  "herdr-close": "notify.failure.herdr-close", "herdr-process-info": "notify.failure.herdr-process-info",
  "herdr-record": "notify.failure.herdr-record", "herdr-rename": "notify.failure.herdr-rename",
  "herdr-run": "notify.failure.herdr-run", "lock-io": "notify.failure.lock-io",
  internal: "notify.failure.internal", failpoint: "notify.failure.failpoint",
  unknown: "notify.failure.unknown" };
const CODE_KEYS = new Set(["opened", "adopted", "ready", "pending", "pending-slow",
  "unresponsive", "busy", "busy:other-owner", "warn-duplicate-install"]);

const baseCodeOf = (code) => {
  const value = String(code ?? "");
  const colon = value.indexOf(":");
  return colon < 0 ? value : value.slice(0, colon);
};

// The token comes from the code itself (`partial:size`), which is what the reconciler
// emits; `detail` is only consulted for a bare `partial`/`failed` and is otherwise extra
// context the caller may keep for its own logging. The detail is never used as a token:
// it holds free text such as a rect comparison or an errno, and printing that inside
// `partial (...)` would be noise.
const argumentOf = (code, fallback) => {
  const colon = String(code ?? "").indexOf(":");
  if (colon >= 0) return String(code).slice(colon + 1);
  return String(fallback ?? "");
};

// A localized token is paired with the raw protocol token: an unknown reason must still
// reach the user instead of being swallowed, and a drill must be able to grep it.
function tokenOf(catalogue, language, table, token, prefix) {
  const key = table[token];
  const described = key && catalogue.has(language, key) ? catalogue.t(language, key) : null;
  if (!token) return described ?? prefix;
  return described ? `${described}: ${token}` : `${prefix} ${token}`;
}

export function notifyText(result, language, gen, deps = {}) {
  const { rootUrl = DEFAULT_MODULE_URL } = objectOr(deps);
  const input = typeof result === "string" ? { code: result } : (result ?? {});
  const code = typeof input.code === "string" && input.code !== "" ? input.code : "failed:unknown";
  const generation = text(gen) ?? "dev";
  const lang = languageOf(language);
  let catalogue;
  try {
    catalogue = catalogueFor(rootUrl);
    // Load the catalogue once up front: `t`/`has` read lazily, so an unreadable tree would
    // otherwise throw halfway through building the message.
    catalogue.messages(lang);
  } catch {
    // outcome: an unreadable catalogue still yields one message; only the wording is raw.
    return `ext ${generation} · ${code}`;
  }
  const say = (key, values) => (catalogue.has(lang, key) ? catalogue.t(lang, key, values) : key);

  const codeText = (value, fallbackArgument) => {
    const base = baseCodeOf(value);
    const argument = argumentOf(value, fallbackArgument);
    switch (base) {
      case "partial":
        return say("notify.code.partial",
          { why: tokenOf(catalogue, lang, WHY_KEYS, argument, "why:") });
      case "replaced":
        return say("notify.code.replaced",
          { why: tokenOf(catalogue, lang, WHY_KEYS, argument, "why:") });
      case "ineligible":
        return say("notify.code.ineligible",
          { reason: tokenOf(catalogue, lang, REASON_KEYS, argument, "reason:") });
      case "failed":
        return say("notify.code.failed",
          { code: tokenOf(catalogue, lang, FAILURE_KEYS, argument, "code:") });
      case "busy":
        return String(value) === "busy:other-owner"
          ? say("notify.code.busy:other-owner") : say("notify.code.busy");
      case "warn":
      case "warn:duplicate-install":
        return say("notify.code.warn-duplicate-install");
      default:
        return CODE_KEYS.has(String(value)) ? say(`notify.code.${value}`)
          : say("notify.code.unknown", { code: String(value) });
    }
  };

  // R1: a busy notify always carries the holder snapshot (`pid <P|unknown> · g<N> · <path>`),
  // for `busy` and for `busy:other-owner` alike: the other-owner case is precisely the one
  // the manual-recovery step is written for. The snapshot is whatever the pass measured — an
  // explicit `busy` object, an object `detail`, or the reconciler's `lock` (generation +
  // directory), which is what a pass that could not inspect the lock file can honestly
  // report. Nothing is invented.
  const sayBusyInfo = (snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return null;
    const pid = Number.isSafeInteger(snapshot.pid) && snapshot.pid > 0
      ? String(snapshot.pid) : say("notify.busyUnknownPid");
    const generationValue = Number.isSafeInteger(snapshot.generation) && snapshot.generation > 0
      ? String(snapshot.generation).padStart(12, "0") : "?";
    return say("notify.busyInfo",
      { pid, generation: generationValue, path: String(snapshot.path ?? "?") });
  };

  const segments = [];
  const seen = new Set();
  const roles = input.roles && typeof input.roles === "object" && !Array.isArray(input.roles)
    ? Object.entries(input.roles) : [];
  for (const [role, entry] of roles) {
    const recorded = typeof entry === "string" ? { code: entry } : (entry ?? {});
    const roleCode = typeof recorded.code === "string" && recorded.code !== ""
      ? recorded.code : code;
    const detail = typeof recorded.detail === "string" ? recorded.detail : "";
    seen.add(roleCode);
    const parts = [ROLE_LABELS[role] ?? role, codeText(roleCode, detail)];
    const viewerGen = text(recorded.viewerGen ?? (recorded.detail && typeof recorded.detail === "object"
      ? recorded.detail.viewerGen : null));
    if (viewerGen) parts.push(say("notify.viewer", { gen: viewerGen }));
    else if (["pending", "pending-slow"].includes(baseCodeOf(roleCode))) {
      parts.push(say("notify.viewerPending"));
    }
    // A partial result names the pane it deliberately left alone (A-29): the user has to be
    // able to find it before deciding whether to close it by hand.
    if (baseCodeOf(roleCode) === "partial") {
      const kept = text(recorded.keptPaneId) ?? text(recorded.paneId);
      if (kept) parts.push(say("notify.pane", { id: kept }));
    }
    segments.push(parts.join(" "));
  }
  // The reconciler's aggregate is the strongest thing the pass did. A role row can only
  // describe its own role, so a pass-level outcome — a lock that stayed busy, an internal
  // failure, a close that failed while the record was kept — would otherwise disappear
  // behind `Todo pending`. LT-4 requires one message per result, not one message per role.
  if (!seen.has(code)) {
    const detail = typeof input.detail === "string" ? input.detail : "";
    segments.push(codeText(code, detail));
  }
  const base = baseCodeOf(code);
  if (base === "busy") {
    const snapshot = input.busy ?? (typeof input.detail === "object" ? input.detail : null) ??
      (input.lock ? { generation: input.lock.generation, path: input.lock.dir } : null);
    const rendered = sayBusyInfo(snapshot);
    if (rendered) segments.push(rendered);
  }
  return `${say("notify.header", { gen: generation })} · ${segments.join(" · ")}`;
}
