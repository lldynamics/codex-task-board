import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createFileStore } from "../src/store.mjs";
import { emptyBoard } from "../src/board.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { validTimeZone } from "../src/view-schedule.mjs";
import { tick } from "./helpers.mjs";
async function settle(ctx) {
  const deadline = Date.now() + 5000;
  while (ctx.byId("session-form").getAttribute("aria-busy") === "true" && Date.now() < deadline) { await tick(); await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.equal(ctx.byId("session-form").getAttribute("aria-busy"), "false", "Mutation must finish before checking its confirmed outcome");
}
const wrap = (value) => ({ content: [], ...(value.ok ? {} : { isError: true }), structuredContent: value });

function installCalendarClock(window, initial) {
  let current = Date.parse(initial); let sequence = 0; let visibility = "visible";
  const timers = new Map();
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(window.document, "hidden", { configurable: true, get: () => visibility !== "visible" });
  window.setTimeout = (callback, delay = 0, ...args) => {
    const id = ++sequence; timers.set(id, { due: current + Number(delay), callback: () => callback(...args) }); return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  function next() { return [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0]; }
  return {
    now: () => current,
    pending: () => timers.size,
    jumpTo(value) { current = Date.parse(value); },
    runNext() { const entry = next(); assert.ok(entry, "A real scheduled timer is required"); current = Math.max(current, entry[1].due); timers.delete(entry[0]); entry[1].callback(); },
    advance(milliseconds) {
      const target = current + milliseconds;
      for (let entry = next(); entry && entry[1].due <= target; entry = next()) {
        current = Math.max(current, entry[1].due); timers.delete(entry[0]); entry[1].callback();
      }
      current = target;
    },
    visibility(value) { visibility = value; window.document.dispatchEvent(new window.Event("visibilitychange")); },
  };
}

async function setup(t, { mutate, now = "2030-10-05T00:00:00.000Z", width = 1024, clock = false, preferredTimeZone } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-calendar-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  const read = async () => { const result = await store.read(); assert.equal(result.ok, true); return result.board; };
  const commit = async (operation) => { const result = await store.mutate({ requestId: randomUUID(), expectedRevision: (await read()).revision, operation }); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const project = await commit({ type: "save_project", project: { name: "学习", description: "测试目标" } });
  const task = await commit({ type: "save_task", task: { projectId: project.entityId, title: "阅读与练习", status: "planned", priority: "high", dueDate: "2030-10-30", sourceTool: "Codex", currentStep: "阅读一章", blocker: "", conversationUrl: null } });
  const ids = [];
  for (const [startAt, endAt] of [["2030-10-05T01:00:00Z", "2030-10-05T02:00:00Z"], ["2030-10-05T03:00:00Z", "2030-10-05T03:30:00Z"], ["2030-10-06T01:00:00Z", "2030-10-06T02:00:00Z"]]) {
    const session = await commit({ type: "save_session", session: { taskId: task.entityId, startAt, endAt, timeZone: "Asia/Shanghai", objective: "掌握本章", completionCriteria: "完成 5 题" } }); ids.push(session.entityId);
  }
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://schedule-ui.invalid/" });
  t.after(() => dom.window.close());
  if (preferredTimeZone) dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "today", timeZone: preferredTimeZone }));
  Object.defineProperty(dom.window, "innerWidth", { value: width, configurable: true });
  const calendarClock = clock ? installCalendarClock(dom.window, typeof now === "function" ? now() : now) : null;
  const calls = []; let refreshCalls = 0;
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), { now: () => calendarClock ? calendarClock.now() : typeof now === "function" ? now() : now, mutate: async (request) => { calls.push(structuredClone(request)); return mutate ? mutate(request, perform, calls.length) : perform(request); }, refresh: async () => { refreshCalls += 1; return wrap(await store.read()); }, data: async (request) => wrap(await store.data(request)) }));
  t.after(() => view.dispose?.());
  view.setHostState({ connected: true, message: "测试宿主" }); view.acceptReadResult(wrap(await store.read()));
  const byId = (id) => dom.window.document.getElementById(id);
  const session = (id = ids[0]) => dom.window.document.querySelector(`[data-session-id="${id}"]`);
  const change = (id, value) => { byId(id).value = value; byId(id).dispatchEvent(new dom.window.Event(byId(id).matches("select") || id === "display-time-zone" ? "change" : "input", { bubbles: true })); };
  const submit = async () => { byId("session-submit").click(); await settle({ byId }); };
  return { dom, document: dom.window.document, store, view, byId, session, change, submit, calls, ids, read, commit, taskId: task.entityId, clock: calendarClock, refreshCalls: () => refreshCalls };
}

