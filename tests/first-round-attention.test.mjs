import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { boardSchema, emptyBoard } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { makeBackup } from "../src/store-data.mjs";
import { mountBoard } from "../src/view.mjs";
import { classifyTaskAttention, sortAttentionTasks } from "../src/view-attention.mjs";
import { projectCodexSnapshot } from "../src/codex-board.mjs";
import { codexSnapshotSchema, unavailableCodexSnapshot, CODEX_SNAPSHOT_STALE_MS } from "../src/codex-domain.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { waitFor } from "./helpers.mjs";

const timestamp = "2030-10-05T04:00:00.000Z";
const id = (value) => `22222222-2222-4222-8222-${String(value).padStart(12, "0")}`;
const wrap = (result) => ({ structuredContent: result, ...(result.ok ? {} : { isError: true }) });
const task = (value, fields = {}) => ({ id: id(value), projectId: id(1), title: `手工任务 ${value}`, status: "planned", sourceTool: "手工来源", currentStep: "", blocker: "", conversationUrl: null, priority: "normal", dueDate: null, lastUpdatedAt: timestamp, ...fields });
const board = (tasks, projects = []) => boardSchema.parse({ ...emptyBoard(), projects: [{ id: id(1), name: "手工项目", description: "", lastUpdatedAt: timestamp }, ...projects], tasks });
const thread = (value, fields = {}) => ({ id: id(value), hostId: "local", title: `自动任务 ${value}`, cwd: "/workspace/project", updatedAt: timestamp, runtimeStatus: "unknown", attention: null, lastTurnStatus: null, goalStatus: null, ...fields });
function snapshot(threads, sourceFields = {}) {
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null, ...sourceFields };
  return codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(timestamp), sources: { threads: source, automations: source }, threads });
}
function installAttentionClock(window, initial) {
  let current = Date.parse(initial); let sequence = 0; let visibility = "visible";
  const timers = new Map();
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => visibility });
  const setTimeout = (callback, delay = 0) => { const timer = ++sequence; timers.set(timer, { due: current + Number(delay), callback }); return timer; };
  const clearTimeout = (timer) => timers.delete(timer);
  window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
  const next = () => [...timers.entries()].sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
  return {
    now: () => current, setTimeout, clearTimeout, pending: () => timers.size, next: () => next()?.[1],
    jumpTo(value) { current = Date.parse(value); },
    advance(milliseconds) {
      const end = current + milliseconds;
      for (let entry = next(); entry && entry[1].due <= end; entry = next()) {
        current = Math.max(current, entry[1].due); timers.delete(entry[0]); entry[1].callback();
      }
      current = end;
    },
    visibility(value) { visibility = value; window.document.dispatchEvent(new window.Event("visibilitychange")); },
  };
}

async function setup(t, initial, { now = () => Date.parse(timestamp), preferences = { viewMode: "board" }, clockStart, ...options } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "first-round-attention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  const seeded = await store.mutate({ requestId: randomUUID(), expectedRevision: 0, operation: { type: "restore_board", backup: makeBackup(initial, timestamp) } });
  assert.equal(seeded.ok, true);
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://first-round-attention.test/", pretendToBeVisual: true });
  const clock = clockStart ? installAttentionClock(dom.window, clockStart) : null;
  const currentTime = clock?.now || now;
  if (preferences) dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify(preferences));
  const document = dom.window.document;
  const calls = [];
  let refreshCalls = 0;
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, emptyBoard(), {
    now: currentTime, setTimeout: clock?.setTimeout || (() => 1), clearTimeout: clock?.clearTimeout || (() => {}),
    refresh: async () => { refreshCalls++; return wrap(await store.read()); },
    mutate: async (request) => { calls.push(structuredClone(request)); return wrap(await store.mutate(request)); },
    ...options,
  }));
  view.setHostState({ connected: true, message: "测试宿主" });
  view.acceptReadResult(wrap(await store.read()));
  t.after(() => { view.dispose(); dom.window.close(); });
  const byId = (value) => document.getElementById(value);
  const change = (field, value) => { const node = byId(field); node.value = value; node.dispatchEvent(new dom.window.Event(node.matches("input,textarea") ? "input" : "change", { bubbles: true })); };
  const card = (value) => document.querySelector(`[data-task-id="${value}"]`);
  const visibleIds = () => [...byId("cards").querySelectorAll("[data-task-id]")].map((node) => node.dataset.taskId);
  const nextCount = () => Number(byId("sidebar-next").querySelector("[data-sidebar-count]").textContent);
  const setSnapshot = (value) => { assert.equal(view.setCodexSnapshot(value), true); return projectCodexSnapshot(value, { now: new Date(currentTime()).getTime() }); };
  return { dom, document, byId, view, store, calls, change, card, visibleIds, nextCount, setSnapshot, clock, refreshCalls: () => refreshCalls };
}
const settle = (predicate) => waitFor(predicate, "保存操作须完成");

