// Test runner with environment isolation: tests never see the real Herdr or the
// owner's home. HERDR_* is removed; HOME/USERPROFILE point at a temp dir.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "gjc-herdr-dashboard-test-"));
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("HERDR_")) continue;
  env[key] = value;
}
env.HOME = home;
env.USERPROFILE = home;

const unitDir = join(root, "test", "unit");
const files = existsSync(unitDir)
  ? readdirSync(unitDir).filter((name) => name.endsWith(".test.mjs")).map((name) => join(unitDir, name))
  : [];
if (files.length === 0) {
  console.error("no unit tests found in test/unit");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", ...files], { cwd: root, env, stdio: "inherit" });
process.exit(result.status ?? 1);