function futureForm(ctx) {
  ctx.byId("new-session").click();
  for (const [id, value] of [["session-date", "2030-10-07"], ["session-end-date", "2030-10-07"], ["session-start", "09:00"], ["session-end", "09:45"], ["session-objective", "不存入偏好的目标"], ["session-criteria", "独立回归标准"]]) ctx.change(id, value);
}

test("calendar today shows multiple sessions for one task, Monday week navigation and explicit display-zone dates", async (t) => {
  const ctx = await setup(t);
  const zones = ctx.byId("display-time-zone");
  assert.equal(zones.tagName, "SELECT");
  assert.equal(zones.getAttribute("aria-label"), "日历显示时区");
  assert.match([...zones.options].find((option) => option.value === "Asia/Shanghai").textContent, /中国 · 上海/);
  ctx.byId("view-today").click();
  assert.equal(ctx.document.querySelectorAll("[data-session-id]").length, 2);
  assert.match(ctx.byId("calendar-summary").textContent, /总计划 90 分钟/);
  assert.match(ctx.session().textContent, /09:00–10:00.*掌握本章.*完成 5 题/s);
  ctx.byId("view-week").click();
  assert.deepEqual([...ctx.document.querySelectorAll("[data-calendar-date]")].map((node) => node.dataset.calendarDate), ["2030-09-30", "2030-10-01", "2030-10-02", "2030-10-03", "2030-10-04", "2030-10-05", "2030-10-06"]);
  assert.equal(ctx.document.querySelectorAll("[data-session-id]").length, 3);
  ctx.byId("week-next").click(); assert.match(ctx.byId("calendar-range").textContent, /^2030-10-07/);
  ctx.byId("week-previous").click(); ctx.byId("week-today").click(); assert.match(ctx.byId("calendar-range").textContent, /^2030-09-30/);
  ctx.byId("view-today").click(); ctx.change("display-time-zone", "America/New_York");
  assert.match(ctx.byId("calendar-range").textContent, /2030-10-04/);
  assert.equal(ctx.document.querySelectorAll("[data-session-id]").length, 2);
  assert.match(ctx.session().textContent, /21:00–22:00/);
  ctx.change("display-time-zone", "+08:00"); assert.equal(ctx.byId("display-time-zone").value, "America/New_York"); assert.match(ctx.byId("data-error").textContent, /时区无效/);
  const preference = JSON.parse(ctx.dom.window.localStorage.getItem("learning-board:view-preferences:v1"));
  assert.equal(preference.timeZone, "America/New_York"); assert.equal(preference.viewMode, "today"); assert.equal(Object.hasOwn(preference, "sessions"), false);
  assert.equal(validTimeZone(""), false); assert.equal(validTimeZone(" Asia/Shanghai"), false); assert.equal(validTimeZone("+08:00"), false);
});

test("display-zone dropdown retains a saved IANA alias and leaves the session editor and saved instants intact", async (t) => {
  const ctx = await setup(t, { preferredTimeZone: "US/Pacific" });
  const before = await ctx.read();
  const zones = ctx.byId("display-time-zone");
  assert.equal(zones.value, "US/Pacific");
  assert.equal(zones.selectedOptions[0].value, "US/Pacific");
  assert.match(ctx.byId("calendar-range").textContent, /2030-10-04/);
  assert.equal(JSON.parse(ctx.dom.window.localStorage.getItem("learning-board:view-preferences:v1")).timeZone, "US/Pacific");
  ctx.byId("new-session").click();
  assert.equal(ctx.byId("session-zone").value, "US/Pacific");
  assert.equal(ctx.byId("session-zone").tagName, "INPUT");
  assert.ok(ctx.document.getElementById(ctx.byId("session-zone").getAttribute("list")), "The session editor retains its time-zone suggestions");
  ctx.byId("session-cancel").click();
  ctx.change("display-time-zone", "Pacific/Chatham");
  assert.equal(zones.value, "Pacific/Chatham");
  ctx.change("display-time-zone", "UTC");
  ctx.session().querySelector('[data-session-action="edit"]').click();
  assert.equal(ctx.byId("session-zone").value, "Asia/Shanghai");
  assert.equal(ctx.byId("session-start").value, "09:00");
  assert.deepEqual((await ctx.read()).sessions, before.sessions);
  assert.equal(ctx.calls.length, 0);
  assert.equal(JSON.parse(ctx.dom.window.localStorage.getItem("learning-board:view-preferences:v1")).timeZone, "UTC");
});