test("attention membership excludes completed, archived and non-actionable statuses; paused manual tasks need a due reminder", () => {
  const context = { today: "2030-10-05" };
  for (const status of ["waiting_user", "failed"]) assert.equal(classifyTaskAttention(task(10, { status }), context).group, "attention");
  for (const status of ["planned", "in_progress"]) assert.equal(classifyTaskAttention(task(10, { status }), context).group, "upcoming");
  assert.equal(classifyTaskAttention(task(10, { status: "paused" }), context), null);
  assert.equal(classifyTaskAttention(task(10, { status: "paused", dueDate: "2030-10-05" }), context).due, "today");
  assert.equal(classifyTaskAttention(task(10, { status: "paused", dueDate: "2030-10-04" }), context).due, "overdue");
  for (const status of ["completed", "idle", "not_loaded", "unknown", "turn_ended"]) assert.equal(classifyTaskAttention(task(10, { status, dueDate: "2030-10-01" }), context), null);
  assert.equal(classifyTaskAttention(task(10, { archivedAt: timestamp, status: "failed" }), context), null);
  assert.equal(classifyTaskAttention(task(10, { status: "failed" }), { ...context, archived: true }), null);
  assert.equal(classifyTaskAttention(task(10, { origin: "codex", status: "paused", dueDate: "2030-10-01" }), { ...context, codexRuntimeReliable: true }), null);
  assert.equal(classifyTaskAttention(task(10, { origin: "codex", status: "failed" }), context), null);
});

test("attention sorts intervention first, then priority and civil due date, preserving ties and the original record order", () => {
  const input = [task(10, { priority: "urgent" }), task(11, { status: "waiting_user", priority: "low" }), task(12, { status: "failed", priority: "high" }), task(13, { status: "waiting_user", priority: "high", dueDate: "2030-10-04" }), task(14, { status: "waiting_user", priority: "high", dueDate: "2030-10-04" }), task(15, { priority: "urgent", dueDate: "2030-10-08" })];
  const original = structuredClone(input);
  const sorted = sortAttentionTasks(input, (value) => classifyTaskAttention(value, { today: "2030-10-05" }));
  assert.deepEqual(sorted.map((value) => value.id), [13, 14, 12, 11, 15, 10].map(id));
  assert.deepEqual(input, original);
});

