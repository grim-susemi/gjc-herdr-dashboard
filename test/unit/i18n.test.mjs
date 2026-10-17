// Locale catalogue tests for the GJC Herdr dashboard viewers.
//
// Adapted from omo-herdr-dashboard @4082c750 `packages/dag/test/i18n.test.mjs`
// (the todo package has no i18n test of its own). Kept: catalogue key/shape parity
// across the three languages and interpolation-parameter parity. Changed with the
// product: the default language is ko, and the catalogue is JSON read from a ROOT
// URL rather than an inline object.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_LANGUAGE, LANGUAGES, ROOT_URL, createI18n, isLanguage, languageOf, localeUrl, t }
  from "../../src/i18n.mjs";
import { footerText } from "../../src/viewers/common.mjs";

test("the default language is ko and unsupported values are reported, not thrown", () => {
  assert.equal(DEFAULT_LANGUAGE, "ko");
  assert.deepEqual([...LANGUAGES].sort(), ["en", "ko", "zh-cn"]);
  for (const value of ["ko", "en", "zh-cn"]) {
    assert.equal(languageOf(value), value);
    assert.equal(isLanguage(value), true);
  }
  // A missing, empty, mistyped or unknown value falls back to ko.
  for (const value of [undefined, null, "", "  ", "de", "KO", "zh", 7, {}, ["ko"]]) {
    assert.equal(languageOf(value), "ko", JSON.stringify(value));
    assert.equal(isLanguage(value), false);
  }
  const i18n = createI18n(ROOT_URL);
  assert.deepEqual(i18n.decision(undefined), { language: "ko", invalidValue: null });
  assert.deepEqual(i18n.decision("en"), { language: "en", invalidValue: null });
  assert.deepEqual(i18n.decision("de"), { language: "ko", invalidValue: "de" });
  // An empty value is not worth a footer notice.
  assert.deepEqual(i18n.decision(""), { language: "ko", invalidValue: null });
});

test("locale files resolve against a ROOT URL, one directory above the module", () => {
  assert.ok(fileURLToPath(ROOT_URL).replaceAll("\\", "/").endsWith("/gjc-herdr-dashboard/"));
  assert.ok(fileURLToPath(localeUrl(ROOT_URL, "ko")).endsWith(join("locale", "ko.json")));
  const i18n = createI18n(ROOT_URL);
  assert.equal(i18n.messages("ko").todo, "Todo");
  assert.equal(i18n.messages("en").followOn, "Follow ON");
  assert.equal(i18n.messages("zh-cn").followOn, "自动跟随 ON");
  // An unsupported language resolves to the ko catalogue rather than failing.
  assert.equal(i18n.messages("nope"), i18n.messages("ko"));
  assert.equal(i18n.has("ko", "followOn"), true);
  assert.equal(i18n.has("ko", "missing-key"), false);
  assert.throws(() => t("ko", "missing-key"), /Unknown translation key: missing-key/);
});

test("every language covers the same keys and the same interpolation parameters", () => {
  const i18n = createI18n(ROOT_URL);
  const reference = Object.keys(i18n.messages("ko")).sort();
  for (const language of LANGUAGES) {
    assert.deepEqual(Object.keys(i18n.messages(language)).sort(), reference, language);
    for (const key of reference) {
      const expected = i18n.messages("ko")[key].match(/\{\w+\}/g)?.sort() ?? [];
      assert.deepEqual(i18n.messages(language)[key].match(/\{\w+\}/g)?.sort() ?? [], expected,
        `${language}.${key}`);
    }
  }
  assert.equal(t("ko", "readError", { error: "EACCES" }), "읽기 오류: EACCES");
  assert.equal(t("en", "readError", { error: "EACCES" }), "Read error: EACCES");
  assert.equal(t("zh-cn", "invalidLanguage", { value: "de" }), "语言值无效，改用韩语显示: de");
  // An unknown placeholder is left untouched rather than replaced by undefined.
  assert.equal(t("en", "readError", { nope: 1 }), "Read error: {error}");
  // A supplied value of any JSON type is stringified, never dropped.
  assert.equal(t("en", "readError", { error: 0 }), "Read error: 0");
});

test("a corrupt or malformed catalogue fails loudly instead of rendering blanks", () => {
  const dir = mkdtempSync(join(tmpdir(), "gjc-i18n-"));
  mkdirSync(join(dir, "locale"));
  for (const [language, text] of [["ko", "{"], ["en", "[]"], ["zh-cn", '{"todo":""}'],
    ["en-extra", '{"todo":"x"}']]) {
    writeFileSync(join(dir, "locale", `${language}.json`), text);
  }
  const i18n = createI18n(new URL(`file:///${dir.replaceAll("\\", "/")}/`));
  assert.throws(() => i18n.messages("ko"), /not valid JSON/);
  assert.throws(() => i18n.messages("en"), /must be a JSON object/);
  assert.throws(() => i18n.messages("zh-cn"), /must be a non-empty string/);
  // An unsupported language falls back to ko, so it reports the ko failure.
  assert.throws(() => i18n.messages("de"), /not valid JSON/);
  rmSync(dir, { recursive: true, force: true });
});

test("each catalogue is read once and shared by every caller", () => {
  const seen = [];
  const i18n = createI18n(ROOT_URL, { readFile: (path) => {
    seen.push(path);
    return JSON.stringify({ todo: `Todo ${seen.length}` });
  } });
  const first = i18n.messages("ko");
  assert.equal(i18n.messages("ko"), first, "the same object is reused");
  i18n.messages("ko"); i18n.messages("ko");
  assert.equal(i18n.messages("KOREA"), first, "an invalid value reuses the ko catalogue");
  i18n.messages("en");
  assert.equal(seen.length, 2, JSON.stringify(seen));
  assert.equal(i18n.messages("en").todo, "Todo 2");
});

test("the footer is a content assertion: follow plus connection in three languages", () => {
  const rows = [
    ["ko", "자동 추적 ON", "자동 추적 OFF", "실시간", "연결 대기", "연결 끊김 09:05", "원천 오류"],
    ["en", "Follow ON", "Follow OFF", "Live", "Waiting", "Disconnected 09:05", "Source error"],
    ["zh-cn", "自动跟随 ON", "自动跟随 OFF", "实时", "等待中", "连接断开 09:05", "来源错误"],
  ];
  for (const [language, on, off, live, waiting, disconnected, failure] of rows) {
    for (const follow of [true, false]) {
      const footer = footerText(language, { follow, connection: { kind: "live" } });
      assert.ok(footer.includes(follow ? on : off), `${language} follow=${follow}`);
      assert.ok(footer.includes(live), `${language} live`);
      assert.ok(footer.startsWith(follow ? on : off), "follow is the first token");
    }
    assert.ok(footerText(language, { connection: { kind: "waiting" } }).includes(waiting));
    assert.ok(footerText(language, { connection: { kind: "disconnected",
      at: new Date(2026, 0, 1, 9, 5).getTime() } }).includes(disconnected));
    assert.ok(footerText(language, { connection: { kind: "source-error" } }).includes(failure));
  }
  // Required tokens precede any notice so a narrow pane truncates a notice first.
  const noticed = footerText("ko", { connection: { kind: "live" }, notices: ["A".repeat(200)] });
  assert.ok(noticed.indexOf("자동 추적 ON") < noticed.indexOf("AAAA"));
  assert.ok(noticed.indexOf("실시간") < noticed.indexOf("AAAA"));
});