test("an invalid injected display-zone candidate is rejected and the previous selection is restored", async (t) => {
  const ctx = await setup(t);
  ctx.byId("view-today").click();
  const option = ctx.document.createElement("option"); option.value = "Mars/Olympus"; option.textContent = "Invalid candidate";
  ctx.byId("display-time-zone").append(option);
  ctx.change("display-time-zone", option.value);
  assert.equal(ctx.byId("display-time-zone").value, "Asia/Shanghai");
  assert.match(ctx.byId("data-error").textContent, /显示时区无效/);
  assert.equal(JSON.parse(ctx.dom.window.localStorage.getItem("learning-board:view-preferences:v1")).timeZone, "Asia/Shanghai");
  assert.equal(ctx.calls.length, 0);
});

test("feedback including early completion records only this session and preserves task, due date and other sessions", async (t) => {
  const ctx = await setup(t);
  ctx.byId("view-today").click();
  ctx.session().querySelector('[data-session-action="feedback"]').click();
  assert.equal(ctx.byId("session-timing-fields").hidden, true); assert.equal(ctx.byId("session-task").disabled, true);
  ctx.change("session-outcome", "not_completed"); ctx.change("session-minutes", "28"); ctx.change("session-feedback", "需要再练习"); await ctx.submit();
  const board = await ctx.read();
  assert.equal(board.tasks[0].status, "planned"); assert.equal(board.tasks[0].dueDate, "2030-10-30"); assert.equal(board.sessions[1].status, "scheduled");
  assert.equal(board.sessions[0].status, "not_completed"); assert.equal(board.sessions[0].actualMinutes, 28); assert.equal(board.sessions[0].feedback, "需要再练习");
  assert.match(ctx.session().textContent, /本次未完成.*28 分钟.*需要再练习/s);
  ctx.session().querySelector('[data-session-action="feedback"]').click(); ctx.change("session-outcome", "completed"); ctx.change("session-minutes", "1441"); await ctx.submit();
  assert.match(ctx.byId("schedule-error").textContent, /0–1440/); assert.equal(ctx.calls.length, 1);
  ctx.change("session-minutes", ""); await ctx.submit(); assert.equal((await ctx.read()).sessions[0].actualMinutes, null); assert.equal((await ctx.read()).tasks[0].status, "planned");
});

test("session editor protects unsaved drafts, is exclusive with task/quick editor and compact modal traps focus", async (t) => {
  const ctx = await setup(t, { width: 600 });
  ctx.byId("view-today").click(); futureForm(ctx);
  assert.equal(ctx.byId("schedule-panel").getAttribute("aria-modal"), "true"); assert.equal(ctx.document.querySelector(".board-area").hasAttribute("inert"), true);
  assert.equal(ctx.byId("new-task").disabled, true); assert.equal(ctx.byId("data-file").disabled, true);
  ctx.byId("session-submit").focus(); ctx.byId("session-submit").dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.ok(ctx.byId("schedule-panel").contains(ctx.document.activeElement));
  ctx.byId("schedule-close").click(); assert.equal(ctx.byId("schedule-discard-dialog").hidden, false); ctx.byId("schedule-keep-editing").click(); assert.equal(ctx.byId("session-objective").value, "不存入偏好的目标");
  assert.equal(ctx.dom.window.localStorage.getItem("learning-board:view-preferences:v1").includes("不存入偏好的目标"), false);
  ctx.byId("session-cancel").click(); ctx.byId("schedule-discard-edits").click(); assert.equal(ctx.byId("schedule-panel").hidden, true); assert.equal(ctx.calls.length, 0);
  ctx.byId("view-board").click(); ctx.document.querySelector('[data-edit-task]').click(); ctx.byId("task-read-edit").click(); ctx.change("task-title", "任务未保存草稿");
  Object.defineProperty(ctx.dom.window, "innerWidth", { value: 1024, configurable: true }); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("resize")); ctx.byId("view-today").click(); ctx.byId("new-session").click();
  assert.equal(ctx.byId("discard-dialog").hidden, false); ctx.byId("keep-editing").click(); assert.equal(ctx.byId("task-title").value, "任务未保存草稿");
  ctx.byId("new-session").click(); ctx.byId("discard-edits").click(); assert.equal(ctx.byId("editor-panel").hidden, true); assert.equal(ctx.byId("schedule-panel").hidden, false);
});

test("unknown session save retains exactly its original request across notification, refresh and retry", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("lost response"); return result; } });
  ctx.byId("view-today").click(); futureForm(ctx); await ctx.submit();
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.byId("session-objective").disabled, true); assert.equal(ctx.byId("schedule-close").disabled, true); assert.equal(ctx.byId("action-retry").disabled, false);
  ctx.view.acceptReadResult(wrap(await ctx.store.read())); await ctx.view.refresh(); assert.equal(ctx.byId("session-objective").value, "不存入偏好的目标");
  ctx.byId("action-retry").click(); await settle(ctx);
  assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.equal(ctx.byId("schedule-panel").hidden, true); assert.equal((await ctx.read()).sessions.length, 4);
});

