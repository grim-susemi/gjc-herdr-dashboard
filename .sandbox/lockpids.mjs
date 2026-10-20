import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
const slot = readdirSync(join(root, "slots"))[0];
const dir = join(root, "slots", slot, "lock");
const pids = new Map(), inst = new Map();
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".lock")) continue;
  try { const j = JSON.parse(readFileSync(join(dir, f), "utf8")); pids.set(j.pid, (pids.get(j.pid) || 0) + 1); inst.set(j.instanceId, (inst.get(j.instanceId) || 0) + 1); }
  catch (e) { /* outcome: a lock file removed by gc mid-scan is not evidence */ }
}
console.log("lock files by pid", JSON.stringify([...pids]));
console.log("lock files by instanceId", JSON.stringify([...inst]));
console.log("owner", readFileSync(join(root, "slots", slot, "owner.json"), "utf8"));
