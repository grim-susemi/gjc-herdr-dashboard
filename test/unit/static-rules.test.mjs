// Static rules SR1-SR9 (plan 15.2 + R3/SR9). Targets: extension.mjs, src/**, scripts/**.
// `scripts/dev-shim.mjs` and `src/core/launch.mjs` have the explicit allowances described per rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const norm = (p) => p.split(sep).join("/");

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

export function targetFiles() {
  const files = [];
  const entry = join(root, "extension.mjs");
  if (existsSync(entry)) files.push(entry);
  files.push(...walk(join(root, "src")), ...walk(join(root, "scripts")));
  return files
    .map((file) => ({ rel: norm(relative(root, file)), text: readFileSync(file, "utf8") }))
    // scripts/ holds repository tooling that is not shipped; the baseline runner and the AC-G1 hasher
    // read omo on purpose (read-only).
    .filter((f) => !["scripts/test.mjs", "scripts/baseline-omo.mjs", "scripts/omo-protected.mjs"].includes(f.rel));
}

// Each rule: a function (rel, text) -> array of violation strings.
export const rules = {
  SR1: (rel, text) => {
    const hits = [];
    if (/\.catch\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined)\s*\)/.test(text)) hits.push("silent .catch");
    for (const m of text.matchAll(/catch\s*(\([^)]*\))?\s*\{\s*(\/\/[^\n]*)?\s*\}/g)) {
      if (!/\/\/\s*outcome:/.test(m[0])) hits.push("empty catch without // outcome:");
    }
    return hits;
  },
  SR2: (rel, text) => (/report-agent|report-metadata|release-agent|GJC_HERDR_PANE_OWNER/.test(text) ? ["GJC herdr reporter surface"] : []),
  SR3: (rel, text) => (/\.omo|omo-stable|OMO_/.test(text) ? ["omo path or env reference"] : []),
  SR4: (rel, text) => (/_session-/.test(text) ? ["GJC session directory literal"] : []),
  // SR5 bans a dynamic import whose argument is not an explicit absolute file URL. The plan and
  // README §5 allow an absolute URL escape hatch; `pathToFileURL(...)` is that form.
  SR5: (rel, text) => (/import\(\s*(?!pathToFileURL\s*\()(?![`'"])|import\(\s*['"`]\.{1,2}\//.test(text)
    ? ["dynamic non-absolute import"] : []),
  SR6: (rel, text) => (/tab\s+focus|['"]tab['"]\s*,\s*['"]focus['"]/.test(text) ? ["herdr tab focus"] : []),
  SR7: (rel, text) => (rel !== "src/core/launch.mjs" && /['"]pane['"]\s*,\s*['"]run['"]|pane\s+run/.test(text) ? ["herdr pane run outside launch.mjs"] : []),
  SR8: (rel, text) => (/(spawn|execFile|execFileSync|spawnSync)\(\s*['"`](gjc|gjc\.exe)['"`]/.test(text) ? ["gjc spawn/execFile"] : []),
  SR9: (rel, text) => {
    const hits = [];
    // The installer has its own D3 failpoint (scripts/install.mjs); product code and the installed
    // shim must not carry one.
    const failpointAllowed = rel === "src/core/launch.mjs" || rel === "scripts/dev-shim.mjs"
      || rel === "scripts/install.mjs";
    if (!failpointAllowed && /FAILPOINT/.test(text)) hits.push("FAILPOINT outside launch.mjs/dev-shim.mjs/install.mjs");
    if (rel !== "src/viewers/common.mjs" && /--failpoint/.test(text) && rel !== "scripts/dev-shim.mjs" && rel !== "src/core/launch.mjs") {
      hits.push("--failpoint parsing outside src/viewers/common.mjs");
    }
    return hits;
  },
};

for (const [id, rule] of Object.entries(rules)) {
  test(`${id}: no violations in product sources`, () => {
    const violations = [];
    for (const file of targetFiles()) {
      for (const hit of rule(file.rel, file.text)) violations.push(`${file.rel}: ${hit}`);
    }
    assert.deepEqual(violations, []);
  });
}

// Self-checks: every rule must actually catch its own violation, otherwise a green run proves nothing.
const bad = {
  SR1: ["src/x.mjs", "p.catch(() => {});"],
  SR2: ["src/x.mjs", "run('report-agent')"],
  SR3: ["src/x.mjs", "const p = process.env.OMO_HOME;"],
  SR4: ["src/x.mjs", "const d = '_session-abc';"],
  SR5: ["src/x.mjs", "await import('./x.mjs');"],
  SR6: ["src/x.mjs", "herdr('tab','focus')"],
  SR7: ["src/x.mjs", "herdr('pane', 'run', id)"],
  SR8: ["src/x.mjs", "spawn('gjc', ['-p'])"],
  SR9: ["src/x.mjs", "const FAILPOINT = 1;"],
};
for (const [id, [rel, text]] of Object.entries(bad)) {
  test(`${id}: rule catches a seeded violation`, () => {
    assert.ok(rules[id](rel, text).length > 0);
  });
}
test("SR1: an empty catch with an outcome comment is allowed", () => {
  assert.deepEqual(rules.SR1("src/x.mjs", "try { a(); } catch { // outcome: ignored on purpose\n}"), []);
});
test("SR7: pane run is allowed inside src/core/launch.mjs", () => {
  assert.deepEqual(rules.SR7("src/core/launch.mjs", "herdr('pane', 'run', id)"), []);
});
test("SR5: an absolute file-URL dynamic import is allowed", () => {
  assert.deepEqual(rules.SR5("src/x.mjs", "await import(pathToFileURL(entry).href);"), []);
  assert.deepEqual(rules.SR5("src/x.mjs", "await import(`file:///C:/tree/extension.mjs`);"), []);
  assert.ok(rules.SR5("src/x.mjs", "await import(url);").length > 0);
});
test("SR9: FAILPOINT is allowed in launch.mjs and dev-shim.mjs", () => {
  assert.deepEqual(rules.SR9("src/core/launch.mjs", "FAILPOINT"), []);
  assert.deepEqual(rules.SR9("scripts/dev-shim.mjs", "FAILPOINT"), []);
});
test("SR9: the install failpoint is allowed only in scripts/install.mjs", () => {
  assert.deepEqual(rules.SR9("scripts/install.mjs", "GJC_HERDR_DASHBOARD_INSTALL_FAILPOINT"), []);
  assert.ok(rules.SR9("scripts/verify-package.mjs", "GJC_HERDR_DASHBOARD_INSTALL_FAILPOINT").length > 0);
});
