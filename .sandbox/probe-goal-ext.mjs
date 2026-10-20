// L5b probe (sandbox only, never committed): what does the 0.18.11 host hand an extension about the
// goal? Records keys/types/scalars only. Run inside a harness-owned Herdr pane via dev-shim.
import { appendFileSync } from "node:fs";

const OUT = process.env.GJC_PROBE_OUT;
if (OUT) appendFileSync(OUT, JSON.stringify({ gate: "L5-module-eval", pid: process.pid, t: Date.now() }) + "\n");
const rec = (gate, data) => OUT && appendFileSync(OUT, JSON.stringify({ gate, pid: process.pid, t: Date.now(), ...data }) + "\n");
const tn = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const ks = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort() : tn(v));
const safe = (fn) => { try { return fn(); } catch (error) { return `ERR:${String(error?.message ?? error).slice(0, 80)}`; } };
const num = (v) => (typeof v === "number" ? v : tn(v));

export default function (pi) {
  rec("L5-factory", { hasEvents: typeof pi?.events?.on, hasRegister: typeof pi?.registerCommand });
  pi.on("session_start", async (_event, ctx) => {
    rec("L5-session_start", {
      hasGetGoalState: typeof ctx?.getGoalState,
      goalType: safe(() => tn(ctx?.getGoalState?.())),
      goalKeys: safe(() => ks(ctx?.getGoalState?.())),
      goalStateKeys: safe(() => ks(ctx?.getGoalState?.()?.state)),
      goalObjKeys: safe(() => ks(ctx?.getGoalState?.()?.goal)),
      enabled: safe(() => ctx?.getGoalState?.()?.enabled),
      status: safe(() => ctx?.getGoalState?.()?.goal?.status),
      objectiveType: safe(() => tn(ctx?.getGoalState?.()?.goal?.objective)),
      tokens: safe(() => num(ctx?.getGoalState?.()?.goal?.tokensUsed)),
      timeUsedSeconds: safe(() => num(ctx?.getGoalState?.()?.goal?.timeUsedSeconds)),
      idType: safe(() => tn(ctx?.getGoalState?.()?.goal?.id)),
      sessionGoalGetter: safe(() => typeof ctx?.session?.getGoalModeState),
      // AC5.1 / F1 re-measured on the current host: is there a native progress source for a third pane?
      getProjectProgress: safe(() => typeof ctx?.getProjectProgress),
      getProjectProgressType: safe(() => tn(ctx?.getProjectProgress?.())),
      getProjectProgressKeys: safe(() => ks(ctx?.getProjectProgress?.())),
      ctxTopLevelKeys: safe(() => ks(ctx)),
    });
  });
  pi.on("goal_updated", async (event, ctx) => {
    rec("L5-goal_updated", {
      eventKeys: ks(event),
      eventGoalType: tn(event?.goal),
      eventGoalKeys: ks(event?.goal),
      eventStateKeys: ks(event?.state),
      enabled: event?.state?.enabled,
      status: event?.state?.goal?.status,
      objectiveType: tn(event?.state?.goal?.objective),
      tokens: num(event?.state?.goal?.tokensUsed),
      timeUsedSeconds: num(event?.state?.goal?.timeUsedSeconds),
      ctxGoalKeys: safe(() => ks(ctx?.getGoalState?.())),
      ctxObjectiveType: safe(() => tn(ctx?.getGoalState?.()?.goal?.objective)),
    });
  });
  pi.registerCommand("probe-goal", {
    description: "L5b probe",
    handler: async (_args, ctx) => {
      rec("L5-command", {
        goalKeys: safe(() => ks(ctx?.getGoalState?.())),
        enabled: safe(() => ctx?.getGoalState?.()?.enabled),
        status: safe(() => ctx?.getGoalState?.()?.goal?.status),
        objective: safe(() => String(ctx?.getGoalState?.()?.goal?.objective ?? "").slice(0, 40)),
        tokens: safe(() => num(ctx?.getGoalState?.()?.goal?.tokensUsed)),
        timeUsedSeconds: safe(() => num(ctx?.getGoalState?.()?.goal?.timeUsedSeconds)),
      });
      ctx.ui?.notify?.("PROBE-GOAL-OK", "info");
    },
  });
}
