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
      pi.on(name, async () => rec("G12-event", { name }));
    } catch (error) {
      rec("G12-event", { name, registerError: String(error?.message ?? error).slice(0, 120) });
    }
  }

  pi.registerCommand("dashboard", {
    description: "L0 probe command",
    handler: async (_args, ctx) => {
      rec("G2-dashboard", { hasUI: ctx.hasUI, hasNotify: typeof ctx.ui?.notify });
      ctx.ui?.notify?.("PROBE-DASHBOARD-OK", "info");
    },
  });
}
