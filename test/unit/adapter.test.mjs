// Host adapter tests: the §7.2 eligibility order (LT-4 matrix), the ctx binding, and the
// single notify message in all three languages.
//
// Nothing here touches a live Herdr, a live GJC, the owner's home or the real OS temp
// directory: every path comes from a scratch directory the test creates and removes, and
// `pidAlive`, `access`, `readFile` and `tmpdir` are all injected.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { ELIGIBILITY_REASONS, bindingOf, catalogueFor, checkEligibility,
  defaultStateDirResolver, isNested, notifyCodes, notifyText } from "../../src/host/gjc-adapter.mjs";
import { ROOT_URL } from "../../src/i18n.mjs";

// A scratch "install" with the four shipped assets R4 requires. It lives under the
// repository sandbox (gitignored) so a crashed run cannot leave anything tracked, and it is
// addressed relative to this file rather than the cwd. The *injected* `tmpdir` is what
// decides mirror detection, so the scratch location itself never matters.
const sandboxBase = fileURLToPath(new URL("../../.sandbox/", import.meta.url));
mkdirSync(sandboxBase, { recursive: true });
const sandboxRoot = mkdtempSync(join(sandboxBase, "adapter-test-"));
const scratch = (name) => join(sandboxRoot, name);
function makeTree(name, { assets = true, locale = '{"todo":"Todo"}' } = {}) {
  const root = scratch(name);
  mkdirSync(root, { recursive: true });
  if (assets) {
    mkdirSync(join(root, "locale"), { recursive: true });
    mkdirSync(join(root, "src", "viewers", "todo"), { recursive: true });
    for (const language of ["ko", "en", "zh-cn"]) {
      writeFileSync(join(root, "locale", `${language}.json`), language === "ko" ? locale : '{"todo":"x"}');
    }
    writeFileSync(join(root, "src", "viewers", "common.mjs"), "export const x = 1;\n");
    writeFileSync(join(root, "src", "viewers", "todo", "viewer.mjs"), "export const x = 1;\n");
  }
  return root;
}

const entryUrlOf = (root) => pathToFileURL(join(root, "extension.mjs")).href;

// A ctx that passes every step, so each test only has to break one thing.
const mainCtx = (extra = {}) => ({ sessionMetadata: { kind: "main" }, hasUI: true, ...extra });
const herdrEnv = (extra = {}) => ({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p9",
  HERDR_SOCKET_PATH: "pipe", ...extra });
// `tmpdir` is deliberately outside the scratch root: the OS temp directory really is a
// mirror location, and the tests must not accidentally depend on where the scratch lives.
const deps = (root, extra = {}) => ({ isTTY: true, hostPid: 111, pidAlive: () => null,
  moduleUrl: entryUrlOf(root), tmpdir: join(sandboxRoot, "not-tmp"), ...extra });

const tree = makeTree("install", {});
const generationRoot = join(scratch("herdr-dashboard"), "generation-000001");
mkdirSync(join(generationRoot, "locale"), { recursive: true });
mkdirSync(join(generationRoot, "src", "viewers", "todo"), { recursive: true });
for (const language of ["ko", "en", "zh-cn"]) {
  writeFileSync(join(generationRoot, "locale", `${language}.json`), '{"todo":"Todo"}');
}
writeFileSync(join(generationRoot, "src", "viewers", "common.mjs"), "x\n");
writeFileSync(join(generationRoot, "src", "viewers", "todo", "viewer.mjs"), "x\n");

test.after(() => rmSync(sandboxRoot, { recursive: true, force: true }));

test("the eligibility order is exactly the plan's eight reasons", () => {
  assert.deepEqual([...ELIGIBILITY_REASONS], ["session-kind", "no-ui", "tty", "outside-herdr",
    "disabled", "nested", "mirrored-install", "state-dir"]);
});

