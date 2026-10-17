// Workers projection source for the GJC Herdr dashboard.
//
// Plan stage-03 §7.6 row Workers. The bus is the primary source and `ctx.getJobs()` the
// background supplement (L0 G5 measured both):
//   * `task:subagent:lifecycle` `{id, agent, agentSource, description?, status, sessionFile?, index}`
//     with `status` started | completed | failed | aborted | paused (a payload the host hands
//     straight from task/types.ts). `started` maps to the card status `running`.
//   * `task:subagent:progress` `{agent, agentSource, assignment, index, progress, sessionFile, task}`
//     where `progress` is the host's `AgentProgress`. A payload is matched to a card by
//     `progress.id`; the `agent` + `index` pair is the fallback for a row that carries no id, and
//     it only matches when it names exactly one card.
//   * `task:subagent:event` carries raw child events and is deliberately not consumed.
//   * `ctx.getJobs()` (`{running, recent, delivery}`) fills in work the sub bus cannot see: a
//     `task` job whose id the bus has not reported becomes a `background: true` card titled by
//     its label, and a later pass updates that same card in place from the job's own frozen
//     `endTime`. Depth > 1 subagents stay invisible (README limitation, §7.6).
//
// The tracker is a pure per-scope state machine: no I/O, no timers, no module-import-time
// reads. The owner (src/host/instance.mjs) feeds the bus payloads and the retained ctx, then
// publishes `snapshot()`; a 200 ms merge upstream keeps the bus burst off the disk.
//
// Malformed payloads are ignored and counted in `snapshot().ignored` instead of being guessed
// at. The counter is per snapshot, so a consumer can tell "no cards yet" from "cards arrived
// and we could not read them". `snapshot()` itself never throws. The three ingest methods can
// throw on a genuinely hostile payload (a getter that raises), which is deliberate: the host
// wraps each bus handler in try/catch and records the exception with `fail()`, and that is how
// AC2.7's source-error label appears. Swallowing it here would hide the fault instead.
//
// Privacy (AC-G4 / AC2.5): `assignment`, transcripts, `sessionFile`, tool arguments and every
// message body other than `lastIntent`/`lastOutput` are dropped at this boundary. Only the
// task description (or, when the host supplies none, the task text) becomes the card title, and
// control sequences are stripped so untrusted child output can never retitle a pane.
//
// Cost (K1, VERIFICATION.md G5): the host reports `cost: 0` at every point for subscription
// models, so a reported 0 is indistinguishable from "unknown" and is projected as `null`.
// Only a positive number survives.
//
// Exported signatures
//   WORKERS_SCHEMA: 'gjc-herdr-dashboard/workers/1'
//   WORKERS_MAX: 50
//   WORKERS_STATUSES: readonly string[]                 // card status vocabulary
//   LIFECYCLE_STATUSES: readonly string[]              // bus lifecycle vocabulary
//   createWorkersTracker({ now?, max? }): Tracker
//     Tracker = { onLifecycle, onProgress, syncJobs, fail, snapshot, reset }
//     snapshot() = { schema, updatedAt, empty, sourceError, cards, ignored }

export const WORKERS_SCHEMA = "gjc-herdr-dashboard/workers/1";

// Cards per scope. The plan's limit keeps one scope's file bounded no matter how noisy a
// long session's bus is.
export const WORKERS_MAX = 50;

// The card status vocabulary of the projection. `paused` is a live-but-frozen subagent, not a
// terminal state: it keeps its elapsed time frozen and can resume.
export const WORKERS_STATUSES = Object.freeze(["pending", "running", "completed", "failed",
  "aborted", "paused"]);

// The lifecycle channel vocabulary. `started` is the only non-terminal spelling.
export const LIFECYCLE_STATUSES = Object.freeze(["started", "completed", "failed", "aborted",
  "paused"]);

// Job rows use the async job manager's own vocabulary; `cancelled` is the same outcome the
// bus calls `aborted`, and the projection keeps its single spelling for it.
const JOB_STATUSES = Object.freeze({ pending: "pending", running: "running",
  completed: "completed", failed: "failed", cancelled: "aborted", canceled: "aborted",
  paused: "paused" });

const TITLE_LIMIT = 120;
const OUTPUT_LIMIT = 200;
const TOOL_LIMIT = 80;
const INTENT_LIMIT = 200;
const AGENT_LIMIT = 80;