test("next aggregation includes manual intervention, reliable Codex intervention and upcoming work; sidebar shares its membership", async (t) => {
  const initial = board([
    task(10), task(11, { status: "in_progress" }), task(12, { status: "waiting_user" }), task(13, { status: "failed" }), task(14, { status: "paused", dueDate: "2030-10-04" }), task(15, { dueDate: "2030-10-05" }),
    task(16, { status: "completed", dueDate: "2030-10-01" }), task(17, { archivedAt: timestamp, status: "failed" }), task(18, { status: "paused" }), task(19, { status: "waiting_user", projectId: id(2) }),
  ], [{ id: id(2), name: "归档项目", description: "", archivedAt: timestamp, lastUpdatedAt: timestamp }]);
  const ctx = await setup(t, initial);
  const before = (await ctx.store.read()).board;
  const projection = ctx.setSnapshot(snapshot([thread(100, { attention: "approval" }), thread(101, { lastTurnStatus: "failed" }), thread(102, { runtimeStatus: "active" }), thread(103, { runtimeStatus: "idle" }), thread(104, { runtimeStatus: "notLoaded" }), thread(105), thread(106, { lastTurnStatus: "completed", goalStatus: "active" }), thread(107, { goalStatus: "complete" }), thread(108, { goalStatus: "paused" })]));
  ctx.byId("sidebar-next").click();
  const automatic = projection.tasks.filter((value) => [100, 101, 102].map(id).includes(value.threadId));
  assert.equal(ctx.visibleIds().length, 9);
  assert.equal(ctx.nextCount(), 9);
  assert.deepEqual(new Set(ctx.visibleIds()), new Set([10, 11, 12, 13, 14, 15].map(id).concat(automatic.map((value) => value.id))));
  const summary = ctx.document.querySelector(".next-actions-summary");
  assert.equal(summary.textContent, "待处理 6 项 · 接下来 3 项");
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /Asia\/Shanghai.*2030-10-05/);
  assert.match(ctx.card(id(14)).querySelector("[data-attention-reason]").textContent, /已逾期.*2030-10-04/);
  assert.match(ctx.card(id(15)).querySelector("[data-attention-reason]").textContent, /今日到期/);
  assert.match(ctx.card(automatic.find((value) => value.threadId === id(100)).id).querySelector("[data-attention-reason]").textContent, /等待批准/);
  assert.match(ctx.card(automatic.find((value) => value.threadId === id(101)).id).querySelector("[data-attention-reason]").textContent, /本轮失败/);
  assert.ok(automatic.every((value) => ctx.card(value.id).querySelectorAll("[data-edit-task],[data-move-control],[data-archive-task]").length === 0));
  ctx.change("search", "不存在"); ctx.change("status-filter", "failed"); ctx.change("source-filter", JSON.stringify("手工来源"));
  assert.equal(ctx.visibleIds().length, 0);
  assert.equal(ctx.nextCount(), 9);
  assert.match(ctx.byId("sidebar-next").title, /待处理 6 项.*接下来 3 项/);
  assert.deepEqual((await ctx.store.read()).board, before);
  assert.deepEqual(ctx.calls, []);
});

test("expired, unavailable and archive Codex sources never add their retained historic failure or blocked result to attention", async (t) => {
  let current = Date.parse(timestamp);
  const ctx = await setup(t, board([task(10, { status: "failed" })]), { now: () => current });
  const threads = [thread(100, { attention: "input" }), thread(101, { runtimeStatus: "error" }), thread(102, { lastTurnStatus: "failed" }), thread(103, { goalStatus: "blocked" }), thread(104, { runtimeStatus: "active" })];
  ctx.setSnapshot(snapshot(threads, { complete: false }));
  ctx.byId("view-next").click();
  assert.equal(ctx.nextCount(), 6, "Partial coverage can still provide reliable status for present records");
  current += CODEX_SNAPSHOT_STALE_MS + 1;
  let projected = ctx.setSnapshot(snapshot(threads));
  assert.equal(projected.freshness.runtimeReliable, false);
  assert.ok(projected.tasks.some((value) => value.status === "failed"), "Historic outcomes remain visible in other views");
  assert.deepEqual(ctx.visibleIds(), [id(10)]); assert.equal(ctx.nextCount(), 1);
  current = Date.parse(timestamp);
  for (const source of [{ state: "disconnected" }, { mode: "unavailable" }, { mode: "archive" }]) {
    projected = ctx.setSnapshot(snapshot(threads, source));
    assert.equal(projected.freshness.runtimeReliable, false);
    assert.deepEqual(ctx.visibleIds(), [id(10)]); assert.equal(ctx.nextCount(), 1);
  }
  assert.deepEqual(ctx.calls, []);
});

