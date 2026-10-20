import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [mode] = process.argv.slice(2);
const R = 'src/core/reconciler.mjs';
const I = 'src/host/instance.mjs';
copyFileSync(R, '.sandbox/r.keep');
copyFileSync(I, '.sandbox/i.keep');
try {
  if (mode === 'stopped') {
    const r = readFileSync(R, 'utf8');
    const line = "if (stopped) return { ok: false, skipped: true, code: 'stopped' };";
    if (!r.includes(line)) throw new Error('anchor stopped');
    writeFileSync(R, r.replace(line, ''));
  } else {
    let i = readFileSync(I, 'utf8');
    const a = 'const same = reboundSessionId !== null && reboundSessionId === local.sessionId;';
    const b = 'current.sessionId !== reboundSessionId;';
    if (!i.includes(a) || !i.includes(b)) throw new Error('anchor rebind');
    i = i.replace(a, 'const same = binding !== null && binding.sessionId === local.sessionId;')
      .replace(b, 'current.sessionId !== binding.sessionId;');
    writeFileSync(I, i);
  }
  const out = spawnSync(process.execPath, ['--test', '--test-isolation=none', 'test/unit/'+(mode==='stopped'?'reconciler':'instance')+'.test.mjs'],
    { encoding: 'utf8' });
  const lines = out.stdout.split(/\r?\n/).filter((l) => /^✖|^ℹ fail/.test(l));
  console.log(mode, lines.join(' | ').slice(0, 400));
} finally {
  copyFileSync('.sandbox/r.keep', R);
  copyFileSync('.sandbox/i.keep', I);
}