// Title = `description ?? task` (or the job label for a background card). The rank records which
// source produced the title, so a description arriving after the task-text fallback still
// upgrades the card, while a later weaker payload never degrades a known description.
const TITLE_RANK = Object.freeze({ fallback: 1, description: 2 });

const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (value) => {
  const number = finite(value);
  return number !== null && number >= 0 ? Math.floor(number) : 0;
};
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

// One line of untrusted text, control-free and bounded. Newlines collapse to spaces because a
// card is always exactly one line; `null` means "no usable text", not "the empty string".
// `clip` counts whole code points, so a bound is never applied through the middle of a surrogate
// pair: a split emoji would put a lone surrogate into the projection file.
function clip(text, limit) {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function lineText(value, limit) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\r\n?/g, "\n").replace(/\n/g, " ").replaceAll("\t", " ")
    .replace(CONTROL, "").trim();
  if (cleaned === "") return null;
  return clip(cleaned, limit);
}

const firstText = (values, limit) => {
  for (const value of values) {
    const text = lineText(value, limit);
    if (text !== null) return text;
  }
  return null;
};

// `lastOutput` is the last non-empty line the child produced, newest line first, so a trailing
// blank in `recentOutput` never blanks the card.
function lastOutputLine(recentOutput) {
  if (!Array.isArray(recentOutput)) return null;
  for (let index = recentOutput.length - 1; index >= 0; index -= 1) {
    const entry = recentOutput[index];
    if (typeof entry !== "string") continue;
    const lines = entry.replace(/\r\n?/g, "\n").split("\n");
    for (let line = lines.length - 1; line >= 0; line -= 1) {
      const text = lineText(lines[line], OUTPUT_LIMIT);
      if (text !== null) return text;
    }
  }
  return null;
}

// contextTokens / contextWindow * 100, verbatim per the contract; `null` when the host did not
// report both numbers (or reported a nonsense window).
function contextPercentOf(progress) {
  const used = finite(progress.contextTokens);
  const window = finite(progress.contextWindow);
  if (used === null || window === null || used < 0 || window <= 0) return null;
  return (used / window) * 100;
}

// K1: 0 means unknown for the subscription tiers this dashboard runs on.
function costOf(value) {
  const cost = finite(value);
  return cost !== null && cost > 0 ? cost : null;
}

function retryOf(value) {
  if (!record(value)) return null;
  return { attempt: finite(value.attempt), delayMs: finite(value.delayMs) };
}

function setTitle(card, text, rank) {
  if (text === null || rank < card.titleRank) return;
  if (rank === card.titleRank && card.title !== "") return;
  card.title = text;
  card.titleRank = rank;
}