test("Codex freshness changes refresh attention even when historic failed and blocked task records remain identical", async (t) => {
  let current = Date.parse(timestamp);
  let timer;
  const ctx = await setup(t, board([]), { now: () => current, setTimeout: (callback) => { timer = callback; return 1; }, clearTimeout: () => {} });
  const value = snapshot([thread(100, { lastTurnStatus: "failed" }), thread(101, { goalStatus: "blocked" })]);
  ctx.setSnapshot(value);
  ctx.byId("view-next").click();
  assert.equal(ctx.nextCount(), 2);
  assert.equal(typeof timer, "function");
  current += CODEX_SNAPSHOT_STALE_MS + 1;
  timer();
  assert.deepEqual(ctx.visibleIds(), []);
  assert.equal(ctx.nextCount(), 0);
  assert.equal(ctx.document.querySelector(".next-actions-summary").textContent, "待处理 0 项 · 接下来 0 项");
  current = Date.parse(timestamp);
  ctx.setSnapshot(value);
  assert.equal(ctx.nextCount(), 2);
  ctx.setSnapshot(snapshot(value.threads, { mode: "unavailable" }));
  assert.deepEqual(ctx.visibleIds(), []);
  assert.equal(ctx.nextCount(), 0);
  assert.deepEqual(ctx.calls, []);
});

test("due reminders follow the displayed civil date across UTC midnight and timezone changes", async (t) => {
  const ctx = await setup(t, board([task(10, { status: "paused", dueDate: "2030-10-05" }), task(11, { status: "paused", dueDate: "2030-10-04" })]), { now: () => Date.parse("2030-10-04T16:30:00.000Z") });
  ctx.byId("view-next").click();
  assert.deepEqual(ctx.visibleIds(), [id(11), id(10)]); assert.equal(ctx.nextCount(), 2);
  assert.match(ctx.card(id(10)).querySelector("[data-attention-reason]").textContent, /今日到期/);
  ctx.change("display-time-zone", "America/Los_Angeles");
  ctx.byId("display-time-zone").dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  assert.deepEqual(ctx.visibleIds(), [id(11)]); assert.equal(ctx.nextCount(), 1);
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /America\/Los_Angeles.*2030-10-04/);
  assert.match(ctx.card(id(11)).querySelector("[data-attention-reason]").textContent, /今日到期/);
  assert.deepEqual(ctx.calls, []);
});

test("all mixed next tasks remain reachable in pages of 50 and saving a waiting task keeps next mode and reveals its page", async (t) => {
  const initial = board(Array.from({ length: 125 }, (_, index) => task(1000 + index, { status: index < 60 ? "waiting_user" : "planned", priority: index % 3 === 0 ? "high" : "normal" })));
  const ctx = await setup(t, initial);
  const before = (await ctx.store.read()).board;
  const expected = sortAttentionTasks(initial.tasks, (value) => classifyTaskAttention(value, { today: "2030-10-05" })).map((value) => value.id);
  ctx.byId("view-next").click();
  const visited = [];
  for (let page = 0; page < 3; page++) {
    const container = ctx.document.querySelector(".next-actions");
    assert.equal(container.dataset.page, String(page));
    assert.deepEqual(ctx.visibleIds(), expected.slice(page * 50, (page + 1) * 50));
    visited.push(...ctx.visibleIds());
    if (page < 2) container.querySelector('[data-page-control="next"]').click();
  }
  assert.deepEqual(visited, expected);
  assert.deepEqual((await ctx.store.read()).board, before);
  assert.equal(ctx.document.activeElement.dataset.pageControl, "previous");
  ctx.byId("new-task").click();
  ctx.change("task-title", "新的等待处理任务"); ctx.change("task-status", "waiting_user");
  ctx.byId("task-form").querySelector('[type="submit"]').click();
  await settle(() => ctx.calls.length === 1 && !ctx.byId("refresh").disabled);
  const after = (await ctx.store.read()).board;
  const saved = after.tasks.at(-1);
  assert.equal(saved.status, "waiting_user");
  assert.equal(ctx.byId("view-next").getAttribute("aria-pressed"), "true");
  assert.equal(ctx.document.querySelector(".next-actions").dataset.page, "1");
  assert.ok(ctx.card(saved.id));
  assert.equal(ctx.document.activeElement.dataset.editTask, saved.id);
  assert.deepEqual(after.tasks.slice(0, -1).map((value) => value.id), before.tasks.map((value) => value.id));
});

