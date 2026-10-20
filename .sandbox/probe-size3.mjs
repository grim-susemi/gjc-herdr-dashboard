import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, SANDBOX } from '../test/live/fixture.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = join(SANDBOX, 'probe-size3'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const fixture = createFixture({ session: 'gjcdash-probesize3', evidenceDir: dir, logDir: dir });
try {
  await fixture.startSession();
  const ws = fixture.createWorkspace({ cwd: dir, label: 'ps3' });
  const pane = ws.rootPaneId;
  const split = fixture.herdr(['pane', 'split', pane, '--direction', 'right', '--no-focus']);
  const p2 = split?.pane?.pane_id ?? split?.result?.pane?.pane_id; fixture.adoptPane(p2, { role: 'viewer' });
  const split2 = fixture.herdr(['pane', 'split', p2, '--direction', 'down', '--ratio', '0.35', '--no-focus']);
  const p3 = split2?.pane?.pane_id ?? split2?.result?.pane?.pane_id; fixture.adoptPane(p3, { role: 'viewer' });
  fixture.sendText(p2, 'node -e "for(let i=1;i<=60;i++)console.log(\'L\'+i); setTimeout(()=>{},9000)"'); fixture.sendKeys(p2, 'enter');
  await sleep(3000);
  for (const p of [pane, p2, p3]) {
    const g = fixture.herdr(['pane', 'get', p]); const pp = g?.pane ?? g;
    console.log(p, 'viewport_rows', pp.scroll?.viewport_rows);
  }
  const lay = fixture.layout(pane); console.log(JSON.stringify(lay.panes.map((p) => [p.pane_id, p.rect.height])));
  const v = fixture.readPane(p2); const ls = v.split(/\r?\n/); console.log('p2 read lines', ls.length, 'first', ls[0].slice(0, 12), 'last', ls.filter(Boolean).at(-1));
} finally { await fixture.cleanup(); }
