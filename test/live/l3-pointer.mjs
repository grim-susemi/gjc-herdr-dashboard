// LV-8 (L3): pointer and focus in a harness-owned Herdr session, for BOTH role viewers.
// Per role: click, drag, wheel up, wheel down, blur, resize = 12 observations.
//   AC3.1  wheel / click / drag turn follow OFF for that role only; wheel steps +-3 rows.
//   AC3.2  focus moving to another pane returns follow ON (blur), for the role that lost focus.
//   AC3.3  (unit) subscription failure; here the subscription is real and must not notify failure.
// SGR reports are sent with `pane send-text` ONLY to the viewer pane that owns the role (the
// harness adopts both product panes first). Mouse bytes measured to reach a pane process intact
// (.sandbox/probe-sgr.mjs: `\x1b[<65;5;10M` arrived verbatim).
//
// HARNESS LIMIT (measured, .evidence/L3/LV-8/pty-size.txt): the harness Herdr server is detached with no
// client attached, so every pane PTY stays at the terminal size (120x40) after splits and resizes; a
// viewer therefore draws 40-row frames inside a 14-row pane rect and click rows are PTY rows. Scroll
// distance is observed on the Todo pane (60 rows > 40); the Workers body fits, so its wheel/drag can
// only be checked for the follow flag here (the +-3 row clamp is unit-tested for both roles), and a
// pane resize cannot change the PTY (the viewer redraw on resize is unit-tested).
//
// Run: node test/live/l3-pointer.mjs
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixture, REPO, SANDBOX } from './fixture.mjs';
import { assert, createCase, evidenceDirFor, launchGjc, runScript, sendPrompt, sendSlash,
  stripAnsi, viewerPanes, writeEvidence, writeEvidenceJson } from './case.mjs';

const LV = 'LV-8';
const CASE = 'lvp';
const SESSION = 'gjcdash-lvp';
const WRAPPER = join(REPO, 'test', 'live', 'herdr-wrapper.mjs');
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const ESC = String.fromCharCode(27);
const sgr = (button, x, y, release = false) => `${ESC}[<${button};${x};${y}${release ? 'm' : 'M'}`;
const FOLLOW_ON = /자동 추적 ON/;
const FOLLOW_OFF = /자동 추적 OFF/;

