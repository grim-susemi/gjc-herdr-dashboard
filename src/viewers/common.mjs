// Shared helpers for every GJC Herdr dashboard role viewer.
//
// Everything here has injectable side effects (fs, clock, herdr) so the unit
// tests never touch a real Herdr, a real clock or the owner's home. The viewer
// process is role-agnostic: the role name only selects the ready file and the
// projection file.
//
// The text primitives (clean/width/fit/wrap) are narrowly adapted from
// omo-herdr-dashboard `packages/todo/src/render.mjs` @4082c750, which in turn
// adapted them from omo-herdr-dag-follow/src/render.mjs.
// grammar re-aligned with omo-herdr-dashboard 3242ad4, see GRAMMAR.md
// MIT License, Copyright (c) 2026 omo-herdr-dag contributors.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Exported signatures
//   clean(value): string
//   width(text): number
//   fit(text, columns, pad?): string
//   wrap(text, columns): string[]
//   languageOf(value) / t(language, key, values?)                    // re-exported
//   clockTime(ms): string                       // local HH:MM
//   connectionLabel(language, connection): string
//   footerText(language, options): string      // follow + connection, no keyboard legend
//   generationOf(rootUrl, { readFile }): string // config.json.generation else 'dev'
//   readyRecord(options): object                // heartbeat file payload
//   createHeartbeat(options): { write, start, stop }
//   createSlotWatcher(options): { close }
//   fenceDecision(slot, { role, token }): { retire, reason }
//   ownerLiveness(owner, { now, pidAlive, killedWithinMs? }): 'live'|'disconnected'|'absent'
//   closeOwnPane(options): Promise<{ closed, reason }>
import { readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { languageOf, t } from "../i18n.mjs";
import { writeJson } from "../storage.mjs";

export { languageOf, t };

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Strip terminal control sequences first (CSI/OSC/DCS and friends), then the
// remaining C0/C1 controls and bidi overrides, so untrusted task content can
// never clear the screen, retitle the pane or reorder the frame.
export const clean = (value) => stripVTControlCharacters(String(value ?? ""))
  .replace(/\r\n?/g, "\n").replaceAll("\t", " ")
  .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

export function width(text) {
  let result = 0;
  for (const { segment } of segmenter.segment(clean(text))) {
    if (/^[\p{Mark}\p{Cf}\n]+$/u.test(segment)) continue;
    const cp = segment.codePointAt(0);
    result += /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment) ||
      cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
        cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 ||
        cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f ||
        cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000) ? 2 : 1;
  }
  return result;
}

export function fit(text, columns, pad = false) {
  text = clean(text).replaceAll("\n", " ");
  if (columns < 1) return "";
  let out = "", used = 0;
  const truncated = width(text) > columns;
  for (const { segment } of segmenter.segment(text)) {
    const size = width(segment);
    if (used + size > columns - (truncated ? 1 : 0)) break;
    out += segment; used += size;
  }
  if (truncated) { out += "~"; used++; }
  return out + (pad ? " ".repeat(Math.max(0, columns - used)) : "");
}

export function wrap(text, columns) {
  columns = Math.max(1, columns);
  const result = [];
  for (const paragraph of clean(text).split("\n")) {
    let line = "";
    for (const { segment } of segmenter.segment(paragraph)) {
      const part = width(segment) > columns ? "?" : segment;
      if (width(line + part) > columns) {
        const space = line.lastIndexOf(" ");
        if (space > 0 && part !== " ") {
          result.push(line.slice(0, space));
          line = line.slice(space + 1);
        } else { result.push(line.trimEnd()); line = ""; }
        if (width(line + part) > columns) { result.push(line); line = ""; }
      }
      line += part;
    }
    result.push(line.trimEnd());
  }
  return result;
}

