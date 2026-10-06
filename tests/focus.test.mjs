import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { boardSchema, emptyBoard } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { makeBackup } from "../src/store-data.mjs";
import { mountBoard } from "../src/view.mjs";
import { FOCUS_PREFERENCE_KEY, MAX_FOCUS_TASKS, PREFERENCE_KEY } from "../src/view-common.mjs";
import { classifyTaskAttention, sortAttentionTasks } from "../src/view-attention.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";

const timestamp = "2030-10-05T04:00:00.000Z";
const id = (value) => `33333333-3333-4333-8333-${String(value).padStart(12, "0")}`;
const wrap = (result) => ({ structuredContent: result, ...(result.ok ? {} : { isError: true }) });
const task = (value, fields = {}) => ({
  id: id(value), projectId: id(1), title: `测试任务 ${value}`, status: "planned",
  sourceTool: "手工来源", currentStep: "", blocker: "", conversationUrl: null,
  priority: "normal", dueDate: null, lastUpdatedAt: timestamp, ...fields,
});
const board = (tasks, projects = []) => boardSchema.parse({
  ...emptyBoard(),
  projects: [{ id: id(1), name: "测试项目", description: "", lastUpdatedAt: timestamp }, ...projects],
  tasks,
});

async function setup(t, initial, { focusPreferences = null, dailyFocus = null, preferences = { viewMode: "next" }, ...options } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "focus-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  const seeded = await store.mutate({
    requestId: randomUUID(), expectedRevision: 0,
    operation: { type: "restore_board", backup: makeBackup({ ...initial, ...(dailyFocus ? { dailyFocus } : {}) }, timestamp) },
  });
  assert.equal(seeded.ok, true);

  const dom = new JSDOM(await loadAppTemplate(), { url: "https://focus.test/", pretendToBeVisual: true });
  if (preferences) dom.window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preferences));
  if (focusPreferences) dom.window.localStorage.setItem(FOCUS_PREFERENCE_KEY, JSON.stringify(focusPreferences));

  const document = dom.window.document;
  const calls = [];
  const errors = [];
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, emptyBoard(), {
    now: () => Date.parse(timestamp),
    reportError: (message) => errors.push(message),
    refresh: async () => wrap(await store.read()),
    data: async (request) => wrap(await store.data(request)),
    mutate: async (request) => { calls.push(structuredClone(request)); return wrap(await store.mutate(request)); },
    ...options,
  }));
  view.setHostState({ connected: true, message: "测试宿主" });
  view.acceptReadResult(wrap(await store.read()));
  t.after(() => { view.dispose(); dom.window.close(); });

  const byId = (value) => document.getElementById(value);
  const card = (value) => document.querySelector(`[data-task-id="${value}"]`);
  const visibleIds = () => [...byId("cards").querySelectorAll("[data-task-id]")].map((node) => node.dataset.taskId);

  return { dom, document, byId, view, store, calls, errors, card, visibleIds, directory };
}

test("classifyTaskAttention classifies focus tasks with group 'focus' and ranks them ahead of attention and upcoming", () => {
  const context = { today: "2030-10-05" };
  const normalTask = task(1, { status: "planned" });
  const waitingTask = task(2, { status: "waiting_user" });
  const completedTask = task(3, { status: "completed" });
  const archivedTask = task(4, { status: "planned", archivedAt: timestamp });

  const nonFocusDecision = classifyTaskAttention(normalTask, { ...context, isFocus: false });
  assert.equal(nonFocusDecision.group, "upcoming");

  const focusDecision = classifyTaskAttention(normalTask, { ...context, isFocus: true });
  assert.equal(focusDecision.group, "focus");
  assert.ok(focusDecision.reasons.some((r) => r.includes("今日焦点")));

  // Completed or archived tasks never appear in attention or focus
  assert.equal(classifyTaskAttention(completedTask, { ...context, isFocus: true }), null);
  assert.equal(classifyTaskAttention(archivedTask, { ...context, isFocus: true }), null);

  // Sorting puts focus (rank 0) before attention (rank 1) and upcoming (rank 2)
  const tasks = [
    normalTask, // upcoming
    waitingTask, // attention
    task(5, { status: "in_progress" }), // will be focus
  ];
  const sorted = sortAttentionTasks(tasks, (t) => classifyTaskAttention(t, { ...context, isFocus: t.id === id(5) }));
  assert.deepEqual(sorted.map((t) => t.id), [id(5), id(2), id(1)]);
});