test("next refresh preserves focused cards, scroll, search and an editor draft while following re-sorted work", async (t) => {
  const initial = board(Array.from({ length: 60 }, (_, index) => task(1000 + index, { status: "waiting_user" })));
  const ctx = await setup(t, initial);
  ctx.byId("view-next").click(); ctx.change("search", "手工任务");
  const focusId = id(1049);
  ctx.card(focusId).querySelector("[data-edit-task]").focus();
  ctx.byId("column-next").scrollTop = 133;
  const updated = structuredClone((await ctx.store.read()).board);
  updated.revision++;
  updated.tasks.unshift(task(999, { status: "failed", priority: "urgent" }));
  assert.equal(ctx.view.setBoard(updated), true);
  assert.equal(ctx.document.querySelector(".next-actions").dataset.page, "1");
  assert.equal(ctx.document.activeElement.dataset.editTask, focusId);
  assert.equal(ctx.byId("column-next").scrollTop, 133);
  assert.equal(ctx.byId("search").value, "手工任务");
  ctx.card(focusId).querySelector("[data-edit-task]").click();
  if (!ctx.byId("task-read-view").hidden) ctx.byId("task-read-edit").click();
  assert.equal(ctx.byId("task-form").hidden, false);
  assert.equal(ctx.byId("task-title").disabled, false);
  ctx.change("task-title", "保留的编辑草稿");
  ctx.change("status-filter", "failed");
  assert.equal(ctx.byId("task-title").value, "保留的编辑草稿");
  assert.equal(ctx.byId("search").value, "手工任务");
  assert.deepEqual(ctx.calls, []);
});

test("stored next with archived preference still downgrades to an accessible archive list", async (t) => {
  const ctx = await setup(t, board([task(10, { archivedAt: timestamp })]), { preferences: { viewMode: "next", archive: "archived" } });
  assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true");
  assert.equal(ctx.byId("view-next").disabled, true);
  assert.ok(ctx.card(id(10)));
  assert.deepEqual(ctx.calls, []);
});

