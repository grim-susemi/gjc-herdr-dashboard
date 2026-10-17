// Unit tests for the live harness wrapper (test/live/herdr-wrapper.mjs).
//
// The wrapper's forwarding seam is `main(argv, {spawnFn, spawnDetached, sleepFn, ...})`, which is what
// these tests drive: the real `spawnSync` is never asked to launch anything, so a test can assert the
// exact binary, the exact argv (including the session prefix) and the exact environment without
// needing a fake executable. (A `.cmd`/`.bat` stand-in is NOT usable on Windows: `child_process`
// refuses to spawn a batch file without a shell, which is why the seam exists.)
//
// The CLI entry is still exercised for real (a child `node herdr-wrapper.mjs …`) on the paths that
// need true process behaviour: exit code, stdout bytes, and a genuinely failing real binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FLAG_DELAY, FLAG_LIST, FLAG_SPLIT, HELPER_DELAY_ENV, HELPER_ENV, RUN_DELAY_MS,
  delayApplies, logLine, main, paneIdOf, planCall, sessionArgs } from "../live/herdr-wrapper.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRAPPER = join(REPO, "test", "live", "herdr-wrapper.mjs");
const NOT_A_BINARY = join(REPO, ".sandbox", "flags", "never-executed.exe");

// A scratch dir per test: the log and the flags live here, so no test can touch the real
// `.sandbox/wrapper.log.jsonl` or leave a flag behind for a live run.
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "gjc-live-wrapper-"));
  const flags = join(dir, "flags");
  mkdirSync(flags, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, flags, log: join(dir, "wrapper.log.jsonl"),
    env: { GJC_LIVE_LOG_DIR: dir, GJC_LIVE_FLAGS_DIR: flags, GJC_LIVE_REAL_HERDR: NOT_A_BINARY,
      HERDR_SOCKET_PATH: "C:\\fake\\herdr.sock" } };
}

const flag = (flags, name) => join(flags, name);
const lines = (log) => (existsSync(log)
  ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : []);
const appendLine = (log, line) => {
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, line, { encoding: "utf8", flag: "a" });
};
const splitLine = (paneId, msAgo = 5_000) => logLine({ at: new Date(Date.now() - msAgo).toISOString(),
  argv: ["pane", "split", "w1:p1"], ok: true, code: null, ms: 5, paneId });

function capture() {
  const out = { stdout: "", stderr: "" };
  return { out, stdout: { write: (text) => { out.stdout += text; } },
    stderr: { write: (text) => { out.stderr += text; } } };
}

function recordingSpawn(reply = {}) {
  const calls = [];
  const spawn = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { status: reply.status ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { calls, spawn };
}

function recordingDetach() {
  const calls = [];
  const spawnDetached = (bin, argv, options) => {
    calls.push({ bin, argv, options });
    return { pid: 4242, unref: () => {} };
  };
  return { calls, spawnDetached };
}

// The child environment for a real CLI run: this process's own env minus HERDR_*, plus overrides.
function childEnv(overrides) {
  const copy = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("HERDR_")) copy[key] = value;
  }
  return Object.assign(copy, overrides);
}

test("sessionArgs: a measured socket identifies the session without a prefix", () => {
  assert.deepEqual(sessionArgs({ HERDR_SOCKET_PATH: "s", HERDR_SESSION: "piomo" }), []);
  assert.deepEqual(sessionArgs({ HERDR_SESSION: "piomo" }), ["--session", "piomo"]);
  assert.deepEqual(sessionArgs({ GJC_LIVE_HERDR_SESSION: "gjcdash-lt1", HERDR_SOCKET_PATH: "s" }),
    ["--session", "gjcdash-lt1"]);
  assert.deepEqual(sessionArgs({}), []);
});

test("paneIdOf: reads the pane id out of the measured split reply", () => {
  assert.equal(paneIdOf({ id: "cli:pane:split", result: { pane: { pane_id: "w1:p6" },
    type: "pane_info" } }), "w1:p6");
  assert.equal(paneIdOf({ result: { pane_id: "w1:p7" } }), "w1:p7");
  assert.equal(paneIdOf({ error: { code: "x" } }), null);
  assert.equal(paneIdOf(null), null);
});

