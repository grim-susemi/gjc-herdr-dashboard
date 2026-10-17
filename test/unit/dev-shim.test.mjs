// Dev shim tests (plan §7.7, stage-05 R4/R3). The shim is what every sandbox case and
// every live drill loads, so its two jobs are pinned here: the re-export must point at the
// absolute URL of the real `extension.mjs` (never a relative path, never a copy), and the
// env defaults must be visible to the factory that GJC calls after loading.
//
// Everything runs against a scratch "repo" and a scratch sandbox root under the repository
// sandbox (gitignored), so the real `.sandbox/case-*` trees, the real entry and the owner's
// home are untouched. The generated file is imported for real: a shim that only looks right
// when printed is worthless.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SHIM_FILE, SHIM_USAGE, main, parseShimArgs, shimPlan, shimSource, writeShim }
  from "../../scripts/dev-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const sandboxBase = join(repo, ".sandbox");
mkdirSync(sandboxBase, { recursive: true });
const sandboxRoot = mkdtempSync(join(sandboxBase, "dev-shim-test-"));
const scratchRoot = join(sandboxRoot, "sandbox");
const scratchRepo = join(sandboxRoot, "repo");
const RECORDS = Symbol.for("gjc-dev-shim-test-records");

// The scratch entry stands in for the real `extension.mjs`: it records the environment
// twice — once while the module body is evaluated (import time) and once inside the
// factory — so the ordering the shim promises is observable, not asserted from prose. The
// record lives on a well-known global: the shim imports this module by URL, and the test
// reaches it through the same symbol.
mkdirSync(scratchRepo, { recursive: true });
writeFileSync(join(scratchRepo, "extension.mjs"), [
  `globalThis[Symbol.for('gjc-dev-shim-test-records')] ??= [];`,
  `const env = () => ({`,
  "  stateDir: process.env.GJC_HERDR_DASHBOARD_STATE_DIR,",
  "  herdr: process.env.GJC_HERDR_DASHBOARD_HERDR,",
  "  failpoint: process.env.GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT,",
  "});",
  `globalThis[Symbol.for('gjc-dev-shim-test-records')].push({ at: 'import', ...env() });`,
  "export default function (pi) {",
  `  globalThis[Symbol.for('gjc-dev-shim-test-records')].push({ at: 'factory', ...env(), pi });`,
  "}",
].join("\n"));

const ENV_KEYS = ["GJC_HERDR_DASHBOARD_STATE_DIR", "GJC_HERDR_DASHBOARD_HERDR",
  "GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT"];

const recordsOf = () => (globalThis[RECORDS] ??= []);
const lastOf = (at) => recordsOf().filter((entry) => entry.at === at).at(-1);

// The `??=` defaults mean a value survives within one process, so every case starts from a
// clean slate and a fresh module instance.
async function importShim(path) {
  for (const key of ENV_KEYS) delete process.env[key];
  recordsOf().length = 0;
  return import(`${pathToFileURL(path).href}?v=${Math.random()}`);
}

test.after(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  rmSync(sandboxRoot, { recursive: true, force: true });
});

test("the usage text names every flag the drills need", () => {
  for (const flag of ["--case", "--state", "--herdr", "--viewer-failpoint", "--root"]) {
    assert.ok(SHIM_USAGE.includes(flag), flag);
  }
  assert.ok(SHIM_USAGE.includes("case-<id>"));
});

test("argument parsing rejects what it cannot honour", () => {
  assert.throws(() => parseShimArgs([]), /--case is required/);
  assert.throws(() => parseShimArgs(["--case"]), /--case needs a value/);
  assert.throws(() => parseShimArgs(["--case", "a", "--state"]), /--state needs a value/);
  assert.throws(() => parseShimArgs(["--case", "a", "--nope"]), /Unknown argument: --nope/);
  const parsed = parseShimArgs(["--case", "c1", "--state", "s", "--herdr", '["h"]',
    "--viewer-failpoint", "ready-delay-25s", "--root", "r"]);
  assert.deepEqual(parsed, { caseId: "c1", stateDir: "s", herdr: '["h"]',
    viewerFailpoint: "ready-delay-25s", root: "r", help: false });
  assert.equal(parseShimArgs(["--help"]).help, true);
  assert.equal(parseShimArgs(["-h"]).help, true);
  // A case id with Korean and a space parses as one value, not as two arguments.
  assert.equal(parseShimArgs(["--case", "한글 공백"]).caseId, "한글 공백");
  // The default root is the repository sandbox, never the owner's home or a temp dir.
  assert.equal(parseShimArgs(["--case", "a"]).root, join(repo, ".sandbox"));
});