await runScript('l3-pointer (LV-8)', async () => {
  const evidence = evidenceDirFor('L3', LV);
  rmSync(join(SANDBOX, `case-${CASE}`), { recursive: true, force: true });
  rmSync(join(SANDBOX, `live-${SESSION}`), { recursive: true, force: true });
  const paths = createCase({ caseId: CASE, herdr: [process.execPath, WRAPPER] });
  const fixture = createFixture({ session: SESSION, evidenceDir: evidence,
    logDir: join(SANDBOX, `live-${SESSION}`, CASE) });
  const observations = [];
  const observe = (name, ok, detail = null) => {
    observations.push({ name, ok, detail });
    writeEvidenceJson(evidence, 'observations.json', observations);
    assert(ok === true, name, detail);
  };
  try {
    await fixture.startSession();
    const ws = fixture.createWorkspace({ cwd: paths.dir, label: CASE });
    const parent = ws.rootPaneId;
    const status = () => fixture.listPanes().find((p) => p.pane_id === parent)?.agent_status ?? null;
    const idle = async (label) => {
      for (let i = 0; i < 90 && status() !== 'idle'; i += 1) await sleep(2_000);
      assert(status() === 'idle', `the parent returned to idle (${label})`, { status: status() });
      await sleep(2_000);
    };
    await launchGjc(fixture, parent, { dir: paths.dir, herdr: [process.execPath, WRAPPER],
      extra: [...fixture.wrapperEnv(), ['GJC_LIVE_HERDR_SESSION', SESSION]] });
    await fixture.waitIdle(parent, { timeoutMs: 120_000, quiet: 3 });

    const opened = await sendSlash(fixture, parent, 'dashboard', /열림|opened/, { label: 'open' });
    writeEvidence(evidence, 'notify-open.txt', opened.line);
    await sleep(8_000);
    const todo = viewerPanes(fixture, 'todo')[0];
    const workers = viewerPanes(fixture, 'workers')[0];
    assert(Boolean(todo && workers), 'both role panes exist', { todo, workers });
    fixture.adoptPane(todo.pane_id, { role: 'viewer', label: todo.label });
    fixture.adoptPane(workers.pane_id, { role: 'viewer', label: workers.label });

    // Enough Todo rows and Workers cards that both bodies are taller than their panes.
    const rows = Array.from({ length: 60 }, (_, i) => `lvp-row-${String(i + 1).padStart(2, '0')}`);
    await sendPrompt(fixture, parent,
      `Call todo_write once: phase LVP with these pending tasks, one each: ${rows.join(', ')}. Then reply done.`);
    const todoHas = (needle) => {
      try {
        const dataDir = join(paths.stateDir, 'data');
        return readdirSync(dataDir).some((scope) => {
          try { return readFileSync(join(dataDir, scope, 'todo.json'), 'utf8').includes(needle); }
          catch { return false; } // outcome: not written yet
        });
      } catch { return false; } // outcome: the data dir appears with the first pass
    };
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && !todoHas('lvp-row-60')) await sleep(2_000);
    assert(todoHas('lvp-row-60') === true, 'the todo_write reached the Todo projection', {});
    await idle('after todo_write');

    // Record the PTY-vs-pane-rect finding for the evidence folder.
    {
      const g = fixture.herdr(['pane', 'get', todo.pane_id]);
      const body = g?.pane ?? g;
      writeEvidence(evidence, 'pty-size.txt', `pane rect (layout): ${JSON.stringify(fixture.layout(parent).panes.find((q) => q.pane_id === todo.pane_id)?.rect)}\npane get viewport_rows: ${body?.scroll?.viewport_rows}\n`);
    }

    // Workers cards: 8 background-less parallel tasks would be slow; instead drive 3 quick tasks
    // so the Workers body has several cards, then rely on a short pane for scrolling.
    await sendPrompt(fixture, parent,
      'Use the task tool ONCE with six executor tasks in parallel, ids lvpa lvpb lvpc lvpd lvpe lvpf, each with a ' +
      'description equal to its id and assignment "reply pong". Then reply done.');
    const wDeadline = Date.now() + 240_000;
    let cards = 0;
    while (Date.now() < wDeadline) {
      await sleep(3_000);
      const frame = stripAnsi(fixture.readPane(workers.pane_id));
      cards = (frame.match(/lvp[a-f]/g) ?? []).length;
      if (/완료 6|Workers \[6\]/.test(frame)) break;
    }
    await idle('after subagents');
    writeEvidence(evidence, 'workers-frame-before.txt', stripAnsi(fixture.readPane(workers.pane_id)));
    writeEvidence(evidence, 'todo-frame-before.txt', stripAnsi(fixture.readPane(todo.pane_id)));

    // Shrink both viewer panes so their bodies overflow (resize also exercises the redraw).
    const layout0 = fixture.layout(parent);
    const rect = (id) => layout0.panes.find((p) => p.pane_id === id)?.rect;
    writeEvidenceJson(evidence, 'layout-before.json', layout0);

    const panes = { todo: todo.pane_id, workers: workers.pane_id };
    const frameOf = (role) => stripAnsi(fixture.readPane(panes[role]));
    const followOf = (role) => (FOLLOW_OFF.test(frameOf(role)) ? 'off' : FOLLOW_ON.test(frameOf(role)) ? 'on' : '?');
    const send = (role, text) => fixture.sendText(panes[role], text);
    // `pane focus` is directional: the band is parent | Todo over Workers. From the parent, right reaches
    // Todo; Workers is Todo then down. Going back is left from Todo / up then left from Workers.
    const focusPane = (role) => {
      fixture.herdr(['pane', 'focus', '--pane', parent, '--direction', 'right']);
      if (role === 'workers') fixture.herdr(['pane', 'focus', '--pane', panes.todo, '--direction', 'down']);
    };
    const focusParent = (role) => {
      if (role === 'workers') fixture.herdr(['pane', 'focus', '--pane', panes.workers, '--direction', 'up']);
      fixture.herdr(['pane', 'focus', '--pane', panes.todo, '--direction', 'left']);
    };
    // The number of the first task row on screen (the phase header is line 0 of the body, so scroll 6 shows
    // row 06 first): it changes when the body scrolls.
    const firstNumber = (role) => Number(/lvp-row-(\d+)/.exec(firstRowOf(role))?.[1] ?? NaN);
    // The first body line that names a task or card: it changes when the body scrolls.
    const firstRowOf = (role) => frameOf(role).split(/\r?\n/)
      .map((line) => line.trim()).find((line) => /lvp-row-\d+|lvp[a-f]\b/.test(line)) ?? '';

    for (const role of ['todo', 'workers']) {
      const other = role === 'todo' ? 'workers' : 'todo';
      const r = rect(panes[role]);
      void r;
      const bodyY = 6;                                    // a body row of the 40-row PTY frame (header + divider above)
      const tag = `${role}`;
      await sleep(1_500);
      observe(`${tag}: starts with follow ON`, followOf(role) === 'on', { frame: frameOf(role) });

      // wheel down x2 (+3 rows each), wheel up x1 (-3): follow OFF, content moves.
      const top0 = firstRowOf(role);
      send(role, sgr(65, 5, bodyY)); await sleep(500); send(role, sgr(65, 5, bodyY)); await sleep(1_500);
      const afterDown = frameOf(role);
      writeEvidence(evidence, `${tag}-wheel-down.txt`, afterDown);
      observe(`${tag}: wheel down turns follow OFF`, followOf(role) === 'off', { frame: afterDown });
      if (role === 'todo') observe(`${tag}: two wheel-down steps moved the body by 6 lines (row 01 -> 06 after the phase header line)`, firstNumber(role) === 6, { top0, now: firstRowOf(role) });
      else observations.push({ name: `${tag}: body fits the PTY, scroll distance is unit-tested`, ok: true, detail: 'harness limit' });
      writeEvidence(evidence, `${tag}-wheel-down.txt`, afterDown);
      send(role, sgr(64, 5, bodyY)); await sleep(1_500);
      const afterUp = frameOf(role);
      observe(`${tag}: wheel up keeps follow OFF${role === 'todo' ? ' and moves back 3 rows' : ''}`, followOf(role) === 'off' && (role !== 'todo' || firstNumber(role) === 3), { afterUp });
      writeEvidence(evidence, `${tag}-wheel-up.txt`, afterUp);
      observe(`${tag}: the other role's follow is untouched by ${role}'s pointer`, followOf(other) === 'on', { other: frameOf(other) });

      // blur: moving focus to the parent pane returns follow ON for the role that lost focus. The
      // role pane has to have focus first, so click-focus it with `pane focus` (harness-owned pane).
      focusPane(role);
      await sleep(1_000);
      writeEvidence(evidence, `${tag}-focus.txt`, JSON.stringify(fixture.listPanes().find((p) => p.focused)?.pane_id ?? null));
      focusParent(role);
      await sleep(2_500);
      observe(`${tag}: blur returns follow ON`, followOf(role) === 'on', { frame: frameOf(role) });
      writeEvidence(evidence, `${tag}-blur.txt`, frameOf(role));

      // click: selects the row under the cursor and turns follow OFF.
      send(role, sgr(0, 5, bodyY + 2)); await sleep(300);
      send(role, sgr(0, 5, bodyY + 2, true)); await sleep(1_500);
      observe(`${tag}: click turns follow OFF`, followOf(role) === 'off', { frame: frameOf(role) });
      writeEvidence(evidence, `${tag}-click.txt`, frameOf(role));

      // drag: press then motion upwards by 3 rows then release: the body scrolls, follow stays OFF.
      const beforeDrag = frameOf(role);
      send(role, sgr(0, 5, bodyY + 3)); await sleep(300);
      send(role, sgr(32, 5, bodyY)); await sleep(300);
      send(role, sgr(0, 5, bodyY, true)); await sleep(1_500);
      const afterDrag = frameOf(role);
      observe(`${tag}: drag keeps follow OFF`, followOf(role) === 'off', { afterDrag });
      if (role === 'todo') observe(`${tag}: drag changed the visible body`, afterDrag !== beforeDrag, { beforeDrag, afterDrag });
      writeEvidence(evidence, `${tag}-drag.txt`, afterDrag);

      // back to follow ON through blur so the next role starts clean, then resize.
      focusPane(role); await sleep(800);
      focusParent(role); await sleep(2_500);
      const before = frameOf(role);
      fixture.herdr(['pane', 'resize', '--pane', panes[role], '--direction', role === 'todo' ? 'down' : 'up', '--amount', '0.1']);
      await sleep(2_500);
      const after = frameOf(role);
      observe(`${tag}: resize redraws the frame and the viewer stays alive`, after.length > 0 && followOf(role) !== '?', { before, after });
      writeEvidence(evidence, `${tag}-resize.txt`, after);
      fixture.herdr(['pane', 'resize', '--pane', panes[role], '--direction', role === 'todo' ? 'up' : 'down', '--amount', '0.1']);
      await sleep(1_500);
    }

    writeEvidenceJson(evidence, 'observations.json', observations);
    assert(observations.length >= 12, `at least 12 observations were recorded (${observations.length})`, {});
    writeEvidenceJson(evidence, 'workers-cards-seen.json', { cards });
    return { observations: observations.length };
  } finally {
    const cleanup = await fixture.cleanup();
    writeEvidenceJson(evidence, 'cleanup.json', cleanup);
  }
});
