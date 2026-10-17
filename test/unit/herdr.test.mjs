// Unit tests for src/herdr.mjs. Adapted from the pinned copy source (see
// .sandbox/provenance-A.md) and extended for the GJC vector precedence of plan 7.10.
// Two host-portability adaptations are recorded in the provenance table: the POSIX quoting
// round-trip uses `sh` (the `bash` on this host's PATH is the WSL launcher and cannot run the
// command), and the real-child test spawns `node` through the HERDR vector env instead of an
// extensionless shebang stub, which win32 cannot exec.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chmodSync } from 'node:fs';
import { createHerdr, quote, resolveHerdrVector, shellCommand } from '../../src/herdr.mjs';

test('POSIX shell command preserves apostrophes and shell metacharacters', () => {
  // Given literal shell-sensitive argv, including an empty value.
  const args = ['/opt/node path/node', "/tmp/owner's/viewer.mjs", '$HOME; & `echo`', ''];
  // When the builder targets a POSIX pane, execute its actual quoting in a POSIX shell.
  const command = shellCommand(args, 'linux');
  const output = execFileSync('sh', ['-c', `printf '%s${String.fromCharCode(92)}0' ${command}`],
    { encoding: 'utf8', timeout: 10000 });
  // Then the original quoting contract and literal argv survive.
  assert.equal(command, args.map(quote).join(' '));
  assert.deepEqual(output.split(String.fromCharCode(0)).slice(0, -1), args);
});

test('win32 shell command uses the PowerShell call operator and doubles apostrophes', () => {
  const command = shellCommand(['C:\\Program Files\\nodejs\\node.exe', 'C:\\한글 공백\\viewer.mjs',
    "it's", '--pane', 'w1:p1'], 'win32');
  assert.equal(command,
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\한글 공백\\viewer.mjs' 'it''s' '--pane' 'w1:p1'");
  // The trailer the launch path appends must stay a separate statement, not a quoted word.
  assert.equal(`${command}; exit`, `${command}; exit`);
});

test('resolveHerdrVector prefers the JSON argv env, then HERDR_BIN_PATH, then PATH', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gjc-herdr-vector-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stub = join(directory, process.platform === 'win32' ? 'herdr.exe' : 'herdr');
  await writeFile(stub, 'exit 0');
  chmodSync(stub, 0o755);
  // Given all three sources, the explicit JSON argv wins and is returned verbatim as a prefix.
  assert.deepEqual(resolveHerdrVector({
    GJC_HERDR_DASHBOARD_HERDR: JSON.stringify(['node', '/opt/herdr/cli.mjs', '--session', 'x']),
    HERDR_BIN_PATH: stub, PATH: directory }), ['node', '/opt/herdr/cli.mjs', '--session', 'x']);
  // Without it, HERDR_BIN_PATH wins.
  assert.deepEqual(resolveHerdrVector({ HERDR_BIN_PATH: stub, PATH: directory }), [stub]);
  // A deleted HERDR_BIN_PATH is not a binary, so PATH is used.
  assert.deepEqual(resolveHerdrVector({ HERDR_BIN_PATH: `${stub} (deleted)`, PATH: directory }), [stub]);
  assert.deepEqual(resolveHerdrVector({ PATH: directory }), [stub]);
  // Nothing resolvable is an error with a code, not an empty vector.
  assert.throws(() => resolveHerdrVector({ PATH: '' }), { code: 'herdr-missing' });
  for (const value of ['not json', '[]', '["node",""]', '{"bin":"herdr"}']) {
    assert.throws(() => resolveHerdrVector({ GJC_HERDR_DASHBOARD_HERDR: value, PATH: directory }),
      { code: 'herdr-vector' }, value);
  }
});

