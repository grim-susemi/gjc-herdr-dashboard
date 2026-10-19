// Generation builder for the GJC Herdr dashboard (plan §13, stage-05 R4/R5).
//
// A generation tree is a full runtime copy with the SAME relative layout as the repository root:
// `extension.mjs`, `src/**`, `locale/**`, `package.json`, optional `LICENSE` /
// `THIRD-PARTY-NOTICES.md`, plus a generated `config.json` { generation, lang }. The entry and every
// viewer resolve assets from that root only, so no fallback path exists (R4).
//
// The builder is deliberately strict: a missing required file fails the build instead of producing
// a tree that would later be rejected as `mirrored-install` or fail at import time.
//
// Exported signatures
//   REPO_ROOT
//   LANGUAGES
//   CONFIG_FILE, CONFIG_SCHEMA
//   isGenerationName(value), isGenerationToken(value), tokenOfGeneration(name)
//   configFor({ generation, lang })
//   runtimePlan({ root?, access?, readFile? }) -> Promise<{ root, files, optional }>
//   planGeneration({ generation, lang, root? }) -> Promise<plan>
//   buildGeneration({ dest, generation, lang, root? }) -> Promise<plan & { dest }>
//   main(argv?, deps?) -> Promise<number>
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LANGUAGES = Object.freeze(["ko", "en", "zh-cn"]);
export const CONFIG_FILE = "config.json";
export const CONFIG_SCHEMA = "gjc-herdr-dashboard/config/1";

// The top-level files every generation must carry. `package.json` is part of the runtime copy
// (plan §13) even though nothing reads it at runtime today.
const REQUIRED_TOP = Object.freeze(["extension.mjs", "package.json"]);
const REQUIRED_LOCALE = Object.freeze(LANGUAGES.map((language) => `locale/${language}.json`));
// A generation keeps the repository's optional licence/notice files when they exist.
const OPTIONAL_TOP = Object.freeze(["LICENSE", "THIRD-PARTY-NOTICES.md"]);

export const isGenerationName = (value) => typeof value === "string" && /^generation-\d{6}$/.test(value);
export const isGenerationToken = (value) => typeof value === "string" && /^gen-\d{6}$/.test(value);
export const tokenOfGeneration = (name) => {
  if (!isGenerationName(name)) throw new Error(`not a generation name: ${String(name)}`);
  return name.replace(/^generation-/, "gen-");
};

const coded = (code, message) => Object.assign(new Error(message ?? code), { code });
const norm = (path) => path.split(sep).join("/");

async function walkFiles(dir, base = dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") throw coded("missing-runtime", `runtime directory is missing: ${dir}`);
    throw error;
  }
  const out = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full, base));
    else if (entry.isFile()) out.push(norm(relative(base, full)));
  }
  return out;
}

// The full required file list, relative to the tree root. `src/**` is discovered from the source
// tree; the three locale catalogues and the entrypoints are fixed names.
export async function runtimePlan({ root = REPO_ROOT } = {}) {
  const absoluteRoot = resolve(root);
  const src = await walkFiles(join(absoluteRoot, "src"));
  if (src.length === 0) throw coded("missing-runtime", `no runtime files under ${join(absoluteRoot, "src")}`);
  const files = [...REQUIRED_TOP, ...REQUIRED_LOCALE, ...src.map((path) => `src/${path}`)];
  const optional = OPTIONAL_TOP.filter((name) => existsSync(join(absoluteRoot, name)));
  const unique = [...new Set(files)].sort();
  // Every required file is read once here: an unreadable file or an invalid catalogue fails the
  // build before a single byte is copied.
  for (const relativePath of unique) {
    let bytes;
    try { bytes = await readFile(join(absoluteRoot, ...relativePath.split("/"))); }
    catch (error) {
      throw coded("missing-runtime", `required file is missing or unreadable: ${relativePath} (${error.code ?? error.message})`);
    }
    if (relativePath.startsWith("locale/") && relativePath.endsWith(".json")) {
      let parsed;
      try { parsed = JSON.parse(bytes.toString("utf8")); }
      catch (error) {
        throw coded("invalid-locale", `${relativePath} is not valid JSON: ${error.message}`);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw coded("invalid-locale", `${relativePath} must be a JSON object`);
      }
    }
  }
  const pkg = JSON.parse((await readFile(join(absoluteRoot, "package.json"))).toString("utf8"));
  if (pkg?.type !== "module") throw coded("invalid-package", "package.json must declare type:module");
  return { root: absoluteRoot, files: unique, optional };
}