test("toggling focus persists dated server state and updates card controls", async (t) => {
  const initial = board([task(10, { title: "焦点目标" }), task(11, { title: "次要任务" })]);
  const ctx = await setup(t, initial);

  const card10 = ctx.card(id(10));
  assert.ok(card10);
  assert.equal(card10.classList.contains("is-focus"), false);
  assert.equal(card10.querySelector(".task-focus-tag"), null);

  // Action menu focus button
  const focusBtn = card10.querySelector(`[data-focus-task="${id(10)}"]`);
  assert.ok(focusBtn);
  assert.equal(focusBtn.textContent, "设为今日焦点");

  // Toggle on
  focusBtn.click();
  await waitFor(() => ctx.card(id(10)).classList.contains("is-focus"));
  const updatedCard = ctx.card(id(10));
  assert.equal(updatedCard.classList.contains("is-focus"), true);
  const tag = updatedCard.querySelector(".task-focus-tag");
  assert.ok(tag);
  assert.match(tag.textContent, /今日焦点/);
  const updatedBtn = updatedCard.querySelector(`[data-focus-task="${id(10)}"]`);
  assert.equal(updatedBtn.textContent, "移出今日焦点");

  // LocalStorage check: FOCUS_PREFERENCE_KEY must contain task 10
  const savedFocus = (await ctx.store.read()).board.dailyFocus;
  assert.deepEqual(savedFocus, { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(10)] });
  assert.equal(ctx.dom.window.localStorage.getItem(FOCUS_PREFERENCE_KEY), null);

  // VIEW_PREFERENCE_KEY must NOT be polluted
  const viewPref = JSON.parse(ctx.dom.window.localStorage.getItem(PREFERENCE_KEY));
  assert.equal(viewPref.focusTaskIds, undefined);

  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].operation.type, "set_focus_task");

  // Toggle off
  updatedBtn.click();
  await waitFor(() => !ctx.card(id(10)).classList.contains("is-focus"));
  const restoredCard = ctx.card(id(10));
  assert.equal(restoredCard.classList.contains("is-focus"), false);
  assert.equal(restoredCard.querySelector(".task-focus-tag"), null);
  assert.equal(restoredCard.querySelector(`[data-focus-task="${id(10)}"]`).textContent, "设为今日焦点");

  const restoredFocus = (await ctx.store.read()).board.dailyFocus;
  assert.deepEqual(restoredFocus.taskIds, []);
  const backups = (await readdir(path.join(ctx.directory, "backups"))).filter((name) => name.startsWith("revision-")).sort();
  const automatic = JSON.parse(await readFile(path.join(ctx.directory, "backups", backups.at(-1)), "utf8"));
  assert.deepEqual(automatic.dailyFocus.taskIds, [id(10)]);
});

test("five-task recommendation is neutral and allows a sixth focus", async (t) => {
  const tasks = Array.from({ length: 7 }, (_, i) => task(100 + i));
  const ctx = await setup(t, board(tasks));
  for (let i = 0; i <= MAX_FOCUS_TASKS; i++) {
    ctx.card(id(100 + i)).querySelector(`[data-focus-task="${id(100 + i)}"]`).click();
    await waitFor(() => ctx.card(id(100 + i)).classList.contains("is-focus"));
  }
  assert.equal((await ctx.store.read()).board.dailyFocus.taskIds.length, 6);
  assert.equal(ctx.byId("data-error").textContent, "");
  assert.match(ctx.byId("daily-focus").textContent, /今日焦点 6 项.*建议最多选择 5 项/);
});

