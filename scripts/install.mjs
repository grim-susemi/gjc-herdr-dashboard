// Generation installer for the GJC Herdr dashboard (plan §7.7, §13, §16 D1-D4).
//
// Layout (stage-05 R4/R5):
//   <agent-dir>/extensions/gjc-herdr-dashboard.js          managed re-export shim (source of truth)
//   <agent-dir>/herdr-dashboard/generation-NNNNNN/          full runtime copy
//   <agent-dir>/herdr-dashboard/current.json               record of the selected generation
//   <agent-dir>/herdr-dashboard/state/                     runtime-owned; the installer never touches it
//
// The shim is one marker comment plus `export { default } from '<absolute file URL>';`. It is the
// selection; `current.json` is only a record that --doctor compares against it. A shim without the
// marker is foreign and is never overwritten or removed.
//
// D3 failpoints (env GJC_HERDR_DASHBOARD_INSTALL_FAILPOINT), in install order:
//   after-gen-copy                  generation is on disk, shim/current untouched
//   after-shim-tmp                  shim tmp is on disk (and then removed), selection untouched
//   before-shim-rename              selection untouched
//   after-shim-rename-before-current  new shim is effective; current.json still names the old one
//
// Exported signatures
//   MANAGED_MARKER, SHIM_FILE, CONTAINER_DIR, CURRENT_FILE, INSTALL_FAILPOINT_ENV, INSTALL_FAILPOINTS
//   agentPaths(agentDir)
//   isManagedShim(text), shimSource(extensionUrl), shimTarget(text)
//   parseInstallArgs(args)
//   install(options, deps?) / selectGeneration(options, deps?) / removeShim(options, deps?)
//   doctor(options, deps?)
//   main(argv?, deps?) -> Promise<number>
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildGeneration, isGenerationName, isGenerationToken, LANGUAGES, planGeneration,
  tokenOfGeneration } from "./build.mjs";

export const MANAGED_MARKER = "// managed by gjc-herdr-dashboard";
export const SHIM_FILE = "gjc-herdr-dashboard.js";
export const CONTAINER_DIR = "herdr-dashboard";
export const CURRENT_FILE = "current.json";
export const CURRENT_SCHEMA = "gjc-herdr-dashboard/current/1";
export const INSTALL_FAILPOINT_ENV = "GJC_HERDR_DASHBOARD_INSTALL_FAILPOINT";
export const INSTALL_FAILPOINTS = Object.freeze([
  "after-gen-copy",
  "after-shim-tmp",
  "before-shim-rename",
  "after-shim-rename-before-current",
]);

const coded = (code, message) => Object.assign(new Error(message ?? code), { code });
const text = (value) => (typeof value === "string" && value !== "" ? value : null);

export function agentPaths(agentDir) {
  const root = resolve(agentDir);
  return {
    agentDir: root,
    extensions: join(root, "extensions"),
    shim: join(root, "extensions", SHIM_FILE),
    container: join(root, CONTAINER_DIR),
    current: join(root, CONTAINER_DIR, CURRENT_FILE),
    state: join(root, CONTAINER_DIR, "state"),
  };
}