test("known overlap preserves editable form and calendar filters; cancel never changes task status or creates replacement", async (t) => {
  const ctx = await setup(t); ctx.byId("view-today").click(); ctx.change("status-filter", "planned");
  ctx.byId("new-session").click(); ctx.change("session-date", "2030-10-05"); ctx.change("session-end-date", "2030-10-05"); ctx.change("session-start", "09:15"); ctx.change("session-end", "09:45"); await ctx.submit();
  assert.match(ctx.byId("schedule-error").textContent, /重叠/); assert.equal(ctx.byId("session-start").disabled, false); assert.equal(ctx.byId("schedule-close").disabled, false); assert.equal((await ctx.read()).sessions.length, 3);
  ctx.change("session-start", "13:00"); ctx.change("session-end", "13:30"); await ctx.submit();
  assert.equal(ctx.byId("status-filter").value, "planned"); assert.equal((await ctx.read()).sessions.length, 4); assert.notEqual(ctx.calls[1].requestId, ctx.calls[0].requestId);
  ctx.session().querySelector('[data-session-action="cancel"]').click(); await settle(ctx);
  assert.equal((await ctx.read()).sessions[0].status, "cancelled"); assert.equal((await ctx.read()).sessions.length, 4); assert.equal((await ctx.read()).tasks[0].status, "planned"); assert.equal(ctx.byId("status-filter").value, "planned");
});

test("explicit refresh after revision conflict preserves schedule input and asks review if session changed remotely", async (t) => {
  const ctx = await setup(t); ctx.byId("view-today").click(); ctx.session().querySelector('[data-session-action="edit"]').click(); ctx.change("session-objective", "本地目标");
  await ctx.commit({ type: "save_session", session: { id: ctx.ids[0], taskId: ctx.taskId, startAt: "2030-10-05T01:00:00Z", endAt: "2030-10-05T02:00:00Z", timeZone: "Asia/Shanghai", objective: "其他处更新目标", completionCriteria: "最新标准" } });
  await ctx.submit(); assert.match(ctx.byId("schedule-error").textContent, /刷新/); assert.equal(ctx.byId("session-submit").disabled, true);
  await ctx.view.refresh(); assert.equal(ctx.byId("session-objective").value, "本地目标"); assert.equal(ctx.byId("schedule-review").hidden, false); assert.match(ctx.byId("schedule-review-message").textContent, /其他处更新目标.*最新标准/); assert.equal(ctx.byId("session-submit").disabled, true);
  ctx.byId("schedule-reviewed").checked = true; ctx.byId("schedule-reviewed").dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  assert.equal(ctx.byId("session-submit").disabled, false); await ctx.submit(); assert.equal((await ctx.read()).sessions[0].objective, "本地目标");
});

test("cross-midnight session is shown on both civil days with day-specific planned minutes", async (t) => {
  const ctx = await setup(t, { now: "2030-10-07T12:00:00Z" });
  const result = await ctx.commit({ type: "save_session", session: { taskId: ctx.taskId, startAt: "2030-10-07T15:30:00Z", endAt: "2030-10-07T16:30:00Z", timeZone: "Asia/Shanghai", objective: "跨日", completionCriteria: "一小时" } });
  ctx.view.acceptReadResult(wrap(await ctx.store.read())); ctx.byId("view-today").click(); assert.match(ctx.byId("calendar-summary").textContent, /总计划 30 分钟/);
  ctx.byId("view-week").click(); const cards = [...ctx.document.querySelectorAll(`[data-session-id="${result.entityId}"]`)]; assert.equal(cards.length, 2); assert.deepEqual(cards.map((node) => node.closest("[data-calendar-date]").dataset.calendarDate), ["2030-10-07", "2030-10-08"]);
});


test("compact editing of an existing session focuses its enabled date and restores focus into the dialog on resize", async (t) => {
  const ctx = await setup(t, { width: 600 }); ctx.byId("view-today").click();
  ctx.session().querySelector('[data-session-action="edit"]').click();
  assert.equal(ctx.byId("session-task").disabled, true);
  assert.equal(ctx.document.activeElement, ctx.byId("session-date"));
  ctx.document.activeElement.blur(); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("resize"));
  assert.equal(ctx.document.activeElement, ctx.byId("session-date"));
  ctx.byId("session-submit").focus(); const event = new ctx.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); ctx.byId("session-submit").dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(ctx.document.activeElement, ctx.byId("schedule-refresh"));
});

