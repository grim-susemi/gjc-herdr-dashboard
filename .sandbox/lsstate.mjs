import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
const walk = (d, o = []) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p, o) : o.push(p); } return o; };
const root = process.argv[2];
for (const f of walk(root)) console.log(f.slice(root.length + 1).replace(/\\/g, "/"), statSync(f).size);
const slotDir = join(root, "slots");
for (const d of readdirSync(slotDir)) {
  const s = JSON.parse(readFileSync(join(slotDir, d, "slot.json"), "utf8"));
  console.log("slot.todo", JSON.stringify(s.roles.todo));
  try { console.log("ready", readFileSync(join(slotDir, d, "roles", "todo.ready.json"), "utf8")); } catch (e) { console.log("ready: none", e.code); }
}
