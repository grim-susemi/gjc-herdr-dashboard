// L6 unit tests: generation build, install/select/remove/doctor and package verification.
//
// Every test uses a temp agent directory; the user scope is never read or written. Herdr is never
// started: the install smoke imports the built entry by absolute file URL (its factory is not
// called), exactly what scripts/verify-package.mjs does.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGeneration, runtimePlan } from "../../scripts/build.mjs";
import { INSTALL_FAILPOINT_ENV, MANAGED_MARKER, agentPaths, doctor, install, isManagedShim,
  parseInstallArgs, removeShim, selectGeneration, shimSource, shimTarget } from "../../scripts/install.mjs";
import { verifyGeneration } from "../../scripts/verify-package.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const listFiles = async (dir) => {
  const out = [];
  const walk = async (root, base = root) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) await walk(full, base);
      else out.push(full.slice(base.length + 1).replaceAll("\\", "/"));
    }
  };
  await walk(dir);
  return out.sort();
};

async function scratch(t, name = "agent") {
  const base = await mkdtemp(join(tmpdir(), "gjc-install-test-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  return { base, agentDir: join(base, name) };
}

const freshInstall = (agentDir, lang = "ko", deps = {}) =>
  install({ agentDir, lang }, { env: {}, ...deps });

test("fresh install writes the managed shim, generation, config and current record", async t => {
  const { agentDir } = await scratch(t);
  const result = await freshInstall(agentDir);
  assert.equal(result.installed, true);
  assert.equal(result.generation, "generation-000001");
  assert.equal(result.token, "gen-000001");
  assert.equal(result.previous, null);
  assert.ok(result.files > 20, `copied runtime files (${result.files})`);

  const paths = agentPaths(agentDir);
  const shim = await readFile(paths.shim, "utf8");
  assert.ok(shim.startsWith(`${MANAGED_MARKER}\n`), "the shim starts with the managed marker");
  assert.equal(isManagedShim(shim), true);
  assert.equal(shimTarget(shim).href, result.extension);
  assert.match(shim, /^export \{ default \} from 'file:\/\/\//m);

  const marker = await readFile(join(paths.container, "generation-000001", ".installed-by"), "utf8");
  assert.equal(marker.trim(), MANAGED_MARKER);

  const config = await readJson(join(paths.container, "generation-000001", "config.json"));
  assert.deepEqual(config, { schema: "gjc-herdr-dashboard/config/1", generation: "gen-000001", lang: "ko" });
  const current = await readJson(paths.current);
  assert.equal(current.generation, "generation-000001");
  assert.equal(current.token, "gen-000001");
  assert.equal(current.lang, "ko");

  for (const relative of ["extension.mjs", "package.json", "locale/ko.json", "locale/en.json",
    "locale/zh-cn.json", "src/host/instance.mjs", "src/viewers/common.mjs"]) {
    assert.ok(existsSync(join(paths.container, "generation-000001", ...relative.split("/"))), relative);
  }

  const report = await doctor({ agentDir });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.equal(report.shim.targetGeneration, report.current.generation);
  assert.equal(report.current.generation, "generation-000001");
  assert.deepEqual(report.generations.map(entry => entry.name), ["generation-000001"]);

  const verified = await verifyGeneration(result.generationDir, { shimPath: paths.shim });
  assert.equal(verified.pass, true, JSON.stringify(verified.errors));
  assert.equal(verified.importOk, true);
  assert.equal(verified.defaultExport, "function");
  assert.equal(verified.localeHeader, "ext gen-000001");
  assert.equal(verified.language, "ko");
  assert.equal(verified.shim.targetMatches, true);
  assert.equal(verified.shim.envDefaults, false);
  assert.equal(verified.shim.failpointPlumbing, false);
});

test("a second install creates the next generation and switches the shim and record", async t => {
  const { agentDir } = await scratch(t);
  const first = await freshInstall(agentDir, "ko");
  const second = await freshInstall(agentDir, "en");
  assert.equal(first.generation, "generation-000001");
  assert.equal(second.generation, "generation-000002");
  assert.equal(second.previous, "generation-000001");

  const paths = agentPaths(agentDir);
  const shim = await readFile(paths.shim, "utf8");
  assert.equal(shimTarget(shim).href, second.extension);
  assert.equal((await readJson(paths.current)).generation, "generation-000002");
  assert.equal((await readJson(join(paths.container, "generation-000002", "config.json"))).lang, "en");
  assert.deepEqual(await readdir(paths.container).then(names => names.filter(name => name.startsWith("generation-")).sort()),
    ["generation-000001", "generation-000002"]);
  assert.equal((await doctor({ agentDir })).ok, true);
});

test("--select re-points the shim and current.json at an existing managed generation", async t => {
  const { agentDir } = await scratch(t);
  await freshInstall(agentDir, "ko");
  await freshInstall(agentDir, "en");
  const selected = await selectGeneration({ agentDir, select: "generation-000001" });
  assert.equal(selected.selected, true);
  const paths = agentPaths(agentDir);
  assert.equal(shimTarget(await readFile(paths.shim, "utf8")).href, selected.extension);
  assert.equal((await readJson(paths.current)).generation, "generation-000001");
  assert.equal((await readJson(paths.current)).lang, "ko");
  const report = await doctor({ agentDir });
  assert.equal(report.ok, true);
  assert.equal(report.shim.targetGeneration, "generation-000001");
  const verified = await verifyGeneration(join(paths.container, "generation-000001"),
    { shimPath: paths.shim });
  assert.equal(verified.pass, true, JSON.stringify(verified.errors));
});

test("--select refuses a missing or unmanaged generation", async t => {
  const { agentDir } = await scratch(t);
  const installed = await freshInstall(agentDir);
  await assert.rejects(() => selectGeneration({ agentDir, select: "generation-000009" }),
    error => error.code === "generation-missing");
  const paths = agentPaths(agentDir);
  await mkdir(join(paths.container, "generation-000009"), { recursive: true });
  await assert.rejects(() => selectGeneration({ agentDir, select: "generation-000009" }),
    error => error.code === "generation-unmanaged");
  assert.equal(shimTarget(await readFile(paths.shim, "utf8")).href, installed.extension);
});

test("--remove deletes only the managed shim; generations, current.json and state stay", async t => {
  const { agentDir } = await scratch(t);
  const installed = await freshInstall(agentDir);
  const paths = agentPaths(agentDir);
  await mkdir(paths.state, { recursive: true });
  const sentinel = join(paths.state, "sentinel.txt");
  await writeFile(sentinel, "runtime-owned\n", "utf8");

  const removed = await removeShim({ agentDir });
  assert.equal(removed.removed, true);
  assert.equal(existsSync(paths.shim), false);
  assert.equal(existsSync(sentinel), true);
  assert.equal((await readFile(sentinel, "utf8")), "runtime-owned\n");
  assert.equal(existsSync(paths.current), true);
  assert.ok(existsSync(installed.generationDir));
  assert.equal((await readJson(paths.current)).generation, "generation-000001");
  const again = await removeShim({ agentDir });
  assert.deepEqual({ removed: again.removed, reason: again.reason }, { removed: false, reason: "absent" });
});

test("a foreign shim is never overwritten, selected over or removed", async t => {
  const { agentDir } = await scratch(t);
  const paths = agentPaths(agentDir);
  await mkdir(paths.extensions, { recursive: true });
  const foreign = "// somebody else's dashboard\nexport default 1;\n";
  await writeFile(paths.shim, foreign, "utf8");

  for (const operation of [
    () => freshInstall(agentDir),
    () => install({ agentDir, lang: "ko", dryRun: true }, { env: {} }),
    () => selectGeneration({ agentDir, select: "generation-000001" }),
    () => removeShim({ agentDir }),
  ]) {
    await assert.rejects(operation, error => error.code === "foreign-shim");
    assert.equal(await readFile(paths.shim, "utf8"), foreign);
  }
  assert.equal(existsSync(paths.container), false, "a refused install writes no container");
});

test("--dry-run prints the plan and writes nothing", async t => {
  const { base, agentDir } = await scratch(t);
  const plan = await install({ agentDir, lang: "en", dryRun: true }, { env: {} });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.installed, false);
  assert.equal(plan.generation, "generation-000001");
  assert.equal(plan.token, "gen-000001");
  assert.equal(plan.language, "en");
  assert.ok(plan.files > 20);
  assert.ok(plan.shimSource.startsWith(MANAGED_MARKER));
  assert.equal(existsSync(agentDir), false, "the whole agent directory stays absent");
  assert.deepEqual(await readdir(base), []);

  await freshInstall(agentDir, "ko");
  const second = await install({ agentDir, lang: "ko", dryRun: true }, { env: {} });
  assert.equal(second.generation, "generation-000002");
  assert.deepEqual(await readdir(agentPaths(agentDir).container)
    .then(names => names.filter(name => name.startsWith("generation-")).sort()),
  ["generation-000001"]);
});

test("an invalid --lang is an install-time error and writes nothing", async t => {
  const { agentDir } = await scratch(t);
  assert.throws(() => parseInstallArgs(["--agent-dir", agentDir, "--lang", "fr"]),
    error => error.code === "invalid-language");
  await assert.rejects(() => install({ agentDir, lang: "fr" }, { env: {} }),
    error => error.code === "invalid-language");
  assert.equal(existsSync(agentDir), false);
});

test("D3 failpoints: every pre-rename failure keeps the previous selection; the post-rename one is repaired by --select", async t => {
  const { agentDir } = await scratch(t);
  const paths = agentPaths(agentDir);
  await freshInstall(agentDir, "ko");                 // generation-000001
  await freshInstall(agentDir, "en");                 // generation-000002, selected
  const baseline = await doctor({ agentDir });
  assert.equal(baseline.shim.targetGeneration, "generation-000002");

  const run = (name) => install({ agentDir, lang: "ko" },
    { env: { [INSTALL_FAILPOINT_ENV]: name } });

  // after-gen-copy: the generation is complete on disk, but the shim and record are untouched.
  await assert.rejects(() => run("after-gen-copy"), error => error.code === "install-failpoint");
  assert.ok(existsSync(join(paths.container, "generation-000003", "extension.mjs")));
  assert.equal((await readFile(join(paths.container, "generation-000003", ".installed-by"), "utf8")).trim(),
    MANAGED_MARKER);
  let report = await doctor({ agentDir });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.equal(report.shim.targetGeneration, "generation-000002");
  assert.equal(report.current.generation, "generation-000002");

  // after-shim-tmp / before-shim-rename: the shim is untouched and no temporary file leaks.
  for (const name of ["after-shim-tmp", "before-shim-rename"]) {
    await assert.rejects(() => run(name), error => error.code === "install-failpoint");
    report = await doctor({ agentDir });
    assert.equal(report.ok, true, `${name}: ${JSON.stringify(report.mismatches)}`);
    assert.equal(report.shim.targetGeneration, "generation-000002");
    assert.deepEqual((await readdir(paths.extensions)).filter(entry => entry.endsWith(".tmp")), []);
    assert.equal((await readFile(paths.shim, "utf8")).includes("generation-000002/extension.mjs"), true);
  }
  // The three pre-rename failures each left a complete managed generation behind.
  report = await doctor({ agentDir });
  assert.deepEqual(report.generations.map(entry => entry.name),
    ["generation-000001", "generation-000002", "generation-000003", "generation-000004", "generation-000005"]);
  assert.ok(report.generations.every(entry => entry.managed && entry.usable));

  // after-shim-rename-before-current: the NEW shim is effective, current.json still names the old one.
  await assert.rejects(() => run("after-shim-rename-before-current"),
    error => error.code === "install-failpoint");
  report = await doctor({ agentDir });
  assert.equal(report.shim.targetGeneration, "generation-000006");
  assert.equal(report.current.generation, "generation-000002");
  assert.equal(report.ok, false);
  assert.ok(report.mismatches.some(entry => entry.code === "selection-mismatch"), JSON.stringify(report.mismatches));
  const newShim = await readFile(paths.shim, "utf8");
  assert.ok(newShim.includes("generation-000006/extension.mjs"));

  // --select repairs the record to the effective (new) selection.
  await selectGeneration({ agentDir, select: "generation-000006" });
  report = await doctor({ agentDir });
  assert.equal(report.ok, true, JSON.stringify(report.mismatches));
  assert.equal(report.shim.targetGeneration, "generation-000006");
  assert.equal(report.current.generation, "generation-000006");

  // ... and it can also roll back to the previous generation.
  await selectGeneration({ agentDir, select: "generation-000002" });
  assert.equal((await doctor({ agentDir })).shim.targetGeneration, "generation-000002");
});

test("an unknown install failpoint is a usage error, not a silent no-op", async t => {
  const { agentDir } = await scratch(t);
  await assert.rejects(() => install({ agentDir, lang: "ko" },
    { env: { [INSTALL_FAILPOINT_ENV]: "not-a-failpoint" } }),
  error => error.code === "invalid-failpoint");
  assert.equal(existsSync(agentDir), false);
});

test("verify-package reports missing files, a bad marker, a bad config and a non-function export", async t => {
  const { base } = await scratch(t);
  const dir = join(base, "pkg", "generation-000001");
  await buildGeneration({ dest: dir, generation: "gen-000001", lang: "en" });
  await writeFile(join(dir, ".installed-by"), `${MANAGED_MARKER}\n`, "utf8");

  let report = await verifyGeneration(dir);
  assert.equal(report.pass, true, JSON.stringify(report.errors));
  assert.equal(report.localeHeader, "ext gen-000001");
  assert.equal(report.language, "en");

  await rm(join(dir, "src", "host", "instance.mjs"));
  report = await verifyGeneration(dir);
  assert.equal(report.pass, false);
  assert.ok(report.errors.includes("missing-file: src/host/instance.mjs"), JSON.stringify(report.errors));

  await writeFile(join(dir, "config.json"), JSON.stringify({ generation: "gen-000002", lang: "xx" }), "utf8");
  report = await verifyGeneration(dir);
  assert.equal(report.pass, false);
  assert.ok(report.errors.includes("config-generation: gen-000002"));
  assert.ok(report.errors.includes("config-language: xx"));

  await writeFile(join(dir, "config.json"), JSON.stringify({ generation: "gen-000001", lang: "ko" }), "utf8");

  // A fresh tree (so the module graph still resolves) with no marker and a non-function export.
  const badExport = join(base, "pkg2", "generation-000001");
  await buildGeneration({ dest: badExport, generation: "gen-000001", lang: "ko" });
  await writeFile(join(badExport, "extension.mjs"), "export default 1;\n", "utf8");
  report = await verifyGeneration(badExport);
  assert.equal(report.pass, false);
  assert.ok(report.errors.includes("installed-by"));
  assert.ok(report.errors.includes("default-export"), JSON.stringify(report.errors));
});

test("verify-package rejects a shim with env defaults, a failpoint or a foreign target", async t => {
  const { agentDir } = await scratch(t);
  const installed = await freshInstall(agentDir);
  const paths = agentPaths(agentDir);
  const entryUrl = installed.extension;

  const good = await verifyGeneration(installed.generationDir, { shimPath: paths.shim });
  assert.equal(good.pass, true, JSON.stringify(good.errors));

  const managedWithEnv = `${MANAGED_MARKER}\nprocess.env.GJC_HERDR_DASHBOARD_STATE_DIR ??= 'x';\n` +
    `export { default } from '${entryUrl}';\n`;
  await writeFile(paths.shim, managedWithEnv, "utf8");
  let report = await verifyGeneration(installed.generationDir, { shimPath: paths.shim });
  assert.equal(report.pass, false);
  assert.ok(report.errors.includes("shim-env-defaults"));
  assert.ok(report.errors.includes("shim-source-form"));

  await writeFile(paths.shim, `${MANAGED_MARKER}\n// failpoint\n` +
    `export { default } from '${entryUrl}';\n`, "utf8");
  report = await verifyGeneration(installed.generationDir, { shimPath: paths.shim });
  assert.ok(report.errors.includes("shim-failpoint"));

  await writeFile(paths.shim, "// foreign\nexport default 1;\n", "utf8");
  report = await verifyGeneration(installed.generationDir, { shimPath: paths.shim });
  assert.ok(report.errors.some(entry => entry.startsWith("shim-foreign")), JSON.stringify(report.errors));

  await writeFile(paths.shim, shimSource(entryUrl), "utf8");
  report = await verifyGeneration(installed.generationDir, { shimPath: paths.shim });
  assert.equal(report.pass, true, JSON.stringify(report.errors));
});

test("build refuses to overwrite an existing generation directory", async t => {
  const { base } = await scratch(t);
  const dir = join(base, "generation-000001");
  await buildGeneration({ dest: dir, generation: "gen-000001", lang: "ko" });
  await assert.rejects(() => buildGeneration({ dest: dir, generation: "gen-000001", lang: "ko" }),
    error => error.code === "generation-exists");
});

test("the runtime plan requires the entry, package, three locales and src/", async () => {
  const plan = await runtimePlan();
  for (const name of ["extension.mjs", "package.json", "locale/ko.json", "locale/en.json",
    "locale/zh-cn.json", "src/host/instance.mjs"]) {
    assert.ok(plan.files.includes(name), name);
  }
  assert.ok(plan.files.every(name => !name.startsWith("test/") && !name.startsWith("scripts/")));
});