test("unknown feedback remains replayable after completion makes the session unavailable for editing", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("lost feedback response"); return result; } });
  ctx.byId("view-today").click(); ctx.session().querySelector('[data-session-action="feedback"]').click(); ctx.change("session-minutes", "55"); await ctx.submit();
  assert.equal((await ctx.read()).sessions[0].status, "completed"); ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  assert.equal(ctx.byId("session-submit").disabled, false); assert.equal(ctx.byId("session-outcome").disabled, true); assert.equal(ctx.byId("action-retry").disabled, false);
  await ctx.view.refresh(); ctx.byId("action-retry").click(); await settle(ctx);
  assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.equal(ctx.byId("schedule-panel").hidden, true); assert.equal((await ctx.read()).tasks[0].status, "planned");
});


test("today focus moves from nearest future to ongoing to next, and ended scheduled sessions remain available for feedback", async (t) => {
  let instant = "2030-10-05T00:00:00Z";
  const ctx = await setup(t, { now: () => instant }); ctx.byId("view-today").click();
  assert.equal(ctx.document.querySelectorAll(".session-card.is-next").length, 1);
  assert.equal(ctx.document.querySelector(".session-card.is-next").dataset.sessionId, ctx.ids[0]);
  assert.match(ctx.session().querySelector(".session-focus-label").textContent, /接下来/);
  assert.match(ctx.byId("calendar-remaining").textContent, /90 分钟/);
  instant = "2030-10-05T01:30:00Z"; ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  assert.match(ctx.session().querySelector(".session-focus-label").textContent, /进行中/);
  assert.match(ctx.byId("calendar-remaining").textContent, /60 分钟/);
  instant = "2030-10-05T02:00:00Z"; ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  assert.equal(ctx.document.querySelector(".session-card.is-next").dataset.sessionId, ctx.ids[1]);
  assert.equal(ctx.document.querySelectorAll(".session-card.is-next").length, 1);
  assert.equal(ctx.document.querySelector("[data-session-id]").dataset.sessionId, ctx.ids[1]);
  assert.match(ctx.session().querySelector(".session-focus-label").textContent, /时间已过.*反馈/);
  assert.ok(ctx.session().querySelector('[data-session-action="feedback"]'));
  assert.match(ctx.byId("calendar-remaining").textContent, /30 分钟/);
  await ctx.commit({ type: "record_session_feedback", sessionId: ctx.ids[1], status: "not_completed", feedback: "待复习", actualMinutes: 0 }); ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  assert.equal(ctx.document.querySelectorAll(".session-card.is-next").length, 0);
  assert.match(ctx.byId("calendar-remaining").textContent, /0 分钟/);
  assert.equal(ctx.session(ctx.ids[1]).closest("details.session-history"), null);
});

test("today history disclosures preserve choice and summary focus while old detached toggle events cannot overwrite a newer choice", async (t) => {
  const ctx = await setup(t);
  await ctx.commit({ type: "record_session_feedback", sessionId: ctx.ids[0], status: "completed", feedback: "完成", actualMinutes: 45 });
  await ctx.commit({ type: "cancel_session", sessionId: ctx.ids[1] }); ctx.view.acceptReadResult(wrap(await ctx.store.read())); ctx.byId("view-today").click();
  const group = (status) => ctx.document.querySelector(`details.session-history[data-session-history="${status}"]`);
  assert.equal(group("completed").open, false); assert.equal(group("cancelled").open, false);
  const detached = group("completed"); detached.open = true; detached.querySelector("summary").focus();
  ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  assert.equal(group("completed").open, true); assert.equal(ctx.document.activeElement, group("completed").querySelector("summary"));
  group("completed").open = false; group("completed").dispatchEvent(new ctx.dom.window.Event("toggle"));
  detached.open = true; detached.dispatchEvent(new ctx.dom.window.Event("toggle"));
  ctx.byId("view-board").click(); ctx.byId("view-today").click();
  assert.equal(group("completed").open, false); assert.equal(group("cancelled").open, false);
  assert.match(ctx.byId("calendar-remaining").textContent, /0 分钟/);
  ctx.byId("view-week").click(); assert.equal(ctx.byId("calendar-remaining").hidden, true);
  ctx.byId("view-board").click(); assert.equal(ctx.byId("calendar-remaining").hidden, true);
});

