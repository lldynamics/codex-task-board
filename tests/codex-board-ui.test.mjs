import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { emptyBoard, boardSchema } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { makeBackup } from "../src/store-data.mjs";
import { mountBoard } from "../src/view.mjs";
import { createCards } from "../src/view-cards.mjs";
import { mountCodex } from "../src/view-codex.mjs";
import { projectCodexSnapshot } from "../src/codex-board.mjs";
import { codexSnapshotSchema, unavailableCodexSnapshot, CODEX_SNAPSHOT_STALE_MS } from "../src/codex-domain.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { tick, waitFor } from "./helpers.mjs";

const timestamp = "2030-10-05T04:00:00.000Z";
const id = (number) => `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
const settle = (predicate) => waitFor(predicate, "操作须在测试结束前完成");
const wrap = (payload) => ({ structuredContent: payload, ...(payload.ok ? {} : { isError: true }) });
const thread = (number = 1, fields = {}) => ({ id: id(number), hostId: "local", title: `自动任务 ${number}`, cwd: "/workspace/project", updatedAt: timestamp, runtimeStatus: "unknown", attention: null, lastTurnStatus: null, goalStatus: null, ...fields });
function snapshot(threads, fields = {}) {
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null };
  return codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(timestamp), connection: { state: "connected", source: "desktop-snapshot", lastSuccessAt: timestamp, error: null, scope: "测试采集范围" }, sources: { threads: source, automations: { ...source } }, completeness: { threads: true, automations: true, truncated: false }, threads, ...fields });
}
function manualBoard(count = 2) {
  return boardSchema.parse({ ...emptyBoard(), projects: [{ id: id(90), name: "手工项目", description: "手工项目说明", lastUpdatedAt: timestamp }], tasks: Array.from({ length: count }, (_, number) => ({ id: id(100 + number), projectId: id(90), title: `手工任务 ${number}`, status: "in_progress", sourceTool: "手工来源", currentStep: "手工步骤", blocker: "", conversationUrl: null, lastUpdatedAt: timestamp })) });
}
function clock() {
  let current = Date.parse(timestamp); let sequence = 0; const timers = new Map();
  return {
    now: () => current, setTimeout(callback, ms) { const id = ++sequence; timers.set(id, { at: current + ms, callback }); return id; }, clearTimeout(id) { timers.delete(id); },
    async advance(ms) { const end = current + ms; while (true) { const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; current = next[1].at; timers.delete(next[0]); next[1].callback(); await tick(); } current = end; await tick(); },
    get pending() { return timers.size; },
  };
}
async function setup(t, { initial = manualBoard(), preferences = { viewMode: "board" }, ...options } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-board-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  await store.mutate({ requestId: randomUUID(), expectedRevision: 0, operation: { type: "restore_board", backup: makeBackup(initial, timestamp) } });
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://codex-board.test/", pretendToBeVisual: true });
  if (preferences) dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify(preferences));
  const scheduler = clock(); const calls = []; const opened = []; const copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (value) => copied.push(value) } });
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
    refresh: async () => wrap(await store.read()), data: async (request) => wrap(await store.data(request)),
    mutate: async (request) => { calls.push(structuredClone(request)); return wrap(await store.mutate(request)); },
    openThread: async (threadId, hostId) => { opened.push({ threadId, hostId }); return {}; }, ...options,
  }));
  view.setHostState({ connected: true, message: "测试宿主" }); view.acceptReadResult(wrap(await store.read()));
  t.after(() => { view.dispose(); dom.window.close(); });
  const document = dom.window.document;
  const ctx = { dom, document, view, store, clock: scheduler, calls, opened, copied, byId: (value) => document.getElementById(value), card: (id) => document.querySelector(`[data-task-id="${id}"]`) };
  ctx.change = (field, value) => { const node = ctx.byId(field); node.value = value; node.dispatchEvent(new dom.window.Event(node.matches("input,textarea") ? "input" : "change", { bubbles: true })); };
  ctx.setSnapshot = (value) => { assert.equal(view.setCodexSnapshot(value), true); return projectCodexSnapshot(value, { now: scheduler.now() }); };
  return ctx;
}

test("same directory names on different paths and hosts become independent Codex project groups", async (t) => {
  const ctx = await setup(t);
  const value = snapshot([thread(1, { cwd: "/a/shared" }), thread(2, { cwd: "/b/shared" }), thread(3, { hostId: "fedora", cwd: "/a/shared" }), thread(4, { cwd: null })]);
  const projection = ctx.setSnapshot(value);
  const rows = [...ctx.document.querySelectorAll('[data-sidebar-project][data-origin="codex"]')];
  assert.equal(rows.length, 4); assert.equal(new Set(rows.map((row) => row.dataset.sidebarProject)).size, 4);
  assert.match(ctx.byId("sidebar-projects").textContent, /手工项目.*Codex 自动项目 · 只读/s);
  for (const project of projection.projects) {
    const row = rows.find((row) => row.dataset.sidebarProject === project.id); assert.ok(row); assert.ok(row.textContent.includes(project.name)); assert.ok(row.textContent.includes(project.hostId)); assert.ok(row.title.includes(project.cwd || "未关联目录"));
    assert.equal(row.querySelector(".sidebar-project-path"), null); assert.equal(row.parentElement.querySelector("[data-sidebar-project-menu]"), null);
    if (project.cwd) assert.ok(!row.textContent.includes(project.cwd), "Full directory belongs in the source title, keeping project rows compact");
    row.click();
    assert.equal(ctx.byId("project-filter").value, project.id);
    assert.deepEqual([...ctx.document.querySelectorAll("#cards [data-task-id]")].map((card) => card.dataset.taskId), projection.tasks.filter((task) => task.projectId === project.id).map((task) => task.id));
    assert.deepEqual([...ctx.document.querySelectorAll("#cards [data-status]")].map((column) => column.dataset.status), ["unknown"]);
  }
});

test("combined counts, search, project, source and readonly status filters include Codex tasks", async (t) => {
  const ctx = await setup(t);
  const projection = ctx.setSnapshot(snapshot([thread(1), thread(2, { runtimeStatus: "active" }), thread(3, { cwd: "/other/repo", lastTurnStatus: "completed" })]));
  assert.equal(ctx.byId("count").textContent, "5 / 5 项任务"); assert.equal(ctx.byId("project-count").textContent, "3 个项目");
  assert.equal(ctx.byId("sidebar-all").querySelector("[data-sidebar-count]").textContent, "5");
  assert.ok([...ctx.byId("status-filter").options].some((option) => option.value === "unknown"));
  assert.ok(![...ctx.byId("task-status").options].some((option) => ["unknown", "turn_ended"].includes(option.value)));
  ctx.change("record-filter", "codex"); assert.equal(ctx.byId("count").textContent, "3 / 5 项任务");
  ctx.change("status-filter", "unknown"); assert.equal(ctx.byId("count").textContent, "1 / 5 项任务");
  ctx.byId("clear").click(); ctx.change("search", "/other/repo"); assert.equal(ctx.byId("count").textContent, "1 / 5 项任务");
  ctx.byId("clear").click(); ctx.change("project-filter", projection.tasks[0].projectId);
  assert.equal(ctx.byId("count").textContent, "2 / 5 项任务");
  assert.ok([...ctx.document.querySelectorAll("#cards .kanban-column")].every((column) => Number(column.querySelector(".column-count").textContent) > 0));
});

test("fresh idle, not-loaded and truly unknown Codex tasks have distinct occupied columns and readonly filters", async (t) => {
  const ctx = await setup(t);
  const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "idle" }), thread(2, { runtimeStatus: "notLoaded" }), thread(3, { runtimeStatus: "unknown" })]));
  ctx.change("project-filter", projection.projects[0].id);
  assert.deepEqual([...ctx.document.querySelectorAll('#cards [data-status]')].map((column) => column.dataset.status), ["idle", "not_loaded", "unknown"]);
  for (const [number, status, label] of [[1, "idle", "空闲 · 完成情况未知"], [2, "not_loaded", "未加载 · 完成情况未知"], [3, "unknown", "状态未知 · 来源未提供当前状态"]]) {
    const task = projection.tasks.find((task) => task.threadId === id(number));
    const card = ctx.card(task.id);
    assert.equal(card.querySelector(".status").textContent, label); assert.ok(card.querySelector(`.status-${status}`));
    assert.equal(card.draggable, false); assert.equal(card.querySelectorAll('[data-edit-task],[data-move-control],[data-archive-task]').length, 0);
    assert.equal([...ctx.byId("status-filter").options].filter((option) => option.value === status).length, 1);
    assert.ok(![...ctx.byId("task-status").options].some((option) => option.value === status));
    ctx.change("status-filter", status);
    assert.equal(ctx.byId("count").textContent, "1 / 5 项任务"); assert.ok(ctx.card(task.id));
    assert.equal(ctx.document.querySelectorAll('#cards [data-task-id]').length, 1);
    ctx.change("status-filter", "all");
  }
  ctx.change("project-filter", id(90));
  assert.deepEqual([...ctx.document.querySelectorAll('#cards [data-status]')].map((column) => column.dataset.status), ["planned", "in_progress", "waiting_user", "completed", "paused", "failed"]);
  assert.deepEqual([...ctx.card(id(100)).querySelector('[data-move-control="status"]').options].map((option) => option.value), ["planned", "in_progress", "waiting_user", "completed", "paused", "failed"]);
  assert.deepEqual(ctx.calls, []);
});

test("idle and not-loaded cards remain present but explain expired and unavailable runtime", async (t) => {
  const ctx = await setup(t);
  const value = snapshot([thread(1, { runtimeStatus: "idle" }), thread(2, { runtimeStatus: "notLoaded" }), thread(3, { runtimeStatus: "idle", goalStatus: "complete" }), thread(4, { runtimeStatus: "notLoaded", lastTurnStatus: "completed" })]);
  const projection = ctx.setSnapshot(value); ctx.change("project-filter", projection.projects[0].id);
  await ctx.clock.advance(CODEX_SNAPSHOT_STALE_MS + 5000);
  for (const number of [1, 2]) assert.equal(ctx.card(projection.tasks.find((task) => task.threadId === id(number)).id).querySelector(".status").textContent, "状态未知 · 采集已过期");
  assert.equal(ctx.card(projection.tasks.find((task) => task.threadId === id(3)).id).querySelector(".status").textContent, "目标已完成");
  assert.match(ctx.card(projection.tasks.find((task) => task.threadId === id(4)).id).querySelector(".status").textContent, /^本轮结束/);
  assert.ok(!ctx.document.querySelector('#cards [data-status="idle"]')); assert.ok(!ctx.document.querySelector('#cards [data-status="not_loaded"]'));
  ctx.setSnapshot({ ...value, observedAt: new Date(ctx.clock.now()).toISOString(), sources: { ...value.sources, threads: { ...value.sources.threads, state: "disconnected", error: { code: "UNAVAILABLE", message: "测试断线" } } } });
  for (const number of [1, 2]) assert.equal(ctx.card(projection.tasks.find((task) => task.threadId === id(number)).id).querySelector(".status").textContent, "状态未知 · 来源不可用");
  assert.deepEqual(ctx.calls, []);
});

test("selecting an automatic failed project reveals its tasks without expanding folded manual columns", async (t) => {
  const ctx = await setup(t); const projection = ctx.setSnapshot(snapshot([thread(1, { lastTurnStatus: "failed" })]));
  assert.equal(ctx.document.querySelector('[data-status="failed"]').classList.contains("is-collapsed"), true);
  ctx.change("project-filter", projection.projects[0].id); assert.ok(ctx.card(projection.tasks[0].id)); assert.equal(ctx.document.querySelector('[data-status="failed"]').classList.contains("is-collapsed"), false);
  ctx.change("project-filter", id(90)); assert.equal(ctx.document.querySelector('[data-status="failed"]').classList.contains("is-collapsed"), true);
});

test("Codex cards open and copy raw IDs but have no edit, drag, archive, quick edit or scheduling writers", async (t) => {
  const ctx = await setup(t); const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "active" })])); const task = projection.tasks[0]; const card = ctx.card(task.id);
  assert.equal(card.draggable, false); assert.equal(card.querySelectorAll("[data-edit-task],[data-move-control],[data-archive-task],[data-quick-task]").length, 0);
  card.querySelector("[data-codex-task-open]").click(); await tick(); assert.deepEqual(ctx.opened, [{ threadId: id(1), hostId: "local" }]);
  card.querySelector("[data-codex-task-copy]").click(); await tick(); assert.deepEqual(ctx.copied, [id(1)]);
  const event = new ctx.dom.window.Event("dragstart", { bubbles: true, cancelable: true }); card.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  ctx.change("project-filter", task.projectId);
  for (const field of ["new-task", "edit-project", "archive-project"]) { assert.equal(ctx.byId(field).disabled, true); ctx.byId(field).dispatchEvent(new ctx.dom.window.Event("click", { bubbles: true })); }
  assert.equal(ctx.byId("task-form").hidden, true); assert.equal(ctx.byId("project-form").hidden, true); assert.equal(ctx.document.querySelectorAll("#cards .add-task").length, 0);
  ctx.byId("view-list").click(); assert.equal(ctx.document.querySelectorAll("[data-quick-task]").length, 0);
  ctx.byId("view-today").click(); assert.match(ctx.byId("calendar-summary").textContent, /Codex 自动项目只读.*不关联手工学习时段/); assert.equal(ctx.byId("new-session").disabled, true);
  assert.equal(ctx.document.querySelectorAll("[data-session-id]").length, 0); assert.deepEqual(ctx.calls, []);
  await ctx.view.exportBackup(); const backup = JSON.parse(ctx.byId("export-json").value); assert.equal(backup.board.tasks.length, 2); assert.equal(backup.board.projects.length, 1); assert.ok(!backup.board.tasks.some((task) => task.id.startsWith("codex-")));
});

test("mixed columns compute up/down anchors only from manual tasks", async (t) => {
  const ctx = await setup(t); const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "active" })]));
  assert.equal(ctx.document.querySelectorAll('[data-status="in_progress"] [data-task-id]').length, 3);
  assert.equal(ctx.card(id(101)).querySelector('[data-move-control="down"]').disabled, true);
  ctx.card(id(100)).querySelector('[data-move-control="down"]').click(); await settle(() => ctx.byId("save-status").textContent === "已移动并保存到本机。");
  assert.equal(ctx.calls.length, 1); assert.deepEqual(ctx.calls[0].operation, { type: "move_task", taskId: id(100), status: "in_progress", beforeTaskId: null });
  assert.ok(ctx.card(projection.tasks[0].id));
  const result = await ctx.store.read(); assert.deepEqual(result.board.tasks.map((task) => task.id), [id(101), id(100)]);
});

test("snapshot updates retain manual detail drafts, search focus and confirmed instant field values", async (t) => {
  const ctx = await setup(t); const value = snapshot([thread(1)]); ctx.setSnapshot(value);
  ctx.card(id(100)).querySelector("[data-edit-task]").click(); ctx.byId("task-read-edit").click(); ctx.change("task-title", "必须保留的手工详情草稿"); ctx.byId("task-title").focus(); ctx.byId("task-title").setSelectionRange(2, 4);
  ctx.setSnapshot({ ...value, observedAt: "2030-10-05T04:00:01.000Z", threads: [thread(1, { runtimeStatus: "active" })] });
  assert.equal(ctx.byId("task-title").value, "必须保留的手工详情草稿"); assert.equal(ctx.document.activeElement, ctx.byId("task-title")); assert.equal(ctx.byId("task-title").selectionStart, 2);
  ctx.byId("editor-close").click(); ctx.byId("discard-edits").click(); ctx.byId("view-list").click();
  ctx.card(id(100)).querySelector("[data-quick-toggle]").click();
  const quick = ctx.card(id(100)).querySelector('[data-quick-field="priority"]'); quick.value = "high"; quick.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  await settle(() => ctx.byId("save-status").textContent === "已保存到本机。");
  ctx.card(id(100)).querySelector('[data-quick-field="priority"]').focus();
  ctx.setSnapshot({ ...value, observedAt: "2030-10-05T04:00:02.000Z", threads: [thread(1, { attention: "input" })] });
  assert.equal(ctx.card(id(100)).querySelector('[data-quick-field="priority"]').value, "high"); assert.equal(ctx.document.activeElement, ctx.card(id(100)).querySelector('[data-quick-field="priority"]'));
  ctx.change("search", "手工"); ctx.byId("search").focus(); ctx.setSnapshot({ ...value, observedAt: "2030-10-05T04:00:03.000Z" }); assert.equal(ctx.byId("search").value, "手工"); assert.equal(ctx.document.activeElement, ctx.byId("search")); assert.equal(ctx.calls.length, 1); assert.deepEqual(ctx.calls[0].operation, { type: "patch_task", taskId: id(100), patch: { priority: "high" } });
});

test("Codex updates preserve the manual revision used by a subsequent explicit save", async (t) => {
  const ctx = await setup(t); ctx.setSnapshot(snapshot([thread(1)]));
  const before = (await ctx.store.read()).board;
  ctx.card(id(100)).querySelector("[data-edit-task]").click(); ctx.byId("task-read-edit").click(); ctx.change("task-title", "自动同步期间保存手工任务");
  ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "active" }), thread(2)], { observedAt: "2030-10-05T04:00:01.000Z" }));
  ctx.byId("task-form").querySelector('[type="submit"]').click(); await settle(() => ctx.byId("save-status").textContent === "已保存到本机。");
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0].expectedRevision, before.revision); assert.equal(ctx.calls[0].operation.task.projectId, id(90));
  const saved = (await ctx.store.read()).board; assert.equal(saved.tasks.length, 2); assert.equal(saved.tasks.find((task) => task.id === id(100)).title, "自动同步期间保存手工任务"); assert.equal(saved.projects.length, 1);
});

test("a changed automatic task does not reset manual pagination or the active source filter", async (t) => {
  const ctx = await setup(t, { initial: manualBoard(70) }); const value = snapshot([thread(1, { runtimeStatus: "active" })]); ctx.setSnapshot(value);
  ctx.document.querySelector('[data-status="in_progress"] [data-page-control="next"]').click();
  assert.equal(ctx.document.querySelector('[data-status="in_progress"]').dataset.page, "1");
  ctx.setSnapshot({ ...value, observedAt: "2030-10-05T04:00:01.000Z", threads: [thread(1, { runtimeStatus: "active", title: "变化的自动任务" })] });
  assert.equal(ctx.document.querySelector('[data-status="in_progress"]').dataset.page, "1");
  ctx.change("source-filter", JSON.stringify("手工来源"));
  ctx.setSnapshot({ ...value, observedAt: "2030-10-05T04:00:02.000Z", threads: [thread(1, { attention: "input" })] });
  assert.equal(ctx.byId("source-filter").value, JSON.stringify("手工来源")); assert.equal(ctx.byId("count").textContent, "70 / 71 项任务");
});

test("snapshot insertions follow a focused Codex task across pages and retain an unfocused page", async (t) => {
  const ctx = await setup(t);
  const threads = Array.from({ length: 50 }, (_, index) => thread(index + 1, { title: `task ${String(index + 1).padStart(3, "0")}`, runtimeStatus: "active" }));
  const projection = ctx.setSnapshot(snapshot(threads));
  ctx.change("project-filter", projection.projects[0].id);
  const taskId = projection.tasks.find((task) => task.threadId === id(50)).id;
  ctx.card(taskId).querySelector("[data-codex-task-open]").focus();
  const next = snapshot([thread(0, { title: "task 000", runtimeStatus: "active" }), ...threads], { observedAt: "2030-10-05T04:00:01.000Z" });
  ctx.setSnapshot(next);
  assert.equal(ctx.document.querySelector('[data-status="in_progress"]').dataset.page, "1");
  assert.equal(ctx.document.activeElement, ctx.card(taskId).querySelector("[data-codex-task-open]"));
  assert.equal(ctx.document.querySelector('[data-status="in_progress"] .page-count').textContent, "51–51/51");
  ctx.byId("search").focus();
  ctx.setSnapshot({ ...next, observedAt: "2030-10-05T04:00:02.000Z", threads: next.threads.map((item) => item.id === id(0) ? { ...item, title: "task 000 updated" } : item) });
  assert.equal(ctx.document.querySelector('[data-status="in_progress"]').dataset.page, "1");
  assert.equal(ctx.document.activeElement, ctx.byId("search"));
  assert.deepEqual(ctx.calls, []);
});

test("a focused Codex task moving into a folded automatic column remains visible without unfolding manual columns", async (t) => {
  const ctx = await setup(t);
  const value = snapshot([thread(1, { runtimeStatus: "active" }), thread(2, { lastTurnStatus: "failed" })]);
  const projection = ctx.setSnapshot(value); ctx.change("project-filter", projection.projects[0].id);
  ctx.document.querySelector('[data-toggle-column="failed"]').click();
  assert.equal(ctx.document.querySelector('[data-status="failed"]').classList.contains("is-collapsed"), true);
  const taskId = projection.tasks.find((task) => task.threadId === id(1)).id;
  ctx.card(taskId).querySelector("[data-codex-task-copy]").focus();
  ctx.setSnapshot({ ...value, observedAt: "2030-10-05T04:00:01.000Z", threads: [thread(1, { runtimeStatus: "error" }), thread(2, { lastTurnStatus: "failed" })] });
  assert.equal(ctx.document.querySelector('[data-status="failed"]').classList.contains("is-collapsed"), false);
  assert.equal(ctx.document.activeElement, ctx.card(taskId).querySelector("[data-codex-task-copy]"));
  ctx.change("project-filter", id(90));
  assert.equal(ctx.document.querySelector('[data-status="failed"]').classList.contains("is-collapsed"), true);
  assert.deepEqual(ctx.calls, []);
});

test("search and source matches unfold automatic columns while search preserves nonmatching folds", async (t) => {
  const ctx = await setup(t);
  const projection = ctx.setSnapshot(snapshot([thread(1, { title: "唯一搜索命中", runtimeStatus: "active" }), thread(2, { attention: "input" }), thread(3, { lastTurnStatus: "failed" })]));
  ctx.change("project-filter", projection.projects[0].id);
  for (const status of ["in_progress", "waiting_user", "failed"]) ctx.document.querySelector(`[data-toggle-column="${status}"]`).click();
  ctx.change("search", "唯一搜索命中");
  assert.equal(ctx.byId("count").textContent, "1 / 5 项任务");
  assert.ok(ctx.card(projection.tasks.find((task) => task.threadId === id(1)).id));
  assert.equal(ctx.document.querySelector('[data-status="in_progress"]').classList.contains("is-collapsed"), false);
  ctx.change("search", "");
  for (const status of ["waiting_user", "failed"]) assert.equal(ctx.document.querySelector(`[data-status="${status}"]`).classList.contains("is-collapsed"), true);
  ctx.document.querySelector('[data-toggle-column="in_progress"]').click();
  ctx.change("record-filter", "codex");
  for (const status of ["in_progress", "waiting_user", "failed"]) assert.equal(ctx.document.querySelector(`[data-status="${status}"]`).classList.contains("is-collapsed"), false);
  assert.equal(ctx.document.querySelectorAll('#cards [data-task-id]').length, 3);
  assert.deepEqual(ctx.calls, []);
});

test("many automatic sidebar rows keep their content height and ellipsis styling instead of shrinking", async (t) => {
  const ctx = await setup(t);
  ctx.setSnapshot(snapshot(Array.from({ length: 49 }, (_, index) => thread(index + 1, { cwd: `/very/long/directory/${"path-".repeat(20)}${index}/project`, hostId: `host-${"remote-".repeat(15)}${index}` }))));
  const style = (node) => ctx.dom.window.getComputedStyle(node);
  const rows = ctx.document.querySelectorAll('[data-sidebar-project][data-origin="codex"]');
  assert.equal(rows.length, 49);
  for (const row of rows) {
    assert.equal(style(row.parentElement).flexShrink, "0"); assert.equal(style(row).minHeight, "51px"); assert.equal(style(row).lineHeight, "18px");
    assert.equal(row.querySelector(".sidebar-project-path"), null); assert.match(row.title, /\/very\/long\/directory\//);
    for (const detail of row.querySelectorAll(".sidebar-project-source")) {
      assert.equal(style(detail).fontSize, "12px"); assert.equal(style(detail).lineHeight, "18px"); assert.equal(style(detail).whiteSpace, "nowrap"); assert.equal(style(detail).overflow, "hidden"); assert.equal(style(detail).textOverflow, "ellipsis");
    }
  }
  for (const heading of ctx.document.querySelectorAll(".sidebar-group-heading")) assert.equal(style(heading).flexShrink, "0");
});

test("large mixed columns compute manual move neighbours within a linear record-read budget", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>"); t.after(() => dom.window.close());
  let recordReads = 0;
  const board = manualBoard(5000);
  const manualTasks = board.tasks.map((task) => new Proxy(task, { get(target, key, receiver) { if (key === "id") recordReads += 1; return Reflect.get(target, key, receiver); } }));
  const columnTasks = manualTasks.flatMap((task, index) => [task, { id: `codex-task-${index}`, origin: "codex", readOnly: true }]);
  const moves = [];
  const state = { board: { ...board, tasks: manualTasks }, presentation: { mode: "board" }, editor: { kind: null } };
  const cards = createCards({ document: dom.window.document, state, options: {}, refs: {}, callbacks: { isArchived: () => false, displayProjectsById: () => new Map(board.projects.map((project) => [project.id, project])), prepareCardMenu() {}, startMove: (...args) => moves.push(args) } });
  const visible = manualTasks.slice(0, 50).map((task, index) => cards.renderCard(task, columnTasks, index * 2));
  const last = cards.renderCard(manualTasks.at(-1), columnTasks, columnTasks.length - 2);
  assert.ok(recordReads < manualTasks.length * 3, `51 visible cards must use a linear neighbour lookup; observed ${recordReads} record reads`);
  assert.equal(visible[0].querySelector('[data-move-control="up"]').dataset.boundary, "true");
  assert.equal(last.querySelector('[data-move-control="down"]').dataset.boundary, "true");
  visible[0].querySelector('[data-move-control="down"]').click();
  assert.deepEqual(moves, [[id(100), "in_progress", id(102)]]);
});

for (const invalidProject of [42, { id: "codex-project-invalid" }]) {
  test(`invalid saved project preference ${JSON.stringify(invalidProject)} does not interrupt manual or Codex reads`, async (t) => {
    const ctx = await setup(t, { preferences: { project: invalidProject, viewMode: "board" } });
    assert.equal(ctx.byId("project-filter").value, "all"); assert.equal(ctx.byId("count").textContent, "2 / 2 项任务");
    const result = await ctx.store.read(); assert.equal(ctx.view.acceptReadResult(wrap(result)), true);
    ctx.setSnapshot(snapshot([thread(1)]));
    assert.equal(ctx.byId("count").textContent, "3 / 3 项任务"); assert.equal(ctx.document.querySelectorAll('#cards [data-origin="codex"]').length, 1);
    assert.deepEqual(ctx.calls, []);
  });
}

test("unchanged projections keep manual card DOM and active drag even when collection time advances", async (t) => {
  const ctx = await setup(t); const value = snapshot([thread(1)]); ctx.setSnapshot(value); const card = ctx.card(id(100));
  card.dispatchEvent(new ctx.dom.window.Event("dragstart", { bubbles: true, cancelable: true })); assert.equal(card.classList.contains("is-dragging"), true);
  const next = { ...value, observedAt: "2030-10-05T04:00:01.000Z", sources: { ...value.sources, threads: { ...value.sources.threads, lastSuccessAt: "2030-10-05T04:00:01.000Z" } } };
  ctx.setSnapshot(next); assert.equal(ctx.card(id(100)), card); assert.equal(card.classList.contains("is-dragging"), true);
  card.dispatchEvent(new ctx.dom.window.Event("dragend", { bubbles: true }));
  const changed = { ...next, threads: [thread(1, { title: "更新过的自动任务" })] };
  ctx.setSnapshot(changed); assert.match(ctx.byId("cards").textContent, /更新过的自动任务/);
});

test("TTL and read errors retain cards without claiming stale runtime completion or approval", async (t) => {
  const ctx = await setup(t); const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "active" }), thread(2, { attention: "approval" }), thread(3, { lastTurnStatus: "completed" })]));
  ctx.view.safeCodexError("暂时断线"); assert.match(ctx.card(projection.tasks.find((task) => task.threadId === id(1)).id).textContent, /运行中/);
  await ctx.clock.advance(CODEX_SNAPSHOT_STALE_MS + 5000);
  for (const number of [1, 2]) { const card = ctx.card(projection.tasks.find((task) => task.threadId === id(number)).id); assert.ok(card); assert.equal(card.querySelector(".status").textContent, "状态未知 · 采集已过期"); }
  assert.match(ctx.card(projection.tasks.find((task) => task.threadId === id(3)).id).querySelector(".status").textContent, /本轮结束/);
  assert.match(ctx.byId("codex-board-source").textContent, /数据已过期.*读取失败/);
  assert.equal(ctx.view.setCodexSnapshot({ version: 99 }), false); assert.equal(ctx.document.querySelectorAll('[data-origin="codex"].task-card').length, 3);
});

test("one poller loads in the manual tab, remains single-flight across tabs, and pauses on hidden pages", async (t) => {
  const ctx = await setup(t); let calls = 0; let hidden = false;
  Object.defineProperty(ctx.document, "visibilityState", { get: () => hidden ? "hidden" : "visible" });
  const codex = (createI18n(ctx.document, { locale: "zh" }), mountCodex(ctx.document, { pollInManual: true, now: ctx.clock.now, setTimeout: ctx.clock.setTimeout, clearTimeout: ctx.clock.clearTimeout, refresh: async () => { calls += 1; return wrap({ ok: true, snapshot: snapshot([thread(1)]) }); }, onSnapshot: ctx.view.setCodexSnapshot, onReadError: ctx.view.safeCodexError }));
  t.after(() => codex.dispose()); codex.setHostState({ connected: true }); await tick(); assert.equal(calls, 1); assert.equal(ctx.byId("codex-panel").hidden, true); assert.equal(ctx.document.querySelectorAll('#manual-board [data-origin="codex"].task-card').length, 1);
  await ctx.clock.advance(5000); assert.equal(calls, 2); ctx.byId("codex-tab").click(); await tick(); assert.equal(calls, 3); ctx.byId("manual-tab").click(); await tick(); assert.equal(calls, 4);
  await ctx.clock.advance(5000); assert.equal(calls, 5);
  hidden = true; ctx.document.dispatchEvent(new ctx.dom.window.Event("visibilitychange")); await ctx.clock.advance(60000); assert.equal(calls, 5);
  hidden = false; ctx.document.dispatchEvent(new ctx.dom.window.Event("visibilitychange")); await tick(); assert.equal(calls, 6);
});

test("an uncooperative timed-out read cannot prevent readonly task freshness from expiring", async (t) => {
  const ctx = await setup(t); let calls = 0; let resolve;
  const value = snapshot([thread(1, { runtimeStatus: "active", lastTurnStatus: "running" })]);
  const codex = (createI18n(ctx.document, { locale: "zh" }), mountCodex(ctx.document, { pollInManual: true, now: ctx.clock.now, setTimeout: ctx.clock.setTimeout, clearTimeout: ctx.clock.clearTimeout,
    refresh: () => { calls += 1; return calls === 1 ? Promise.resolve(wrap({ ok: true, snapshot: value })) : new Promise((done) => { resolve = done; }); }, onSnapshot: ctx.view.setCodexSnapshot, onReadError: ctx.view.safeCodexError }));
  t.after(() => codex.dispose()); codex.setHostState({ connected: true }); await tick(); const projected = projectCodexSnapshot(value, { now: ctx.clock.now() }).tasks[0];
  await ctx.clock.advance(CODEX_SNAPSHOT_STALE_MS + 5000); assert.equal(calls, 2); assert.equal(ctx.card(projected.id).querySelector(".status").textContent, "状态未知 · 采集已过期"); assert.match(ctx.byId("codex-diagnostic-count").textContent, /状态未知/);
  codex.dispose(); resolve(wrap({ ok: true, snapshot: value })); await tick();
});

test("a saved Codex project filter is restored only after its first valid snapshot", async (t) => {
  const value = snapshot([thread(1)]); const projectId = projectCodexSnapshot(value, { now: Date.parse(timestamp) }).projects[0].id;
  const ctx = await setup(t, { preferences: { project: projectId, viewMode: "board" } }); assert.equal(ctx.byId("project-filter").value, "all");
  ctx.setSnapshot(value); assert.equal(ctx.byId("project-filter").value, projectId); assert.equal(ctx.byId("count").textContent, "1 / 3 项任务");
});
