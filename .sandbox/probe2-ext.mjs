// Second-round L0 probe (sandbox only, never committed). Keys/types and small scalars only.
import { appendFileSync } from "node:fs";

const OUT = process.env.GJC_PROBE_OUT;
const rec = (gate, data) => OUT && appendFileSync(OUT, JSON.stringify({ gate, pid: process.pid, t: Date.now(), ...data }) + "\n");
const tn = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const ks = (v) => (v && typeof v === "object" ? Object.keys(v).sort() : tn(v));
const safe = (fn) => { try { return fn(); } catch (error) { return `ERR:${String(error?.message ?? error).slice(0, 80)}`; } };

let instanceSeq = 0;
export default function (pi) {
  const instance = ++instanceSeq;
  let mainCtx;
  const meta = (ctx) => ({ kind: ctx?.sessionMetadata?.kind, depth: ctx?.sessionMetadata?.taskDepth, agentType: ctx?.sessionMetadata?.currentAgentType, hasUI: ctx?.hasUI, isTTY: Boolean(process.stdout.isTTY) });
  rec("P2-factory", { instance, busKeys: ks(pi.events), url: import.meta.url.slice(-30) });

  pi.on("session_start", async (_e, ctx) => {
    rec("G3-session_start", { instance, ...meta(ctx) });
    if (ctx?.sessionMetadata?.kind === "main" || ctx?.sessionMetadata?.kind === undefined) mainCtx = ctx;
    // G9 follow-up: stored ctx used after a switch
    setInterval(() => {
      rec("G9-interval", {
        instance,
        sessionId: safe(() => tn(ctx.sessionManager?.getSessionId?.())),
        leaf: safe(() => tn(ctx.sessionManager?.getLeafId?.())),
        cwd: safe(() => ctx.cwd),
      });
    }, 2000).unref?.();
  });
  for (const name of ["session_before_switch", "session_switch", "session_before_branch", "session_branch", "session_shutdown", "session_tree"]) {
    pi.on(name, async (event, ctx) => rec("G12-event", { instance, name, reason: event?.reason, kind: ctx?.sessionMetadata?.kind, sidType: safe(() => tn(ctx?.sessionManager?.getSessionId?.())), sid: safe(() => String(ctx?.sessionManager?.getSessionId?.()).slice(0, 8)) }));
  }

  // G5: bus subscriptions, jobs and cost values
  for (const channel of ["task:subagent:lifecycle", "task:subagent:progress", "task:subagent:event"]) {
    try { pi.events.on(channel, (data) => rec("G5-bus", { instance, channel, keys: ks(data), status: data?.status, id: data?.id, agent: data?.agent })); } catch (error) { rec("G5-bus-error", { channel, error: String(error?.message ?? error).slice(0, 80) }); }
  }
  pi.on("tool_execution_update", async (event, ctx) => {
    if (event?.toolName !== "task") return;
    const d = event?.partialResult?.details;
    rec("G5-task-update", {
      instance, kind: ctx?.sessionMetadata?.kind,
      async: d?.async,
      progress: Array.isArray(d?.progress) ? d.progress.map((p) => ({ id: p.id, status: p.status, cost: p.cost, tokens: p.tokens, toolCount: p.toolCount })) : null,
      jobs: safe(() => { const j = ctx?.getJobs?.(); return { running: Array.isArray(j?.running) ? j.running.map((x) => ({ keys: ks(x), type: x?.type, status: x?.status })) : tn(j?.running), recent: Array.isArray(j?.recent) ? j.recent.length : tn(j?.recent) }; }),
    });
  });
  pi.on("turn_end", async (_e, ctx) => {
    rec("G5-turn_end", { instance, kind: ctx?.sessionMetadata?.kind, jobs: safe(() => { const j = ctx?.getJobs?.(); return { running: Array.isArray(j?.running) ? j.running.length : tn(j?.running), recent: Array.isArray(j?.recent) ? j.recent.map((x) => ({ type: x?.type, status: x?.status, cost: x?.cost })).slice(0, 3) : tn(j?.recent) }; }) });
  });
  pi.registerCommand("dashboard", { description: "L0 probe", handler: async (_a, ctx) => { rec("G2-dashboard", { instance, ...meta(ctx) }); ctx.ui?.notify?.("PROBE2-OK", "info"); } });
}
