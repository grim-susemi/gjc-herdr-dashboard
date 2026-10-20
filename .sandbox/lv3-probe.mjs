import fs from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from '../test/live/fixture.mjs';
import { createCase, launchGjc, stripAnsi, sendSlash } from '../test/live/case.mjs';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
fs.rmSync(join(SANDBOX, 'case-lv3p'), { recursive: true, force: true });
const paths = createCase({ caseId: 'lv3p', herdr: [process.execPath, WRAPPER] });
const fixture = createFixture({ session: 'gjcdash-lv3p', evidenceDir: join(SANDBOX, 'lv3p-ev'),
  logDir: join(SANDBOX, 'live-gjcdash-lv3p', 'x') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = () => fixture.listPanes().find((p) => p.pane_id === ws.rootPaneId)?.agent_status;
let ws;
try {
  await fixture.startSession();
  ws = fixture.createWorkspace({ cwd: paths.dir, label: 'p' });
  await launchGjc(fixture, ws.rootPaneId, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
    extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', 'gjcdash-lv3p']] });
  await fixture.waitIdle(ws.rootPaneId, { timeoutMs: 120000, quiet: 3 });
  await sendSlash(fixture, ws.rootPaneId, 'dashboard', /열림|opened/);
  console.log('dashboard open; status', status());
  const sd = join(paths.stateDir,'data');
  const find=()=>{try{const d=fs.readdirSync(sd)[0];return JSON.parse(fs.readFileSync(join(sd,d,'todo.json'),'utf8'))}catch{return null}};
  await sleep(6000);
  fixture.sendText(ws.rootPaneId,'/todo');await sleep(900);fixture.sendText(ws.rootPaneId,' append P probe-row');await sleep(900);
  const t0=Date.now();fixture.sendKeys(ws.rootPaneId,'enter');
  let hit=null;for(let i=0;i<300&&!hit;i++){await sleep(100);const d=find();if(d&&JSON.stringify(d.phases).includes('probe-row'))hit=Date.now()-t0;}
  console.log('status over time: reflected_ms',hit);
} finally {
  console.log(JSON.stringify(await fixture.cleanup()).slice(0, 100));
}