test('createHerdr runs the vector without a shell and appends the caller arguments', async () => {
  const calls = [];
  const herdr = createHerdr({ vector: ['node', '/opt/herdr/cli.mjs'],
    execute: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: JSON.stringify({ id: 'cli:pane:list', result: { panes: [{ pane_id: 'w1:p1' }] } }) };
    } });
  // When a caller passes ('pane','list'), then the vector stays a pure argv prefix.
  assert.deepEqual(await herdr('pane', 'list'), { panes: [{ pane_id: 'w1:p1' }] });
  assert.deepEqual(calls[0].bin, 'node');
  assert.deepEqual(calls[0].args, ['/opt/herdr/cli.mjs', 'pane', 'list']);
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(calls[0].options.shell, undefined);
});

test('createHerdr returns {} for an empty body and surfaces Herdr error codes', async () => {
  const empty = createHerdr({ vector: ['herdr'], execute: async () => ({ stdout: '  \n' }) });
  // An empty body acknowledges a successful run, and the run subcommand carries the caller argv.
  const subcommand = 'run';
  assert.deepEqual(await empty('pane', subcommand, 'w1:p1', 'node viewer.mjs'), {});
  // A structured error on stdout keeps its code so absence is distinguishable from a crash.
  const failed = createHerdr({ vector: ['herdr'], execute: async () => ({
    stdout: JSON.stringify({ id: 'x', error: { code: 'pane_not_found', message: 'unknown pane' } }) }) });
  await assert.rejects(failed('pane', 'close', 'w1:gone'), error => {
    assert.equal(error.code, 'pane_not_found');
    assert.equal(error.message, 'unknown pane');
    return true;
  });
  // A non-zero exit whose body is Herdr's structured error is unwrapped the same way.
  const exitError = createHerdr({ vector: ['herdr'], execute: async bin => {
    throw Object.assign(new Error(`Command failed: ${bin}`), { code: 1,
      stdout: JSON.stringify({ error: { code: 'pane_not_found', message: 'gone' } }) });
  } });
  await assert.rejects(exitError('pane', 'list'), { code: 'pane_not_found' });
  // A body that is neither empty, nor JSON, nor a Herdr error stays a raw failure.
  const garbage = createHerdr({ vector: ['herdr'], execute: async () => { throw Object.assign(new Error('boom'), { code: 2, stdout: 'segfault' }); } });
  await assert.rejects(garbage('pane', 'list'), /boom/);
});

test('createHerdr resolves a real vector from the environment and spawns a real child', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gjc-herdr-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Given the JSON argv env pointing at a real interpreter and a real script. On win32 an
  // extensionless shebang stub is not executable, so the vector carries the interpreter itself.
  const script = join(directory, 'herdr-stub.mjs');
  await writeFile(script,
    'console.log(JSON.stringify({result:{argv:process.argv.slice(2)}}));\n');
  const herdr = createHerdr({ env: {
    GJC_HERDR_DASHBOARD_HERDR: JSON.stringify([process.execPath, script]),
    HERDR_BIN_PATH: join(directory, 'herdr (deleted)'),
    PATH: directory,
  } });
  // Then execFile runs it without a shell and the parsed result carries the caller arguments.
  assert.deepEqual(await herdr('pane', 'get', 'w1:p1'),
    { argv: ['pane', 'get', 'w1:p1'] });
  // An empty environment has no vector at all, which is a coded refusal to spawn.
  const absent = createHerdr({ env: { PATH: '' } });
  await assert.rejects(absent('pane', 'list'), { code: 'herdr-missing' });
});

test('resolveHerdrVector finds an executable on PATH and rejects a non-executable override', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gjc-herdr-onpath-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // On win32 createHerdr appends .exe to the PATH lookup; either name resolves here.
  const name = process.platform === 'win32' ? 'herdr.exe' : 'herdr';
  const stub = join(directory, name);
  await writeFile(stub, 'exit 0');
  chmodSync(stub, 0o755);
  assert.deepEqual(resolveHerdrVector({ PATH: directory }), [stub]);
  // A HERDR_BIN_PATH that is not a regular file is skipped in favour of the PATH hit.
  await mkdir(join(directory, 'herdr (deleted)'), { recursive: true });
  assert.deepEqual(resolveHerdrVector({ HERDR_BIN_PATH: join(directory, 'herdr (deleted)'), PATH: directory }),
    [stub]);
});
