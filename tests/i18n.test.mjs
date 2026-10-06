import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { spawnSync } from "node:child_process";
import { CATALOGS, LOCALE_PREFERENCE_KEY, createI18n, i18nFor, normalizeLocale, msg } from "../src/i18n.mjs";

function fixture(html = "<p id='label'></p>", options = {}) {
  const dom = new JSDOM(`<!doctype html><html lang="zh-CN"><body>${html}</body></html>`, { url: "https://board.test" });
  const document = dom.window.document;
  return { dom, document, byId: (id) => document.getElementById(id), i18n: createI18n(document, { locale: "zh", ...options }) };
}

test("every key is registered in English and both languages use the same placeholder names", () => {
  // Chinese source strings are their own keys; zh.mjs lists only differing text.
  for (const key of Object.keys(CATALOGS.zh)) assert.ok(Object.hasOwn(CATALOGS.en, key), key);
  for (const [key, value] of Object.entries(CATALOGS.zh)) assert.notEqual(value, key, `Redundant Chinese entry: ${key}`);
  const parameters = (value) => [...new Set(value.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g) || [])].sort();
  for (const key of Object.keys(CATALOGS.en)) {
    assert.deepEqual(parameters(CATALOGS.en[key]), parameters(CATALOGS.zh[key] ?? key), key);
    if (key !== "中文") assert.doesNotMatch(CATALOGS.en[key], /\p{Script=Han}/u, key);
  }
});

test("English navigator language initializes a document; saved preference and explicit locale override it", () => {
  const english = fixture("", { locale: undefined, navigatorLanguage: "en-GB" });
  assert.equal(english.i18n.locale, "en");
  assert.equal(english.document.documentElement.lang, "en-US");
  const storage = { getItem: (key) => key === LOCALE_PREFERENCE_KEY ? "zh" : "en", setItem() {} };
  assert.equal(fixture("", { locale: undefined, navigatorLanguage: "en", storage }).i18n.locale, "zh");
  assert.equal(fixture("", { locale: "en", navigatorLanguage: "zh", storage }).i18n.locale, "en");
  assert.equal(fixture("", { locale: undefined, navigatorLanguage: "fr", storage: null }).i18n.locale, "en");
  assert.equal(normalizeLocale(" EN_us "), "en");
  assert.equal(normalizeLocale("fr-FR"), null);
});

test("locale preference is independent of existing view preferences", () => {
  const { dom, i18n } = fixture();
  const key = "learning-board:view-preferences:v1";
  const value = JSON.stringify({ viewMode: "week", timeZone: "America/New_York", collapsed: ["completed"] });
  dom.window.localStorage.setItem(key, value);
  i18n.setLocale("en");
  assert.equal(dom.window.localStorage.getItem(LOCALE_PREFERENCE_KEY), "en");
  assert.equal(dom.window.localStorage.getItem(key), value);
});

test("denied browser storage still allows immediate in-memory language switching", () => {
  const denied = { getItem() { throw new Error("Denied"); }, setItem() { throw new Error("Denied"); } };
  const { byId, i18n } = fixture(undefined, { storage: denied });
  i18n.bindText(byId("label"), "任务看板");
  assert.equal(i18n.setLocale("en"), true);
  assert.equal(byId("label").textContent, "Task Board");
  assert.equal(i18n.setLocale("zh"), true);
  assert.equal(byId("label").textContent, "任务看板");
});

test("text parameters are injected as text without translating user content or interpreting markup", () => {
  const { byId, i18n } = fixture();
  const userTitle = "计划中 <img src=x onerror=alert(1)> {count}";
  i18n.bindText(byId("label"), "打开任务：{title}", { title: userTitle });
  i18n.bindAttr(byId("label"), "aria-label", "打开任务：{title}", { title: userTitle });
  i18n.setLocale("en");
  assert.equal(byId("label").textContent, `Open task: ${userTitle}`);
  assert.equal(byId("label").getAttribute("aria-label"), `Open task: ${userTitle}`);
  assert.equal(byId("label").querySelector("img"), null);
});