test("each eligibility step is checked in order and reports its own reason", () => {
  // Given a fully eligible host, every single failure below differs by one input.
  // A dev tree derives no state dir (§7.7 state dir 2 needs a generation tree), so the
  // happy path supplies the env override the shim would write.
  const readyEnv = herdrEnv({ GJC_HERDR_DASHBOARD_STATE_DIR: scratch("state") });
  const ready = (root, extra) => checkEligibility(mainCtx(), readyEnv, deps(root, extra));
  assert.deepEqual(ready(tree),
    { ok: true, reason: null, rootUrl: new URL("./", new URL(entryUrlOf(tree))),
      rootPath: tree, stateDir: scratch("state"), moduleUrl: entryUrlOf(tree) });

  const cases = [
    ["session-kind", { ctx: { sessionMetadata: { kind: "sub" }, hasUI: true } }, herdrEnv(), {}],
    ["session-kind", { ctx: { hasUI: true } }, herdrEnv(), {}],
    ["session-kind", { ctx: { sessionMetadata: {}, hasUI: true } }, herdrEnv(), {}],
    ["session-kind", { ctx: { sessionMetadata: { kind: "MAIN" }, hasUI: true } }, herdrEnv(), {}],
    ["no-ui", { ctx: { sessionMetadata: { kind: "main" } } }, herdrEnv(), {}],
    ["no-ui", { ctx: { sessionMetadata: { kind: "main" }, hasUI: "true" } }, herdrEnv(), {}],
    ["tty", { ctx: mainCtx() }, herdrEnv(), { isTTY: false }],
    ["tty", { ctx: mainCtx() }, herdrEnv(), { isTTY: undefined }],
    ["outside-herdr", { ctx: mainCtx() }, {}, {}],
    ["outside-herdr", { ctx: mainCtx() }, herdrEnv({ HERDR_ENV: "0" }), {}],
    ["outside-herdr", { ctx: mainCtx() }, herdrEnv({ HERDR_PANE_ID: "" }), {}],
    ["outside-herdr", { ctx: mainCtx() }, herdrEnv({ HERDR_SOCKET_PATH: undefined }), {}],
    ["disabled", { ctx: mainCtx() }, herdrEnv({ GJC_HERDR_DASHBOARD: "0" }), {}],
    ["nested", { ctx: mainCtx() }, herdrEnv({ GJC_HERDR_DASHBOARD_HOST: "222" }), {}],
    ["mirrored-install", { ctx: mainCtx() }, readyEnv, { moduleUrl: entryUrlOf(scratch("missing")) }],
    ["state-dir", { ctx: mainCtx() }, herdrEnv(), {}],
  ];
  for (const [reason, { ctx }, env, extra] of cases) {
    const result = checkEligibility(ctx, env, deps(tree, extra));
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason, JSON.stringify({ ctx, env, extra }));
  }
});

test("an earlier failure hides a later one, so the order alone decides the reason", () => {
  const readyEnv = herdrEnv({ GJC_HERDR_DASHBOARD_STATE_DIR: scratch("state") });
  // sub session, no UI, no TTY, outside Herdr, disabled, nested: session-kind wins.
  const result = checkEligibility({ sessionMetadata: { kind: "sub" }, hasUI: false }, {},
    deps(tree, { isTTY: false }));
  assert.equal(result.reason, "session-kind");
  // Dropping only session-kind moves the failure to the next step.
  assert.equal(checkEligibility({ sessionMetadata: { kind: "main" }, hasUI: false }, {},
    deps(tree, { isTTY: false })).reason, "no-ui");
  assert.equal(checkEligibility(mainCtx(), {}, deps(tree, { isTTY: false })).reason, "tty");
  assert.equal(checkEligibility(mainCtx(), { GJC_HERDR_DASHBOARD: "0" },
    deps(tree)).reason, "outside-herdr");
  assert.equal(checkEligibility(mainCtx(), herdrEnv({ GJC_HERDR_DASHBOARD: "0",
    GJC_HERDR_DASHBOARD_HOST: "222" }), deps(tree)).reason, "disabled");
  assert.equal(checkEligibility(mainCtx(), herdrEnv({ GJC_HERDR_DASHBOARD_HOST: "222" }),
    deps(tree, { moduleUrl: entryUrlOf(scratch("missing")) })).reason, "nested");
  assert.equal(checkEligibility(mainCtx(), readyEnv,
    deps(scratch("missing"))).reason, "mirrored-install");
  assert.equal(checkEligibility(mainCtx(), herdrEnv(), deps(tree)).reason, "state-dir");
});