test("next view groups focus tasks at the top with proper summary and group header", async (t) => {
  const initial = board([
    task(10, { status: "planned", title: "普通任务" }),
    task(11, { status: "waiting_user", title: "等待任务" }),
    task(12, { status: "planned", title: "焦点任务" }),
  ]);
  const ctx = await setup(t, initial, {
    dailyFocus: { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(12)] },
  });

  // Next view summary should mention 今日焦点
  const summary = ctx.document.querySelector(".next-actions-summary");
  assert.ok(summary);
  assert.match(summary.textContent, /今日焦点 1 项 · 待处理 1 项 · 接下来 1 项/);
  assert.equal(summary.dataset.focusCount, "1");
  assert.equal(summary.dataset.attentionCount, "1");
  assert.equal(summary.dataset.upcomingCount, "1");

  // Headings in next view
  const groupHeadings = [...ctx.document.querySelectorAll(".next-group-heading")];
  assert.equal(groupHeadings.length, 3);
  assert.equal(groupHeadings[0].dataset.attentionGroup, "focus");
  assert.match(groupHeadings[0].textContent, /今日焦点 · 1 项/);
  assert.equal(groupHeadings[1].dataset.attentionGroup, "attention");
  assert.match(groupHeadings[1].textContent, /待处理 · 1 项/);
  assert.equal(groupHeadings[2].dataset.attentionGroup, "upcoming");
  assert.match(groupHeadings[2].textContent, /接下来 · 1 项/);

  // Ordering: focus task 12 is first
  assert.deepEqual(ctx.visibleIds(), [id(12), id(11), id(10)]);
  const card12 = ctx.card(id(12));
  assert.equal(card12.dataset.attentionGroup, "focus");
  assert.equal(card12.classList.contains("is-focus"), true);
  const reason12 = card12.querySelector("[data-attention-reason]");
  assert.ok(reason12.classList.contains("attention-focus"));
  assert.match(reason12.textContent, /今日焦点/);
});

test("gracefully handles missing, corrupted, or non-array focus preferences on mount", async (t) => {
  const initial = board([task(10, { title: "任务 A" })]);

  // Corrupted JSON
  const ctxCorrupt = await setup(t, initial, { focusPreferences: null });
  assert.equal(ctxCorrupt.card(id(10)).classList.contains("is-focus"), false);

  // Non-array structure in focus preferences
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://focus.test/", pretendToBeVisual: true });
  dom.window.localStorage.setItem(FOCUS_PREFERENCE_KEY, "invalid-json{");
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: () => Date.parse(timestamp),
  }));
  view.setHostState({ connected: true, message: "测试" });
  view.acceptReadResult(wrap({ ok: true, board: initial }));
  assert.equal(dom.window.document.querySelector(`[data-task-id="${id(10)}"]`).classList.contains("is-focus"), false);
  view.dispose();
  dom.window.close();
});

async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "expected UI state did not arrive");
}

test("undated legacy localStorage focus is not revived as today's focus", async (t) => {
  const ctx = await setup(t, board([task(10)]), { focusPreferences: { focusTaskIds: [id(10)] } });
  assert.equal(ctx.card(id(10)).classList.contains("is-focus"), false);
  assert.equal(ctx.byId("daily-focus").hidden, true);
});

test("midnight expires focus and selection starts a new day's set", async (t) => {
  let instant = Date.parse("2030-10-05T15:59:00Z");
  const ctx = await setup(t, board([task(10), task(11)]), {
    now: () => instant,
    dailyFocus: { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(10)] },
  });
  instant = Date.parse("2030-10-05T16:00:00Z");
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus"));
  await waitFor(() => !ctx.card(id(10)).classList.contains("is-focus") && !ctx.byId("refresh").disabled);
  assert.equal(ctx.byId("daily-focus").hidden, true);
  ctx.card(id(11)).querySelector(`[data-focus-task="${id(11)}"]`).click();
  await waitFor(() => ctx.card(id(11)).classList.contains("is-focus"));
  assert.deepEqual((await ctx.store.read()).board.dailyFocus, { date: "2030-10-06", timeZone: "Asia/Shanghai", taskIds: [id(11)] });
});

test("focus can be removed while its card is hidden by a search filter", async (t) => {
  const ctx = await setup(t, board([task(10, { title: "焦点目标" }), task(11, { title: "可见任务" })]), {
    dailyFocus: { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(10)] },
  });
  ctx.byId("search").value = "可见任务";
  ctx.byId("search").dispatchEvent(new ctx.dom.window.Event("input"));
  assert.equal(ctx.card(id(10)), null);
  ctx.byId("daily-focus").querySelector(`[data-focus-task="${id(10)}"]`).click();
  await waitFor(() => ctx.byId("daily-focus").hidden);
  assert.deepEqual((await ctx.store.read()).board.dailyFocus.taskIds, []);
});