const pad2 = (value) => String(value).padStart(2, "0");
export function clockTime(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Connection label: live / disconnected HH:MM / source error / waiting / empty.
// AC1.9 requires these to be pairwise distinct strings.
export function connectionLabel(language, connection = {}) {
  const languageCode = languageOf(language);
  switch (connection.kind) {
    case "disconnected": return t(languageCode, "disconnectedAt", { time: clockTime(connection.at) });
    case "source-error": return t(languageCode, "sourceError");
    case "empty": return t(languageCode, "empty");
    case "waiting": return t(languageCode, "waiting");
    default: return t(languageCode, "live");
  }
}

// Footer: follow state plus connection label, and nothing else is required.
// There are no keyboard legend tokens here (AC-F1). Optional notices are appended
// last so a narrow pane truncates a notice before it truncates a required token.
export function footerText(language, { follow = true, connection = {}, notices = [] } = {}) {
  const languageCode = languageOf(language);
  // The two required tokens come first so a narrow pane truncates a notice, never
  // the follow state or the connection state (AC-F1, AC-F3).
  const required = `${t(languageCode, follow ? "followOn" : "followOff")} · ` +
    connectionLabel(languageCode, connection);
  const rest = notices.filter((notice) => typeof notice === "string" && notice !== "");
  return rest.length ? `${required} · ${rest.join(" · ")}` : required;
}

// The generation and the installer language both live in `config.json` at ROOT (stage-05 R4).
// Absent or unreadable values are an empty object, which callers read as `dev` / no choice.
export function configOf(rootUrl, { readFile = readFileSync } = {}) {
  try {
    const value = JSON.parse(readFile(fileURLToPath(new URL("config.json", rootUrl)), "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (cause) {
    // outcome: an absent or unreadable config.json means an uninstalled dev tree.
    return {};
  }
}

// The viewer records the generation of its own ROOT (`dev` when no config.json).
export function generationOf(rootUrl, deps = {}) {
  const generation = configOf(rootUrl, deps).generation;
  return typeof generation === "string" && generation !== "" ? generation : "dev";
}

// R3 / SR9: the one place a viewer failpoint is parsed. The launcher passes
// `--failpoint ready-delay-25s`; the name maps to a delay of the first ready write and the first
// data paint. A name outside the table is a usage error, not a silent no-op.
export const VIEWER_FP_DELAYS_MS = Object.freeze({ "ready-delay-25s": 25000 });
export const VIEWER_FP_FLAG = "--failpoint";
export const isViewerFailpoint = (name) => Object.hasOwn(VIEWER_FP_DELAYS_MS, name);
export const viewerFailpointDelayMs = (name) => (isViewerFailpoint(name) ? VIEWER_FP_DELAYS_MS[name] : 0);

export function readyRecord({ pid, token, paneId, gen = "dev", startedAt, now, closing }) {
  return { pid, token, paneId, gen, startedAt, heartbeatAt: now, ...(closing ? { closing } : {}) };
}

// Heartbeat writer: roles/<role>.ready.json every 5s while the viewer is open.
// `write` is awaited by callers that need the bytes on disk (tests and the fence).
export function createHeartbeat({ path, build, write = defaultWrite, clock = defaultClock,
  intervalMs = 5000, heartbeat = false, onError } = {}) {
  let timer;
  let lastCommit = Promise.resolve();
  async function commit(extra) {
    const record = build(extra);
    await write(path, record);
    return record;
  }
  return {
    write: (extra) => commit(extra),
    start() {
      if (timer !== undefined || !heartbeat) return;
      timer = clock.setInterval(() => {
        lastCommit = commit().then(() => undefined, (cause) => { onError?.(cause); });
      }, intervalMs);
      timer?.unref?.();
    },
    // Returns the in-flight tick write, so a caller that removes the state directory after `stop()`
    // cannot race a heartbeat that had already started (architect LOW-4).
    stop() {
      if (timer !== undefined) { clock.clearInterval(timer); timer = undefined; }
      return lastCommit;
    },
  };
}

function defaultWrite(path, value) {
  return writeJson(path, value);
}

const defaultClock = {
  now: () => Date.now(),
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};

// Slot watcher: fs.watch plus a 1s poll of slot.json (plan 7.3 item 6). A read or
// parse error is reported to onError and is never a retire reason.
export function createSlotWatcher({ slotPath, readFile = readFileSync, watchFn = watch,
  clock = defaultClock, pollMs = 1000, onChange, onError } = {}) {
  let last, closed = false, watcher, timer;
  const read = () => {
    try { return { text: readFile(slotPath, "utf8") }; }
    catch (cause) { return { error: cause }; }
  };
  function observe(force = false) {
    if (closed) return;
    const result = read();
    if (result.error) { onError?.(result.error); return; }
    if (!force && result.text === last) return;
    last = result.text;
    onChange?.(result.text);
  }
  observe(true);
  try {
    watcher = watchFn(dirname(slotPath), (_event, name) => {
      if (name && String(name) !== basename(slotPath)) return;
      observe();
    });
    watcher.on?.("error", (cause) => onError?.(cause));
  } catch (cause) {
    // outcome: without fs.watch the 1s poll below still observes every change.
    onError?.(cause);
  }
  timer = clock.setInterval(() => observe(), pollMs);
  timer?.unref?.();
  return {
    close() {
      closed = true;
      clock.clearInterval(timer);
      watcher?.close?.();
    },
  };
}

// Token fence (plan 7.3 item 6). A validly read slot that no longer carries this
// role, carries a different token, or is marked closed retires the viewer. An
// unreadable or invalid slot keeps the last state and only shows the source error.
export function fenceDecision(slot, { role, token } = {}) {
  if (!slot || typeof slot !== "object") return { retire: false, reason: "invalid-slot" };
  if (slot.schema !== "gjc-herdr-dashboard/slot/1") return { retire: false, reason: "invalid-slot" };
  const roles = slot.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    return { retire: false, reason: "invalid-slot" };
  }
  const record = roles[role];
  if (!record || typeof record !== "object") return { retire: true, reason: "role-missing" };
  if (record.state === "closed") return { retire: true, reason: "closed" };
  if (record.token !== token) return { retire: true, reason: "token-mismatch" };
  return { retire: false, reason: "ok" };
}

// Owner liveness for the footer label (AC1.9). `stoppedAt` means the owner stopped
// cooperatively, so the label flips immediately (well inside the 5s contract). A
// killed owner flips once its heartbeat is at least `killedWithinMs` (two missed 5 s beats) old, which
// keeps kill -> label inside the 20 s contract even with the 1 s repaint, and a
// pid that is still alive keeps the live label no matter how stale its heartbeat is
// — heartbeat age alone is never treated as proof of death (fail-closed). The pane
// always stays open.
export function ownerLiveness(owner, { now, pidAlive = () => true, killedWithinMs = 10000 } = {}) {
  if (!owner || typeof owner !== "object") return "absent";
  if (Number.isFinite(owner.stoppedAt)) return "disconnected";
  if (pidAlive(owner.pid)) return "live";
  const heartbeatAt = Number.isFinite(owner.heartbeatAt) ? owner.heartbeatAt : null;
  if (heartbeatAt === null) return "disconnected";
  return Math.max(0, now - heartbeatAt) >= killedWithinMs ? "disconnected" : "live";
}

// `q`: write closing:'q' first, then close our own pane. The close target is the
// paneId argument and it only fires when HERDR_PANE_ID equals it (plan 7.3 item 6),
// so a viewer can never close a pane it does not own.
export async function closeOwnPane({ paneId, env = process.env, herdr, onClose } = {}) {
  if (!paneId || env.HERDR_PANE_ID !== paneId) return { closed: false, reason: "not-owner" };
  if (typeof herdr !== "function") return { closed: false, reason: "no-herdr" };
  await herdr(["pane", "close", paneId]);
  await onClose?.();
  return { closed: true, reason: "closed" };
}