test("the plan puts the shim under the case's .gjc/extensions", () => {
  const plan = shimPlan({ caseId: "p1", stateDir: null, herdr: null, viewerFailpoint: null,
    root: scratchRoot }, { repoRoot: scratchRepo });
  assert.equal(plan.dir, join(scratchRoot, "case-p1"));
  assert.equal(plan.path, join(scratchRoot, "case-p1", ".gjc", "extensions", SHIM_FILE));
  assert.equal(SHIM_FILE, "gjc-herdr-dashboard.js");
  assert.equal(plan.stateDir, join(scratchRoot, "case-p1", ".gjc", "herdr-dashboard", "state"));
  // The state default is absolute, so a drill launched from any cwd resolves the same tree.
  assert.ok(isAbsolute(plan.stateDir));
});

test("the generated source is an env-default block plus an absolute-URL re-export", () => {
  const source = shimSource({ caseUrl: "file:///tmp/x/extension.mjs", stateDir: "C:\\s t\\state",
    herdr: '["herdr"]', viewerFailpoint: "ready-delay-25s" });
  assert.ok(source.includes("export { default } from 'file:///tmp/x/extension.mjs';"));
  assert.ok(source.includes("process.env.GJC_HERDR_DASHBOARD_STATE_DIR ??= 'C:\\\\s t\\\\state';"));
  assert.ok(source.includes("process.env.GJC_HERDR_DASHBOARD_HERDR ??= '[\"herdr\"]';"));
  assert.ok(source.includes("process.env.GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT ??= 'ready-delay-25s';"));
  // The re-export is the last statement: §7.7's ordering reads top to bottom.
  assert.ok(source.trimEnd().endsWith("export { default } from 'file:///tmp/x/extension.mjs';"));
  // Never a relative specifier: a relative re-export breaks the moment the case moves.
  assert.ok(!source.includes("from './"));
  assert.ok(!source.includes("from '../"));
  // Exactly the documented defaults are written, and nothing reads the environment.
  assert.equal(source.match(/process\.env\.\w+/g).length, 3);
  // A shim with no --herdr and no failpoint does not invent either default.
  const bare = shimSource({ caseUrl: "file:///tmp/x/extension.mjs", stateDir: "S" });
  assert.equal(bare.match(/process\.env\.\w+/g).length, 1);
  assert.ok(!bare.includes("VIEWER_FAILPOINT"));
});

test("a written shim loads for real and the factory sees the case's defaults", async () => {
  const plan = await writeShim({ caseId: "load", stateDir: null,
    herdr: '["herdr","--session","c"]', viewerFailpoint: null, root: scratchRoot },
  { repoRoot: scratchRepo });
  const text = readFileSync(plan.path, "utf8");
  assert.ok(text.includes(pathToFileURL(join(scratchRepo, "extension.mjs")).href), text);
  const module = await importShim(plan.path);
  assert.equal(typeof module.default, "function");
  // The documented ESM ordering caveat, observed: the entry module body ran before the
  // shim's `??=` lines, so it saw no defaults; the factory, called after loading, sees them.
  const atImport = lastOf("import");
  assert.equal(atImport.stateDir, undefined);
  assert.equal(atImport.herdr, undefined);
  // The shim set the state dir before the factory ran; the factory is called here, exactly
  // as GJC calls it after loading.
  assert.equal(process.env.GJC_HERDR_DASHBOARD_STATE_DIR, plan.stateDir);
  assert.equal(process.env.GJC_HERDR_DASHBOARD_HERDR, '["herdr","--session","c"]');
  module.default({ tag: "load" });
  const seen = lastOf("factory");
  assert.equal(seen.stateDir, plan.stateDir);
  assert.equal(seen.herdr, '["herdr","--session","c"]');
  assert.equal(seen.failpoint, undefined);
  assert.deepEqual(seen.pi, { tag: "load" });
});

