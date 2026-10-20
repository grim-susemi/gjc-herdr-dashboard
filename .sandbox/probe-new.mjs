import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createFixture, REPO, SANDBOX } from '../test/live/fixture.mjs';
import { createCase, launchGjc, stripAnsi, sendSlash } from '../test/live/case.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const SESSION = 'gjcdash-probenew';
rmSync(join(SANDBOX, 'case-pnew'), { recursive: true, force: true });
const paths = createCase({ caseId: 'pnew', herdr: [process.execPath, WRAPPER] });
const dir = join(SANDBOX, 'probe-new'); mkdirSync(dir, { recursive: true });
const fixture = createFixture({ session: SESSION, evidenceDir: dir, logDir: dir });
const log = [];
try {
  await fixture.startSession();
  const ws = fixture.createWorkspace({ cwd: paths.dir, label: 'pnew' });
  const p = ws.rootPaneId;
  await launchGjc(fixture, p, { dir: paths.dir, herdr: [process.execPath, WRAPPER], extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
  await fixture.waitIdle(p, { timeoutMs: 120000, quiet: 3 });
  await sendSlash(fixture, p, 'dashboard', /열림|opened/);
  await sleep(8000);
  const slotsDir = join(paths.stateDir, 'slots');
  const key = readdirSync(slotsDir)[0];
  const slotFile = join(slotsDir, key, 'slot.json');
  const sid = () => JSON.parse(readFileSync(slotFile, 'utf8')).scope.sessionId;
  log.push('before ' + sid());
  for (let i = 1; i <= 3; i += 1) {
    fixture.sendKeys(p, 'escape'); await sleep(600);
    fixture.sendText(p, '/ne'); await sleep(900);
    fixture.sendText(p, 'w'); await sleep(900);
    const snap = stripAnsi(fixture.readPane(p)).split(/\r?\n/).filter((l) => l.trim()).slice(-6).join(' / ');
    fixture.sendKeys(p, 'enter');
    await sleep(8000);
    const after = stripAnsi(fixture.readPane(p)).split(/\r?\n/).filter((l) => l.trim()).slice(-8).join(' / ');
    log.push(`try ${i}: sid=${sid()} | before-enter: ${snap.slice(0, 200)} | after: ${after.slice(0, 260)}`);
    if (sid() !== log[0].split(' ')[1]) break;
  }
} finally { writeFileSync(join(dir, 'log.txt'), log.join('\n')); await fixture.cleanup(); }