test("GJC_HERDR_DASHBOARD accepts every value except the documented off switch", () => {
  for (const value of [undefined, "1", "true", "yes", "", "00"]) {
    const env = herdrEnv(value === undefined ? {} : { GJC_HERDR_DASHBOARD: value });
    assert.equal(checkEligibility(mainCtx(), env, deps(tree)).reason, "state-dir", String(value));
  }
});

test("nested follows R1: a recorded pid is nested unless it is provably dead", () => {
  assert.equal(isNested({}, 111, () => true), false);
  assert.equal(isNested({ GJC_HERDR_DASHBOARD_HOST: "111" }, 111, () => true), false);
  assert.equal(isNested({ GJC_HERDR_DASHBOARD_HOST: "222" }, 111, () => true), true);
  // ESRCH is the only proof of death (R1 forbids takeover on a live or unknowable pid).
  assert.equal(isNested({ GJC_HERDR_DASHBOARD_HOST: "222" }, 111, () => false), false);
  assert.equal(isNested({ GJC_HERDR_DASHBOARD_HOST: "222" }, 111, () => null), true);
  // A recorded value that cannot be a pid is not provably dead either.
  for (const value of ["abc", "0", "-1", "1.5", "  "]) {
    assert.equal(isNested({ GJC_HERDR_DASHBOARD_HOST: value }, 111, () => false), true, value);
  }
  assert.equal(isNested({ GJC_HERDR_DASHBOARD_HOST: " 222 " }, 111, () => false), false);
  assert.equal(isNested({ GJC_HERDR_DASHBOARD_HOST: "" }, 111, () => true), false);
});

test("mirror detection rejects a tree under the OS temp dir or missing a shipped asset", () => {
  // Every tree below is a complete install; only the tmpdir comparison can reject them.
  const underTmp = makeTree("under-tmp", {});
  const sibling = makeTree("not-tmp-sibling", {});
  const nested = makeTree(join("under-tmp", "deeper"), {});
  const readyEnv = herdrEnv({ GJC_HERDR_DASHBOARD_STATE_DIR: scratch("s") });
  assert.equal(checkEligibility(mainCtx(), readyEnv,
    deps(underTmp, { tmpdir: sandboxRoot })).reason, "mirrored-install");
  // The comparison is case-insensitive on win32 and component-based, not equality-based.
  assert.equal(checkEligibility(mainCtx(), readyEnv,
    deps(underTmp, { tmpdir: scratch("UNDER-TMP") })).reason, "mirrored-install");
  assert.equal(checkEligibility(mainCtx(), readyEnv,
    deps(nested, { tmpdir: underTmp })).reason, "mirrored-install");
  // A root that is exactly the tmp dir is rejected without a separator question.
  assert.equal(checkEligibility(mainCtx(), readyEnv,
    deps(sibling, { tmpdir: sibling })).reason, "mirrored-install");
  // A sibling whose name only starts with the tmp path text is not under it, so this
  // complete install stays eligible: the check compares path components, not raw prefixes.
  assert.deepEqual(checkEligibility(mainCtx(), readyEnv,
    deps(sibling, { tmpdir: join(sandboxRoot, "not-tmp") })),
  { ok: true, reason: null, rootUrl: new URL("./", new URL(entryUrlOf(sibling))),
    rootPath: sibling, stateDir: scratch("s"), moduleUrl: entryUrlOf(sibling) });

  const noAssets = makeTree("no-assets", { assets: false });
  assert.equal(checkEligibility(mainCtx(), herdrEnv(), deps(noAssets)).reason, "mirrored-install");

  // Each asset is required on its own; a read-only check is not enough for ko.json.
  for (const relative of ["locale/ko.json", "locale/en.json", "locale/zh-cn.json",
    "src/viewers/common.mjs", "src/viewers/todo/viewer.mjs"]) {
    const root = makeTree(`asset-${relative.replace(/[\\/.]/g, "-")}`, {});
    rmSync(join(root, relative));
    assert.equal(checkEligibility(mainCtx(), herdrEnv(), deps(root)).reason, "mirrored-install",
      relative);
  }

  const broken = makeTree("broken-locale", { locale: "{" });
  assert.equal(checkEligibility(mainCtx(), herdrEnv(), deps(broken)).reason, "mirrored-install");
  assert.equal(checkEligibility(mainCtx(), herdrEnv(), deps(tree)).reason, "state-dir");
});