test("an existing environment value is never overwritten by the shim", async () => {
  const plan = await writeShim({ caseId: "keep", stateDir: null, herdr: null,
    viewerFailpoint: null, root: scratchRoot }, { repoRoot: scratchRepo });
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GJC_HERDR_DASHBOARD_STATE_DIR = "C:\\already\\set";
  const module = await import(`${pathToFileURL(plan.path).href}?v=keep`);
  module.default({});
  assert.equal(lastOf("factory").stateDir, "C:\\already\\set");
  // The shim also did not set the two defaults it had no value for.
  assert.equal(lastOf("factory").herdr, undefined);
  assert.equal(lastOf("factory").failpoint, undefined);
});

test("a case id with Korean and a space works end to end", async () => {
  const caseId = "한글 공백 case";
  const plan = await writeShim({ caseId, stateDir: null, herdr: null, viewerFailpoint: null,
    root: scratchRoot }, { repoRoot: scratchRepo });
  assert.equal(plan.path, join(scratchRoot, `case-${caseId}`, ".gjc", "extensions", SHIM_FILE));
  assert.ok(readFileSync(plan.path, "utf8").includes(plan.stateDir.replaceAll("\\", "\\\\")));
  const module = await importShim(plan.path);
  module.default({});
  assert.equal(lastOf("factory").stateDir, plan.stateDir);
});

test("--viewer-failpoint reaches the viewer environment (R3/SR9)", async () => {
  const plan = await writeShim({ caseId: "fp", stateDir: null, herdr: null,
    viewerFailpoint: "ready-delay-25s", root: scratchRoot }, { repoRoot: scratchRepo });
  const module = await importShim(plan.path);
  module.default({});
  assert.equal(lastOf("factory").failpoint, "ready-delay-25s");
});

test("--state overrides the derived state directory, relatively or absolutely", () => {
  const absolute = shimPlan({ caseId: "s", stateDir: resolve(scratchRoot, "elsewhere"),
    herdr: null, viewerFailpoint: null, root: scratchRoot }, { repoRoot: scratchRepo });
  assert.equal(absolute.stateDir, resolve(scratchRoot, "elsewhere"));
  const relative = shimPlan({ caseId: "s", stateDir: "rel/state", herdr: null,
    viewerFailpoint: null, root: scratchRoot }, { repoRoot: scratchRepo });
  assert.equal(relative.stateDir, resolve("rel/state"));
});

test("--herdr must be a JSON argv array, so a typo fails before a live pass", () => {
  const plan = (herdr) => shimPlan({ caseId: "h", stateDir: null, herdr, viewerFailpoint: null,
    root: scratchRoot }, { repoRoot: scratchRepo });
  assert.throws(() => plan("herdr -x"), /must be a JSON argv array/);
  assert.throws(() => plan("[]"), /non-empty JSON array of strings/);
  assert.throws(() => plan('[1,2]'), /non-empty JSON array of strings/);
  assert.throws(() => plan('{"a":1}'), /non-empty JSON array of strings/);
  assert.ok(plan('["herdr"]').source.includes("'[\"herdr\"]'"));
});

test("a missing entry fails the plan instead of writing a broken shim", () => {
  assert.throws(() => shimPlan({ caseId: "x", stateDir: null, herdr: null, viewerFailpoint: null,
    root: scratchRoot }, { repoRoot: join(sandboxRoot, "no-repo") }), /extension\.mjs is missing/);
});

test("main reports usage errors on stderr and the path on stdout", async () => {
  const out = [];
  const err = [];
  const stdout = { write: (text) => out.push(text) };
  const stderr = { write: (text) => err.push(text) };
  assert.equal(await main(["--help"], { stdout, stderr }), 0);
  assert.ok(out.join("").includes("--case"));
  assert.equal(await main([], { stdout, stderr }), 2);
  assert.ok(err.join("").includes("--case is required"));
  assert.equal(await main(["--case", "m", "--root", scratchRoot, "--herdr", "bad"],
    { stdout, stderr, repoRoot: scratchRepo }), 2);
  assert.ok(err.join("").includes("--herdr must be a JSON argv array"));
  // A write failure is reported, not swallowed, and main stays a return-code function.
  assert.equal(await main(["--case", "m", "--root", scratchRoot], { stdout, stderr,
    repoRoot: join(sandboxRoot, "no-repo") }), 2);
  assert.ok(err.join("").includes("extension.mjs is missing"));
  assert.equal(await main(["--case", "m", "--root", scratchRoot], { stdout, stderr,
    repoRoot: scratchRepo }), 0);
  assert.ok(out.at(-1).endsWith(`${SHIM_FILE}\n`));
  assert.ok(readFileSync(out.at(-1).trim(), "utf8").includes("export { default } from"));
});
