import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createFixture, REPO, SANDBOX } from '../test/live/fixture.mjs';
import { createCase, launchGjc, stripAnsi } from '../test/live/case.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const SESSION = 'gjcdash-probereload';
rmSync(join(SANDBOX, 'case-prel'), { recursive: true, force: true });
const paths = createCase({ caseId: 'prel', herdr: [process.execPath, WRAPPER] });
const dir = join(SANDBOX, 'probe-reload'); mkdirSync(dir, { recursive: true });
const fixture = createFixture({ session: SESSION, evidenceDir: dir, logDir: dir });
try {
  await fixture.startSession();
  const ws = fixture.createWorkspace({ cwd: paths.dir, label: 'prel' });
  const p = ws.rootPaneId;
  await launchGjc(fixture, p, { dir: paths.dir, herdr: [process.execPath, WRAPPER], extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
  await fixture.waitIdle(p, { timeoutMs: 120000, quiet: 3 });
  let out = '';
  for (const text of ['/relo']) {
    fixture.sendText(p, text); await sleep(1200);
    out += `--- after "${text}" ---\n` + stripAnsi(fixture.readPane(p)).split(/\r?\n/).filter((l) => l.trim()).join('\n') + '\n';
  }
  fixture.sendKeys(p, 'escape'); await sleep(800);
  writeFileSync(join(dir, 'popup2.txt'), out);
} finally { await fixture.cleanup(); }