test("feedback context uses safe original-zone text and reason buttons preserve long content without submitting", async (t) => {
  const ctx = await setup(t);
  await ctx.commit({ type: "save_session", session: { id: ctx.ids[0], taskId: ctx.taskId, startAt: "2030-10-05T01:00:00Z", endAt: "2030-10-05T02:00:00Z", timeZone: "Asia/Shanghai", objective: '<img src=x onerror="window.injected=true">', completionCriteria: "<script>alert(1)</script>" } }); ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  ctx.byId("view-today").click(); ctx.change("display-time-zone", "UTC"); ctx.session().querySelector('[data-session-action="feedback"]').click();
  assert.match(ctx.byId("session-context-time").textContent, /2030-10-05 09:00.*10:00.*Asia\/Shanghai/s);
  assert.match(ctx.byId("session-context-objective").textContent, /<img/); assert.match(ctx.byId("session-context-criteria").textContent, /<script>/);
  assert.equal(ctx.byId("session-context").querySelector("img, script"), null);
  ctx.change("session-outcome", "not_completed"); const reason = ctx.document.querySelector('[data-feedback-reason="时间不够"]');
  ctx.change("session-feedback", "a".repeat(3999)); reason.click();
  assert.equal(ctx.byId("session-feedback").value, "a".repeat(3999)); assert.match(ctx.byId("schedule-error").textContent, /4000/); assert.equal(ctx.calls.length, 0);
  ctx.change("session-feedback", "保留末尾空格 "); reason.click();
  assert.equal(ctx.byId("session-feedback").value, "保留末尾空格 \n时间不够"); reason.click(); assert.equal(ctx.byId("session-feedback").value, "保留末尾空格 \n时间不够");
  ctx.byId("session-cancel").click(); assert.equal(ctx.byId("schedule-discard-dialog").hidden, false); ctx.byId("schedule-keep-editing").click(); assert.equal(ctx.calls.length, 0);
});

test("feedback reason shortcuts stay disabled through a revision conflict until explicit refresh and record review", async (t) => {
  const ctx = await setup(t); ctx.byId("view-today").click(); ctx.session().querySelector('[data-session-action="feedback"]').click(); ctx.change("session-outcome", "not_completed"); ctx.change("session-feedback", "我的输入");
  await ctx.commit({ type: "save_session", session: { id: ctx.ids[0], taskId: ctx.taskId, startAt: "2030-10-05T01:00:00Z", endAt: "2030-10-05T02:00:00Z", timeZone: "Asia/Shanghai", objective: "更新目标", completionCriteria: "新标准" } });
  await ctx.submit();
  const reasons = () => [...ctx.document.querySelectorAll("#session-reasons [data-feedback-reason]")];
  assert.ok(reasons().every((button) => button.disabled)); reasons()[0].click(); assert.equal(ctx.byId("session-feedback").value, "我的输入");
  await ctx.view.refresh(); assert.ok(reasons().every((button) => button.disabled));
  assert.equal(ctx.byId("session-context-objective").textContent, "掌握本章"); assert.match(ctx.byId("schedule-review-message").textContent, /更新目标/);
  ctx.byId("schedule-reviewed").checked = true; ctx.byId("schedule-reviewed").dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  assert.ok(reasons().every((button) => !button.disabled)); reasons()[1].click(); assert.equal(ctx.byId("session-feedback").value, "我的输入\n内容太难");
  assert.equal(ctx.calls.length, 1); await ctx.submit(); assert.equal(ctx.calls.length, 2); assert.equal((await ctx.read()).tasks[0].status, "planned");
});


test("visible calendar clock updates idle start/end boundaries and midnight without backend reads or manual board notifications", async (t) => {
  const ctx = await setup(t, { now: "2030-10-05T00:59:00Z", clock: true }); ctx.byId("view-today").click();
  assert.equal(ctx.clock.pending(), 1); assert.match(ctx.session().querySelector(".session-focus-label").textContent, /接下来/);
  ctx.clock.advance(60000);
  assert.match(ctx.session().querySelector(".session-focus-label").textContent, /进行中/); assert.match(ctx.byId("calendar-remaining").textContent, /90 分钟/);
  ctx.clock.advance(60000); assert.match(ctx.byId("calendar-remaining").textContent, /89 分钟/);
  // A throttled timer must use the actual clock rather than its former due time.
  ctx.clock.jumpTo("2030-10-05T02:00:00Z"); ctx.clock.runNext();
  assert.equal(ctx.document.querySelector(".session-card.is-next").dataset.sessionId, ctx.ids[1]); assert.match(ctx.session().querySelector(".session-focus-label").textContent, /时间已过/);
  assert.equal(ctx.refreshCalls(), 0); assert.equal(ctx.calls.length, 0); assert.ok((await ctx.read()).sessions.every((session) => session.status === "scheduled"));
  const midnight = await setup(t, { now: "2030-10-05T15:59:00Z", clock: true }); midnight.byId("view-today").click();
  assert.match(midnight.byId("calendar-range").textContent, /2030-10-05/); midnight.clock.advance(60000);
  assert.match(midnight.byId("calendar-range").textContent, /2030-10-06/); assert.equal(midnight.document.querySelector(".session-card.is-next").dataset.sessionId, midnight.ids[2]);
  assert.match(midnight.byId("calendar-remaining").textContent, /60 分钟/); assert.equal(midnight.refreshCalls(), 0); assert.equal(midnight.calls.length, 0);
});

