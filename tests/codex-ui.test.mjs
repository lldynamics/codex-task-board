import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { unavailableCodexSnapshot, codexSnapshotSchema, CODEX_SNAPSHOT_STALE_MS } from "../src/codex-domain.mjs";
import { mountCodex, threadPresentation } from "../src/view-codex.mjs";
import { mountBoard } from "../src/view.mjs";
import { emptyBoard, boardSchema } from "../src/board.mjs";
import { tick } from "./helpers.mjs";

const timestamp = "2030-10-05T04:00:00.000Z";
const id = (number) => `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
const thread = (number = 1, fields = {}) => ({ id: id(number), hostId: "local", title: `任务 ${number}`, cwd: "/project", updatedAt: timestamp, runtimeStatus: "unknown", attention: null, lastTurnStatus: null, goalStatus: null, ...fields });
const automation = (fields = {}) => ({ id: "plan-1", name: "每日检查", status: "ACTIVE", kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", timeZone: "Asia/Shanghai", targetThreadId: null, lastRunAt: null, nextRunAt: null, ...fields });
function snapshot(fields = {}) {
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null };
  return codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(timestamp), connection: { state: "connected", lastSuccessAt: timestamp, error: null, scope: "本机测试来源", source: "desktop-snapshot" }, sources: { threads: source, automations: { ...source } }, completeness: { threads: true, automations: true, truncated: false }, ...fields });
}
const wrap = (value) => ({ structuredContent: { ok: true, snapshot: value } });
function clock() {
  let time = Date.parse(timestamp); let sequence = 0; const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) { const key = ++sequence; timers.set(key, { callback, at: time + delay }); return key; },
    clearTimeout(key) { timers.delete(key); },
    get pending() { return timers.size; },
    async advance(ms) {
      const end = time + ms;
      while (true) { const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; time = next[1].at; timers.delete(next[0]); next[1].callback(); await tick(); }
      time = end; await tick();
    },
  };
}
async function setup(t, options = {}) {
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://board.test/", pretendToBeVisual: true });
  const scheduler = clock();
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountCodex(dom.window.document, { now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout, ...options }));
  t.after(() => { view.dispose(); dom.window.close(); });
  const ctx = { dom, document: dom.window.document, view, clock: scheduler, byId: (value) => dom.window.document.getElementById(value) };
  ctx.input = (name, value) => { ctx.byId(name).value = value; ctx.byId(name).dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  return ctx;
}

test("runtime idle/notLoaded never imply completion; turn end and goal completion have distinct labels", () => {
  for (const runtimeStatus of ["idle", "notLoaded", "unknown"]) { const presentation = threadPresentation(thread(1, { runtimeStatus })); assert.equal(presentation.group, "other"); assert.ok(!presentation.label.includes("已完成")); }
  assert.equal(threadPresentation(thread(1, { lastTurnStatus: "completed" })).label, "本轮结束 · 目标完成情况未知");
  assert.equal(threadPresentation(thread(1, { goalStatus: "complete" })).label, "目标已完成");
  assert.equal(threadPresentation(thread(1, { attention: "approval", runtimeStatus: "active" })).group, "waiting");
  assert.equal(threadPresentation(thread(1, { goalStatus: "blocked" })).group, "waiting");
  assert.equal(threadPresentation(thread(1, { lastTurnStatus: "failed" })).group, "error");
  assert.equal(threadPresentation(thread(1, { runtimeStatus: "active" })).group, "running");
});

test("failure retains aggregate diagnostics; source collection time stays stale despite a fresh cache read", async (t) => {
  const ctx = await setup(t);
  ctx.view.acceptReadResult(wrap(snapshot({ threads: [thread()] })));
  const old = ctx.byId("codex-diagnostic-count").textContent;
  assert.equal(ctx.view.acceptReadResult({ isError: true, structuredContent: { ok: false } }), false);
  assert.equal(ctx.byId("codex-diagnostic-count").textContent, old);
  assert.equal(ctx.document.querySelector("[data-codex-thread]"), null);
  assert.match(ctx.byId("codex-thread-source").textContent, /数据已过期/);
  await ctx.clock.advance(CODEX_SNAPSHOT_STALE_MS + 1);
  ctx.view.acceptReadResult(wrap(snapshot({ observedAt: new Date(ctx.clock.now()).toISOString(), threads: [thread()] })));
  assert.match(ctx.byId("codex-thread-source").textContent, /按已配置的采集频率更新.*数据已过期.*最新采集/);
  assert.doesNotMatch(ctx.byId("codex-thread-source").textContent, /按分钟采集/);
  assert.match(ctx.byId("codex-observed").textContent, /面板最新读取/);
  assert.ok(!ctx.byId("codex-thread-source").textContent.includes("实时来源"));
});

test("independent source failures and historical data are disclosed without claiming no tasks", async (t) => {
  const value = snapshot(); value.sources.threads = { ...value.sources.threads, mode: "archive", state: "partial", complete: false, truncated: true }; value.sources.automations = { ...value.sources.automations, mode: "unavailable", state: "unsupported", lastSuccessAt: null, complete: false };
  const ctx = await setup(t); ctx.view.acceptReadResult(wrap(value));
  assert.match(ctx.byId("codex-thread-source").textContent, /历史记录，不能反映当前运行状态.*部分范围.*已截断/);
  assert.match(ctx.byId("codex-automation-source").textContent, /来源不可用.*不支持读取/);
  assert.match(ctx.byId("codex-diagnostic-count").textContent, /不能据此判断没有/);
  assert.match(ctx.byId("codex-automation-empty").textContent, /尚未确认/);
});

test("automation pagination and focused controls survive snapshots without duplicating task records", async (t) => {
  const ctx = await setup(t); ctx.view.openAutomations();
  const value = snapshot({ threads: Array.from({ length: 61 }, (_, index) => thread(index + 1)), automations: Array.from({ length: 61 }, (_, index) => automation({ id: `plan-${index + 1}` })) }); ctx.view.acceptReadResult(wrap(value));
  assert.equal(ctx.document.querySelectorAll("[data-codex-thread]").length, 0);
  assert.equal(ctx.document.querySelectorAll("[data-codex-automation]").length, 50);
  ctx.byId("codex-automation-more").click(); assert.equal(ctx.document.querySelectorAll("[data-codex-automation]").length, 61);
  const control = ctx.document.querySelector('[data-codex-control="plan:plan-1"]'); control.focus();
  ctx.view.acceptReadResult(wrap({ ...value, observedAt: "2030-10-05T04:00:01.000Z" }));
  assert.equal(ctx.document.activeElement.dataset.codexControl, "plan:plan-1");
  assert.match(ctx.byId("codex-automation-list").textContent, /计划启用.*下次运行：未知.*上次运行：未知/s);
  assert.match(ctx.byId("codex-diagnostic-count").textContent, /已读取 61 项任务/);
  assert.ok(!ctx.byId("codex-diagnostics").textContent.includes("任务 61"));
});

test("minute and hour recurrence intervals are rendered as Chinese frequencies", async (t) => {
  const ctx = await setup(t);
  const rules = [
    ["minute", "FREQ=MINUTELY", "每分钟"],
    ["minutes", "RRULE:FREQ=MINUTELY;INTERVAL=120", "每 120 分钟"],
    ["hour", "FREQ=HOURLY;INTERVAL=1", "每小时"],
    ["hours", "FREQ=HOURLY;INTERVAL=2", "每 2 小时"],
    ["invalid", "FREQ=HOURLY;INTERVAL=0", "已配置计划"],
  ];
  ctx.view.acceptReadResult(wrap(snapshot({ automations: rules.map(([id, rrule]) => automation({ id, rrule })) })));
  for (const [id, , label] of rules) assert.ok(ctx.document.querySelector(`[data-codex-automation="${id}"]`).textContent.includes(label));
});

test("only fully supported recurrence shapes receive a simplified label; constrained rules remain inspectable", async (t) => {
  const ctx = await setup(t);
  const unsupported = [
    ["weekdays", "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"],
    ["count", "FREQ=HOURLY;INTERVAL=2;COUNT=1"],
    ["until", "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;UNTIL=20301231T160000Z"],
    ["month", "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYMONTH=10"],
    ["unknown", "FREQ=MINUTELY;INTERVAL=120;UNRECOGNIZED=1"],
    ["duplicate", "FREQ=HOURLY;INTERVAL=2;INTERVAL=3"],
    ["missing-minute", "FREQ=DAILY;BYHOUR=9"],
    ["unknown-frequency", "FREQ=constructor;INTERVAL=2"],
    ["invalid-day", "FREQ=WEEKLY;BYDAY=constructor;BYHOUR=9;BYMINUTE=0"],
  ];
  const supported = [
    ["daily", "RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0", "每天 09:00"],
    ["weekly", "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=18;BYMINUTE=30", "每周 周一、周五 18:30"],
    ["minutes", "FREQ=MINUTELY;INTERVAL=120", "每 120 分钟"],
    ["hours", "FREQ=HOURLY;INTERVAL=2", "每 2 小时"],
  ];
  ctx.view.acceptReadResult(wrap(snapshot({ automations: [...unsupported, ...supported].map(([id, rrule]) => automation({ id, rrule })) })));
  for (const [id, rrule] of unsupported) {
    const card = ctx.document.querySelector(`[data-codex-automation="${id}"]`);
    assert.match(card.querySelector(".codex-meta").textContent, /规则未解析，请在 Codex 核对/);
    assert.equal(card.querySelector(".codex-rule").textContent, `原始规则：${rrule}`);
  }
  for (const [id, , label] of supported) {
    const card = ctx.document.querySelector(`[data-codex-automation="${id}"]`);
    assert.ok(card.querySelector(".codex-meta").textContent.includes(label)); assert.equal(card.querySelector(".codex-rule"), null);
  }
});

test("healthy partial and truncated snapshots continue polling every five seconds", async (t) => {
  let calls = 0;
  const value = snapshot();
  const error = { code: "SOURCE_PARTIAL", message: "来源返回部分记录" };
  value.connection = { ...value.connection, state: "partial", error };
  value.sources.threads = { ...value.sources.threads, state: "partial", complete: false, truncated: true, error };
  value.completeness = { threads: false, automations: true, truncated: true };
  const ctx = await setup(t, { refresh: async () => { calls += 1; return wrap(value); } });
  ctx.view.setHostState({ connected: true }); ctx.view.setVisible(true); await tick();
  assert.equal(calls, 1); assert.match(ctx.byId("codex-thread-source").textContent, /部分范围.*已截断/);
  for (let expected = 2; expected <= 4; expected += 1) {
    await ctx.clock.advance(4999); assert.equal(calls, expected - 1);
    await ctx.clock.advance(1); assert.equal(calls, expected);
    assert.match(ctx.byId("codex-poll-status").textContent, /每 5 秒读取/);
    assert.ok(!ctx.byId("codex-poll-status").textContent.includes("重试"));
  }
});

test("fresh retained activity survives a brief read failure but becomes unknown after collection expires", async (t) => {
  let fail = false;
  const value = snapshot({ threads: [thread(1, { runtimeStatus: "active", lastTurnStatus: "running" })] });
  const ctx = await setup(t, { refresh: async () => { if (fail) throw new Error("Offline"); return wrap(value); } });
  ctx.view.setHostState({ connected: true }); ctx.view.setVisible(true); await tick();
  assert.match(ctx.byId("codex-diagnostic-count").textContent, /运行中 1/);
  fail = true; await ctx.view.refresh();
  assert.match(ctx.byId("codex-diagnostic-count").textContent, /运行中 1/);
  await ctx.clock.advance(CODEX_SNAPSHOT_STALE_MS + 1); await ctx.view.refresh();
  assert.equal(ctx.document.querySelectorAll("[data-codex-thread]").length, 0);
  assert.match(ctx.byId("codex-diagnostic-count").textContent, /状态未知 1/);
  assert.match(ctx.byId("codex-thread-source").textContent, /数据已过期/);
  assert.equal(value.threads[0].runtimeStatus, "active"); assert.equal(value.threads[0].lastTurnStatus, "running");
});

test("clock and disconnected source clear current attention while preserving completed turn history", async (t) => {
  const ctx = await setup(t); ctx.view.setVisible(true);
  ctx.view.acceptReadResult(wrap(snapshot({ threads: [thread(1, { attention: "approval", runtimeStatus: "active" })] })));
  await ctx.clock.advance(CODEX_SNAPSHOT_STALE_MS + 5000);
  assert.match(ctx.byId("codex-diagnostic-count").textContent, /状态未知 1/);
  const value = snapshot({ observedAt: new Date(ctx.clock.now()).toISOString(), threads: [thread(1, { runtimeStatus: "active", attention: "input", lastTurnStatus: "completed" })] });
  value.sources.threads = { ...value.sources.threads, state: "disconnected", lastSuccessAt: new Date(ctx.clock.now()).toISOString() };
  ctx.view.acceptReadResult(wrap(value));
  assert.match(ctx.byId("codex-diagnostic-count").textContent, /本轮结束 · 目标完成情况未知 1/);
});

test("polling is visible-only and single-flight; pagehide aborts, pageshow resumes, dispose stops", async (t) => {
  let calls = 0; let resolve; let signal;
  const ctx = await setup(t, { refresh: ({ signal: requestSignal }) => { calls += 1; signal = requestSignal; return new Promise((done) => { resolve = done; }); } });
  ctx.view.setHostState({ connected: true }); await ctx.clock.advance(20000); assert.equal(calls, 0);
  ctx.view.setVisible(true); await tick(); const first = ctx.view.refresh(); assert.equal(calls, 1);
  ctx.byId("codex-refresh").click(); assert.equal(calls, 1);
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("pagehide")); assert.equal(signal.aborted, true); assert.equal(await first, false);
  resolve(wrap(snapshot())); await tick(); assert.equal(ctx.document.querySelectorAll("[data-codex-thread]").length, 0);
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("pageshow")); await tick(); assert.equal(calls, 2);
  resolve(wrap(snapshot())); await tick(); await ctx.clock.advance(5000); assert.equal(calls, 3);
  ctx.view.setVisible(false); assert.equal(signal.aborted, true); resolve(wrap(snapshot())); await tick(); await ctx.clock.advance(60000); assert.equal(calls, 3);
  ctx.view.setVisible(true); await tick(); assert.equal(calls, 4); ctx.view.dispose(); assert.equal(signal.aborted, true); resolve(wrap(snapshot())); await tick(); await ctx.clock.advance(60000); assert.equal(calls, 4); assert.equal(ctx.clock.pending, 0);
});

test("timeout aborts without concurrent replacement; failed reads back off", async (t) => {
  let calls = 0; let resolve; let signal;
  const ctx = await setup(t, { refresh: ({ signal: value }) => { calls += 1; signal = value; return calls === 1 ? new Promise((done) => { resolve = done; }) : Promise.reject(new Error("Offline")); } });
  ctx.view.setHostState({ connected: true }); ctx.view.setVisible(true); await tick();
  await ctx.clock.advance(10000); assert.equal(signal.aborted, true); assert.match(ctx.byId("codex-read-error").textContent, /超时/);
  await ctx.view.refresh(); await ctx.clock.advance(60000); assert.equal(calls, 1, "ignored abort must not start concurrent requests");
  resolve(wrap(snapshot())); await tick(); await ctx.clock.advance(9999); assert.equal(calls, 1); await ctx.clock.advance(1); assert.equal(calls, 2);
  await ctx.clock.advance(19999); assert.equal(calls, 2); await ctx.clock.advance(1); assert.equal(calls, 3);
});

test("hidden page aborts and resumes on visibilitychange", async (t) => {
  let hidden = false; let calls = 0;
  const ctx = await setup(t, { refresh: async () => { calls += 1; return wrap(snapshot()); } });
  Object.defineProperty(ctx.document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
  ctx.view.setHostState({ connected: true }); ctx.view.setVisible(true); await tick(); assert.equal(calls, 1);
  hidden = true; ctx.document.dispatchEvent(new ctx.dom.window.Event("visibilitychange")); await ctx.clock.advance(60000); assert.equal(calls, 1);
  hidden = false; ctx.document.dispatchEvent(new ctx.dom.window.Event("visibilitychange")); await tick(); assert.equal(calls, 2);
});

test("switching surfaces retains a manual draft and saving still uses the manual mutation callback", async (t) => {
  const ctx = await setup(t); const initial = boardSchema.parse({ ...emptyBoard(), revision: 1, projects: [{ id: id(90), name: "手工项目", description: "", lastUpdatedAt: timestamp }] }); let saves = 0;
  const board = (createI18n(ctx.document, { locale: "zh" }), mountBoard(ctx.document, emptyBoard(), { mutate: async (request) => { saves += 1; const record = { ...request.operation.task, id: id(91), lastUpdatedAt: timestamp }; return { structuredContent: { ok: true, board: boardSchema.parse({ ...initial, revision: 2, tasks: [record] }), entityId: record.id, appliedRevision: 2, replayed: false } }; } }));
  t.after(() => board.dispose()); board.setHostState({ connected: true, message: "测试" }); board.acceptReadResult({ structuredContent: { ok: true, board: initial } }); ctx.byId("new-task").click(); ctx.input("task-title", "未保存的手工草稿");
  const field = ctx.byId("task-title"); ctx.byId("codex-tab").click(); assert.equal(ctx.byId("manual-board").hidden, false); assert.equal(ctx.byId("task-surface").hidden, true);
  ctx.byId("codex-back-to-board").dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ctx.byId("manual-tab").click(); assert.equal(ctx.byId("task-title"), field); assert.equal(field.value, "未保存的手工草稿"); assert.equal(ctx.byId("task-form").hidden, false);
  ctx.byId("task-form").querySelector('[type="submit"]').click(); await tick(); assert.equal(saves, 1); assert.match(ctx.byId("cards").textContent, /未保存的手工草稿/);
});

test("plan actions copy requests without sending or changing source state", async (t) => {
  const requests = []; const copies = [];
  const ctx = await setup(t, { requestAutomation: async (text) => { requests.push(text); } });
  Object.defineProperty(ctx.dom.window.navigator, "clipboard", { value: { writeText: async (text) => copies.push(text) } });
  ctx.view.openAutomations(); ctx.view.acceptReadResult(wrap(snapshot({ automations: [automation()] })));
  assert.equal(ctx.byId("codex-automation-form"), null);
  assert.equal(ctx.byId("codex-action-send"), null);
  ctx.document.querySelector('[data-codex-automation] button').click(); await tick();
  assert.equal(requests.length, 0); assert.equal(copies.length, 1);
  assert.match(copies[0], /暂停.*计划 ID：plan-1/s);
  assert.match(ctx.byId("codex-copy-status").textContent, /请求已复制/);
  assert.equal(ctx.byId("codex-request-fallback").hidden, true);
  assert.match(ctx.byId("codex-automation-list").textContent, /计划启用/);
  ctx.view.acceptReadResult(wrap(snapshot({ automations: [automation({ status: "PAUSED" })] })));
  ctx.document.querySelector('[data-codex-automation] button').click(); await tick();
  assert.match(copies[1], /恢复.*计划 ID：plan-1/s); assert.equal(requests.length, 0);
});

test("clipboard failure keeps a selected request through subsequent snapshots", async (t) => {
  const ctx = await setup(t); ctx.view.openAutomations();
  ctx.view.acceptReadResult(wrap(snapshot({ automations: [automation()] })));
  ctx.document.querySelector('[data-codex-automation] button').click(); await tick();
  const field = ctx.byId("codex-request-text");
  assert.equal(ctx.byId("codex-request-fallback").hidden, false);
  assert.equal(ctx.document.activeElement, field);
  assert.equal(field.selectionStart, 0); assert.equal(field.selectionEnd, field.value.length);
  assert.match(ctx.byId("codex-copy-status").textContent, /手动复制/);
  ctx.view.acceptReadResult(wrap(snapshot({ observedAt: "2030-10-05T04:00:01.000Z", automations: [automation()] })));
  assert.match(field.value, /计划 ID：plan-1/); assert.equal(ctx.document.activeElement, field);
});

test("untrusted automation text stays literal and diagnostic view contains no duplicate thread title or raw ID", async (t) => {
  const ctx = await setup(t); ctx.view.openAutomations();
  ctx.view.acceptReadResult(wrap(snapshot({ threads: [thread(1, { title: '<img src=x onerror="alert(1)">', cwd: '<script>alert(1)</script>' }), thread(2, { id: "javascript:alert(1)" })], automations: [automation({ name: "<svg onload=alert(1)>" })] })));
  assert.equal(ctx.byId("codex-panel").querySelectorAll("img,script,svg").length, 0); assert.match(ctx.byId("codex-automation-list").textContent, /<svg onload/);
  assert.ok(!ctx.byId("codex-diagnostics").textContent.includes("<img src=x")); assert.ok(!ctx.byId("codex-diagnostics").textContent.includes("javascript:alert(1)"));
  assert.equal(ctx.document.querySelectorAll("[data-codex-thread]").length, 0);
  ctx.document.querySelector("[data-codex-automation] button").click(); await tick();
  assert.equal(ctx.byId("codex-panel").querySelectorAll("img,script,svg").length, 0);
});