test("explicit nested system parameters retranslate while raw user parameters stay unchanged", () => {
  const { byId, i18n } = fixture();
  const title = "已完成 用户标题";
  i18n.setText(byId("label"), msg("{p1}：{p2}已保存为{p3}。", { p1: title, p2: msg("状态"), p3: msg("已完成") }));
  i18n.setLocale("en");
  assert.equal(byId("label").textContent, `${title}: Status saved as Completed.`);
  i18n.setText(byId("label"), "已完成 用户新标题");
  i18n.setLocale("zh");
  assert.equal(byId("label").textContent, "已完成 用户新标题");
});

test("language switching preserves controls, selection, focus, icons, node identity, and a pending receipt", () => {
  const { document, byId, i18n } = fixture("<button id='save'><svg id='icon'></svg><span id='label'></span><span id='count'>3</span></button><input id='input' value='user draft'><textarea id='draft'>待处理 用户内容</textarea><select id='status'><option value='planned'>计划中</option><option value='completed'>已完成</option></select><input id='checked' type='checkbox' checked>");
  const pending = { requestId: "original-request", expectedRevision: 8, operation: { type: "save_task", task: { title: "计划中" } }, uncertain: true };
  const before = structuredClone(pending);
  const input = byId("input"); input.value = "unsaved text"; input.focus(); input.setSelectionRange(2, 7, "backward");
  byId("status").value = "completed";
  i18n.bindText(byId("label"), "正在确认上次保存结果…");
  i18n.bindText(byId("status").options[0], "计划中");
  i18n.bindText(byId("status").options[1], "已完成");
  i18n.bindAttr(input, "placeholder", "任务名称");
  const nodes = [...document.body.querySelectorAll("*")];
  i18n.setLocale("en");
  assert.equal(byId("label").textContent, "Confirming the previous save…");
  assert.equal(input.value, "unsaved text");
  assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 7); assert.equal(input.selectionDirection, "backward");
  assert.equal(document.activeElement, input);
  assert.equal(byId("draft").value, "待处理 用户内容");
  assert.equal(byId("status").value, "completed"); assert.equal(byId("checked").checked, true);
  assert.deepEqual([...document.body.querySelectorAll("*")], nodes);
  assert.equal(byId("count").textContent, "3"); assert.ok(byId("icon"));
  assert.deepEqual(pending, before);
  assert.throws(() => i18n.bindText(byId("save"), "保存"), /text leaf/);
  for (const name of ["value", "href", "onclick", "data-task-id"]) assert.throws(() => i18n.bindAttr(input, name, "保存"), /display attributes/);
  assert.throws(() => i18n.bindText(input, "保存"), /control values/);
});

test("each document has an independent locale and binding context", () => {
  const first = fixture(); const second = fixture();
  first.i18n.bindText(first.byId("label"), "任务看板");
  second.i18n.bindText(second.byId("label"), "任务看板");
  assert.equal(createI18n(first.document), first.i18n);
  assert.equal(i18nFor(first.document), first.i18n);
  assert.throws(() => first.i18n.bindText(second.byId("label"), "任务看板"), /this document/);
  first.i18n.setLocale("en");
  assert.equal(first.byId("label").textContent, "Task Board");
  assert.equal(second.byId("label").textContent, "任务看板");
  assert.equal(second.i18n.locale, "zh");
});