test("calendar and manual date clocks run exclusively, stop hidden/pagehide/dispose, resume on visibility or BFC restore and preserve chosen week", async (t) => {
  const ctx = await setup(t, { now: "2030-10-05T00:59:00Z", clock: true });
  assert.equal(ctx.clock.pending(), 1, "Manual view has one date clock"); ctx.byId("view-today").click(); assert.equal(ctx.clock.pending(), 1, "Calendar replaces the manual date clock rather than adding a second timer");
  ctx.clock.visibility("hidden"); assert.equal(ctx.clock.pending(), 0); ctx.clock.advance(61 * 60000);
  assert.match(ctx.session().querySelector(".session-focus-label").textContent, /接下来/);
  ctx.clock.visibility("visible"); assert.equal(ctx.clock.pending(), 1); assert.equal(ctx.document.querySelector(".session-card.is-next").dataset.sessionId, ctx.ids[1]);
  ctx.byId("view-week").click(); ctx.byId("week-next").click(); const selected = ctx.byId("calendar-range").textContent;
  ctx.clock.advance(60000); assert.equal(ctx.byId("calendar-range").textContent, selected);
  ctx.byId("view-board").click(); assert.equal(ctx.clock.pending(), 1, "Manual date clock replaces the calendar clock");
  const boardBefore = ctx.byId("cards").innerHTML;
  ctx.clock.advance(60000); assert.equal(ctx.byId("cards").innerHTML, boardBefore, "Same-day manual clock does not rerender cards or calendar sessions");
  assert.equal(ctx.byId("schedule-toolbar").hidden, true);
  ctx.byId("view-today").click(); assert.equal(ctx.clock.pending(), 1);
  ctx.dom.window.dispatchEvent(new ctx.dom.window.PageTransitionEvent("pagehide", { persisted: true })); assert.equal(ctx.clock.pending(), 0);
  ctx.clock.jumpTo("2030-10-06T00:00:00Z"); ctx.dom.window.dispatchEvent(new ctx.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.match(ctx.byId("calendar-range").textContent, /2030-10-06/); assert.equal(ctx.clock.pending(), 1);
  const before = ctx.byId("cards").innerHTML; assert.equal(typeof ctx.view.dispose, "function"); ctx.view.dispose(); assert.equal(ctx.clock.pending(), 0);
  ctx.clock.advance(24 * 60 * 60000); ctx.clock.visibility("visible"); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus")); ctx.dom.window.dispatchEvent(new ctx.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.equal(ctx.clock.pending(), 0); assert.equal(ctx.byId("cards").innerHTML, before); assert.equal(ctx.refreshCalls(), 0); assert.equal(ctx.calls.length, 0);
});

test("calendar minute timer defers active input and restores week disclosure focus when idle", async (t) => {
  const ctx = await setup(t, { now: "2030-10-05T00:59:00Z", clock: true }); ctx.byId("view-today").click();
  // Task search is hidden in the calendar; use its visible native time-zone
  // control to exercise the same input-focus protection.
  const zones = ctx.byId("display-time-zone"); zones.focus(); const selected = zones.selectedIndex; const before = ctx.byId("cards").innerHTML;
  ctx.clock.advance(60000); assert.equal(ctx.byId("cards").innerHTML, before); assert.equal(ctx.document.activeElement, zones); assert.equal(zones.selectedIndex, selected);
  zones.blur(); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus")); assert.match(ctx.session().querySelector(".session-focus-label").textContent, /进行中/);
  ctx.byId("view-week").click(); const details = ctx.session().querySelector("details.session-details"); details.open = true; details.querySelector("summary").focus();
  ctx.clock.advance(60000); const refreshed = ctx.session().querySelector("details.session-details"); assert.equal(refreshed.open, true); assert.equal(ctx.document.activeElement, refreshed.querySelector("summary"));
  assert.equal(zones.value, "Asia/Shanghai"); assert.equal(ctx.calls.length, 0); assert.equal(ctx.refreshCalls(), 0);
});

test("calendar clock protects dirty task text and failed immediate field intents until they are resolved", async (t) => {
  const ctx = await setup(t, { now: "2030-10-05T00:59:00Z", clock: true, mutate: async () => wrap({ ok: false, error: { code: "SAVE_FAILED", message: "failed clock patch" } }) }); ctx.document.querySelector("[data-edit-task]").click(); ctx.byId("task-read-edit").click(); ctx.change("task-title", "保留时钟期间的任务输入");
  ctx.byId("view-today").click(); ctx.document.activeElement.blur(); const before = ctx.byId("cards").innerHTML; ctx.clock.advance(60000);
  assert.equal(ctx.byId("cards").innerHTML, before); assert.equal(ctx.byId("task-title").value, "保留时钟期间的任务输入");
  ctx.byId("editor-close").click(); ctx.byId("discard-edits").click(); assert.match(ctx.session().querySelector(".session-focus-label").textContent, /进行中/);
  ctx.byId("view-list").click(); ctx.document.querySelector("[data-quick-toggle]").click(); const quick = ctx.document.querySelector('[data-quick-field="priority"]'); assert.ok(quick); quick.value = "urgent"; quick.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); await settle(ctx);
  ctx.byId("view-today").click(); ctx.document.activeElement.blur(); const quickBefore = ctx.byId("cards").innerHTML; ctx.clock.advance(60000);
  assert.equal(ctx.byId("cards").innerHTML, quickBefore); assert.equal(ctx.byId("new-session").disabled, true); assert.equal(ctx.calls.length, 1); assert.equal(ctx.refreshCalls(), 0);
});

