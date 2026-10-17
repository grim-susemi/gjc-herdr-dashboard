// Viewer interpreter resolution. The viewer is always launched as a plain Node script, so the
// host's own executable is only usable when it IS Node (a compiled GJC/Bun binary is not a
// general JavaScript interpreter). Adapted from the pinned copy source (see
// PROVENANCE.md, "Lane A — core state").
//
// Exports:
//   resolveViewerNode({env, execPath, run, language, message}) -> absolute path to a Node
//     runtime with major version >= 24. Resolution order: `GJC_HERDR_DASHBOARD_NODE` (explicit
//     override, never falls back), then the host executable when it is named node/nodejs, then
//     `node` from PATH. `run(command, args, options)` is injectable for tests; the default is
//     promisified `execFile`.
//     `message(language)` supplies the localized failure text for the shared i18n key
//     `nodeUnavailable`. It defaults to an English sentence so this module stays independent of
//     the i18n module.
import { execFile } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const MINIMUM_MAJOR = 24;
const PROBE = 'JSON.stringify({runtime:"gjc-herdr-dashboard-node",version:process.versions.node,bun:!!process.versions.bun,path:process.execPath})';

export const nodeUnavailableText = {
  en: 'Node.js 24 or newer is required to open the dashboard viewer.',
  ko: '대시보드 viewer를 열려면 Node.js 24 이상이 필요합니다.',
  'zh-cn': '打开仪表盘 viewer 需要 Node.js 24 或更高版本。',
};

function defaultMessage(language) {
  return nodeUnavailableText[language] ?? nodeUnavailableText.en;
}

export async function resolveViewerNode({ env = process.env, execPath = process.execPath,
  run = exec, language = 'en', message = defaultMessage } = {}) {
  const override = env.GJC_HERDR_DASHBOARD_NODE?.trim();
  const candidates = [];
  if (override) {
    // An explicit override is an instruction, not a hint: a failure here must surface.
    candidates.push(override);
  } else {
    if (/^node(?:js)?(?:\.exe)?$/i.test(basename(execPath))) candidates.push(execPath);
    candidates.push('node');
  }
  for (const candidate of new Set(candidates)) {
    try {
      const { stdout } = await run(candidate, ['--eval', `console.log(${PROBE})`],
        { env, timeout: 5000, maxBuffer: 16384 });
      const result = JSON.parse(stdout.trim());
      if (result.runtime === 'gjc-herdr-dashboard-node' && !result.bun &&
          typeof result.version === 'string' && /^\d+\.\d+\.\d+/.test(result.version) &&
          Number(result.version.split('.')[0]) >= MINIMUM_MAJOR &&
          typeof result.path === 'string' && isAbsolute(result.path)) return result.path;
    } catch (error) {
      // outcome: this candidate is unusable; try the next one, or fall through to the error.
      if (override) throw Object.assign(new Error(message(language)), { code: 'node', cause: error });
    }
  }
  throw Object.assign(new Error(message(language)), { code: 'node' });
}