test("the state dir resolves from the env override, then a generation tree, else null", () => {
  assert.equal(defaultStateDirResolver(tree, {}), null);
  assert.equal(defaultStateDirResolver(tree, { GJC_HERDR_DASHBOARD_STATE_DIR: scratch("s1") }),
    scratch("s1"));
  assert.equal(defaultStateDirResolver(tree, { GJC_HERDR_DASHBOARD_STATE_DIR: "  " }), null);
  // stage-05 R4 item 2: generation-NNNNNN under a `herdr-dashboard` parent.
  assert.equal(defaultStateDirResolver(generationRoot, {}), join(scratch("herdr-dashboard"), "state"));
  const lookalike = join(scratch("herdr-dashboard"), "generation-00001");
  assert.equal(defaultStateDirResolver(lookalike, {}), null);
  assert.equal(defaultStateDirResolver(join(scratch("other"), "generation-000001"), {}), null);
  assert.equal(defaultStateDirResolver(`${generationRoot}\\`, {}).replaceAll("\\", "/"),
    join(scratch("herdr-dashboard"), "state").replaceAll("\\", "/"));
});

test("a generation tree keeps the dev tree's eligibility, with the state dir it derives", () => {
  const result = checkEligibility(mainCtx(), herdrEnv(), deps(generationRoot));
  assert.equal(result.ok, true);
  assert.equal(result.stateDir, join(scratch("herdr-dashboard"), "state"));
});

test("a degraded call is answered, never thrown, and a bad module URL is not an install", () => {
  // A host that hands a handler an unexpected shape must not make the extension throw; the
  // worst case is an ineligible verdict the user can read.
  assert.deepEqual(checkEligibility(null, null, null), { ok: false, reason: "session-kind" });
  assert.deepEqual(bindingOf(null, null), { socket: null, parentPaneId: null, tabId: null,
    sessionId: null });
  const env = herdrEnv();
  const depsFor = (moduleUrl) => deps(tree, { moduleUrl, stateDirResolver: () => scratch("state") });
  for (const bad of ["not a url", "https://example.invalid/ext.mjs", "", null]) {
    assert.equal(checkEligibility(mainCtx(), env, depsFor(bad)).reason, "mirrored-install",
      String(bad));
  }
  // An absent `moduleUrl` is not a bad one: the default is this package root, and the repo
  // tree really does carry the R4 assets, so the only thing left to decide is the state dir.
  const fallback = checkEligibility(mainCtx(), env,
    deps(tree, { moduleUrl: undefined, stateDirResolver: () => null }));
  assert.equal(fallback.reason, "state-dir");
  // A ROOT directory URL is accepted as-is, with or without the trailing slash.
  for (const moduleUrl of [entryUrlOf(tree), new URL("./", new URL(entryUrlOf(tree))),
    new URL(entryUrlOf(tree))]) {
    const result = checkEligibility(mainCtx(), env,
      deps(tree, { moduleUrl, stateDirResolver: () => scratch("state") }));
    assert.equal(result.ok, true, String(moduleUrl));
    assert.equal(result.rootPath, tree);
  }
  // A non-file protocol can never be a shipped tree.
  assert.equal(checkEligibility(mainCtx(), env,
    deps(tree, { moduleUrl: "data:text/javascript," })).reason, "mirrored-install");
});

