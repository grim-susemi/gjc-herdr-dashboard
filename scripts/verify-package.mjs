// Generation verifier for the GJC Herdr dashboard (plan §13, stage-05 R4 AC6.4).
//
// Verifies a `generation-NNNNNN/` tree without running the product:
//   * the full runtime file set exists (the same set scripts/build.mjs copies),
//   * `.installed-by` carries the managed marker,
//   * `config.json` names the directory's token and a supported language,
//   * the tree's own locale catalogue produces the notify header with that generation token,
//   * `extension.mjs` imports by absolute file URL and its default export is a function (never called).
// When `--shim` is given, the installed shim is also checked: managed marker, target = this tree,
// and no environment defaults or failpoint plumbing (AC6.4).
//
// Exported signatures
//   verifyGeneration(dir, options?) -> Promise<report>
//   main(argv?, deps?) -> Promise<number>
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG_FILE, LANGUAGES, REPO_ROOT, isGenerationName, runtimePlan,
  tokenOfGeneration } from "./build.mjs";
import { MANAGED_MARKER, isManagedShim, shimSource, shimTarget } from "./install.mjs";

const coded = (code, message) => Object.assign(new Error(message ?? code), { code });

async function verifyShim(shimPath, entryUrl, report) {
  const shim = { path: shimPath, exists: existsSync(shimPath), managed: false, target: null,
    targetMatches: false, envDefaults: false, failpointPlumbing: false };
  report.shim = shim;
  report.errors = report.errors ?? [];
  let raw;
  try { raw = await readFile(shimPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") { report.errors.push(`shim-missing: ${shimPath}`); return; }
    throw error;
  }
  shim.exists = true;
  shim.managed = isManagedShim(raw);
  if (!shim.managed) report.errors.push(`shim-foreign: ${shimPath}`);
  const target = shimTarget(raw);
  shim.target = target?.href ?? null;
  if (target === null) report.errors.push("shim-unparseable");
  else {
    shim.targetMatches = target.href === entryUrl;
    if (!shim.targetMatches) report.errors.push(`shim-target: ${target.href} != ${entryUrl}`);
  }
  shim.envDefaults = /process\.env|\?\?=/.test(raw);
  shim.failpointPlumbing = /failpoint/i.test(raw);
  if (shim.envDefaults) report.errors.push("shim-env-defaults");
  if (shim.failpointPlumbing) report.errors.push("shim-failpoint");
  // The expected source is the one the installer writes; comparing it keeps the two modules in
  // lockstep without parsing JS.
  shim.sourceMatches = raw === shimSource(entryUrl);
  if (!shim.sourceMatches) report.errors.push("shim-source-form");
}

export async function verifyGeneration(dir, options = {}) {
  const target = resolve(dir);
  const report = {
    pass: false,
    dir: target,
    generation: basename(target),
    token: null,
    language: null,
    files: 0,
    importOk: false,
    defaultExport: null,
    localeHeader: null,
    shim: null,
    errors: [],
  };
  if (!existsSync(target)) {
    report.errors.push(`generation-missing: ${target}`);
    return report;
  }
  if (!isGenerationName(report.generation)) {
    report.errors.push(`generation-name: ${report.generation}`);
    return report;
  }
  report.token = tokenOfGeneration(report.generation);

  let required;
  try { required = await runtimePlan({ root: options.root ?? REPO_ROOT }); }
  catch (error) {
    report.errors.push(`source-plan: ${error.message}`);
    return report;
  }
  for (const relativePath of required.files) {
    if (!existsSync(join(target, ...relativePath.split("/")))) {
      report.errors.push(`missing-file: ${relativePath}`);
    } else {
      report.files += 1;
    }
  }

  let marker = null;
  try { marker = await readFile(join(target, ".installed-by"), "utf8"); }
  catch (error) {
    // outcome: reported as a missing marker; the rest of the tree is still measured.
    if (error.code !== "ENOENT") throw error;
  }
  if (marker === null || marker.trim() !== MANAGED_MARKER) report.errors.push("installed-by");

  let config = null;
  try {
    config = JSON.parse(await readFile(join(target, CONFIG_FILE), "utf8"));
  } catch (error) {
    report.errors.push(`config: ${error.code === "ENOENT" ? "missing" : error.message}`);
  }
  if (config !== null) {
    if (config?.generation !== report.token) report.errors.push(`config-generation: ${config?.generation}`);
    if (!LANGUAGES.includes(config?.lang)) report.errors.push(`config-language: ${config?.lang}`);
    else report.language = config.lang;
    if (config?.schema !== undefined && config.schema !== "gjc-herdr-dashboard/config/1") {
      report.errors.push(`config-schema: ${config.schema}`);
    }
  }

  const entry = join(target, "extension.mjs");
  const entryUrl = pathToFileURL(entry).href;
  if (existsSync(entry)) {
    try {
      const module = await import(pathToFileURL(entry).href);
      report.importOk = true;
      report.defaultExport = typeof module.default;
      if (typeof module.default !== "function") report.errors.push("default-export");
      // The default export is inspected only; calling it would arm a host surface that is not here.
    } catch (error) {
      report.errors.push(`import: ${error.code ?? error.message}`);
    }
  }

  if (report.language !== null) {
    try {
      const i18nPath = join(target, "src", "i18n.mjs");
      const { createI18n } = await import(pathToFileURL(i18nPath).href);
      const catalogue = createI18n(new URL("./", entryUrl));
      const header = catalogue.t(report.language, "notify.header", { gen: report.token });
      report.localeHeader = header;
      if (!header.includes(report.token)) report.errors.push(`locale-header: ${header}`);
    } catch (error) {
      report.errors.push(`locale: ${error.code ?? error.message}`);
    }
  }

  if (typeof options.shimPath === "string" && options.shimPath !== "") {
    await verifyShim(options.shimPath, entryUrl, report);
  }

  report.pass = report.errors.length === 0;
  return report;
}

const USAGE = [
  "Usage: node scripts/verify-package.mjs <generation-dir> [--root <source-root>] [--shim <shim-path>]",
  "  <generation-dir>  directory named generation-NNNNNN",
  "  --root            source tree whose runtime file list is required",
  "  --shim            installed shim to check as well (managed marker, target, no env/failpoint)",
].join("\n");

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw coded("usage", `${flag} needs a value`);
  return value;
}

export function parseVerifyArgs(args = []) {
  const options = { dir: null, root: REPO_ROOT, shimPath: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--dir") options.dir = requireValue(args, index++, flag);
    else if (flag === "--root") options.root = requireValue(args, index++, flag);
    else if (flag === "--shim") options.shimPath = requireValue(args, index++, flag);
    else if (flag.startsWith("--")) throw coded("usage", `Unknown argument: ${flag}`);
    else if (options.dir === null) options.dir = flag;
    else throw coded("usage", `Unexpected argument: ${flag}`);
  }
  if (!options.help && !options.dir) throw coded("usage", "a generation directory is required");
  return options;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr } = deps;
  let options;
  try { options = parseVerifyArgs(argv); }
  catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const report = await verifyGeneration(options.dir, { root: options.root, shimPath: options.shimPath });
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.pass ? 0 : 1;
  } catch (error) {
    stderr.write(`${error.code ?? "verify"}: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {});
}
