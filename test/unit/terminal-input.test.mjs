// Terminal input decoder tests.
//
// omo-herdr-dashboard @4082c750 ships `packages/{todo,dag}/src/terminal-input.mjs`
// with no unit test of its own (its behaviour was only exercised through the
// pty-driven viewer tests). Those viewer tests are replaced here by a direct test
// of the decoder, because the decoder is the part the viewer keeps.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { disablePointer, enablePointer, terminalInput, watchHerdrFocus }
  from "../../src/terminal-input.mjs";

function harness() {
  const input = new PassThrough();
  const keys = [], pointer = [], focus = [];
  const dispose = terminalInput(input, {
    key: (text, pressed) => keys.push(pressed?.sequence ?? text ?? pressed?.name),
    pointer: (report) => pointer.push(report),
    focus: (focused) => focus.push(focused),
  });
  return { input, keys, pointer, focus, dispose,
    async send(text) { input.write(text); await new Promise((done) => setImmediate(done)); } };
}

test("the pointer modes bracket the frame and match the DECSET bytes omo used", () => {
  assert.equal(enablePointer, "\x1b[?1002h\x1b[?1006h\x1b[?1004h");
  assert.equal(disablePointer, "\x1b[?1004l\x1b[?1006l\x1b[?1002l");
});

test("pointer press, drag and wheel become reports and never keys", async () => {
  const h = harness();
  await h.send("\x1b[<0;4;8M");
  await h.send("\x1b[<32;4;12M");
  await h.send("\x1b[<64;4;12M");
  await h.send("\x1b[<0;4;12m");
  assert.deepEqual(h.pointer, [
    { button: 0, x: 4, y: 8, release: false },
    { button: 32, x: 4, y: 12, release: false },
    { button: 64, x: 4, y: 12, release: false },
    { button: 0, x: 4, y: 12, release: true },
  ]);
  assert.deepEqual(h.keys, [], "a report must never leak into the key stream");
  h.dispose();
});

test("a fragmented report is buffered until its final M or m arrives", async () => {
  const h = harness();
  await h.send("\x1b[<0;1");
  assert.deepEqual(h.pointer, [], "a partial report is not emitted");
  await h.send("0;7M");
  assert.deepEqual(h.pointer, [{ button: 0, x: 10, y: 7, release: false }]);
  h.dispose();
});

test("focus in/out reports drive blur and are not keys; ordinary keys still arrive", async () => {
  const h = harness();
  await h.send("\x1b[O");
  await h.send("\x1b[I");
  assert.deepEqual(h.focus, [false, true]);
  await h.send("j");
  await h.send("q");
  await h.send("\x03");
  assert.deepEqual(h.keys, ["j", "q", "\u0003"]);
  h.dispose();
});

test("a bare escape prefix is held, and an arrow split across chunks still arrives", async () => {
  const h = harness();
  await h.send("\x1b");
  assert.deepEqual(h.keys, [], "a lone ESC waits for the rest of its sequence");
  await h.send("[");
  assert.deepEqual(h.keys, [], "ESC [ is still held");
  await h.send("B");
  assert.deepEqual(h.keys, ["\x1b[B"], "the arrow key reaches the key handler");
  h.dispose();
  // The whole sequence in one chunk behaves the same way, so a fast terminal and a
  // slow one cannot disagree about which key arrived.
  const whole = harness();
  await whole.send("\x1b[A");
  assert.deepEqual(whole.keys, ["\x1b[A"]);
  whole.dispose();
});

test("disposal detaches the listener so no later chunk reaches a handler", async () => {
  const h = harness();
  await h.send("a");
  h.dispose();
  await h.send("b");
  assert.deepEqual(h.keys, ["a"]);
  assert.equal(h.input.listenerCount("data"), 0);
});

test("watchHerdrFocus refuses to subscribe without a matching Herdr pane", async () => {
  // No HERDR_ENV / no socket / a different pane id: a no-op disposer, no connection.
  const calls = [];
  const dispose = await watchHerdrFocus("w1:p2", () => calls.push("blur"),
    () => calls.push("failed"), {});
  assert.equal(typeof dispose, "function");
  dispose();
  assert.deepEqual(calls, []);
  const mismatched = await watchHerdrFocus("w1:p2", () => calls.push("blur"),
    () => calls.push("failed"), { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p9", HERDR_SOCKET_PATH: "s" });
  mismatched();
  assert.deepEqual(calls, []);
});

test("an unreachable Herdr socket reports the failure instead of hanging the viewer", async () => {
  // Given a socket path that cannot be connected, the module rejects after the
  // failure is reported, so the viewer can show its own error label and continue.
  const failures = [];
  await assert.rejects(
    watchHerdrFocus("w1:p2", () => {}, (cause) => failures.push(cause?.message),
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "\\\\.\\pipe\\gjc-does-not-exist" }),
    (cause) => cause instanceof Error,
  );
  assert.ok(failures.length >= 1, "the failure callback fired");
});

test("a Herdr subscription that closes after it started reports one failure", async () => {
  const net = await import("node:net");
  const path = process.platform === "win32" ? "gjc-ti-close-" + process.pid : "";
  const failures = [];
  let connection;
  const server = net.createServer((socket) => {
    connection = socket;
    socket.once("data", () => socket.write(JSON.stringify({ id: "dashboard-focus", result: { type: "subscription_started" } }) + "\n"));
  });
  const where = process.platform === "win32" ? "\\\\.\\pipe\\" + path : (await import("node:path")).join((await import("node:os")).tmpdir(), "gjc-ti-" + process.pid + ".sock");
  await new Promise((done) => { server.listen(where, done); });
  try {
    const dispose = await watchHerdrFocus("w1:p2", () => {}, (cause) => failures.push(cause?.message),
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: process.platform === "win32" ? path : where });
    connection.destroy();
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(failures, ["Herdr focus subscription closed"]);
    dispose();
  } finally { server.close(); }
});

test("an error followed by the socket close reports exactly one failure", async () => {
  const net = await import("node:net");
  const failures = [];
  let connection;
  const name = "gjc-ti-err-" + process.pid;
  const server = net.createServer((socket) => {
    connection = socket;
    socket.once("data", () => socket.write(JSON.stringify({ id: "dashboard-focus", result: { type: "subscription_started" } }) + "\n"));
  });
  const where = process.platform === "win32" ? "\\\\.\\pipe\\" + name
    : (await import("node:path")).join((await import("node:os")).tmpdir(), name + ".sock");
  await new Promise((done) => { server.listen(where, done); });
  try {
    const dispose = await watchHerdrFocus("w1:p2", () => {}, (cause) => failures.push(cause?.message),
      { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: process.platform === "win32" ? name : where });
    // A Herdr error reply reports the failure and destroys the socket, which then closes.
    connection.write(JSON.stringify({ error: { message: "boom" } }) + "\n");
    await new Promise((done) => setTimeout(done, 300));
    assert.deepEqual(failures, ["boom"], "one notice for the error and the close that follows");
    dispose();
  } finally { server.close(); }
});
