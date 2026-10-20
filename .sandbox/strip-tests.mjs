import { readFileSync, writeFileSync } from "node:fs";
const path = "test/unit/live-wrapper.test.mjs";
let text = readFileSync(path, "utf8");
const start = text.indexOf('test("delay-run-25s: the call is handed');
const end = text.indexOf('test("no binary: the wrapper reports herdr_missing');
if (start < 0 || end < 0) throw new Error("markers missing");
const replacement = `test("planCall: no verb other than the two flagged ones is ever intercepted", (t) => {
  const { env } = scratch(t);
  assert.equal(planCall(["pane", "run", "w1:p9", "x"], env).forward, true);
  assert.equal(planCall(["pane", "rename", "w1:p9", "label"], env).forward, true);
  assert.equal(planCall(["pane", "process-info", "--pane", "w1:p9"], env).forward, true);
  assert.equal(planCall(["pane", "close", "w1:p9"], env).forward, true);
  assert.equal(planCall(["pane", "list"], env).forward, true);
  assert.equal(planCall(["pane", "split", "w1:p1"], env).forward, true);
});

test("R3: the wrapper no longer offers a delay-run flag (the late viewer is the product failpoint)", () => {
  const source = readFileSync(WRAPPER, "utf8");
  assert.doesNotMatch(source, /FLAG_DELAY|delayApplies|spawnDetached|HELPER_ENV/);
});

`;
text = text.slice(0, start) + replacement + text.slice(end);
text = text.replace(/import \{ FLAG_DELAY, FLAG_LIST, FLAG_SPLIT, HELPER_DELAY_ENV, HELPER_ENV, RUN_DELAY_MS,\nimport/, "import");
text = text.replace('import { FLAG_DELAY, FLAG_LIST, FLAG_SPLIT, HELPER_DELAY_ENV, HELPER_ENV, RUN_DELAY_MS,\n  delayApplies, logLine, main, paneIdOf, planCall, sessionArgs }',
  'import { FLAG_LIST, FLAG_SPLIT, logLine, main, paneIdOf, planCall, sessionArgs }');
text = text.replace(", the split result is logged for the delay rule", ", the split result is logged");
writeFileSync(path, text);
console.log("done");