export function configFor({ generation, lang }) {
  if (!isGenerationToken(generation)) throw coded("invalid-generation", `generation token must be gen-NNNNNN: ${String(generation)}`);
  if (!LANGUAGES.includes(lang)) throw coded("invalid-language", `unsupported language: ${String(lang)}`);
  return { schema: CONFIG_SCHEMA, generation, lang };
}

// A plan is everything a dry run may inspect: it validates the source tree and produces the exact
// file list, but writes nothing.
export async function planGeneration({ generation, lang, root = REPO_ROOT } = {}) {
  const config = configFor({ generation, lang });
  const runtime = await runtimePlan({ root });
  return { root: runtime.root, generation, token: generation, lang,
    config, files: [...runtime.files, CONFIG_FILE].sort(), optional: runtime.optional };
}

export async function buildGeneration({ dest, generation, lang, root = REPO_ROOT } = {}) {
  const plan = await planGeneration({ generation, lang, root });
  const absoluteDest = resolve(dest);
  if (existsSync(absoluteDest)) throw coded("generation-exists", `generation directory already exists: ${absoluteDest}`);
  await mkdir(absoluteDest, { recursive: true, mode: 0o700 });
  for (const relativePath of plan.files) {
    if (relativePath === CONFIG_FILE) continue;
    const target = join(absoluteDest, ...relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(plan.root, ...relativePath.split("/")), target);
  }
  for (const name of plan.optional) {
    await copyFile(join(plan.root, name), join(absoluteDest, name));
  }
  await writeFile(join(absoluteDest, CONFIG_FILE), `${JSON.stringify(plan.config, null, 2)}\n`, "utf8");
  // A copied tree is only useful if every file actually landed; read the full set back.
  for (const relativePath of [...plan.files, ...plan.optional]) {
    const info = await stat(join(absoluteDest, ...relativePath.split("/")));
    if (!info.isFile()) throw coded("build-incomplete", `copied file is not a regular file: ${relativePath}`);
  }
  return { ...plan, dest: absoluteDest };
}

const USAGE = [
  "Usage: node scripts/build.mjs --out <generation-dir> --generation <gen-NNNNNN> --lang <ko|en|zh-cn>",
  "  --out          destination directory (must not exist)",
  "  --generation   generation token written to config.json (gen-NNNNNN)",
  "  --lang         ko (default), en or zh-cn",
  "  --root         source tree root (default: the repository root)",
].join("\n");

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw coded("usage", `${flag} needs a value`);
  return value;
}

export function parseBuildArgs(args = []) {
  const options = { out: null, generation: null, lang: "ko", root: REPO_ROOT, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--out") options.out = requireValue(args, index++, flag);
    else if (flag === "--generation") options.generation = requireValue(args, index++, flag);
    else if (flag === "--lang") options.lang = requireValue(args, index++, flag);
    else if (flag === "--root") options.root = requireValue(args, index++, flag);
    else throw coded("usage", `Unknown argument: ${flag}`);
  }
  if (options.help) return options;
  if (!options.out) throw coded("usage", "--out is required");
  if (!options.generation) throw coded("usage", "--generation is required");
  return options;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr } = deps;
  let options;
  try { options = parseBuildArgs(argv); }
  catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await buildGeneration({ dest: options.out, generation: options.generation,
      lang: options.lang, root: options.root });
    stdout.write(`${JSON.stringify({ built: true, ...result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.code ?? "build"}: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {});
}
