// Probe: can SGR mouse bytes reach a viewer-like process in a Herdr pane via `pane send-text`?
// Harness-owned session only. A tiny node program runs in the pane, enables the same modes, and logs raw stdin bytes.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from '../test/live/fixture.mjs';
import { evidenceDirFor } from '../test/live/case.mjs';

const SESSION = 'gjcdash-probesgr';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = join(SANDBOX, 'probe-sgr');
mkdirSync(dir, { recursive: true });
const logFile = join(dir, 'stdin.log');
writeFileSync(logFile, '');
const reader = join(dir, 'reader.mjs');
writeFileSync(reader, `
import { appendFileSync } from 'node:fs';
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdout.write('\\x1b[?1049h\\x1b[?1002h\\x1b[?1006h\\x1b[?1004h');
process.stdin.on('data', (d) => appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(String(d)) + '\\n'));
setTimeout(() => process.exit(0), 60000);
`);
const fixture = createFixture({ session: SESSION, evidenceDir: dir, logDir: dir });
try {
  await fixture.startSession();
  const ws = fixture.createWorkspace({ cwd: dir, label: 'probesgr' });
  const pane = ws.rootPaneId;
  fixture.sendText(pane, `node "${reader}"`);
  fixture.sendKeys(pane, 'enter');
  await sleep(3000);
  const tests = {
    esc_literal_in_arg: '\x1b[<65;5;10M',
    text_only: '[<65;5;10M',
  };
  for (const [name, text] of Object.entries(tests)) {
    fixture.sendText(pane, text);
    await sleep(800);
  }
  fixture.sendKeys(pane, 'escape');
  await sleep(500);
  console.log(readFileSync(logFile, 'utf8'));
  console.log('log exists', existsSync(logFile));
} finally {
  console.log(JSON.stringify(await fixture.cleanup()).slice(0, 300));
}