export function createWorkersTracker({ now = () => Date.now(), max = WORKERS_MAX } = {}) {
  const limit = finite(max) !== null && max >= 1 ? Math.floor(max) : WORKERS_MAX;
  // Keyed by card id. Display order comes from `order` (a creation sequence, newest first), not
  // from the Map's iteration order, so the list is stable no matter how the host interleaves
  // lifecycle, progress and jobs payloads. `order` is the only tie-breaker `prune()` needs.
  const cards = new Map();
  let sequence = 0;
  let ignored = 0;
  let sourceError = null;

  // The only clock read. A clock that raises or hands back garbage falls back to the wall clock
  // rather than making `snapshot()` throw or stamping `NaN` into the projection.
  const stamp = () => {
    let value;
    try { value = now(); }
    catch {
      // outcome: a throwing clock is replaced by the wall clock; `snapshot()` is documented never
      // to throw, and the owner publishes its result verbatim as the scope's data file.
      return Date.now();
    }
    return finite(value) !== null ? value : Date.now();
  };

  function blank(id) {
    sequence += 1;
    return { id, agent: "", title: "", titleRank: 0, status: "pending", background: false,
      currentTool: null, lastIntent: null, lastOutput: null, toolCount: 0, tokens: 0,
      contextPercent: null, cost: null, reportedDurationMs: null, retry: null, startedAt: null,
      endedAt: null, index: null, order: sequence };
  }
  function cardFor(id) {
    const existing = cards.get(id);
    if (existing !== undefined) return existing;
    const card = blank(id);
    cards.set(id, card);
    return card;
  }

  // Cap. The oldest *completed* card goes first so a finished run frees room for live work;
  // with none completed, the oldest card goes, so the newest window always survives.
  function prune() {
    while (cards.size > limit) {
      let victim = null;
      for (const card of cards.values()) {
        if (card.status !== "completed") continue;
        if (victim === null || card.order < victim.order) victim = card;
      }
      if (victim === null) {
        for (const card of cards.values()) {
          if (victim === null || card.order < victim.order) victim = card;
        }
      }
      cards.delete(victim.id);
    }
  }

  function onLifecycle(payload) {
    if (!record(payload) || typeof payload.id !== "string" || payload.id === "") {
      ignored += 1;
      return;
    }
    const status = payload.status;
    if (typeof status !== "string" || !LIFECYCLE_STATUSES.includes(status)) {
      ignored += 1;
      return;
    }
    const card = cardFor(payload.id);
    const agent = lineText(payload.agent, AGENT_LIMIT);
    if (agent !== null) card.agent = agent;
    setTitle(card, lineText(payload.description, TITLE_LIMIT), TITLE_RANK.description);
    const index = finite(payload.index);
    if (index !== null) card.index = Math.floor(index);
    if (status === "started") {
      // A `started` for a card whose last run had ended begins a new run, so the clock restarts;
      // a duplicate `started` for a card still running must not rewind its own start.
      const restarting = card.endedAt !== null;
      card.status = "running";
      card.endedAt = null;
      if (restarting || card.startedAt === null) card.startedAt = stamp();
    } else {
      card.status = status;
      // Frozen on the first terminal event: a duplicate `completed` must not stretch the
      // duration, and only a `started` event clears it again (a retry re-run).
      if (card.endedAt === null) card.endedAt = stamp();
    }
    prune();
  }

  function onProgress(payload) {
    if (!record(payload) || !record(payload.progress)) {
      ignored += 1;
      return;
    }
    const progress = payload.progress;
    if (typeof progress.status !== "string" || !WORKERS_STATUSES.includes(progress.status)) {
      ignored += 1;
      return;
    }
    const id = lineText(progress.id, 256);
    const agent = firstText([progress.agent, payload.agent], AGENT_LIMIT);
    const indexValue = finite(progress.index) !== null ? finite(progress.index) : finite(payload.index);
    const index = indexValue !== null ? Math.floor(indexValue) : null;
    // `progress.id` is the card key when the host sends one: an id names a card outright, and an id
    // no card knows is a card we have not seen yet. The agent+index pair is only the fallback for
    // a row that carries no id, and it counts only when it names exactly one card — merging two
    // subagents that share an agent and an index would silently lose one of them.
    let card = id !== null ? cards.get(id) ?? null : null;
    if (id === null) {
      if (agent !== null && index !== null) {
        for (const candidate of cards.values()) {
          if (candidate.agent !== agent || candidate.index !== index) continue;
          if (card !== null) { card = null; break; }
          card = candidate;
        }
      }
      if (card === null) {
        // Nothing identifies the row at all. Counting it is the whole point of the counter — a
        // silently dropped progress row would be a lie about the live work.
        ignored += 1;
        return;
      }
    } else if (card === null) {
      card = cardFor(id);
    }
    if (agent !== null) card.agent = agent;
    if (index !== null) card.index = index;
    const description = firstText([progress.description, payload.description], TITLE_LIMIT);
    if (description !== null) setTitle(card, description, TITLE_RANK.description);
    else setTitle(card, firstText([progress.task, payload.task], TITLE_LIMIT), TITLE_RANK.fallback);
    card.status = progress.status;
    card.currentTool = lineText(progress.currentTool, TOOL_LIMIT);
    card.lastIntent = lineText(progress.lastIntent, INTENT_LIMIT);
    card.lastOutput = lastOutputLine(progress.recentOutput);
    card.toolCount = count(progress.toolCount);
    card.tokens = count(progress.tokens);
    card.contextPercent = contextPercentOf(progress);
    card.cost = costOf(progress.cost);
    card.retry = retryOf(progress.retryState);
    const reported = finite(progress.durationMs);
    card.reportedDurationMs = reported !== null && reported >= 0 ? reported : null;
    if (progress.status === "running" || progress.status === "pending") card.endedAt = null;
    else if (card.endedAt === null) card.endedAt = stamp();
    prune();
  }

  // `jobsState` is `ctx.getJobs()` or undefined. An absent surface is not a malformed payload:
  // the host simply did not offer one, so nothing is counted and nothing changes.
  function syncJobs(jobsState) {
    if (jobsState === undefined || jobsState === null) return;
    if (!record(jobsState)) {
      ignored += 1;
      return;
    }
    const groups = [jobsState.running, jobsState.recent];
    if (groups.every((group) => group === undefined)) {
      ignored += 1;
      return;
    }
    for (const group of groups) {
      if (group === undefined || group === null) continue;
      if (!Array.isArray(group)) {
        ignored += 1;
        continue;
      }
      for (const job of group) {
        if (!record(job)) {
          ignored += 1;
          continue;
        }
        if (job.type !== "task") continue; // only subagent jobs have a card here.
        if (typeof job.id !== "string" || job.id === "") {
          ignored += 1;
          continue;
        }
        const existing = cards.get(job.id);
        // The contract's rule, and the reason this is a *supplement*: a job whose id is already a
        // card is not re-projected from the job row. The bus owns that card and carries facts the
        // row does not (agent, intent, tool, tokens). A card this method created itself is the
        // exception — a later pass must be able to move it to completed, or it would stay
        // `running` forever and never be pruned.
        if (existing !== undefined && existing.background !== true) continue;
        const card = existing ?? cardFor(job.id);
        card.background = true;
        card.status = JOB_STATUSES[job.status] ?? card.status;
        setTitle(card, lineText(job.label, TITLE_LIMIT), TITLE_RANK.fallback);
        const agent = record(job.metadata) ? lineText(job.metadata.agent, AGENT_LIMIT) : null;
        if (agent !== null) card.agent = agent;
        const startedAt = finite(job.startTime);
        if (startedAt !== null) card.startedAt = startedAt;
        // A job's `endTime` is the manager's frozen truth: set for every terminal or paused
        // job, absent while running. A later pass therefore updates the same card in place.
        card.endedAt = finite(job.endTime);
      }
    }
    prune();
  }

  function fail(error, where) {
    const message = typeof error?.message === "string" ? error.message : "";
    // Preference order: an `Error`'s own message, then a thrown string as it stands, then the call
    // site that failed (the only evidence left when the error carries none). A non-Error object is
    // never stringified: "[object Object]" would hide the call site that still knows something.
    // Never empty: the footer renders `sourceError` verbatim, and "" would read as a healthy source.
    sourceError = message || (typeof error === "string" ? error : "") ||
      (where === undefined || where === null || where === "" ? "error" : String(where));
  }

  // Elapsed time always agrees with the stamps the card carries: once both ends are known the
  // duration is frozen (a completed card must not keep counting), a running card counts to the
  // snapshot's own `now`, and a card known only from progress falls back to the host's number.
  function durationOf(card, nowMs) {
    if (card.startedAt !== null && card.endedAt !== null) {
      return Math.max(0, card.endedAt - card.startedAt);
    }
    if (card.startedAt !== null) return Math.max(0, nowMs - card.startedAt);
    const reported = finite(card.reportedDurationMs);
    return reported !== null && reported >= 0 ? Math.floor(reported) : 0;
  }

  function project(card, nowMs) {
    return { id: card.id, agent: card.agent, title: card.title, status: card.status,
      background: card.background, currentTool: card.currentTool, lastIntent: card.lastIntent,
      lastOutput: card.lastOutput, toolCount: card.toolCount, tokens: card.tokens,
      contextPercent: card.contextPercent, cost: card.cost, durationMs: durationOf(card, nowMs),
      retry: card.retry === null ? null : { ...card.retry }, startedAt: card.startedAt,
      endedAt: card.endedAt };
  }

  function snapshot() {
    const updatedAt = stamp();
    const ordered = [...cards.values()].sort((left, right) => right.order - left.order);
    return { schema: WORKERS_SCHEMA, updatedAt, empty: ordered.length === 0, sourceError,
      cards: ordered.map((card) => project(card, updatedAt)), ignored };
  }

  // A new scope starts clean: cards, the source error and the ignore counter all describe the
  // scope that just ended, so none of them may leak into the next one.
  function reset() {
    cards.clear();
    sourceError = null;
    ignored = 0;
    sequence = 0;
  }

  return { onLifecycle, onProgress, syncJobs, fail, snapshot, reset };
}
