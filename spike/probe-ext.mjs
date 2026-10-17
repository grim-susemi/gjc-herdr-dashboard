// L0 spike extension (deleted at L0 exit). Records keys/types only to GJC_PROBE_OUT.
import { appendFileSync } from "node:fs";

const OUT = process.env.GJC_PROBE_OUT;
const rec = (gate, data) => {
  if (!OUT) return;
  appendFileSync(OUT, JSON.stringify({ gate, pid: process.pid, at: new Date().toISOString(), ...data }) + "\n");
};
const tname = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const keysOf = (v) => (v && typeof v === "object" ? Object.keys(v).sort() : tname(v));

export default function (pi) {
  rec("G1-factory", {
    importMetaUrl: import.meta.url,
    cwd: process.cwd(),
    piKeys: keysOf(pi),
    hasOn: typeof pi.on,
    hasRegisterCommand: typeof pi.registerCommand,
  });

  const onResult = pi.on("session_start", async (_event, ctx) => {
    rec("G3-session_start", {
      ctxKeys: keysOf(ctx),
      hasUI: ctx.hasUI,
      isTTY: Boolean(process.stdout.isTTY),
      modeProp: "mode" in ctx ? tname(ctx.mode) : "absent",
      cwd: ctx.cwd,
      hasGetLeafId: typeof ctx.sessionManager?.getLeafId,
      hasGetSessionId: typeof ctx.sessionManager?.getSessionId,
      hasGetProjectProgress: typeof ctx.getProjectProgress,
      hasGetTodoState: typeof ctx.getTodoState,
      hasGetGoalState: typeof ctx.getGoalState,
      hasGetJobs: typeof ctx.getJobs,
      hasOnSessionEvent: typeof ctx.onSessionEvent,
    });
    // G9: stored ctx used from a timer
    setTimeout(() => {
      try {
        rec("G9-timer", {
          leaf: tname(ctx.sessionManager?.getLeafId?.()),
          sessionId: tname(ctx.sessionManager?.getSessionId?.()),
        });
      } catch (error) {
        rec("G9-timer", { error: String(error?.message ?? error).slice(0, 200) });
      }
    }, 1000);
  });
  rec("G11-on-return", { type: tname(onResult), isUndefined: onResult === undefined });

  for (const name of ["session_switch", "session_shutdown", "session_before_switch", "session_fork", "session_tree"]) {
    try {
      pi.on(name, async (event) => rec("G12-event", { name, reason: event?.reason, eventKeys: keysOf(event) }));
    } catch (error) {
      rec("G12-event", { name, registerError: String(error?.message ?? error).slice(0, 120) });
    }
  }

  let lastCtx;
  pi.on("session_start", async (_e, ctx) => { lastCtx = ctx; });
  for (const name of ["tool_execution_start", "tool_execution_update", "tool_execution_end"]) {
    pi.on(name, async (event, ctx) => {
      lastCtx = ctx;
      const d = event?.partialResult?.details ?? event?.result?.details;
      rec("G5-tool-event", {
        name,
        toolName: event?.toolName,
        eventKeys: keysOf(event),
        detailsKeys: keysOf(d),
        hasUI: ctx?.hasUI,
        subSessionId: tname(ctx?.sessionManager?.getSessionId?.()),
        asyncFlag: d?.async,
        progressType: tname(d?.progress),
        progressSample: Array.isArray(d?.progress) ? d.progress.slice(0, 1).map((p) => ({ keys: keysOf(p), status: p?.status, agent: p?.agent, id: p?.id })) : keysOf(d?.progress),
        resultsSample: Array.isArray(d?.results) ? d.results.slice(0, 1).map((r) => ({ keys: keysOf(r), exit: r?.exitCode, aborted: r?.aborted })) : keysOf(d?.results),
        jobsAtEvent: (() => { try { const j = ctx?.getJobs?.(); return Array.isArray(j) ? j.slice(0, 3).map((x) => ({ keys: keysOf(x), type: x?.type, status: x?.status })) : keysOf(j); } catch (error) { return `ERR:${String(error?.message ?? error).slice(0, 60)}`; } })(),
      });
    });
  }
  for (const evName of ["turn_end", "agent_end"]) pi.on(evName, async (_e, ctx) => {
    const safe = (fn) => { try { return fn(); } catch (error) { return `ERR:${String(error?.message ?? error).slice(0, 80)}`; } };
    const todo = safe(() => ctx.getTodoState?.());
    const jobs = safe(() => ctx.getJobs?.());
    const goal = safe(() => ctx.getGoalState?.());
    rec("G4-" + evName, {
      hasUI: ctx?.hasUI,
      todoType: tname(todo),
      todoKeys: keysOf(todo), todoSample: Array.isArray(todo) ? todo.slice(0, 1).map((x) => ({ keys: keysOf(x), tasksType: tname(x?.tasks), taskKeys: Array.isArray(x?.tasks) ? keysOf(x.tasks[0]) : null, name: tname(x?.name) })) : null,
      todoPhases: Array.isArray(todo?.phases) ? todo.phases.map((p) => ({ keys: keysOf(p), items: Array.isArray(p.tasks) ? p.tasks.map((t) => keysOf(t)) : keysOf(p.items) })) : null,
      jobsType: tname(jobs),
      jobsKeys: keysOf(jobs),
      jobsSample: Array.isArray(jobs) ? jobs.slice(0, 2).map((j) => keysOf(j)) : null,
      goalType: tname(goal),
    });
  });

  pi.registerCommand("dashboard", {
    description: "L0 probe command",
    handler: async (_args, ctx) => {
      rec("G2-dashboard", { hasUI: ctx.hasUI, hasNotify: typeof ctx.ui?.notify });
      ctx.ui?.notify?.("PROBE-DASHBOARD-OK", "info");
    },
  });
}
