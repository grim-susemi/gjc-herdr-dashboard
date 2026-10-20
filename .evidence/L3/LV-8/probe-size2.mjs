import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, SANDBOX } from '../test/live/fixture.mjs';
const SESSION = 'gjcdash-probesize2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = join(SANDBOX, 'probe-size2'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const out = join(dir, 'size.log'); const prog = join(dir, 'size.mjs');
writeFileSync(prog, `import { appendFileSync } from 'node:fs'; import { execSync } from 'node:child_process';
const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => /HERDR|COLUMNS|LINES/.test(k)));
let ps = ''; try { ps = execSync('powershell -NoProfile -Command "[Console]::WindowWidth.ToString() + \\'x\\' + [Console]::WindowHeight.ToString()"', {encoding:'utf8', stdio:['inherit','pipe','pipe']}).trim(); } catch (c) { ps = 'err ' + c.message.slice(0,60); }
appendFileSync(${JSON.stringify(out)}, JSON.stringify({ so: process.stdout.columns + 'x' + process.stdout.rows, se: process.stderr.columns + 'x' + process.stderr.rows, ws: process.stdout.getWindowSize?.(), ps, e }) + '\\n'); setTimeout(() => process.exit(0), 2000);`);
const fixture = createFixture({ session: SESSION, evidenceDir: dir, logDir: dir });
try {
  await fixture.startSession();
  const ws = fixture.createWorkspace({ cwd: dir, label: 'ps2' });
  const pane = ws.rootPaneId;
  const split = fixture.herdr(['pane', 'split', pane, '--direction', 'right', '--no-focus']);
  const p2 = split?.pane?.pane_id ?? split?.result?.pane?.pane_id;
  fixture.adoptPane(p2, { role: 'viewer' });
  fixture.sendText(p2, `node "${prog}"`); fixture.sendKeys(p2, 'enter');
  await sleep(5000);
  console.log('layout', JSON.stringify(fixture.layout(pane).panes.map((p) => [p.pane_id, p.rect.width, p.rect.height])));
  console.log(readFileSync(out, 'utf8'));
  console.log('pane get', JSON.stringify(fixture.herdr(['pane', 'get', p2])).slice(0, 400));
} finally { await fixture.cleanup(); }