test("archiving or completing tasks releases persisted focus", async (t) => {
  const ctx = await setup(t, board([task(10), task(11)]), {
    dailyFocus: { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(10), id(11)] },
  });
  let latest = (await ctx.store.read()).board;
  let result = await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: latest.revision, operation: { type: "archive_task", taskId: id(10), archived: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.dailyFocus.taskIds, [id(11)]);
  const { lastUpdatedAt, archivedAt, ...input } = result.board.tasks.find((item) => item.id === id(11));
  result = await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: result.board.revision, operation: { type: "save_task", task: { ...input, status: "completed" } } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.dailyFocus.taskIds, []);
});

test("focus exports, restores, and old backups clear it without changing old checksums", async (t) => {
  const initial = board([task(10)]);
  const ctx = await setup(t, initial, { dailyFocus: { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(10)] } });
  const exported = await ctx.store.data({ action: "export" });
  assert.deepEqual(exported.backup.board.dailyFocus.taskIds, [id(10)]);
  const old = makeBackup(initial, timestamp);
  let latest = (await ctx.store.read()).board;
  let result = await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: latest.revision, operation: { type: "restore_board", backup: old } });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.board, "dailyFocus"), false);
  result = await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: result.board.revision, operation: { type: "restore_board", backup: exported.backup } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.dailyFocus.taskIds, [id(10)]);
});

test("another mounted window reads shared focus on activation; drafts prevent background reads", async (t) => {
  const ctx = await setup(t, board([task(10)]));
  const second = new JSDOM(await loadAppTemplate(), { url: "https://another-window.test/", pretendToBeVisual: true });
  let reads = 0;
  const view = (createI18n(second.window.document, { locale: "zh" }), mountBoard(second.window.document, emptyBoard(), {
    now: () => Date.parse(timestamp), refresh: async () => { reads++; return wrap(await ctx.store.read()); },
    mutate: async (request) => wrap(await ctx.store.mutate(request)),
  }));
  t.after(() => { view.dispose(); second.window.close(); });
  view.setHostState({ connected: true, message: "测试宿主" });
  view.acceptReadResult(wrap(await ctx.store.read()));
  ctx.card(id(10)).querySelector(`[data-focus-task="${id(10)}"]`).click();
  await waitFor(() => ctx.card(id(10)).classList.contains("is-focus"));
  second.window.dispatchEvent(new second.window.Event("focus"));
  await waitFor(() => second.window.document.querySelector(`[data-task-id="${id(10)}"]`).classList.contains("is-focus"));
  assert.equal(reads, 1);
  second.window.document.querySelector(`[data-edit-task="${id(10)}"]`).click();
  second.window.dispatchEvent(new second.window.Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(reads, 1);
});

test("archive has one empty state and no task creation controls", async (t) => {
  const ctx = await setup(t, board([task(10)]));
  ctx.byId("sidebar-archive").click();
  assert.equal(ctx.byId("cards").children.length, 0);
  assert.match(ctx.byId("empty").textContent, /暂无归档任务/);
  assert.equal(ctx.byId("new-task").hidden, true);
  assert.equal(ctx.document.querySelectorAll(".add-task").length, 0);
});

test("shared-focus conflicts and idempotent replay preserve other window selections", async (t) => {
  const ctx = await setup(t, board([task(10), task(11)]));
  const revision = (await ctx.store.read()).board.revision;
  const request = (taskId, expectedRevision) => ({ requestId: randomUUID(), expectedRevision, operation: { type: "set_focus_task", taskId, focused: true, date: "2030-10-05", timeZone: "Asia/Shanghai" } });
  const first = request(id(10), revision);
  const a = await ctx.store.mutate(first);
  assert.equal(a.ok, true);
  const stale = await ctx.store.mutate(request(id(11), revision));
  assert.equal(stale.error.code, "REVISION_CONFLICT");
  assert.deepEqual(stale.board.dailyFocus.taskIds, [id(10)]);
  const b = await ctx.store.mutate(request(id(11), stale.board.revision));
  assert.equal(b.ok, true);
  const replay = await ctx.store.mutate(first);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.board.dailyFocus.taskIds, [id(10), id(11)]);
});

