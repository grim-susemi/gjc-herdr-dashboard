import { spawn } from "node:child_process";
import { openSync } from "node:fs";
const out = openSync(".evidence/L0/probe-server-l1.log", "a");
const c = spawn(process.env.HERDR_BIN_PATH, ["--session", "gjcdash-l1", "server"], { detached: true, stdio: ["ignore", out, out], windowsHide: true });
c.unref();
console.log("started", c.pid);