test("bindingOf reads the environment and the session id, and never throws", () => {
  const ctx = mainCtx({ sessionManager: { getSessionId: () => "S1" } });
  assert.deepEqual(bindingOf(ctx, { HERDR_SOCKET_PATH: "pipe", HERDR_PANE_ID: "w1:p9",
    HERDR_TAB_ID: "w1:t1" }), { socket: "pipe", parentPaneId: "w1:p9", tabId: "w1:t1",
    sessionId: "S1" });
  // No tab id is not an error: the reconciler resolves it through pane get.
  assert.deepEqual(bindingOf(ctx, { HERDR_SOCKET_PATH: "pipe", HERDR_PANE_ID: "w1:p9" }),
    { socket: "pipe", parentPaneId: "w1:p9", tabId: null, sessionId: "S1" });
  for (const bad of [{}, { sessionManager: {} }, { sessionManager: { getSessionId: () => 7 } },
    { sessionManager: { getSessionId() { throw new Error("no session"); } } }]) {
    assert.equal(bindingOf(bad, {}).sessionId, null, JSON.stringify(bad));
  }
  assert.deepEqual(bindingOf(undefined, undefined), { socket: null, parentPaneId: null,
    tabId: null, sessionId: null });
  assert.deepEqual(bindingOf(null, null), { socket: null, parentPaneId: null, tabId: null,
    sessionId: null });
});

test("the notify covers every plan code in all three languages, always with a gen token", () => {
  const cases = ["opened", "adopted", "ready", "pending", "pending-slow", "partial:size",
    "partial:shape", "partial:timeout", "busy", "busy:other-owner", "unresponsive",
    "replaced:dead", "replaced:stalled", "ineligible:session-kind", "ineligible:no-ui",
    "ineligible:tty", "ineligible:outside-herdr", "ineligible:disabled", "ineligible:nested",
    "ineligible:mirrored-install", "ineligible:state-dir", "failed:node", "failed:viewer",
    "failed:herdr", "failed:herdr-split", "failed:herdr-close", "failed:lock-io",
    "failed:failpoint", "warn:duplicate-install"];
  // The gen token is the drill's decision input, so it must be present and must be the only
  // thing two languages are allowed to share for one code.
  for (const code of cases) {
    const lines = [];
    for (const language of ["ko", "en", "zh-cn"]) {
      for (const gen of ["gen-000001", "dev"]) {
        const line = notifyText({ code }, language, gen);
        assert.equal(typeof line, "string");
        assert.ok(line.includes(gen), `${language} ${code} gen token`);
        assert.ok(line.length < 140, `${language} ${code} is one short line: ${line}`);
        assert.ok(!line.includes("null") && !line.includes("undefined"), line);
        lines.push(line);
      }
    }
    assert.equal(new Set(lines).size, 6, `${code}: ${lines.join(" | ")}`);
    // And the language really changes the wording of at least one generation form.
    assert.notEqual(lines[1], lines[0], code);
    assert.notEqual(lines[3], lines[0], code);
    assert.notEqual(lines[5], lines[0], code);
  }
  // Machine tokens survive the translation, so a drill can grep the notify.
  for (const language of ["ko", "en", "zh-cn"]) {
    const ineligible = notifyText({ code: "ineligible:state-dir" }, language, "dev");
    const failed = notifyText({ code: "failed:herdr-split" }, language, "dev");
    assert.ok(ineligible.includes("state-dir"), ineligible);
    assert.ok(failed.includes("herdr-split"), failed);
    // The eight eligibility reasons are all reachable from the plan's reason list.
    for (const reason of ELIGIBILITY_REASONS) {
      assert.ok(notifyText({ code: `ineligible:${reason}` }, language, "dev").includes(reason),
        `${language} ${reason}`);
    }
  }
  // Every documented code is covered above, so a new code cannot slip through unnoticed.
  assert.deepEqual([...notifyCodes].filter((code) => !cases.some((entry) =>
    entry === code || entry.startsWith(`${code}:`))), []);
});

