// AC-F4 (L2): the real Workers viewer process, started by the product launch path's own argv shape
// (`node viewer.mjs --state --layout --role workers --token --pane [--width N]`), draws card title
// and status at 24 and 40 columns inside a Herdr pane of the harness-owned session.
//
// Why `--width`: the harness Herdr server has no attached client, so a pane's PTY stays at 120x40
// whatever its split rect is (measured, `.evidence/L3/LV-8/pty-size.txt`). `--width` is the viewer's
// own documented width override; the content is the live Workers projection of a real subagent run
// is replaced here by a fixture projection with the same schema, because the point is the width.
//
// Run: node test/live/l2-width.mjs
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, evidenceDirFor, runScript, stripAnsi, writeEvidence, writeEvidenceJson } from './case.mjs';

const SESSION = 'gjcdash-lvwid';
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });

await runScript('l2-width (AC-F4)', async () => {
  const evidence = evidenceDirFor('L2', 'LV-7w');
  const dir = join(SANDBOX, 'case-lvwid');
  rmSync(dir, { recursive: true, force: true });
  const state = join(dir, 'state');
  const layout = 'abcdef0123456789';
  mkdirSync(join(state, 'slots', layout, 'roles'), { recursive: true });
  mkdirSync(join(state, 'data', 'scope1'), { recursive: true });
  const cards = [
    { id: '0-alpha', agent: 'executor', title: 'Parse the config files', status: 'running', background: false,
      currentTool: 'read', lastIntent: 'Reading config', lastOutput: null, toolCount: 3, tokens: 1200,
      contextPercent: 4, cost: null, durationMs: 9000, retry: null, startedAt: 1, endedAt: null },
    { id: '1-beta', agent: 'executor', title: 'Write the migration', status: 'failed', background: false,
      currentTool: null, lastIntent: null, lastOutput: 'boom', toolCount: 5, tokens: 3400, contextPercent: 9,
      cost: null, durationMs: 31000, retry: null, startedAt: 1, endedAt: 2 },
    { id: '2-gamma', agent: 'executor', title: 'Check the lint output', status: 'aborted', background: false,
      currentTool: null, lastIntent: null, lastOutput: null, toolCount: 1, tokens: 90, contextPercent: null,
      cost: null, durationMs: 2000, retry: null, startedAt: 1, endedAt: 2 },
  ];
  writeFileSync(join(state, 'data', 'scope1', 'workers.json'), JSON.stringify({
    schema: 'gjc-herdr-dashboard/workers/1', updatedAt: 1, empty: false, sourceError: null, cards }));
  writeFileSync(join(state, 'slots', layout, 'slot.json'), JSON.stringify({
    schema: 'gjc-herdr-dashboard/slot/1', layoutKey: layout,
    scope: { scopeKey: 'scope1', scopeEpoch: 1, sessionId: 's' },
    roles: { workers: { state: 'ready', token: 'tok', paneId: 'w1:p1' } } }));
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence, logDir: join(SANDBOX, `live-${SESSION}`) });
  const results = {};
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: dir, label: 'lvwid' });
    const viewer = join(REPO, 'src', 'viewers', 'workers', 'viewer.mjs');
    for (const width of [24, 40]) {
      // A fresh pane per width: the previous shell line would otherwise stay in the scrollback.
      const split = fixture.herdr(['pane', 'split', ws.rootPaneId, '--direction', 'right', '--no-focus']);
      const pane = split?.pane?.pane_id ?? split?.result?.pane?.pane_id;
      fixture.adoptPane(pane, { role: 'viewer' });
      await sleep(1_500);
      fixture.sendText(pane, `node "${viewer}" --state "${state}" --layout ${layout} --role workers --token tok --pane ${ws.rootPaneId} --width ${width} --lang en`);
      fixture.sendKeys(pane, 'enter');
      await sleep(4_000);
      // The shell echoes the command line above the frame: keep only what the viewer drew (from the header).
      const whole = stripAnsi(fixture.readPane(pane));
      const frame = whole.slice(whole.lastIndexOf('Workers ['));
      writeEvidence(evidence, `workers-${width}col.txt`, frame);
      const lines = frame.split(/\r?\n/);
      // Column 0 is the selection marker and column 1 the status bar; the glyph comes next.
      const cardLines = lines.filter((l) => /^[ >][▌ ][⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏○✓×⊘Ⅱ?]/.test(l));
      assert(cardLines.length === 3, `${width} cols: three card title lines are drawn`, { frame });
      assert(cardLines.every((l, i) => l.includes(['Parse', 'Write', 'Check'][i].slice(0, width >= 40 ? 5 : 3))), `${width} cols: each card title is recognisable`, { cardLines });
      // Q3=A: a running card carries the spinner glyph, not a word; the header says `run 1`.
      assert(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(frame) && /failed/.test(frame) && /aborted/.test(frame),
        `${width} cols: every status indicator is visible`, { frame });
      const widest = Math.max(...lines.filter((l) => l.trim() !== '').map((l) => [...l].length));
      assert(widest <= width, `${width} cols: every drawn line fits the width (${widest})`, { frame });
      results[width] = { titleLines: cardLines.length, widest, cardLines };
      fixture.sendKeys(pane, 'q');
      await sleep(1_500);
    }
    writeEvidenceJson(evidence, 'result.json', results);
    return results;
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
  }
});