test("unknown feedback timer ticks preserve opening context, frozen draft and original replay request", async (t) => {
  const ctx = await setup(t, { now: "2030-10-05T00:59:00Z", clock: true, mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw Error("lost clock-test response"); return result; } });
  ctx.byId("view-today").click(); ctx.session().querySelector('[data-session-action="feedback"]').click(); ctx.change("session-outcome", "not_completed"); ctx.change("session-feedback", "定时更新期间保留的输入");
  const originalContext = ctx.byId("session-context").textContent; await ctx.submit(); const retained = structuredClone(ctx.calls[0]); const before = ctx.byId("cards").innerHTML;
  ctx.clock.advance(60000); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus"));
  assert.equal(ctx.byId("cards").innerHTML, before); assert.equal(ctx.byId("session-context").textContent, originalContext); assert.equal(ctx.byId("session-feedback").value, "定时更新期间保留的输入"); assert.equal(ctx.byId("session-feedback").disabled, true); assert.equal(ctx.calls.length, 1); assert.equal(ctx.refreshCalls(), 0);
  ctx.byId("action-retry").click(); await settle(ctx); assert.deepEqual(ctx.calls[1], retained); assert.equal((await ctx.read()).tasks[0].status, "planned"); assert.equal(ctx.byId("schedule-panel").hidden, true);
});

test("calendar clock defers retained non-editor actions until their exact request is explicitly retried", async (t) => {
  const ctx = await setup(t, { now: "2030-10-05T00:59:00Z", clock: true, mutate: async (request, perform, count) => count === 1 ? wrap({ ok: false, error: { code: "SAVE_FAILED", message: "retain this cancel action" } }) : perform(request) });
  ctx.byId("view-today").click(); ctx.session().querySelector('[data-session-action="cancel"]').click(); await settle(ctx);
  assert.equal(ctx.byId("schedule-panel").hidden, true); assert.equal(ctx.byId("action-feedback").hidden, false); const original = structuredClone(ctx.calls[0]); const before = ctx.byId("cards").innerHTML;
  ctx.clock.advance(60000); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus"));
  assert.equal(ctx.byId("cards").innerHTML, before); assert.equal(ctx.calls.length, 1); assert.equal(ctx.refreshCalls(), 0); assert.equal((await ctx.read()).sessions[0].status, "scheduled");
  ctx.byId("action-retry").click(); await settle(ctx); assert.deepEqual(ctx.calls[1], original); assert.equal((await ctx.read()).sessions[0].status, "cancelled"); assert.equal((await ctx.read()).tasks[0].status, "planned");
});

for (const surface of ["automations", "diagnostics"]) {
  test(`hidden calendar draft on ${surface} rejects keyboard and form submission until returning`, async (t) => {
    const ctx = await setup(t);
    ctx.byId("view-today").click(); futureForm(ctx);
    const before = await ctx.read();
    ctx.view.setWorkbenchSurface(true, surface);
    assert.equal(ctx.byId("task-surface").hidden, true);
    assert.equal(ctx.byId("session-submit").disabled, true);
    for (const key of ["Escape", "Enter"]) {
      const event = new ctx.dom.window.KeyboardEvent("keydown", { key, metaKey: key === "Enter", bubbles: true, cancelable: true });
      ctx.document.body.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, "Hidden calendar must not consume the visible surface shortcut");
    }
    ctx.byId("session-form").dispatchEvent(new ctx.dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(await ctx.read(), before);
    assert.equal(ctx.byId("schedule-discard-dialog").hidden, true);
    assert.equal(ctx.byId("session-objective").value, "不存入偏好的目标");
    ctx.view.setWorkbenchSurface(false);
    assert.equal(ctx.byId("session-submit").disabled, false);
    await ctx.submit();
    assert.equal(ctx.calls.length, 1);
    assert.equal((await ctx.read()).sessions.length, before.sessions.length + 1);
  });
}
