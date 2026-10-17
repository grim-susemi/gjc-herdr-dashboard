// L0 B1/B2 baseline of the omo archive. Read-only on omo: runs node --test inside an
// extracted `git archive` copy with HERDR_* removed and HOME/USERPROFILE in a temp dir.
// usage: node scripts/baseline-omo.mjs <archiveRoot> <outJson>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [archiveRoot, outPath] = process.argv.slice(2);
if (!archiveRoot || !outPath) throw new Error("usage: baseline-omo.mjs <archiveRoot> <outJson>");

const home = mkdtempSync(join(tmpdir(), "omo-baseline-home-"));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("HERDR_") || key.startsWith("OMO_")) continue;
  env[key] = value;
}
env.HOME = home;
env.USERPROFILE = home;

function listTests(dir) {
  return existsSync(dir)
    ? readdirSync(dir).filter((n) => n.endsWith(".test.mjs")).sort().map((n) => join(dir, n))
    : [];
}

function parse(output) {
  const grab = (key) => {
    const m = output.match(new RegExp(`^# ${key} (\\d+)`, "m"));
    return m ? Number(m[1]) : null;
  };
  const failures = [];
  const stack = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(\s*)(not ok) \d+ - (.*)$/) ;
    if (m) failures.push({ depth: m[1].length / 4, name: m[3].trim() });
  }
  return { total: grab("tests"), pass: grab("pass"), fail: grab("fail"), skipped: grab("skipped"), cancelled: grab("cancelled"), todo: grab("todo"), failures };
}

function run(files) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
    cwd: archiveRoot, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 600000,
  });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

const result = { node: process.version, archiveRoot, b1: null, b2: {} };

const b1Files = listTests(join(archiveRoot, "test"));
const b1 = run(b1Files);
result.b1 = { files: b1Files.map((f) => f.slice(archiveRoot.length + 1)), status: b1.status, ...parse(b1.output) };
writeFileSync(outPath.replace(/\.json$/, ".b1.tap.txt"), b1.output);

for (const pkg of ["todo", "dag"]) {
  for (const file of listTests(join(archiveRoot, "packages", pkg, "test"))) {
    const r = run([file]);
    result.b2[`packages/${pkg}/test/${file.split(/[\\/]/).pop()}`] = { status: r.status, ...parse(r.output) };
  }
}
writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ b1: { total: result.b1.total, pass: result.b1.pass, fail: result.b1.fail, skipped: result.b1.skipped }, b2files: Object.keys(result.b2).length }));
