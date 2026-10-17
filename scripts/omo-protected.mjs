// AC-G1 helper: print sha256 of the two protected omo files and the omo repo ref/status, read-only.
// Usage: node scripts/omo-protected.mjs > snapshot.txt   (compare two snapshots with a plain diff)
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const files = [
  join(home, ".omo-stable-500", "home", ".omo", "agent", "extensions", "omo-herdr-dashboard.js"),
  join(home, ".omo-stable-500", "home", ".omo", "agent", "herdr-dashboard", "integration", "current.json"),
];
for (const file of files) {
  const text = existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "MISSING";
  console.log(`${text}  ${file.replaceAll("\\", "/")}`);
}
const repo = join(home, "orca", "projects", "omo-herdr-dashboard");
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
console.log(`main=${git("rev-parse", "main").stdout.trim()}`);
console.log(`status-porcelain-lines=${git("status", "--porcelain").stdout.split("\n").filter(Boolean).length}`);