test("archived projects release focus and invalid selections make no revision change", async (t) => {
  const ctx = await setup(t, board([task(10)]), { dailyFocus: { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(10)] } });
  const revision = (await ctx.store.read()).board.revision;
  const archived = await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: revision, operation: { type: "archive_project", projectId: id(1), archived: true } });
  assert.equal(archived.ok, true);
  assert.deepEqual(archived.board.dailyFocus.taskIds, []);
  const refused = await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: archived.board.revision, operation: { type: "set_focus_task", taskId: id(10), focused: true, date: "2030-10-05", timeZone: "Asia/Shanghai" } });
  assert.equal(refused.error.code, "INVALID_INPUT");
  assert.deepEqual((await ctx.store.read()).board, archived.board);
  assert.equal(boardSchema.safeParse({ ...archived.board, dailyFocus: { date: "2030-02-30", timeZone: "Asia/Shanghai", taskIds: [] } }).success, false);
  assert.equal(boardSchema.safeParse({ ...archived.board, dailyFocus: { date: "2030-10-05", timeZone: "Invalid/Zone", taskIds: [] } }).success, false);
});

test("populated archive keeps restore controls and hides creation controls", async (t) => {
  const ctx = await setup(t, board([task(10, { archivedAt: timestamp })]));
  ctx.byId("sidebar-archive").click();
  assert.ok(ctx.card(id(10)));
  assert.equal(ctx.document.querySelectorAll(".add-task").length, 0);
  assert.equal(ctx.byId("new-task").hidden, true);
  assert.equal(ctx.card(id(10)).querySelector(`[data-focus-task="${id(10)}"]`).disabled, true);
  assert.equal(ctx.card(id(10)).querySelector(`[data-archive-task="${id(10)}"]`).textContent, "恢复任务");
});

test("shared focus read deferred by search resumes when the native control loses focus", async (t) => {
  let reads = 0;
  const ctx = await setup(t, board([task(10)]), { refresh: async () => { reads++; return wrap(await ctx.store.read()); } });
  const revision = (await ctx.store.read()).board.revision;
  await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: revision, operation: { type: "set_focus_task", taskId: id(10), focused: true, date: "2030-10-05", timeZone: "Asia/Shanghai" } });
  ctx.byId("search").focus();
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus"));
  assert.equal(reads, 0);
  ctx.byId("search").blur();
  await waitFor(() => ctx.card(id(10)).classList.contains("is-focus"));
  assert.equal(reads, 1);
});

test("an empty archive does not block navigation to the learning calendar", async (t) => {
  const ctx = await setup(t, board([task(10)]));
  ctx.byId("sidebar-archive").click();
  ctx.byId("sidebar-learning").click();
  assert.equal(ctx.byId("schedule-toolbar").hidden, false);
  assert.ok(ctx.document.querySelector(".calendar-day"));
  ctx.byId("sidebar-archive").click();
  assert.equal(ctx.byId("schedule-toolbar").hidden, true);
  assert.equal(ctx.document.querySelector(".calendar-day"), null);
  assert.ok(ctx.byId("new-session").closest("[hidden]"));
});

test("a shared read deferred during a busy read is retried by the next clock tick", async (t) => {
  let reads = 0; let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const timers = new Map(); let timerId = 0;
  const ctx = await setup(t, board([task(10)]), {
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    refresh: async () => { if (++reads === 1) await blocked; return wrap(await ctx.store.read()); },
  });
  const refreshing = ctx.view.refresh();
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("focus"));
  assert.equal(reads, 1);
  release(); await refreshing;
  const [id, callback] = timers.entries().next().value;
  timers.delete(id); callback();
  await waitFor(() => reads === 2 && !ctx.byId("refresh").disabled);
});

test("changing display time zone hides the previous zone's focus without writing until a new selection", async (t) => {
  const ctx = await setup(t, board([task(10), task(11)]), { dailyFocus: { date: "2030-10-05", timeZone: "Asia/Shanghai", taskIds: [id(10)] } });
  const before = (await ctx.store.read()).board;
  ctx.byId("sidebar-learning").click();
  ctx.byId("display-time-zone").value = "UTC";
  ctx.byId("display-time-zone").dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  ctx.byId("sidebar-next").click();
  assert.equal(ctx.card(id(10)).classList.contains("is-focus"), false);
  assert.equal(ctx.byId("daily-focus").hidden, true);
  assert.deepEqual((await ctx.store.read()).board, before);
  ctx.card(id(11)).querySelector(`[data-focus-task="${id(11)}"]`).click();
  await waitFor(() => ctx.card(id(11)).classList.contains("is-focus"));
  assert.deepEqual((await ctx.store.read()).board.dailyFocus, { date: "2030-10-05", timeZone: "UTC", taskIds: [id(11)] });
});
