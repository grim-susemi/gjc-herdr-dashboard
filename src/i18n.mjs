// Locale catalogue for the GJC Herdr dashboard viewers.
//
// Strings live in `locale/<lang>.json` and are resolved against a ROOT URL so a
// dev tree and a `generation-NNNNNN/` tree load the same relative layout (plan
// stage-05 R4: `i18n` receives the locale URL as an argument). Nothing here
// uses a dynamic import (SR5); the JSON is read with node:fs and cached.
//
// Language policy: the default is `ko`. An unsupported value falls back to `ko`
// and `decision()` reports the offending value so the caller can show a one-time
// footer notice (AC-F2).
//
// Exported signatures
//   LANGUAGES: readonly string[]                       // ['ko','en','zh-cn']
//   DEFAULT_LANGUAGE: 'ko'
//   ROOT_URL: URL                                     // two levels above src/i18n.mjs
//   isLanguage(value): boolean
//   languageOf(value): string                         // unsupported -> DEFAULT_LANGUAGE
//   localeUrl(rootUrl, language): URL
//   createI18n(rootUrl?, deps?): { rootUrl, url, messages, has, t, decision }
//   i18n: object                                      // createI18n() bound to ROOT_URL
//   t(language, key, values?): string                 // throws on an unknown key
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LANGUAGES = Object.freeze(["ko", "en", "zh-cn"]);
export const DEFAULT_LANGUAGE = "ko";
export const ROOT_URL = new URL("../", import.meta.url);

export const isLanguage = (value) => typeof value === "string" && LANGUAGES.includes(value);
export const languageOf = (value) => (isLanguage(value) ? value : DEFAULT_LANGUAGE);
export const localeUrl = (rootUrl, language) => new URL(`locale/${language}.json`, rootUrl);

export function createI18n(rootUrl = ROOT_URL, { readFile = readFileSync, cache = new Map() } = {}) {
  function messages(language) {
    const selected = languageOf(language);
    const url = localeUrl(rootUrl, selected);
    const key = url.href;
    const cached = cache.get(key);
    if (cached) return cached;
    const text = readFile(fileURLToPath(url), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new TypeError(`Locale ${selected} is not valid JSON: ${cause.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(`Locale ${selected} must be a JSON object of strings`);
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || value === "") {
        throw new TypeError(`Locale ${selected} entry ${name} must be a non-empty string`);
      }
    }
    cache.set(key, parsed);
    return parsed;
  }

  function has(language, key) {
    return Object.hasOwn(messages(language), key);
  }

  function t(language, key, values = {}) {
    const table = messages(language);
    if (!Object.hasOwn(table, key)) throw new Error(`Unknown translation key: ${key}`);
    return table[key].replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match);
  }

  function decision(value) {
    if (isLanguage(value)) return { language: value, invalidValue: null };
    const invalidValue = typeof value === "string" && value.trim() !== "" ? value : null;
    return { language: DEFAULT_LANGUAGE, invalidValue };
  }

  return { rootUrl, url: (language) => localeUrl(rootUrl, language), messages, has, t, decision };
}

export const i18n = createI18n();
export const t = i18n.t;