test("rebinding and userText replace old system bindings; removed nodes are released", () => {
  const { document, byId, i18n } = fixture("<p id='label'></p><p id='user'></p><p id='gone'></p>");
  i18n.bindText(byId("label"), "任务看板");
  i18n.bindText(byId("label"), "保存");
  i18n.bindText(byId("user"), "未填写");
  i18n.userText(byId("user"), "未填写 用户标题");
  const removed = byId("gone"); i18n.bindText(removed, "任务看板"); removed.remove();
  i18n.setLocale("en");
  assert.equal(byId("label").textContent, "Save");
  assert.equal(byId("user").textContent, "未填写 用户标题");
  assert.equal(removed.textContent, "任务看板");
  document.body.append(removed); i18n.setLocale("zh"); i18n.setLocale("en");
  assert.equal(removed.textContent, "任务看板");
});

test("format bindings localize dates and relative time without changing machine date fields", () => {
  const { byId, i18n } = fixture("<p id='date'></p><p id='relative'></p><input id='raw' type='date' value='2026-10-06'>");
  const instant = "2026-10-06T00:00:00.000Z";
  const settings = { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" };
  i18n.bindFormatText(byId("date"), (language) => language.date(instant, settings));
  i18n.bindFormatText(byId("relative"), (language) => language.relative(-2, "hour"));
  assert.match(byId("date").textContent, /10月/);
  i18n.setLocale("en");
  assert.equal(byId("date").textContent, "October 6, 2026");
  assert.equal(byId("relative").textContent, "2 hours ago");
  assert.equal(byId("raw").value, "2026-10-06");
});

test("explicit text nodes preserve surrounding icons and binding disposal stops updates", () => {
  const { document, byId, i18n } = fixture("<button id='save'><svg></svg>保存<span>4</span></button>");
  const leaf = [...byId("save").childNodes].find((node) => node.nodeType === 3);
  const stop = i18n.bindText(leaf, "保存");
  i18n.setLocale("en"); assert.equal(leaf.data, "Save");
  assert.equal(byId("save").children.length, 2);
  stop(); i18n.setLocale("zh"); assert.equal(leaf.data, "Save");
  i18n.dispose(); assert.equal(i18n.setLocale("en"), false);
  assert.notEqual(createI18n(document, { locale: "zh" }), i18n);
});

test("English count forms apply to registered templates without changing user parameters", () => {
  const { i18n } = fixture("", { locale: "en" });
  for (const count of [0, 1, 2]) {
    assert.equal(i18n.t("{p1} 个项目", { p1: count }), `${count} ${count === 1 ? "project" : "projects"}`);
    assert.equal(i18n.t("{p1} 分钟", { p1: count }), `${count} ${count === 1 ? "minute" : "minutes"}`);
    assert.equal(i18n.t("{p1} · {p2} 个时段", { p1: "tasks 用户标题", p2: count }), `tasks 用户标题 · ${count} ${count === 1 ? "session" : "sessions"}`);
  }
});

test("fixed-locale repeated rendering releases detached payloads and cycles without a language switch", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { JSDOM } from "jsdom";
    import { createI18n } from "./src/i18n.mjs";
    const dom = new JSDOM("<body></body>", { url: "https://gc.test" });
    const document = dom.window.document;
    const i18n = createI18n(document, { locale: "zh" });
    const payloads = [];
    function render(index, cycle) {
      const node = document.createElement("span");
      const payload = { index, bytes: new Array(128).fill(index) };
      if (cycle) payload.node = node;
      payloads.push(new WeakRef(payload));
      i18n.bindFormatText(node, () => String(payload.index));
      document.body.replaceChildren(node);
    }
    for (let index = 0; index < 1000; index++) render(index, false);
    for (let index = 0; index < 100; index++) render(index, true);
    const connected = document.createElement("p");
    i18n.bindText(connected, "任务看板");
    document.body.replaceChildren(connected);
    for (let index = 0; index < 12; index++) {
      await new Promise((resolve) => setImmediate(resolve));
      globalThis.gc();
    }
    assert.equal(payloads.filter((value) => value.deref()).length, 0);
    i18n.setLocale("en");
    assert.equal(connected.textContent, "Task Board");
    dom.window.close();
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || String(result.error || ""));
});