async function readText(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseJson(textValue) {
  try { return { value: JSON.parse(textValue), error: null }; }
  catch (error) {
    // outcome: an unreadable record is reported to the caller, never guessed.
    return { value: null, error: error.message };
  }
}

export function isManagedShim(value) {
  return typeof value === "string" && value.split(/\r?\n/, 1)[0] === MANAGED_MARKER;
}

// The URL literal is JS single-quoted. A `file:` URL never contains a backslash; apostrophes are
// escaped so a path with one still produces a valid module.
function literal(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function shimSource(extensionUrl) {
  return `${MANAGED_MARKER}\nexport { default } from ${literal(extensionUrl)};\n`;
}

// Absolute file URL of the managed target, or null when the shim is not our shape.
export function shimTarget(shimText) {
  if (!isManagedShim(shimText)) return null;
  const match = /^export\s*\{\s*default\s*\}\s*from\s*['"]([^'"]+)['"];?\s*$/m.exec(shimText);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    return url.protocol === "file:" ? url : null;
  } catch (error) {
    // outcome: an unparseable target is not a managed selection; the caller reports it.
    return null;
  }
}

function generationNameOfTarget(target, paths) {
  if (!target) return null;
  let path;
  try { path = fileURLToPath(target); }
  catch (error) {
    // outcome: a non-file target cannot name a generation in this container.
    return null;
  }
  const name = basename(dirname(path));
  if (!isGenerationName(name)) return null;
  if (resolve(dirname(dirname(path))) !== resolve(paths.container)) return null;
  return name;
}

async function generationInfo(paths, name) {
  const dir = join(paths.container, name);
  const marker = await readText(join(dir, ".installed-by"));
  const configText = await readText(join(dir, "config.json"));
  const parsed = configText === null ? { value: null, error: "missing" } : parseJson(configText);
  const token = tokenOfGeneration(name);
  const config = parsed.value;
  const languageOk = config !== null && typeof config === "object" && LANGUAGES.includes(config.lang);
  const generationOk = config !== null && typeof config === "object" && config.generation === token;
  return {
    name,
    token,
    dir,
    extension: join(dir, "extension.mjs"),
    managed: typeof marker === "string" && marker.trim() === MANAGED_MARKER,
    config,
    configError: parsed.error,
    languageOk,
    generationOk,
    usable: existsSync(join(dir, "extension.mjs")) && languageOk && generationOk,
  };
}

async function generationNames(paths) {
  let entries;
  try { entries = await readdir(paths.container); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter(isGenerationName).sort();
}

async function currentRecord(paths) {
  const raw = await readText(paths.current);
  if (raw === null) return { exists: false, valid: false, record: null, error: "missing" };
  const parsed = parseJson(raw);
  const record = parsed.value;
  const valid = parsed.error === null && record !== null && typeof record === "object"
    && isGenerationName(record.generation);
  return { exists: true, valid, record: valid ? record : null, error: parsed.error };
}

function previousSelection(paths, shimText, current) {
  if (isManagedShim(shimText)) {
    const target = generationNameOfTarget(shimTarget(shimText), paths);
    if (target !== null) return target;
  }
  if (current.valid) return current.record.generation;
  return null;
}

async function assertSelectable(paths, name) {
  if (!isGenerationName(name)) throw coded("invalid-generation", `--select needs generation-NNNNNN: ${String(name)}`);
  const info = await generationInfo(paths, name);
  if (!existsSync(info.dir)) throw coded("generation-missing", `generation does not exist: ${info.dir}`);
  if (!info.managed) throw coded("generation-unmanaged", `generation has no managed marker: ${info.dir}`);
  if (!existsSync(info.extension)) throw coded("generation-invalid", `generation has no extension.mjs: ${info.dir}`);
  if (!info.languageOk || !info.generationOk) {
    throw coded("generation-invalid",
      `generation config.json is invalid for ${name}: ${info.configError ?? JSON.stringify(info.config)}`);
  }
  return info;
}

function failpointOf(env) {
  const value = text(String(env?.[INSTALL_FAILPOINT_ENV] ?? "").trim());
  if (value !== null && !INSTALL_FAILPOINTS.includes(value)) {
    throw coded("invalid-failpoint", `unsupported ${INSTALL_FAILPOINT_ENV}: ${value}`);
  }
  return value;
}

function assertLang(lang) {
  if (!LANGUAGES.includes(lang)) throw coded("invalid-language", `unsupported language: ${String(lang)} (ko|en|zh-cn)`);
}

async function writeAtomic(path, content, options = {}) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    await options.beforeRename?.(temporary);
    await rename(temporary, path);
    await options.afterRename?.(path);
  } finally {
    // outcome: the temporary file is removed whether the rename ran or not; ENOENT after a
    // successful rename is the normal case.
    await rm(temporary, { force: true });
  }
}