test("source summaries, source copy focus and secondary-status summaries survive replacement without hidden focus", async (t) => {
  const copied = [];
  const ctx = await setup(t, board([task(10)]), { openThread: async () => ({}) });
  Object.defineProperty(ctx.dom.window.navigator, "clipboard", { value: { writeText: async (value) => copied.push(value) } });
  const threads = [thread(100, { runtimeStatus: "active" }), thread(101, { runtimeStatus: "idle" })];
  const projection = ctx.setSnapshot(snapshot(threads));
  const automatic = projection.tasks.find((value) => value.threadId === id(100));
  const source = ctx.card(automatic.id).querySelector("[data-card-source-details]");
  assert.ok(source);
  source.querySelector(":scope > summary").focus();
  const newer = (offset) => {
    const captured = new Date(Date.parse(timestamp) + offset).toISOString();
    const value = snapshot(threads.map((value) => ({ ...value, title: `${value.title} ${offset}` })));
    value.observedAt = captured;
    return value;
  };
  ctx.setSnapshot(newer(1));
  let freshSource = ctx.card(automatic.id).querySelector("[data-card-source-details]");
  assert.equal(ctx.document.activeElement, freshSource.querySelector(":scope > summary"));
  assert.equal(freshSource.open, false);
  freshSource.open = true;
  freshSource.querySelector("[data-codex-task-copy]").focus();
  ctx.setSnapshot(newer(2));
  freshSource = ctx.card(automatic.id).querySelector("[data-card-source-details]");
  assert.equal(freshSource.open, true);
  assert.equal(ctx.document.activeElement, freshSource.querySelector("[data-codex-task-copy]"));
  ctx.document.activeElement.click();
  await settle(() => copied.length === 1);
  assert.deepEqual(copied, [id(100)]);
  const secondary = ctx.document.querySelector("[data-other-statuses]");
  assert.ok(secondary);
  secondary.open = false;
  secondary.querySelector("[data-toggle-other-statuses]").focus();
  ctx.setSnapshot(newer(3));
  const current = ctx.document.querySelector("[data-other-statuses]");
  assert.equal(current.open, false);
  assert.equal(ctx.document.activeElement, current.querySelector("[data-toggle-other-statuses]"));
  ctx.change("record-filter", "codex");
  assert.equal(ctx.document.querySelector("[data-other-statuses]").open, true);
  ctx.change("record-filter", "all");
  assert.equal(ctx.document.querySelector("[data-other-statuses]").open, false, "Temporary filter expansion must not become a lasting preference");
  assert.deepEqual(ctx.calls, []);
});

test("manual date clock crosses the displayed midnight without navigation or backend I/O", async (t) => {
  const ctx = await setup(t, board([task(10, { status: "paused", dueDate: "2030-10-06" })]), { clockStart: "2030-10-05T15:59:10Z" });
  ctx.byId("sidebar-next").click();
  const persisted = await ctx.store.read();
  assert.deepEqual(ctx.visibleIds(), []);
  assert.equal(ctx.nextCount(), 0);
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-05/);
  assert.equal(ctx.clock.pending(), 1);
  assert.equal(ctx.clock.next().due - ctx.clock.now(), 50000, "The date clock aligns with the next minute");
  ctx.clock.advance(50000);
  assert.deepEqual(ctx.visibleIds(), [id(10)]);
  assert.equal(ctx.nextCount(), 1);
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-06/);
  assert.match(ctx.card(id(10)).querySelector(".task-attention-reason").textContent, /今日到期/);
  assert.equal(ctx.card(id(10)).querySelector(".card-date").classList.contains("due-overdue"), false);
  const sameDay = ctx.byId("cards").innerHTML;
  ctx.clock.advance(60000);
  assert.equal(ctx.byId("cards").innerHTML, sameDay, "Same-day minute ticks keep the current DOM");
  assert.equal(ctx.refreshCalls(), 0);
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(await ctx.store.read(), persisted);
});

test("manual date clock stops in the background, resumes from visibility/focus/BFCache, and stays stopped after disposal", async (t) => {
  const ctx = await setup(t, board([task(10, { status: "paused", dueDate: "2030-10-06" })]), { clockStart: "2030-10-05T15:59:00Z" });
  ctx.byId("sidebar-next").click();
  ctx.clock.visibility("hidden");
  assert.equal(ctx.clock.pending(), 0);
  ctx.clock.advance(120000);
  assert.equal(ctx.nextCount(), 0);
  ctx.clock.visibility("visible");
  assert.equal(ctx.nextCount(), 1);
  assert.deepEqual(ctx.visibleIds(), [id(10)]);
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-06/);
  assert.equal(ctx.clock.pending(), 1);
  ctx.dom.window.dispatchEvent(new ctx.dom.window.PageTransitionEvent("pagehide", { persisted: true }));
  assert.equal(ctx.clock.pending(), 0);
  ctx.clock.jumpTo("2030-10-06T16:01:00Z");
  ctx.dom.window.dispatchEvent(new ctx.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-07/);
  assert.equal(ctx.card(id(10)).querySelector(".card-date").classList.contains("due-overdue"), true);
  assert.equal(ctx.clock.pending(), 1);
  ctx.clock.jumpTo("2030-10-07T16:01:00Z");
  assert.equal(ctx.refreshCalls(), 0, "the attention clock itself never reads the store");
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus"));
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-08/);
  await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.refreshCalls(), 1, "window activation reads shared focus once");
  ctx.view.dispose();
  assert.equal(ctx.clock.pending(), 0);
  const disposed = ctx.byId("cards").innerHTML;
  ctx.clock.advance(86400000);
  ctx.clock.visibility("visible");
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus"));
  ctx.dom.window.dispatchEvent(new ctx.dom.window.PageTransitionEvent("pageshow", { persisted: true }));
  assert.equal(ctx.clock.pending(), 0);
  assert.equal(ctx.byId("cards").innerHTML, disposed);
  assert.equal(ctx.refreshCalls(), 1, "disposed windows never initiate another read");
  assert.deepEqual(ctx.calls, []);
});