test("main: forwards argv unchanged, passes the reply through byte for byte, and logs the call", (t) => {
  const { env, log } = scratch(t);
  const reply = '{"id":"cli:pane:list","result":{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1"}]}}\n';
  const { calls, spawn } = recordingSpawn({ stdout: reply });
  const io = capture();
  const code = main(["pane", "list"], { env, spawnFn: spawn, stdout: io.stdout, stderr: io.stderr,
    now: () => "2026-10-17T00:00:00.000Z" });
  assert.equal(code, 0);
  assert.equal(calls.length, 1, "exactly one real call, and only for what the caller asked");
  assert.equal(calls[0].bin, NOT_A_BINARY);
  assert.deepEqual(calls[0].argv, ["pane", "list"]);
  assert.equal(calls[0].options.env, env, "the incoming environment is forwarded");
  assert.equal(io.out.stdout, reply, "the reply reaches the caller byte for byte");
  const entry = lines(log).at(-1);
  assert.deepEqual(entry.argv, ["pane", "list"]);
  assert.equal(entry.ok, true);
  assert.equal(entry.code, null);
  assert.equal(entry.at, "2026-10-17T00:00:00.000Z");
  assert.equal(Number.isFinite(entry.ms), true);
});

test("main: a session prefix is added only when the environment cannot identify the session", (t) => {
  const { env } = scratch(t);
  const { calls, spawn } = recordingSpawn({ stdout: "" });
  const io = capture();
  main(["pane", "list"], { env: { ...env, GJC_LIVE_HERDR_SESSION: "gjcdash-lt1" }, spawnFn: spawn,
    stdout: io.stdout, stderr: io.stderr });
  assert.deepEqual(calls[0].argv, ["--session", "gjcdash-lt1", "pane", "list"]);
});

test("fail-list: every pane list fails while the flag exists, and the flag is not consumed", (t) => {
  const { env, flags } = scratch(t);
  writeFileSync(flag(flags, FLAG_LIST), "", "utf8");
  for (const pass of [1, 2]) {
    const io = capture();
    const code = main(["pane", "list"], { env,
      spawnFn: () => { throw new Error(`must not forward (pass ${pass})`); },
      stdout: io.stdout, stderr: io.stderr });
    assert.equal(code, 1, `pass ${pass} exits 1`);
    assert.equal(JSON.parse(io.out.stdout).error.code, "server_unavailable");
    assert.equal(existsSync(flag(flags, FLAG_LIST)), true, `the flag survived pass ${pass}`);
  }
});

