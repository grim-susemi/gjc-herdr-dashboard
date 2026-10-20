import fs from 'node:fs';
export default function (pi) {
  const log = (m) => fs.appendFileSync(process.env.TRACE_FILE, `${Date.now()} ${m}\n`);
  let ctxRef = null;
  pi.on('session_start', (_e, ctx) => { ctxRef = ctx; log('session_start'); });
  pi.registerCommand('trace', { description: 'trace', handler: async (_a, ctx) => { ctxRef = ctx; log('trace-cmd'); } });
  setInterval(() => { try { log(`leaf=${ctxRef?.sessionManager?.getLeafId?.()} todo=${JSON.stringify(ctxRef?.getTodoState?.() ?? null).slice(0, 60)}`); } catch (e) { log(`ERR ${e.message}`); } }, 500).unref();
}
