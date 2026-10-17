// GJC entry point for the Herdr dashboard (plan §7.1 item 1, stage-05 R6).
//
// The factory body does exactly one thing: hand the host surface and this module's own URL to
// `createInstance`, which registers the handlers. It reads no environment value, starts no timer,
// watches no file, creates no registry entry and spawns no process - a factory runs once per
// session (main and every sub), and every one of those side effects belongs to an ARMED MAIN
// instance only (§7.1 items 2/3, §7.3 note on the dev shim's `??=` ordering).
//
// `import.meta.url` is passed as a value, never imported dynamically (SR5): the instance resolves
// its ROOT (and therefore `locale/`, `src/viewers/`, `config.json`) from it (R4).
//
// Exported signature
//   default function (pi) -> { armed(), dispose(), state() }   // the instance handle (tests only)
import { createInstance } from './src/host/instance.mjs';

export default function (pi) {
  return createInstance(pi, { moduleUrl: import.meta.url });
}