test("every code the reconciler can emit has its own wording, not a raw fallback", () => {
  // The codes below are read off `src/core/reconciler.mjs` and `src/core/launch.mjs` (lane
  // C). If a new one appears there, this test must grow a key rather than silently render
  // `why: x` / `code: x` at the user.
  const emitted = ["partial:size", "partial:shape", "partial:timeout",
    "partial:ownership-unproven", "replaced:dead", "replaced:stalled", "failed:node",
    "failed:viewer", "failed:herdr", "failed:herdr-split", "failed:herdr-close",
    "failed:herdr-process-info", "failed:herdr-record", "failed:herdr-rename",
    "failed:herdr-run", "failed:lock-io", "failed:internal", "failed:failpoint",
    "busy", "busy:other-owner", "opened", "adopted", "ready", "pending", "pending-slow",
    "unresponsive"];
  for (const language of ["ko", "en", "zh-cn"]) {
    for (const code of emitted) {
      const line = notifyText({ code }, language, "dev");
      assert.ok(!line.includes("why: ") && !line.includes("code: ") &&
        !line.includes("reason: ") && !line.includes("notify."), `${language} ${code}: ${line}`);
    }
  }
});

test("notify renders role detail, viewer generations and the busy holder snapshot", () => {
  const opened = notifyText({ code: "opened", roles: { todo: { code: "opened", id: "T1",
    paneId: "w1:p9" } } }, "en", "gen-000002");
  assert.equal(opened, "ext gen-000002 · Todo opened");
  // A pending role says the viewer is still on its way (R5's message form).
  assert.equal(notifyText({ code: "pending", roles: { todo: { code: "pending", id: "T1" } } },
    "en", "gen-000002"), "ext gen-000002 · Todo pending viewer pending");
  // An adopted role may run an older viewer than the extension: both generations show.
  assert.equal(notifyText({ code: "adopted", roles: { todo: { code: "adopted", id: "T1",
    detail: { viewerGen: "gen-000001" } } } }, "en", "gen-000002"),
  "ext gen-000002 · Todo adopted viewer gen-000001");
  assert.equal(notifyText({ code: "partial:size", roles: { todo: { code: "partial:size",
    id: "T1", paneId: "w1:p9", detail: "parent 30x6 < 40x8" } } }, "en", "dev"),
  "ext dev · Todo partial (not enough room: size) pane w1:p9");
  // R1: the busy notify carries pid, generation and the lock path for manual recovery.
  assert.equal(notifyText({ code: "busy", roles: { todo: { code: "busy" } },
    busy: { pid: 4321, generation: 12, path: "C:/state/slots/ab/lock" } }, "en", "dev"),
  "ext dev · Todo busy · pid 4321 · g000000000012 · C:/state/slots/ab/lock");
  // An unknowable holder is reported as unknown rather than as a possibly wrong pid.
  assert.equal(notifyText({ code: "busy:other-owner", roles: { todo: { code: "busy:other-owner" } },
    busy: { generation: null, path: "C:/state" } }, "en", "dev"),
  "ext dev · Todo busy (other owner) · pid unknown · g? · C:/state");
  // A code with no role map still produces one line.
  assert.equal(notifyText("ready", "en", "dev"), "ext dev · ready");
  // A pass-level outcome is never hidden behind a role row that looks quieter.
  assert.equal(notifyText({ code: "busy", roles: { todo: { code: "pending", id: null } },
    lock: { generation: 3, dir: "C:/state" } }, "en", "dev"),
  "ext dev · Todo pending viewer pending · busy · pid unknown · g000000000003 · C:/state");
  assert.equal(notifyText({ code: "failed:internal", roles: { todo: { code: "pending" } } },
    "en", "dev"), "ext dev · Todo pending viewer pending · failed (internal error: internal)");
  assert.equal(notifyText({ code: "partial:timeout", roles: { todo: { code: "opened",
    paneId: "w1:p9" } } }, "en", "dev"),
  "ext dev · Todo opened · partial (timed out: timeout)");
  // The A-29 not-O+ branch keeps the orphan: the notify names the pane the user must find.
  assert.equal(notifyText({ code: "partial:ownership-unproven", roles: { todo: {
    code: "partial:ownership-unproven", keptPaneId: "w1:p7", detail: "still-present" } } },
  "en", "dev"),
  "ext dev · Todo partial (ownership not proven: ownership-unproven) pane w1:p7");
  // A bare code with the reason only in `detail` still gets a localized token.
  assert.equal(notifyText({ code: "partial", roles: { todo: { code: "partial",
    detail: "shape" } } }, "en", "dev"), "ext dev · Todo partial (pane shape: shape)");  // A lock that could not be read still names the generation and directory it measured.
  assert.equal(notifyText({ code: "busy", roles: { todo: { code: "busy" } },
    lock: { generation: 7, dir: "C:/state/slots/ab/lock" } }, "en", "dev"),
  "ext dev · Todo busy · pid unknown · g000000000007 · C:/state/slots/ab/lock");
});