// ---------------------------------------------------------------- operations ------------------
export async function install(options, deps = {}) {
  const env = deps.env ?? process.env;
  const paths = agentPaths(deps.agentDir ?? options.agentDir ?? join(homedir(), ".gjc", "agent"));
  const lang = deps.lang ?? options.lang ?? "ko";
  assertLang(lang);
  const failpoint = failpointOf(env);
  const hit = (name) => {
    if (failpoint === name) throw coded("install-failpoint", `${INSTALL_FAILPOINT_ENV}=${name}`);
  };
  const shimText = await readText(paths.shim);
  if (shimText !== null && !isManagedShim(shimText)) {
    throw coded("foreign-shim", `refusing to overwrite a foreign shim: ${paths.shim}`);
  }
  const current = await currentRecord(paths);
  const names = await generationNames(paths);
  const next = names.length === 0 ? 1
    : Math.max(...names.map((name) => Number(name.slice("generation-".length)))) + 1;
  if (next > 999999) throw coded("generation-limit", "generation number exhausted");
  const name = `generation-${String(next).padStart(6, "0")}`;
  const token = tokenOfGeneration(name);
  const generationDir = join(paths.container, name);
  const extensionUrl = pathToFileURL(join(generationDir, "extension.mjs")).href;
  const previous = previousSelection(paths, shimText, current);

  if (options.dryRun === true) {
    const plan = await planGeneration({ generation: token, lang });
    return {
      dryRun: true,
      installed: false,
      agentDir: paths.agentDir,
      generation: name,
      token,
      generationDir,
      extension: extensionUrl,
      shim: paths.shim,
      shimSource: shimSource(extensionUrl),
      current: paths.current,
      state: paths.state,
      language: lang,
      previous,
      files: plan.files.length,
    };
  }

  await mkdir(paths.extensions, { recursive: true, mode: 0o700 });
  await mkdir(paths.container, { recursive: true, mode: 0o700 });
  const built = await buildGeneration({ dest: generationDir, generation: token, lang });
  await writeFile(join(generationDir, ".installed-by"), `${MANAGED_MARKER}\n`, "utf8");
  hit("after-gen-copy");

  await writeAtomic(paths.shim, shimSource(extensionUrl), {
    beforeRename: async () => {
      hit("after-shim-tmp");
      hit("before-shim-rename");
    },
    afterRename: async () => { hit("after-shim-rename-before-current"); },
  });

  const record = { schema: CURRENT_SCHEMA, generation: name, token, lang };
  await writeAtomic(paths.current, `${JSON.stringify(record, null, 2)}\n`);
  return {
    installed: true,
    agentDir: paths.agentDir,
    generation: name,
    token,
    generationDir,
    extension: extensionUrl,
    shim: paths.shim,
    current: paths.current,
    state: paths.state,
    language: lang,
    previous,
    files: built.files.length + built.optional.length,
  };
}

export async function selectGeneration(options, deps = {}) {
  const paths = agentPaths(deps.agentDir ?? options.agentDir ?? join(homedir(), ".gjc", "agent"));
  const name = options.select ?? deps.select ?? null;
  const shimText = await readText(paths.shim);
  if (shimText !== null && !isManagedShim(shimText)) {
    throw coded("foreign-shim", `refusing to replace a foreign shim: ${paths.shim}`);
  }
  const info = await assertSelectable(paths, name);
  const extensionUrl = pathToFileURL(info.extension).href;
  await writeAtomic(paths.shim, shimSource(extensionUrl));
  const record = { schema: CURRENT_SCHEMA, generation: info.name, token: info.token, lang: info.config.lang };
  await writeAtomic(paths.current, `${JSON.stringify(record, null, 2)}\n`);
  return {
    selected: true,
    agentDir: paths.agentDir,
    generation: info.name,
    token: info.token,
    generationDir: info.dir,
    extension: extensionUrl,
    shim: paths.shim,
    current: paths.current,
    state: paths.state,
    language: info.config.lang,
  };
}

export async function removeShim(options, deps = {}) {
  const paths = agentPaths(deps.agentDir ?? options.agentDir ?? join(homedir(), ".gjc", "agent"));
  const shimText = await readText(paths.shim);
  if (shimText !== null && !isManagedShim(shimText)) {
    throw coded("foreign-shim", `refusing to remove a foreign shim: ${paths.shim}`);
  }
  if (shimText === null) {
    return { removed: false, reason: "absent", agentDir: paths.agentDir, shim: paths.shim,
      generationsKept: await generationNames(paths), state: paths.state };
  }
  await rm(paths.shim, { force: true });
  return { removed: true, agentDir: paths.agentDir, shim: paths.shim,
    generationsKept: await generationNames(paths), state: paths.state };
}

