// L5b goal-surface probe driver (sandbox only). Runs the probe extension inside a harness-owned
// Herdr session, sets a goal with `/goal`, and records what the host hands the extension.
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createFixture, REPO, SANDBOX } from '../test/live/fixture.mjs';
import { createCase, launchGjc, sendPrompt, sendSlash, stripAnsi } from '../test/live/case.mjs';

const sleep = (ms) => new Promise((reset) => { setTimeout(reset, ms); });
const CASE = 'l5goal';
const SESSION = 'gjcdash-l5goal';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const OUT = join(SANDBOX, 'l5-probe-out.jsonl');
const LOG = join(SANDBOX, 'l5-probe.log');

async function main() {
  rmSync(OUT, { force: true });
  rmSync(join(SANDBOX, `case-${CASE}`), { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  writeFileSync(OUT, '');
  const log = [];
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  // The probe replaces the product shim: the case extension re-exports the probe module.
  const shim = join(paths.dir, '.gjc', 'extensions', 'gjc-herdr-dashboard.js');
  // Set through the pane launch env: a static `export … from` is evaluated BEFORE this shim's body runs.
  writeFileSync(shim, [
    `process.env.GJC_PROBE_OUT ??= ${JSON.stringify(OUT)};`,
    `export { default } from ${JSON.stringify(`file:///${REPO.replace(/\\/g, '/')}/.sandbox/probe-goal-ext.mjs`)};`,
    '',
  ].join('\n'), 'utf8');
  const fixture = createFixture({ session: SESSION, evidenceDir: join(SANDBOX, 'l5-evidence'),
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    const pane = ws.rootPaneId;
    await launchGjc(fixture, pane, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION], ['GJC_PROBE_OUT', OUT]] });
    await fixture.waitIdle(pane, { timeoutMs: 120_000, quiet: 3 });
    log.push('launched ok');
    // Dismiss the update-available modal (it swallows typed input) before sending anything.
    fixture.sendKeys(pane, 'escape');
    await sleep(2_000);
    await sleep(5_000);
    writeFileSync(LOG, log.join('\n'), 'utf8');
    // Set a goal through the host's own slash command, then look at what the probe saw.
    await sendPrompt(fixture, pane, '/goal Add a one line goal header to the Todo pane that shows the objective and its token and time usage');
    await sleep(15_000);
    const frame = stripAnsi(fixture.readPane(pane)).split(/\r?\n/).filter((line) => line.trim());
    log.push('after /goal: ' + frame.slice(-8).join(' / ').slice(0, 700));
    writeFileSync(LOG, log.join('\n'), 'utf8');
    fixture.snapshot(join(SANDBOX, 'l5-evidence'), 'frame-after-goal', pane);
  } finally {
    await fixture.cleanup();
  }
}

main().catch((error) => { console.error('PROBE FAIL', error?.message ?? error); process.exitCode = 1; });
