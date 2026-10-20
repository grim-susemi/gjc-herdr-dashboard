import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, SANDBOX } from '../test/live/fixture.mjs';
const SESSION = 'gjcdash-probesize';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = join(SANDBOX, 'probe-size'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const out = join(dir, 'size.log');
const prog = join(dir, 'size.mjs');
writeFileSync(prog, `import { appendFileSync } from 'node:fs'; const w = () => appendFileSync(${JSON.stringify(out)}, process.stdout.columns + 'x' + process.stdout.rows + '\\n'); w(); process.stdout.on('resize', w); setInterval(w, 1000); setTimeout(() => process.exit(0), 20000);`);
const fixture = createFixture({ session: SESSION, evidenceDir: dir, logDir: dir });
try {
  await fixture.startSession();
  const ws = fixture.createWorkspace({ cwd: dir, label: 'ps' });
  const pane = ws.rootPaneId;
  const split = fixture.herdr(['pane', 'split', pane, '--direction', 'right', '--no-focus']);
  const p2 = split?.pane?.pane_id ?? split?.result?.pane?.pane_id;
  fixture.adoptPane(p2, { role: 'viewer' });
  const split2 = fixture.herdr(['pane', 'split', p2, '--direction', 'down', '--ratio', '0.35', '--no-focus']);
  const p3 = split2?.pane?.pane_id ?? split2?.result?.pane?.pane_id;
  fixture.adoptPane(p3, { role: 'viewer' });
  fixture.sendText(p2, `node "${prog}"`); fixture.sendKeys(p2, 'enter');
  await sleep(2500);
  fixture.herdr(['pane', 'focus', '--pane', pane, '--direction', 'right']);
  await sleep(2500);
  fixture.herdr(['pane', 'resize', '--pane', p2, '--direction', 'down', '--amount', '0.1']);
  await sleep(3000);
  console.log('layout', JSON.stringify(fixture.layout(pane).panes.map((p) => [p.pane_id, p.rect.width, p.rect.height])));
  console.log('log', readFileSync(out, 'utf8').trim().replace(/\n/g, ' | '));
} finally { await fixture.cleanup(); }