export async function doctor(options, deps = {}) {
  const paths = agentPaths(deps.agentDir ?? options.agentDir ?? join(homedir(), ".gjc", "agent"));
  const mismatches = [];
  const add = (code, detail) => mismatches.push({ code, detail });
  const shimText = await readText(paths.shim);
  const current = await currentRecord(paths);
  const names = await generationNames(paths);
  const generations = [];
  for (const name of names) {
    const info = await generationInfo(paths, name);
    generations.push({ name, token: info.token, managed: info.managed, extension: existsSync(info.extension),
      config: info.config, configError: info.configError, usable: info.usable,
      selected: false });
    if (!info.managed) add("unmanaged-generation", name);
    else if (!info.usable) add("generation-invalid", `${name}: ${info.configError ?? "config or extension.mjs"}`);
  }

  const shim = { path: paths.shim, exists: shimText !== null, managed: shimText !== null && isManagedShim(shimText),
    target: null, targetPath: null, targetGeneration: null, targetUsable: false };
  if (shimText === null) add("shim-missing", paths.shim);
  else if (!shim.managed) add("shim-foreign", paths.shim);
  else {
    const target = shimTarget(shimText);
    if (target === null) add("shim-unparseable", paths.shim);
    else {
      shim.target = target.href;
      try { shim.targetPath = fileURLToPath(target); }
      catch (error) {
        // outcome: reported through shim-unparseable below; the URL is still evidence.
        shim.targetPath = null;
      }
      const targetName = generationNameOfTarget(target, paths);
      shim.targetGeneration = targetName;
      if (targetName === null) add("shim-target-outside", target.href);
      else {
        const info = generations.find((entry) => entry.name === targetName);
        shim.targetUsable = info?.usable === true;
        if (info === undefined) add("shim-target-missing", targetName);
        else if (!info.managed) add("shim-target-unmanaged", targetName);
        else {
          info.selected = true;
          if (!info.usable) add("shim-target-invalid", targetName);
        }
      }
    }
  }

  const currentReport = { path: paths.current, exists: current.exists, valid: current.valid,
    generation: current.record?.generation ?? null, token: current.record?.token ?? null,
    language: current.record?.lang ?? null, error: current.error };
  if (!current.exists) add("current-missing", paths.current);
  else if (!current.valid) add("current-invalid", `${paths.current}: ${current.error ?? "generation"}`);
  else {
    if (!names.includes(current.record.generation)) add("current-generation-missing", current.record.generation);
    if (shim.targetGeneration !== null && shim.targetGeneration !== current.record.generation) {
      add("selection-mismatch", `shim ${shim.targetGeneration} != current.json ${current.record.generation}`);
    }
  }

  const state = { path: paths.state, exists: existsSync(paths.state) };
  return { ok: mismatches.length === 0, agentDir: paths.agentDir, shim, current: currentReport,
    generations, state, mismatches };
}

// ---------------------------------------------------------------- CLI -------------------------
const USAGE = [
  "Usage: node scripts/install.mjs --agent-dir <dir> [--lang ko|en|zh-cn] [--dry-run]",
  "       node scripts/install.mjs --agent-dir <dir> --select <generation-NNNNNN>",
  "       node scripts/install.mjs --agent-dir <dir> --remove",
  "       node scripts/install.mjs --agent-dir <dir> --doctor",
  "  --agent-dir  agent directory (default: <home>/.gjc/agent)",
  "  --lang       language written to the generation's config.json (default: ko)",
  "  --dry-run    print the install plan; write nothing",
  "  --select     re-point the shim + current.json at an existing managed generation",
  "  --remove     delete the managed shim only (generations and state stay)",
  "  --doctor     report shim target, current.json, generations and mismatches (exit 1 on mismatch)",
].join("\n");

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw coded("usage", `${flag} needs a value`);
  return value;
}

export function parseInstallArgs(args = []) {
  const options = {
    agentDir: join(homedir(), ".gjc", "agent"),
    lang: "ko",
    dryRun: false,
    select: null,
    remove: false,
    doctor: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--agent-dir") options.agentDir = requireValue(args, index++, flag);
    else if (flag === "--lang") options.lang = requireValue(args, index++, flag);
    else if (flag === "--dry-run") options.dryRun = true;
    else if (flag === "--select") options.select = requireValue(args, index++, flag);
    else if (flag === "--remove") options.remove = true;
    else if (flag === "--doctor") options.doctor = true;
    else throw coded("usage", `Unknown argument: ${flag}`);
  }
  if (options.help) return options;
  assertLang(options.lang);
  if (options.select !== null && !isGenerationName(options.select)) {
    throw coded("usage", `--select needs generation-NNNNNN: ${options.select}`);
  }
  const modes = [options.select !== null, options.remove, options.doctor].filter(Boolean).length;
  if (modes > 1) throw coded("usage", "--select, --remove and --doctor are mutually exclusive");
  if (modes > 0 && options.dryRun) throw coded("usage", "--dry-run applies only to a fresh install");
  return options;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr, env = process.env } = deps;
  let options;
  try { options = parseInstallArgs(argv); }
  catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    if (options.doctor) {
      const report = await doctor(options, { env });
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? 0 : 1;
    }
    const result = options.remove ? await removeShim(options, { env })
      : options.select !== null ? await selectGeneration(options, { env })
        : await install(options, { env });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.code ?? "install"}: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {});
}