test("an unknown code or reason is shown raw instead of being swallowed", () => {
  assert.equal(notifyText({ code: "ineligible:no-such-reason" }, "en", "dev"),
    "ext dev · ineligible (reason: no-such-reason)");
  assert.equal(notifyText({ code: "failed:weird" }, "en", "dev"), "ext dev · failed (code: weird)");
  assert.equal(notifyText({ code: "totally-new" }, "en", "dev"),
    "ext dev · unknown result (totally-new)");
  assert.equal(notifyText({}, "en", "dev"), "ext dev · failed (unknown: unknown)");
  assert.equal(notifyText(undefined, "en", undefined), "ext dev · failed (unknown: unknown)");
});

test("a broken catalogue degrades to the raw code but still yields exactly one message", () => {
  const empty = makeTree("empty-root", {});
  rmSync(join(empty, "locale"), { recursive: true, force: true });
  const rootUrl = new URL(`file:///${empty.replaceAll("\\", "/")}/`);
  // The module-level cache is keyed by root, so this root was never loaded before.
  assert.throws(() => catalogueFor(rootUrl).messages("ko"), /ENOENT|no such file/);
  const line = notifyText({ code: "opened" }, "ko", "gen-000009", { rootUrl });
  assert.equal(line, "ext gen-000009 · opened");
  assert.equal(notifyText({ code: "busy" }, "ko", "dev", { rootUrl }), "ext dev · busy");
});

test("the shipped catalogue is complete for every notify key the adapter asks for", () => {
  const catalogue = catalogueFor(ROOT_URL);
  const required = [];
  for (const language of ["ko", "en", "zh-cn"]) {
    const messages = catalogue.messages(language);
    for (const [key, value] of Object.entries(messages)) {
      if (key.startsWith("notify.")) assert.ok(value.length > 0, `${language}.${key}`);
    }
    required.push(Object.keys(messages).filter((key) => key.startsWith("notify.")).sort());
  }
  // Lane B's parity test owns the generic key check; this pins the notify subset it covers.
  assert.deepEqual(required[1], required[0]);
  assert.deepEqual(required[2], required[0]);
  assert.ok(required[0].length >= 40, String(required[0].length));
});