test("fail-split-once: the first split fails with structured JSON, then the flag is gone", (t) => {
  const { env, flags, log } = scratch(t);
  writeFileSync(flag(flags, FLAG_SPLIT), "", "utf8");
  const io = capture();
  const code = main(["pane", "split", "w1:p1", "--direction", "right", "--no-focus"],
    { env, spawnFn: () => { throw new Error("must not forward the injected split"); },
      stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 1);
  const body = JSON.parse(io.out.stdout);
  assert.equal(body.error.code, "pane_split_failed");
  assert.equal(body.id, "cli:live-wrapper");
  assert.equal(existsSync(flag(flags, FLAG_SPLIT)), false, "the flag is deleted at use");
  const entry = lines(log).at(-1);
  assert.equal(entry.ok, false);
  assert.equal(entry.code, "pane_split_failed");
  assert.deepEqual(entry.argv, ["pane", "split", "w1:p1", "--direction", "right", "--no-focus"]);

  // The second split reaches the real binary: that is what makes the flag "once".
  const { calls, spawn } = recordingSpawn({ stdout: '{"result":{"pane":{"pane_id":"w1:p9"}}}' });
  const io2 = capture();
  const code2 = main(["pane", "split", "w1:p1", "--direction", "right", "--no-focus"],
    { env, spawnFn: spawn, stdout: io2.stdout, stderr: io2.stderr });
  assert.equal(code2, 0);
  assert.equal(calls.length, 1);
  assert.equal(lines(log).at(-1).paneId, "w1:p9", "the split result is logged for the delay rule");
});

test("delay-run-25s: the call is handed to a detached helper, and the wrapper answers at once", (t) => {
  const { env, flags, log } = scratch(t);
  // The real order: `delay-run-25s` is armed BEFORE `/dashboard`, so the flag exists first and the
  // split it must license comes after. That ordering is the flag's lifetime.
  writeFileSync(flag(flags, FLAG_DELAY), "", "utf8");
  appendLine(log, `${splitLine("w1:p9", 0)}`);
  const { calls, spawnDetached } = recordingDetach();
  const { spawn } = recordingSpawn();
  const io = capture();
  const started = Date.now();
  const code = main(["pane", "run", "w1:p9", "node x.mjs"], { env, spawnFn: spawn, spawnDetached,
    sleepFn: () => { throw new Error("the parent must not sleep"); },
    stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0, "the delayed call still answers success, so the pass is not failed");
  assert.ok(Date.now() - started < 2_000, "the parent returned immediately");
  assert.equal(calls.length, 1, "one detached helper was started");
  assert.equal(calls[0].bin, process.execPath);
  assert.deepEqual(calls[0].argv.slice(1), ["pane", "run", "w1:p9", "node x.mjs"],
    "the helper receives the caller's argv untouched");
  assert.equal(calls[0].options.env[HELPER_ENV], "1");
  assert.equal(calls[0].options.env[HELPER_DELAY_ENV], String(RUN_DELAY_MS));
  assert.equal(existsSync(flag(flags, FLAG_DELAY)), false, "the flag is deleted at use");
  const entry = lines(log).at(-1);
  assert.equal(entry.delayed, true);
  assert.equal(entry.deferredPid, 4242);

  // A second run cannot be delayed: the flag was consumed.
  const slept = [];
  main(["pane", "run", "w1:p9", "node x.mjs"], { env, spawnFn: (bin, argv) => {
    slept.push(argv); return { status: 0, stdout: "", stderr: "" }; },
    spawnDetached: () => { throw new Error("must not defer twice"); },
    stdout: io.stdout, stderr: io.stderr });
  assert.deepEqual(slept, [["pane", "run", "w1:p9", "node x.mjs"]]);
});

test("delay-run-25s: the helper waits, then forwards the same argv to the real binary", (t) => {
  const { env, log } = scratch(t);
  const slept = [];
  const { calls, spawn } = recordingSpawn({ stdout: "" });
  const io = capture();
  const code = main(["pane", "run", "w1:p9", "node x.mjs"],
    { env: { ...env, [HELPER_ENV]: "1", [HELPER_DELAY_ENV]: "1234" }, spawnFn: spawn,
      sleepFn: (ms) => slept.push(ms), stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 0);
  assert.deepEqual(slept, [1234], "the helper waits the whole delay");
  assert.deepEqual(calls[0].argv, ["pane", "run", "w1:p9", "node x.mjs"],
    "the helper forwards the caller's argv, with no session prefix when the socket names the session");
  assert.equal(lines(log).at(-1).delayed, true);

  // A helper whose environment names the session only by HERDR_SESSION still reaches the right server.
  const second = capture();
  main(["pane", "run", "w1:p9", "node x.mjs"], { env: { ...env, HERDR_SOCKET_PATH: "",
    HERDR_SESSION: "gjcdash-lt3", [HELPER_ENV]: "1", [HELPER_DELAY_ENV]: "1" }, spawnFn: spawn,
    sleepFn: () => {}, stdout: second.stdout, stderr: second.stderr });
  assert.deepEqual(calls[1].argv,
    ["--session", "gjcdash-lt3", "pane", "run", "w1:p9", "node x.mjs"]);
});

test("delay-run-25s: a split older than the flag, or a pane with no split, is never delayed", (t) => {
  const old = scratch(t);
  appendLine(old.log, `${splitLine("w1:p9", 60_000)}`);
  writeFileSync(flag(old.flags, FLAG_DELAY), "", "utf8");
  assert.equal(planCall(["pane", "run", "w1:p9", "x"], old.env).delayMs, 0);
  assert.equal(existsSync(flag(old.flags, FLAG_DELAY)), true, "the flag is not consumed");

  const plain = scratch(t);
  writeFileSync(flag(plain.flags, FLAG_DELAY), "", "utf8");
  assert.equal(planCall(["pane", "run", "w1:p1", "x"], plain.env).delayMs, 0);
  assert.equal(existsSync(flag(plain.flags, FLAG_DELAY)), true);

  const armed = scratch(t);
  appendLine(armed.log, `${splitLine("w1:p9")}`);
  utimesSync(armed.log, new Date(Date.now() - 1_000), new Date(Date.now() - 1_000));
  writeFileSync(flag(armed.flags, FLAG_DELAY), "", "utf8");
  utimesSync(flag(armed.flags, FLAG_DELAY), new Date(Date.now() - 20_000),
    new Date(Date.now() - 20_000));
  assert.equal(planCall(["pane", "run", "w1:p9", "x"], armed.env).delayMs, RUN_DELAY_MS,
    "flag before split: the same lifetime");
});

test("delayApplies: a failed split never licenses a delay", (t) => {
  const { flags, log } = scratch(t);
  appendLine(log, logLine({ at: new Date().toISOString(), argv: ["pane", "split", "w1:p1"],
    ok: false, code: "pane_split_failed", ms: 1, paneId: null }));
  writeFileSync(flag(flags, FLAG_DELAY), "", "utf8");
  assert.equal(delayApplies({ logPath: log, flagPath: flag(flags, FLAG_DELAY), paneId: "w1:p9" }),
    false);
});

test("planCall: no verb other than split/list/run is ever intercepted", (t) => {
  const { env } = scratch(t);
  assert.equal(planCall(["pane", "run", "w1:p9", "x"], env).delayed, false);
  assert.equal(planCall(["pane", "rename", "w1:p9", "label"], env).forward, true);
  assert.equal(planCall(["pane", "process-info", "--pane", "w1:p9"], env).forward, true);
  assert.equal(planCall(["pane", "close", "w1:p9"], env).forward, true);
  assert.equal(planCall(["pane", "read", "w1:p9", "--source", "visible"], env).forward, true);
  assert.equal(planCall(["pane", "split", "w1:p1"], env).forward, true);
  // With no flag at all, nothing is intercepted and nothing sleeps.
  for (const argv of [["pane", "split", "w1:p1"], ["pane", "list"], ["pane", "run", "w1:p1", "x"]]) {
    const plan = planCall(argv, env);
    assert.equal(plan.forward, true);
    assert.equal(plan.delayMs, 0);
  }
});

test("no binary: the wrapper reports herdr_missing instead of guessing a path", (t) => {
  const { env } = scratch(t);
  const bare = { ...env };
  delete bare.GJC_LIVE_REAL_HERDR;
  delete bare.HERDR_BIN_PATH;
  const io = capture();
  const code = main(["pane", "list"], { env: bare, stdout: io.stdout, stderr: io.stderr });
  assert.equal(code, 1);
  assert.equal(JSON.parse(io.out.stdout).error.code, "herdr_missing");
});

test("CLI: an injected failure is visible to a real caller as exit 1 plus a JSON error body", (t) => {
  const { env, flags, log } = scratch(t);
  writeFileSync(flag(flags, FLAG_LIST), "", "utf8");
  const child = spawnSync(process.execPath, [WRAPPER, "pane", "list"],
    { env: childEnv({ ...env, HERDR_SOCKET_PATH: "" }), encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).error.code, "server_unavailable");
  assert.equal(child.stderr.includes("injected list failure"), true);
  const entry = lines(log).at(-1);
  assert.equal(entry.code, "server_unavailable");
  assert.equal(entry.ok, false);
});

test("CLI: a flag-free call whose real binary cannot run fails without inventing a reply", (t) => {
  const { env, log } = scratch(t);
  const child = spawnSync(process.execPath, [WRAPPER, "pane", "list"],
    { env: childEnv({ ...env, GJC_LIVE_REAL_HERDR: join(tmpdir(), "gjc-live-does-not-exist.exe") }),
      encoding: "utf8" });
  assert.notEqual(child.status, 0);
  assert.equal(child.stdout.trim(), "", "nothing is invented when the real call cannot run");
  assert.equal(lines(log).at(-1).ok, false);
  assert.equal(lines(log).at(-1).code, "ENOENT");
});
