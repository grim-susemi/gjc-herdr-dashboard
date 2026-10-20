// L0 spike (deleted at L0 exit): U7 events.subscribe pane_focused and G6 focus invariance.
import net from "node:net";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const SESSION = process.argv[2] ?? "gjcdash-probe";
const BIN = process.env.HERDR_BIN_PATH ?? "herdr";
const RAW = process.argv[3];
const SOCK = process.platform === "win32" ? `\\\\.\\pipe\\${RAW}` : RAW;
const OUT = ".evidence/L0/probe.jsonl";
const record = (gate, ok, data) => {
  appendFileSync(OUT, JSON.stringify({ gate, ok, at: new Date().toISOString(), ...data }) + "\n");
  console.log(gate, ok ? "OK" : "FAIL", JSON.stringify(data).slice(0, 400));
};
const h = (...args) => JSON.parse(execFileSync(BIN, ["--session", SESSION, ...args], { encoding: "utf8", timeout: 20000 }));
const focusedOf = () => h("pane", "list").result.panes.filter((p) => p.focused).map((p) => p.pane_id);

// G6 focus invariance: split --no-focus must not change the focused set.
const root = h("pane", "list").result.panes[0].pane_id;
const before = focusedOf();
const created = h("pane", "split", root, "--direction", "right", "--no-focus").result.pane.pane_id;
const after = focusedOf();
record("G6-focus-invariant-split-no-focus", JSON.stringify(before) === JSON.stringify(after), { before, after, created });

// U7: subscribe, then focus the created pane and the root pane.
const events = [];
let subscribeAck = null;
await new Promise((resolve, reject) => {
  const socket = net.createConnection(SOCK, () => {
    socket.write(JSON.stringify({ id: "u7", method: "events.subscribe", params: { subscriptions: ["pane.focused", "tab.focused", "workspace.focused"].map((type) => ({ type })) } }) + "\n");
  });
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id === "u7" && !subscribeAck) { subscribeAck = { keys: Object.keys(msg), hasError: !!msg.error }; continue; }
        events.push({ keys: Object.keys(msg), event: msg.event, dataKeys: msg.data ? Object.keys(msg.data) : null, type: msg.data?.type, pane_id: msg.data?.pane_id });
      } catch { /* outcome: non-JSON frame ignored in spike */ }
    }
  });
  socket.on("error", reject);
  setTimeout(() => { try { h("pane", "focus", "--pane", root, "--direction", "right"); } catch (e) { events.push({ focusError: String(e.message).slice(0, 120) }); } }, 800);
  setTimeout(() => { try { h("pane", "focus", "--pane", created, "--direction", "left"); } catch (e) { events.push({ focusError: String(e.message).slice(0, 120) }); } }, 1600);
  setTimeout(() => { socket.destroy(); resolve(); }, 3200);
});
const gotFocused = events.some((e) => e.type === "pane_focused" || e.event === "pane_focused");
record("U7-events-subscribe-pane_focused", gotFocused, { subscribeAck, events: events.slice(0, 6) });
h("pane", "close", created);
