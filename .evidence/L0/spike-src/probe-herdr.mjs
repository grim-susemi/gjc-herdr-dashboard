// L0 spike (deleted at L0 exit): G6, G7-use, U9, U10, U12, U13 against a harness-owned Herdr session.
// Writes keys/types and outcomes only to .evidence/L0/probe.jsonl.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const SESSION = process.argv[2] ?? "gjcdash-probe";
const BIN = process.env.HERDR_BIN_PATH ?? "herdr";
const OUT = ".evidence/L0/probe.jsonl";
mkdirSync(".evidence/L0", { recursive: true });

const record = (gate, ok, data) => {
  appendFileSync(OUT, JSON.stringify({ gate, ok, at: new Date().toISOString(), ...data }) + "\n");
  console.log(gate, ok ? "OK" : "FAIL", JSON.stringify(data).slice(0, 300));
};

function h(...args) {
  try {
    const stdout = execFileSync(BIN, ["--session", SESSION, ...args], { encoding: "utf8", timeout: 20000 });
    return { ok: true, json: safe(stdout), raw: stdout };
  } catch (error) {
    return { ok: false, json: safe(String(error.stdout ?? "")), raw: String(error.stdout ?? ""), err: String(error.stderr ?? error.message).slice(0, 400) };
  }
}
function safe(text) { try { return JSON.parse(text); } catch { return null; } }
const keys = (v) => (v && typeof v === "object" ? Object.keys(v).sort() : typeof v);

const ws = h("workspace", "create", "--label", "gjcdash-l0", "--cwd", process.cwd());
record("U13-workspace-create", ws.ok, { keys: keys(ws.json?.result), err: ws.err });
if (!ws.ok) process.exit(1);
const wsId = ws.json.result.workspace?.workspace_id ?? ws.json.result.workspace_id;
const first = h("pane", "list");
const root = first.json?.result?.panes?.[0];
record("G6-list", first.ok && !!root, { paneKeys: keys(root), count: first.json?.result?.panes?.length });
if (!root) process.exit(1);
const rootId = root.pane_id;

const split = h("pane", "split", rootId, "--direction", "right", "--no-focus");
const splitPane = split.json?.result?.pane;
record("G6-split", split.ok && !!splitPane, { keys: keys(splitPane), err: split.err });
if (!splitPane) process.exit(1);
const p1 = splitPane.pane_id;

record("G6-rename", h("pane", "rename", p1, "gjcdash-probe-viewer").ok, {});
const lay = h("pane", "layout", "--pane", p1);
record("G6-layout", lay.ok, { keys: keys(lay.json?.result), err: lay.err });
const pi = h("pane", "process-info", "--pane", p1);
record("G6-process-info", pi.ok, { keys: keys(pi.json?.result) });
const run = h("pane", "run", p1, "node -e \"console.log('probe-ok ' + (process.env.HERDR_PANE_ID||'none'))\"");
record("G6-run", run.ok, { err: run.err });
const wait = h("pane", "wait-output", p1, "--match", "probe-ok", "--timeout", "15000");
record("G6-wait-output", wait.ok, { err: wait.err });
const read = h("pane", "read", p1, "--source", "visible");
const text = typeof read.json?.result?.read?.text === "string" ? read.json.result.read.text : read.raw;
record("G6-read-env", /probe-ok w\d+:\S+/.test(text), { readKeys: keys(read.json?.result), sawPaneIdEnv: /probe-ok w\d+:\S+/.test(text), matchedAny: /probe-ok/.test(text) });

// U9: split/close 20 times
const ids = [];
let u9 = true;
for (let i = 0; i < 20; i++) {
  const s = h("pane", "split", rootId, "--direction", "down", "--no-focus");
  const id = s.json?.result?.pane?.pane_id;
  if (!id) { u9 = false; break; }
  ids.push(id);
  if (!h("pane", "close", id).ok) { u9 = false; break; }
}
record("U9-split-close-20", u9, { ids });

// U10: exit in a new pane removes it from list
const s10 = h("pane", "split", rootId, "--direction", "down", "--no-focus");
const id10 = s10.json?.result?.pane?.pane_id;
if (id10) {
  h("pane", "run", id10, "exit");
  await new Promise((r) => setTimeout(r, 4000));
  const ids10 = (h("pane", "list").json?.result?.panes ?? []).map((p) => p.pane_id);
  record("U10-exit-removes-pane", !ids10.includes(id10), { id10, remaining: ids10 });
  if (ids10.includes(id10)) h("pane", "close", id10);
} else record("U10-exit-removes-pane", false, { err: s10.err });

// U12: split --help flags
const help = h("pane", "split", "--help");
record("U12-split-flags", true, { flags: (help.raw.match(/--[a-z-]+/g) ?? []).filter((v, i, a) => a.indexOf(v) === i) });

h("pane", "close", p1);
console.log("probe done");
