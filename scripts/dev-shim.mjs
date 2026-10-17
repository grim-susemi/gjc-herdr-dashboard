// Dev shim generator for the GJC Herdr dashboard (plan §7.7, stage-05 R4 for the URL
// form, R3/SR9 for the viewer failpoint).
//
// Usage: node scripts/dev-shim.mjs --case <id> [--state <dir>] [--herdr <json argv>]
//                                  [--viewer-failpoint <value>] [--root <dir>]
//
// The generated file is a pure re-export of the absolute URL of this tree's `extension.mjs`
// plus two or three `??=` defaults, so a drill can point one case at its own state directory
// and herdr argv without touching the environment it was launched from.
//
// Form of the re-export: plan §7.7 writes the shim (sandbox and user scope alike) as
// `export { default } from '<absolute URL>';` with the `??=` defaults above it, and that is
// what this generator emits.
//
// ESM ordering caveat: `export … from` and `import … from` are both *static* module
// dependencies, so the target is instantiated and evaluated before this file's own body
// runs. The `??=` lines therefore execute after `extension.mjs` has been evaluated and
// before GJC calls the default export — which is exactly the ordering §7.7 relies on
// ("둘 다 factory 호출 전에 실행되고, 모듈은 import 시점에 env를 읽지 않는다"). It is safe only
// because the entry registers handlers and reads the environment inside the factory, never
// at import time (§7.1 item 1). If the entry ever read the environment during its own
// evaluation, no static form could guarantee the order, and this file would need a wrapper
// that dynamically imports the absolute URL from its own body; SR5 bans dynamic *relative*
// imports and permits absolute URLs, so that escape hatch is legal, but there is no reason to
// pay for it today. `test/unit/dev-shim.test.mjs` observes both readings: the entry records
// what it saw at import time (no defaults yet) and what the factory sees afterwards
// (defaults applied).
//
// Exported signatures
//   SHIM_FILE: 'gjc-herdr-dashboard.js'
//   SHIM_USAGE: string
//   parseShimArgs(args): { caseId, stateDir, herdr, viewerFailpoint, root, help }
//   shimSource({ caseUrl, stateDir, herdr, viewerFailpoint }): string
//   shimPlan(options, deps?): { dir, path, source, stateDir }
//   writeShim(options, deps?): Promise<plan & { written: true }>
//   main(argv?, deps?): Promise<number>
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SHIM_FILE = "gjc-herdr-dashboard.js";

export const SHIM_USAGE = [
  "Usage: node scripts/dev-shim.mjs --case <id> [--state <dir>] [--herdr <json argv>]",
  "                                  [--viewer-failpoint <value>] [--root <dir>]",
  "  --case             case id; the shim goes to <root>/case-<id>/.gjc/extensions/",
  "  --state            absolute state dir written as GJC_HERDR_DASHBOARD_STATE_DIR",
  "                     (default <case>/.gjc/herdr-dashboard/state)",
  "  --herdr            JSON argv array for GJC_HERDR_DASHBOARD_HERDR (§7.10)",
  "  --viewer-failpoint value for GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT (R3, SR9)",
  "  --root             sandbox root (default <repo>/.sandbox)",
].join("\n");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A single-quoted JS literal. Case ids may be Korean and may contain spaces (the plan
// keeps `.sandbox/한글 공백/` for quoting drills), and a Windows path holds backslashes.
const literal = (value) => `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

export function parseShimArgs(args = []) {
  const options = { caseId: null, stateDir: null, herdr: null, viewerFailpoint: null,
    root: join(REPO_ROOT, ".sandbox"), help: false };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--case") options.caseId = requireValue(args, index++, flag);
    else if (flag === "--state") options.stateDir = requireValue(args, index++, flag);
    else if (flag === "--herdr") options.herdr = requireValue(args, index++, flag);
    else if (flag === "--viewer-failpoint") {
      options.viewerFailpoint = requireValue(args, index++, flag);
    } else if (flag === "--root") options.root = requireValue(args, index++, flag);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!options.help && !options.caseId) throw new Error("--case is required");
  return options;
}

// `herdr` is an argv array (§7.10 stores it as JSON), so a mistyped value fails here
// rather than inside a live pass.
function herdrLiteral(value) {
  if (value === null) return null;
  const text = String(value);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`--herdr must be a JSON argv array: ${cause.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
    throw new Error("--herdr must be a non-empty JSON array of strings");
  }
  return JSON.stringify(parsed);
}

export function shimSource({ caseUrl, stateDir, herdr = null, viewerFailpoint = null } = {}) {
  const lines = [
    "// Generated by scripts/dev-shim.mjs. Do not edit; regenerate the case instead.",
    "// The env defaults below run after the entry module is evaluated and before GJC calls",
    "// its default export (§7.7).",
    `process.env.GJC_HERDR_DASHBOARD_STATE_DIR ??= ${literal(stateDir)};`,
  ];
  if (herdr !== null) lines.push(`process.env.GJC_HERDR_DASHBOARD_HERDR ??= ${literal(herdr)};`);
  if (viewerFailpoint !== null) {
    lines.push(`process.env.GJC_HERDR_DASHBOARD_VIEWER_FAILPOINT ??= ${literal(viewerFailpoint)};`);
  }
  lines.push(`export { default } from ${literal(caseUrl)};`, "");
  return lines.join("\n");
}

export function shimPlan(options, { repoRoot = REPO_ROOT, exists = existsSync } = {}) {
  const caseId = options.caseId;
  const root = isAbsolute(options.root) ? options.root : resolve(options.root);
  const dir = join(root, `case-${caseId}`);
  const stateDir = options.stateDir
    ? (isAbsolute(options.stateDir) ? options.stateDir : resolve(options.stateDir))
    : join(dir, ".gjc", "herdr-dashboard", "state");
  const entry = join(repoRoot, "extension.mjs");
  if (!exists(entry)) throw new Error(`extension.mjs is missing: ${entry}`);
  const source = shimSource({ caseUrl: pathToFileURL(entry).href, stateDir,
    herdr: herdrLiteral(options.herdr), viewerFailpoint: options.viewerFailpoint });
  return { dir, path: join(dir, ".gjc", "extensions", SHIM_FILE), source, stateDir };
}

export async function writeShim(options, { mkdirFn = mkdir, writeFileFn = writeFile, ...deps } = {}) {
  const plan = shimPlan(options, deps);
  await mkdirFn(dirname(plan.path), { recursive: true, mode: 0o700 });
  await writeFileFn(plan.path, plan.source, "utf8");
  return { ...plan, written: true };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const { stdout = process.stdout, stderr = process.stderr } = deps;
  let options;
  try {
    options = parseShimArgs(argv);
  } catch (cause) {
    stderr.write(`${cause.message}\n${SHIM_USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${SHIM_USAGE}\n`);
    return 0;
  }
  try {
    const plan = await writeShim(options, deps);
    stdout.write(`${plan.path}\n`);
    return 0;
  } catch (cause) {
    stderr.write(`${cause.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), {});
}