test("midnight updates sidebar counts while preserving an editor draft and its date-consistent card layout", async (t) => {
  const ctx = await setup(t, board([task(10), task(11, { status: "paused", dueDate: "2030-10-06" })]), { clockStart: "2030-10-05T15:59:00Z" });
  ctx.byId("sidebar-next").click();
  ctx.card(id(10)).querySelector("[data-edit-task]").click();
  ctx.byId("task-read-edit").click();
  ctx.change("task-title", "午夜仍须保留的未保存草稿");
  ctx.byId("task-title").focus();
  ctx.byId("task-title").setSelectionRange(2, 5);
  const before = ctx.byId("cards").innerHTML;
  ctx.clock.advance(60000);
  assert.equal(ctx.nextCount(), 2);
  assert.equal(ctx.byId("cards").innerHTML, before);
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-05/);
  assert.equal(ctx.byId("task-title").value, "午夜仍须保留的未保存草稿");
  assert.equal(ctx.document.activeElement, ctx.byId("task-title"));
  assert.equal(ctx.byId("task-title").selectionStart, 2);
  assert.equal(ctx.byId("task-title").selectionEnd, 5);
  ctx.byId("editor-close").click();
  assert.equal(ctx.byId("discard-dialog").hidden, false);
  const pendingLayout = ctx.byId("cards").innerHTML;
  const pendingCard = ctx.card(id(10));
  ctx.clock.advance(60000);
  assert.equal(ctx.byId("cards").innerHTML, pendingLayout);
  assert.equal(ctx.card(id(10)), pendingCard, "Clock leaves the existing card node in place during the discard decision");
  ctx.byId("discard-edits").click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.visibleIds(), [id(11), id(10)]);
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-06/);
  assert.equal(ctx.refreshCalls(), 0);
  assert.deepEqual(ctx.calls, []);
});

test("native search selection survives midnight until focus leaves the input", async (t) => {
  const ctx = await setup(t, board([task(10), task(11, { status: "paused", dueDate: "2030-10-06" })]), { clockStart: "2030-10-05T15:59:00Z" });
  ctx.byId("sidebar-next").click();
  ctx.change("search", "手工任务");
  ctx.byId("search").focus();
  ctx.byId("search").setSelectionRange(1, 3);
  const before = ctx.byId("cards").innerHTML;
  ctx.clock.advance(60000);
  assert.equal(ctx.nextCount(), 2);
  assert.equal(ctx.byId("cards").innerHTML, before);
  assert.equal(ctx.document.activeElement, ctx.byId("search"));
  assert.equal(ctx.byId("search").selectionStart, 1);
  assert.equal(ctx.byId("search").selectionEnd, 3);
  ctx.byId("search").blur();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.visibleIds(), [id(11), id(10)]);
  assert.match(ctx.document.querySelector(".next-actions-date").textContent, /2030-10-06/);
  assert.equal(ctx.byId("search").value, "手工任务");
  assert.equal(ctx.refreshCalls(), 0);
  assert.deepEqual(ctx.calls, []);
});
