import { createI18n } from "../src/i18n.mjs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { boardSchema, emptyBoard, mutationInputSchema, TOOL_NAME, MUTATION_TOOL_NAME, DATA_TOOL_NAME, VERSION } from "../src/board.mjs";
import { makeBackup, validateBackup } from "../src/store-data.mjs";
import { mountBoard, STATUS_LABELS, PAGE_SIZE } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { CODEX_TOOL_NAME, unavailableCodexSnapshot } from "../src/codex-domain.mjs";
import { tick } from "./helpers.mjs";

const timestamp = "2026-10-04T12:00:00.000Z";
const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";
const readResult = (board) => ({ content: [], structuredContent: { ok: true, board: structuredClone(board) } });
const saveResult = (board, replayed = false, appliedRevision = board.revision, entityId) => ({ content: [], structuredContent: { ok: true, board: structuredClone(board), replayed, appliedRevision, ...(entityId ? { entityId } : {}) } });
const failure = (code, board) => ({ isError: true, content: [{ type: "text", text: code }], structuredContent: { ok: false, error: { code, message: "Test error" }, ...(board ? { board: structuredClone(board) } : {}) } });

function fixture() {
  return boardSchema.parse({
    ...emptyBoard(), revision: 3,
    projects: [
      { id: projectId, name: "英语学习", description: "每日学习与复习", lastUpdatedAt: timestamp },
      { id: otherProjectId, name: "网站维护", description: "改进页面", lastUpdatedAt: timestamp },
    ],
    tasks: [{ id: taskId, projectId, title: "复习词汇", status: "planned", sourceTool: "手动来源", currentStep: "整理今日词汇", blocker: "等待材料", lastUpdatedAt: timestamp, conversationUrl: null }],
  });
}

function fakeStore(initial = emptyBoard()) {
  let board = boardSchema.parse(initial);
  const calls = [];
  const replay = new Map();
  return {
    calls,
    get board() { return structuredClone(board); },
    set board(value) { board = boardSchema.parse(value); },
    refresh: async () => readResult(board),
    async data(input) {
      if (input.action === "export") return { structuredContent: { ok: true, backup: makeBackup(board, timestamp) } };
      try {
        const backup = validateBackup(input.backup);
        return { structuredContent: { ok: true, board: structuredClone(board), preview: {
          sourceRevision: backup.board.revision, projectCount: backup.board.projects.length, taskCount: backup.board.tasks.length, sessionCount: backup.board.sessions?.length || 0,
          archivedProjectCount: backup.board.projects.filter((project) => project.archivedAt).length,
          archivedTaskCount: backup.board.tasks.filter((task) => task.archivedAt).length,
        } } };
      } catch { return failure("INVALID_INPUT"); }
    },
    async mutate(raw) {
      const request = mutationInputSchema.parse(raw);
      calls.push(structuredClone(request));
      if (replay.has(request.requestId)) { const receipt = replay.get(request.requestId); return saveResult(board, true, receipt.revision, receipt.entityId); }
      if (request.expectedRevision !== board.revision) return failure("REVISION_CONFLICT", board);
      const operation = request.operation;
      let entityId;
      if (operation.type === "move_task") {
        const index = board.tasks.findIndex((task) => task.id === operation.taskId);
        if (index < 0) return failure("NOT_FOUND", board);
        if (operation.beforeTaskId === operation.taskId) return failure("INVALID_INPUT", board);
        if (operation.beforeTaskId !== null) {
          const anchor = board.tasks.find((task) => task.id === operation.beforeTaskId);
          if (!anchor) return failure("NOT_FOUND", board);
          if (anchor.status !== operation.status) return failure("INVALID_INPUT", board);
        }
        const [task] = board.tasks.splice(index, 1);
        const destination = operation.beforeTaskId === null ? board.tasks.length : board.tasks.findIndex((task) => task.id === operation.beforeTaskId);
        board.tasks.splice(destination, 0, { ...task, status: operation.status, lastUpdatedAt: timestamp });
      } else if (operation.type === "patch_task") {
        const record = board.tasks.find((task) => task.id === operation.taskId);
        if (!record) return failure("NOT_FOUND", board);
        Object.assign(record, operation.patch, { lastUpdatedAt: timestamp });
        entityId = record.id;
      } else if (operation.type === "archive_task" || operation.type === "archive_project") {
        const records = operation.type === "archive_task" ? board.tasks : board.projects;
        entityId = operation.taskId || operation.projectId;
        const record = records.find((item) => item.id === entityId);
        if (!record) return failure("NOT_FOUND", board);
        record.archivedAt = operation.archived ? timestamp : null;
      } else if (operation.type === "restore_board") {
        const currentRevision = board.revision;
        board = { ...validateBackup(operation.backup).board, revision: currentRevision };
      } else {
        const records = operation.type === "save_project" ? board.projects : board.tasks;
        const input = operation.type === "save_project" ? operation.project : operation.task;
        const id = input.id || randomUUID();
        entityId = id;
        const index = records.findIndex((item) => item.id === id);
        const record = { ...(index >= 0 ? records[index] : {}), ...input, id, lastUpdatedAt: timestamp };
        if (index >= 0) records[index] = record;
        else records.push(record);
      }
      board.revision += 1;
      board = boardSchema.parse(board);
      replay.set(request.requestId, { revision: board.revision, entityId });
      return saveResult(board, false, board.revision, entityId);
    },
  };
}

async function component({ board = emptyBoard(), connected = true, store = fakeStore(board), mutate = store.mutate, refresh = store.refresh, data = store.data, preferences = { viewMode: "board" }, now } = {}) {
  const html = await loadAppTemplate();
  const dom = new JSDOM(html, { url: "https://board.test/" });
  if (preferences) dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify(preferences));
  const document = dom.window.document;
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, emptyBoard(), { mutate, refresh, data, now }));
  if (connected) {
    view.setHostState({ connected: true, message: "已连接 · 记录保存于本机" });
    view.acceptReadResult(readResult(board));
  } else view.setHostState({ connected: false, message: "组件预览 · 不能本机保存" });
  return { dom, document, view, store, byId: (id) => document.getElementById(id) };
}

// Existing editor regression cases now enter editing explicitly after reading.
function openTaskForEditing(ctx, card) {
  card.querySelector("[data-edit-task]").click();
  if (!ctx.byId("task-read-view").hidden) ctx.byId("task-read-edit").click();
}

function change(ctx, id, value) {
  ctx.byId(id).value = value;
  ctx.byId(id).dispatchEvent(new ctx.dom.window.Event(id === "search" ? "input" : "change", { bubbles: true }));
}

async function submit(ctx, formId) {
  // Programmatic value assignment does not emit the event a real edit does.
  ctx.byId(formId).dispatchEvent(new ctx.dom.window.Event("input", { bubbles: true }));
  ctx.byId(formId).querySelector('[type="submit"]').click();
  await tick();
}

function multiTaskFixture() {
  const board = fixture();
  const first = board.tasks[0];
  board.tasks = [
    { ...first, title: "任务 A", sourceTool: "Codex" },
    { ...first, id: randomUUID(), title: "任务 B", sourceTool: "all", projectId: otherProjectId },
    { ...first, id: randomUUID(), title: "任务 C", sourceTool: "", status: "waiting_user" },
    { ...first, id: randomUUID(), title: "任务 D", sourceTool: "none", status: "paused" },
    { ...first, id: randomUUID(), title: "任务 E", sourceTool: "Codex", status: "failed", blocker: "专用失败原因" },
  ];
  return board;
}

const cardFor = (ctx, id) => ctx.document.querySelector(`[data-task-id="${id}"]`);
const columnFor = (ctx, status) => ctx.document.querySelector(`.kanban-column[data-status="${status}"]`);
function activeError(ctx) {
  const node = ctx.document.querySelector('.error:not([hidden])');
  assert.ok(node, "The error must be visible to the user");
  return node;
}
function dragEvent(ctx, node, type) {
  const event = new ctx.dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { setData() {}, getData() { return "external"; } } });
  node.dispatchEvent(event);
  return event;
}

test("B1 filter popover supports keyboard dismissal and independent chips without changing a dirty draft", async () => {
  const ctx = await component({ board: multiTaskFixture() });
  try {
    openTaskForEditing(ctx, cardFor(ctx, taskId));
    ctx.byId("task-title").value = "保留筛选期间的草稿";
    ctx.byId("filter-toggle").click();
    assert.equal(ctx.byId("filter-panel").hidden, false);
    assert.equal(ctx.byId("filter-toggle").getAttribute("aria-expanded"), "true");
    assert.ok(ctx.byId("filter-panel").contains(ctx.document.activeElement));
    change(ctx, "status-filter", "planned");
    change(ctx, "source-filter", JSON.stringify("Codex"));
    change(ctx, "search", "任务 A");
    assert.equal(ctx.document.querySelectorAll("article").length, 1);
    ctx.document.querySelector('[data-clear-filter="status"]').focus();
    ctx.document.querySelector('[data-clear-filter="status"]').click();
    assert.equal(ctx.byId("status-filter").value, "all");
    assert.equal(ctx.byId("source-filter").value, JSON.stringify("Codex"));
    assert.equal(ctx.byId("search").value, "任务 A");
    assert.ok(ctx.byId("filter-chips").contains(ctx.document.activeElement), "Removing a focused chip must retain a reachable filter control");
    assert.equal(ctx.byId("filter-panel").hidden, false);
    assert.equal(ctx.byId("task-title").value, "保留筛选期间的草稿");
    ctx.byId("source-filter").dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(ctx.byId("filter-panel").hidden, true);
    assert.equal(ctx.byId("filter-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(ctx.document.activeElement, ctx.byId("filter-toggle"));
    ctx.byId("filter-toggle").click();
    ctx.byId("count").click();
    assert.equal(ctx.byId("filter-panel").hidden, true);
    ctx.byId("filter-toggle").click();
    ctx.byId("search").focus();
    ctx.byId("search").click();
    assert.equal(ctx.byId("filter-panel").hidden, true);
    assert.equal(ctx.document.activeElement, ctx.byId("search"), "Dismissing filters must preserve the clicked search field's keyboard focus");
    assert.equal(ctx.store.calls.length, 0);
  } finally { ctx.dom.window.close(); }
});

test("B1 row project management closes on editor actions and returns focus to the visible initiating control", async () => {
  const ctx = await component({ board: fixture() });
  try {
    const menu = ctx.document.querySelector(`[data-sidebar-project-menu="${projectId}"]`);
    const summary = menu.querySelector("summary");
    const openMenu = () => summary.dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    openMenu(); assert.equal(menu.open, true);
    ctx.byId("sidebar-new-project").focus();
    ctx.byId("sidebar-new-project").click();
    assert.equal(menu.open, false);
    assert.equal(ctx.byId("project-form").hidden, false);
    ctx.byId("editor-close").click();
    assert.equal(ctx.byId("editor-panel").hidden, true);
    assert.equal(ctx.document.activeElement, ctx.byId("sidebar-new-project"));
    assert.equal(ctx.byId("sidebar-new-project").closest("[hidden],[inert]"), null);
    change(ctx, "project-filter", otherProjectId);
    openMenu(); assert.equal(menu.open, true);
    const edit = menu.querySelector('[data-sidebar-project-action="edit"]');
    edit.focus(); edit.click();
    assert.equal(menu.open, false);
    assert.equal(ctx.byId("project-name").value, "英语学习");
    assert.equal(ctx.byId("project-filter").value, otherProjectId, "Editing a row must keep the unrelated project filter");
    ctx.byId("editor-close").click();
    assert.equal(ctx.byId("editor-panel").hidden, true);
    assert.equal(ctx.document.activeElement, summary);
    assert.equal(summary.isConnected, true); assert.equal(summary.closest("[hidden],[inert]"), null);
    assert.notEqual(ctx.dom.window.getComputedStyle(summary).display, "none");
    assert.equal(ctx.store.calls.length, 0);
  } finally { ctx.dom.window.close(); }
});

test("B1 archived filtering leaves next actions for a useful list and explains its unavailable next shortcut", async () => {
  const board = fixture();
  const archived = { ...board.tasks[0], id: randomUUID(), title: "已归档任务", archivedAt: timestamp };
  board.tasks.push(archived);
  const ctx = await component({ board });
  try {
    ctx.byId("view-next").click();
    change(ctx, "archive-filter", "archived");
    assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true");
    assert.equal(ctx.byId("cards").classList.contains("next-view"), false);
    assert.equal(ctx.document.querySelectorAll("article").length, 1);
    assert.ok(cardFor(ctx, archived.id));
    assert.equal(ctx.byId("view-next").disabled, true);
    assert.match(ctx.byId("view-next").getAttribute("title"), /活动|归档/);
    change(ctx, "archive-filter", "active");
    assert.equal(ctx.byId("view-next").disabled, false);
    ctx.byId("view-next").click();
    assert.equal(ctx.byId("archive-filter").value, "active");
    assert.equal(ctx.byId("view-next").getAttribute("aria-pressed"), "true");
    assert.ok(cardFor(ctx, taskId));
    assert.equal(cardFor(ctx, archived.id), null);
    assert.equal(ctx.store.calls.length, 0);
  } finally { ctx.dom.window.close(); }
});

test("B1 stored next plus archive preferences normalize to a view that can display archived records", async () => {
  const board = fixture();
  board.tasks[0].archivedAt = timestamp;
  const ctx = await component({ board, preferences: { viewMode: "next", archive: "archived" } });
  try {
    assert.equal(ctx.byId("archive-filter").value, "archived");
    assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true");
    assert.ok(cardFor(ctx, taskId));
  } finally { ctx.dom.window.close(); }
});

test("B1 task more menu closes by Escape with focus restored and by clicking outside", async () => {
  const ctx = await component({ board: fixture() });
  try {
    const menu = cardFor(ctx, taskId).querySelector(".card-actions");
    const summary = menu.querySelector("summary");
    menu.open = true;
    const status = menu.querySelector('[data-move-control="status"]');
    status.focus();
    status.dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(menu.open, false);
    assert.equal(ctx.document.activeElement, summary);
    menu.open = true;
    ctx.byId("count").click();
    assert.equal(menu.open, false);
    assert.equal(ctx.store.calls.length, 0);
  } finally { ctx.dom.window.close(); }
});

test("A1 a known failed save survives a successful move and retains its original compare-and-swap revision", async () => {
  const board = fixture();
  const store = fakeStore(board);
  const calls = [];
  const ctx = await component({ board, store, mutate: async (request) => {
    calls.push(structuredClone(request));
    if (calls.length === 1) return failure("SAVE_FAILED");
    return store.mutate(request);
  } });
  try {
    openTaskForEditing(ctx, cardFor(ctx, taskId));
    ctx.byId("task-title").value = "明确失败后保留的草稿";
    await submit(ctx, "task-form");
    dragEvent(ctx, cardFor(ctx, taskId), "dragstart");
    dragEvent(ctx, columnFor(ctx, "in_progress"), "drop");
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(store.board.tasks[0].status, "in_progress");
    assert.equal(ctx.byId("task-title").value, "明确失败后保留的草稿");
    await submit(ctx, "task-form");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].requestId, calls[0].requestId);
    assert.equal(calls[2].expectedRevision, board.revision);
    assert.equal(store.board.tasks[0].title, "复习词汇");
    assert.match(activeError(ctx).textContent, /版本|刷新|变化|修改/);
  } finally { ctx.dom.window.close(); }
});

test("V3 columns default to four open states and two folded states, with matching counts and visible filter results", async () => {
  const ctx = await component({ board: multiTaskFixture() });
  try {
    assert.deepEqual([...ctx.document.querySelectorAll(".kanban-column")].map((column) => column.dataset.status), ["planned", "in_progress", "waiting_user", "completed", "paused", "failed"]);
    assert.deepEqual([...ctx.document.querySelectorAll(".kanban-column:not(.is-collapsed)")].map((column) => column.dataset.status), ["planned", "in_progress", "waiting_user", "completed"]);
    assert.equal(columnFor(ctx, "planned").querySelector(".column-count").textContent, "2");
    assert.equal(columnFor(ctx, "paused").querySelector(".column-cards").hidden, true);
    change(ctx, "status-filter", "paused");
    assert.equal(ctx.document.querySelectorAll(".kanban-column").length, 1);
    assert.equal(columnFor(ctx, "paused").querySelector(".column-cards").hidden, false);
    assert.equal(ctx.byId("count").textContent, "1 / 5 项任务");
    ctx.byId("clear").click();
    change(ctx, "search", "专用失败原因");
    assert.equal(columnFor(ctx, "failed").querySelector(".column-cards").hidden, false);
    assert.equal(columnFor(ctx, "failed").querySelector(".column-count").textContent, "1");
    assert.equal(columnFor(ctx, "planned").querySelector(".column-count").textContent, "0");
    ctx.byId("view-list").click();
    assert.equal(ctx.byId("cards").classList.contains("list-view"), true);
    assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true");
    assert.equal(ctx.byId("search").value, "专用失败原因");
    ctx.byId("view-board").click();
    assert.equal(ctx.byId("cards").classList.contains("board-view"), true);
    assert.equal(ctx.store.calls.length, 0, "View and filter changes must not mutate records");
  } finally { ctx.dom.window.close(); }
});

test("V3 exact source filters distinguish all, none and empty source values and combine with project, status and search", async () => {
  const ctx = await component({ board: multiTaskFixture() });
  try {
    for (const [source, title] of [["all", "任务 B"], ["none", "任务 D"], ["", "任务 C"]]) {
      change(ctx, "source-filter", JSON.stringify(source));
      assert.equal(ctx.document.querySelectorAll("article").length, 1);
      assert.equal(ctx.document.querySelector(".task-title").textContent, title);
      assert.equal(ctx.document.querySelector(".column-cards:not([hidden]) .task-title").textContent, title);
    }
    change(ctx, "source-filter", JSON.stringify("Codex"));
    change(ctx, "project-filter", projectId);
    change(ctx, "status-filter", "planned");
    change(ctx, "search", "任务 A");
    assert.equal(ctx.document.querySelectorAll("article").length, 1);
    assert.equal(ctx.byId("main-title").textContent, "英语学习");
    assert.equal(ctx.byId("count").textContent, "1 / 5 项任务");
    change(ctx, "search", "无此任务");
    assert.equal(ctx.byId("empty").hidden, false);
    ctx.byId("clear").click();
    assert.equal(ctx.byId("source-filter").value, "all");
    assert.equal(ctx.byId("project-filter").value, "all");
    assert.equal(ctx.byId("status-filter").value, "all");
    assert.equal(ctx.byId("search").value, "");
    assert.equal(ctx.document.querySelectorAll("article").length, 5);
  } finally { ctx.dom.window.close(); }
});

test("V3 drawer close and task switching require an inline decision for dirty fields", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const ctx = await component({ board });
  try {
    openTaskForEditing(ctx, cardFor(ctx, first.id));
    assert.equal(ctx.byId("workspace").classList.contains("has-editor"), true);
    assert.equal(ctx.byId("editor-panel").getAttribute("aria-label"), "任务详情");
    ctx.byId("task-title").value = "未保存的草稿";
    ctx.byId("editor-close").click();
    assert.equal(ctx.byId("discard-dialog").hidden, false);
    assert.equal(ctx.byId("editor-panel").hidden, false);
    assert.equal(ctx.byId("task-title").value, "未保存的草稿");
    ctx.byId("keep-editing").click();
    assert.equal(ctx.byId("discard-dialog").hidden, true);
    assert.equal(ctx.byId("task-title").value, "未保存的草稿");
    openTaskForEditing(ctx, cardFor(ctx, second.id));
    assert.equal(ctx.byId("discard-dialog").hidden, false);
    assert.equal(ctx.byId("task-title").value, "未保存的草稿");
    ctx.byId("discard-edits").click();
    assert.equal(ctx.byId("task-title").value, second.title);
    assert.equal(ctx.byId("task-project").value, second.projectId);
    ctx.byId("editor-close").click();
    assert.equal(ctx.byId("editor-panel").hidden, true);
    assert.equal(ctx.byId("workspace").classList.contains("has-editor"), false);
    assert.equal(ctx.store.calls.length, 0, "Discarding an unsaved draft is never a mutation");
    ctx.byId("new-project").click();
    ctx.byId("project-name").value = "项目草稿";
    ctx.byId("project-form").querySelector("[data-cancel]").click();
    assert.equal(ctx.byId("discard-dialog").hidden, false);
    ctx.byId("discard-edits").click();
    assert.equal(ctx.byId("editor-panel").hidden, true);
  } finally { ctx.dom.window.close(); }
});

test("V3 deferred drawer switch uses the latest task and matching revision after a notification", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const ctx = await component({ board });
  try {
    openTaskForEditing(ctx, cardFor(ctx, first.id));
    ctx.byId("task-step").value = "旧任务仍保留的草稿";
    openTaskForEditing(ctx, cardFor(ctx, second.id));
    const newest = ctx.store.board;
    newest.revision += 1;
    newest.tasks[1].title = "另一处更新的最新标题";
    newest.tasks[1].currentStep = "另一处更新的最新步骤";
    ctx.store.board = newest;
    ctx.view.acceptReadResult(readResult(newest));
    assert.equal(ctx.byId("task-step").value, "旧任务仍保留的草稿");
    ctx.byId("discard-edits").click();
    assert.equal(ctx.byId("task-title").value, "另一处更新的最新标题");
    assert.equal(ctx.byId("task-step").value, "另一处更新的最新步骤");
    assert.equal(ctx.byId("task-read-view").hidden, false);
    ctx.byId("task-read-edit").click();
    ctx.byId("task-blocker").value = "保留新记录并增加阻塞项";
    await submit(ctx, "task-form");
    assert.equal(ctx.store.calls[0].expectedRevision, newest.revision);
    assert.equal(ctx.store.calls[0].operation.task.id, second.id);
    assert.equal(ctx.store.board.tasks[1].title, "另一处更新的最新标题");
    assert.equal(ctx.store.board.tasks[1].currentStep, "另一处更新的最新步骤");
  } finally { ctx.dom.window.close(); }
});

test("V3 native internal drag reorders across projects and moves to a collapsed column end without accepting external drops", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const ctx = await component({ board });
  try {
    dragEvent(ctx, columnFor(ctx, "completed"), "drop");
    assert.equal(ctx.store.calls.length, 0);
    dragEvent(ctx, cardFor(ctx, second.id), "dragstart");
    const over = dragEvent(ctx, cardFor(ctx, first.id), "dragover");
    assert.equal(over.defaultPrevented, true);
    assert.equal(cardFor(ctx, first.id).classList.contains("drop-before"), true);
    dragEvent(ctx, cardFor(ctx, first.id), "drop");
    await tick();
    assert.deepEqual(ctx.store.calls[0].operation, { type: "move_task", taskId: second.id, status: "planned", beforeTaskId: first.id });
    assert.deepEqual(ctx.store.board.tasks.slice(0, 2).map((task) => task.id), [second.id, first.id]);
    assert.equal(ctx.store.board.tasks[0].projectId, second.projectId);
    assert.equal(columnFor(ctx, "paused").classList.contains("is-collapsed"), true);
    dragEvent(ctx, cardFor(ctx, first.id), "dragstart");
    dragEvent(ctx, columnFor(ctx, "paused"), "drop");
    await tick();
    assert.deepEqual(ctx.store.calls[1].operation, { type: "move_task", taskId: first.id, status: "paused", beforeTaskId: null });
    assert.equal(ctx.store.board.tasks.at(-1).id, first.id);
    assert.equal(ctx.store.board.tasks.at(-1).status, "paused");
    assert.equal(columnFor(ctx, "paused").classList.contains("is-collapsed"), false);
    assert.equal(columnFor(ctx, "paused").querySelector(".column-cards").hidden, false);
    assert.equal(ctx.byId("save-status").textContent, "已移动并保存到本机。");
    assert.equal(ctx.document.querySelectorAll(".is-dragging,.drop-before,.is-drop-target").length, 0);
  } finally { ctx.dom.window.close(); }
});

test("V3 keyboard-accessible move controls persist up/down order and expose the changed target state", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const ctx = await component({ board });
  try {
    assert.equal(cardFor(ctx, first.id).querySelector('[data-move-control="up"]').disabled, true);
    cardFor(ctx, first.id).querySelector('[data-move-control="down"]').click();
    await tick();
    assert.deepEqual(ctx.store.board.tasks.filter((task) => task.status === "planned").map((task) => task.id), [second.id, first.id]);
    cardFor(ctx, first.id).querySelector('[data-move-control="up"]').click();
    await tick();
    assert.deepEqual(ctx.store.board.tasks.filter((task) => task.status === "planned").map((task) => task.id), [first.id, second.id]);
    change(ctx, "status-filter", "planned");
    const select = cardFor(ctx, first.id).querySelector('[data-move-control="status"]');
    assert.match(select.getAttribute("aria-label"), /移动.*任务 A/);
    select.value = "failed";
    select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
    await tick();
    assert.deepEqual(ctx.store.calls.at(-1).operation, { type: "patch_task", taskId: first.id, patch: { status: "failed" } });
    assert.equal(ctx.store.board.tasks.find((task) => task.id === first.id).status, "failed");
    assert.equal(ctx.byId("status-filter").value, "all");
    assert.equal(columnFor(ctx, "failed").querySelector(".column-cards").hidden, false);
    assert.equal(cardFor(ctx, first.id).querySelector(".task-title").textContent, first.title);
  } finally { ctx.dom.window.close(); }
});

test("V3 pending move shows only confirmed records and blocks duplicate drags and other mutations", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const store = fakeStore(board);
  let resolve;
  const incoming = [];
  const ctx = await component({ board, store, mutate: (request) => { incoming.push(request); return new Promise((done) => { resolve = done; }); } });
  try {
    cardFor(ctx, first.id).querySelector('[data-move-control="down"]').click();
    assert.equal(incoming.length, 1);
    assert.deepEqual(ctx.store.board, board);
    assert.deepEqual([...columnFor(ctx, "planned").querySelectorAll("article")].map((card) => card.dataset.taskId), [first.id, second.id]);
    assert.equal(cardFor(ctx, second.id).draggable, false);
    assert.equal(cardFor(ctx, second.id).querySelector('[data-move-control="up"]').disabled, true);
    assert.equal(ctx.byId("new-task").disabled, true);
    dragEvent(ctx, cardFor(ctx, second.id), "dragstart");
    dragEvent(ctx, columnFor(ctx, "completed"), "drop");
    assert.equal(incoming.length, 1);
    resolve(await store.mutate(incoming[0]));
    await tick();
    assert.equal(ctx.byId("move-feedback").hidden, true);
    assert.equal(ctx.byId("new-task").disabled, false);
    assert.deepEqual(ctx.store.board.tasks.filter((task) => task.status === "planned").map((task) => task.id), [second.id, first.id]);
  } finally { ctx.dom.window.close(); }
});

test("V3 known move failure preserves an open draft and retries its unchanged request without using the draft form", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const store = fakeStore(board);
  const calls = [];
  const ctx = await component({ board, store, mutate: async (request) => { calls.push(request); return calls.length === 1 ? failure("SAVE_FAILED") : store.mutate(request); } });
  try {
    openTaskForEditing(ctx, cardFor(ctx, second.id));
    ctx.byId("task-title").value = "与移动独立的草稿";
    cardFor(ctx, first.id).querySelector('[data-move-control="down"]').click();
    await tick();
    assert.equal(ctx.byId("task-title").value, "与移动独立的草稿");
    assert.deepEqual(store.board, board);
    assert.equal(ctx.byId("move-dismiss").disabled, false);
    assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
    ctx.byId("move-retry").click();
    await tick();
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(ctx.byId("task-title").value, "与移动独立的草稿");
    assert.equal(ctx.byId("task-form").hidden, false);
    assert.equal(ctx.byId("move-feedback").hidden, true);
    await submit(ctx, "task-form");
    assert.equal(calls[2].operation.type, "save_task");
    assert.equal(calls[2].expectedRevision, board.revision, "An existing draft retains its revision until an explicit refresh");
    assert.equal(ctx.byId("task-title").value, "与移动独立的草稿");
    assert.match(activeError(ctx).textContent, /刷新记录/);
  } finally { ctx.dom.window.close(); }
});

test("V3 lost move response keeps its ID across refresh and BUSY until replay confirms the saved order", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const store = fakeStore(board);
  const calls = [];
  const ctx = await component({ board, store, mutate: async (request) => {
    calls.push(request);
    if (calls.length === 1) { await store.mutate(request); throw Error("Move response lost after commit"); }
    if (calls.length === 2) return failure("BUSY");
    return store.mutate(request);
  } });
  try {
    cardFor(ctx, first.id).querySelector('[data-move-control="down"]').click();
    await tick();
    assert.match(activeError(ctx).textContent, /无法确认本次是否移动/);
    assert.equal(ctx.byId("move-dismiss").disabled, true);
    assert.equal(cardFor(ctx, second.id).draggable, false);
    await ctx.view.refresh();
    ctx.byId("move-retry").click();
    await tick();
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(ctx.byId("move-dismiss").disabled, true);
    assert.match(activeError(ctx).textContent, /无法确认上次移动/);
    ctx.byId("move-retry").click();
    await tick();
    assert.deepEqual(calls[2], calls[0]);
    assert.equal(store.board.revision, board.revision + 1);
    assert.deepEqual(store.board.tasks.filter((task) => task.status === "planned").map((task) => task.id), [second.id, first.id]);
    assert.equal(ctx.byId("move-feedback").hidden, true);
    assert.equal(ctx.byId("save-status").textContent, "已移动并保存到本机。");
  } finally { ctx.dom.window.close(); }
});

test("V3 move conflict requires explicit refresh and a new request while preserving the current draft", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const store = fakeStore(board);
  const ctx = await component({ board, store });
  try {
    openTaskForEditing(ctx, cardFor(ctx, second.id));
    ctx.byId("task-step").value = "保留步骤草稿";
    const newest = store.board;
    newest.revision += 1;
    newest.tasks[1].title = "另一处更新标题";
    store.board = newest;
    cardFor(ctx, first.id).querySelector('[data-move-control="down"]').click();
    await tick();
    assert.equal(ctx.byId("move-retry").disabled, true);
    assert.equal(ctx.byId("move-dismiss").disabled, false);
    assert.equal(ctx.byId("task-step").value, "保留步骤草稿");
    assert.match(activeError(ctx).textContent, /刷新记录.*核对/);
    ctx.byId("move-retry").click();
    assert.equal(store.calls.length, 1);
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-step").value, "保留步骤草稿");
    ctx.byId("move-retry").click();
    await tick();
    assert.notEqual(store.calls[1].requestId, store.calls[0].requestId);
    assert.equal(store.calls[1].expectedRevision, newest.revision);
    assert.deepEqual(store.calls[1].operation, store.calls[0].operation);
    assert.equal(store.board.tasks.find((task) => task.id === second.id).title, "另一处更新标题");
    assert.equal(ctx.byId("task-step").value, "保留步骤草稿");
  } finally { ctx.dom.window.close(); }
});

test("V3 incomplete move confirmation cannot count as saved and must replay the original request", async () => {
  const board = multiTaskFixture();
  const store = fakeStore(board);
  const calls = [];
  const ctx = await component({ board, store, mutate: async (request) => {
    calls.push(request);
    const result = await store.mutate(request);
    if (calls.length === 1) delete result.structuredContent.replayed;
    return result;
  } });
  try {
    cardFor(ctx, board.tasks[0].id).querySelector('[data-move-control="down"]').click();
    await tick();
    assert.match(activeError(ctx).textContent, /未收到完整的移动确认/);
    assert.equal(ctx.byId("save-status").textContent, "");
    assert.equal(ctx.byId("move-dismiss").disabled, true);
    ctx.byId("move-retry").click();
    await tick();
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(store.board.revision, board.revision + 1);
    assert.equal(ctx.byId("save-status").textContent, "已移动并保存到本机。");
  } finally { ctx.dom.window.close(); }
});

test("V3 project selection preserves folded columns and explicit folding survives clearing filters", async () => {
  const ctx = await component({ board: multiTaskFixture() });
  try {
    change(ctx, "project-filter", projectId);
    assert.equal(columnFor(ctx, "failed").classList.contains("is-collapsed"), true);
    assert.equal(columnFor(ctx, "paused").classList.contains("is-collapsed"), true);
    assert.equal(columnFor(ctx, "failed").querySelector(".column-count").textContent, "1");
    columnFor(ctx, "planned").querySelector("[data-toggle-column]").click();
    assert.equal(columnFor(ctx, "planned").querySelector(".column-cards").hidden, true);
    ctx.byId("clear").click();
    assert.equal(columnFor(ctx, "planned").querySelector(".column-cards").hidden, true);
    assert.equal(columnFor(ctx, "failed").querySelector(".column-cards").hidden, true);
    assert.equal(columnFor(ctx, "planned").querySelector(".column-count").textContent, "2");
  } finally { ctx.dom.window.close(); }
});

test("V3 compact drawer isolates background keyboard controls, traps Tab, and restores desktop navigation on resize", async () => {
  const ctx = await component({ board: fixture() });
  try {
    Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, writable: true });
    ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("resize"));
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    assert.equal(ctx.byId("editor-panel").getAttribute("role"), "dialog");
    assert.equal(ctx.byId("editor-panel").getAttribute("aria-modal"), "true");
    for (const selector of [".app-header", ".toolbar", ".feedback", ".board-area", ".app-footer"]) assert.equal(ctx.document.querySelector(selector).hasAttribute("inert"), true);
    change(ctx, "task-title", "需要确认的草稿");
    const submitButton = ctx.byId("task-form").querySelector('[type="submit"]');
    assert.equal(submitButton.disabled, false);
    submitButton.focus();
    const tab = new ctx.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    submitButton.dispatchEvent(tab);
    assert.equal(tab.defaultPrevented, true);
    assert.equal(ctx.document.activeElement, ctx.byId("task-edit-read"));
    ctx.byId("task-edit-read").dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(ctx.document.activeElement, submitButton);
    ctx.byId("editor-close").click();
    assert.equal(ctx.byId("task-form").hasAttribute("inert"), true);
    assert.equal(ctx.document.activeElement, ctx.byId("keep-editing"));
    ctx.byId("discard-edits").focus();
    ctx.byId("discard-edits").dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(ctx.document.activeElement, ctx.byId("keep-editing"));
    ctx.dom.window.innerWidth = 1200;
    ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("resize"));
    assert.equal(ctx.document.querySelector(".board-area").hasAttribute("inert"), true, "Discard decisions remain isolated on desktop");
    ctx.byId("keep-editing").click();
    assert.equal(ctx.byId("task-form").hasAttribute("inert"), false);
    assert.equal(ctx.document.querySelector(".board-area").hasAttribute("inert"), false);
    assert.equal(ctx.byId("editor-panel").hasAttribute("aria-modal"), false);
    ctx.byId("task-title").value = "复习词汇";
    ctx.byId("editor-close").click();
    assert.equal(ctx.byId("editor-panel").hidden, true);
    assert.equal(ctx.document.querySelector(".toolbar").hasAttribute("inert"), false);
  } finally { ctx.dom.window.close(); }
});

test("V3 compact drawer displays validation and save errors inside the active dialog and preserves error feedback on close", async () => {
  const store = fakeStore(fixture());
  const ctx = await component({ board: store.board, store, mutate: async () => failure("SAVE_FAILED") });
  try {
    Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, writable: true });
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    ctx.byId("task-title").value = "";
    await submit(ctx, "task-form");
    assert.equal(ctx.byId("editor-error").hidden, false);
    assert.equal(ctx.byId("data-error").hidden, true);
    assert.match(activeError(ctx).textContent, /任务名称必填/);
    ctx.byId("task-title").value = "修改后的标题";
    await submit(ctx, "task-form");
    assert.equal(ctx.byId("editor-error").hidden, false);
    assert.match(activeError(ctx).textContent, /保存到本机失败/);
    assert.equal(ctx.byId("task-title").value, "修改后的标题");
    ctx.byId("editor-close").click();
    ctx.byId("discard-edits").click();
    assert.equal(ctx.byId("editor-error").hidden, true);
    assert.equal(ctx.byId("data-error").hidden, false);
    assert.match(activeError(ctx).textContent, /保存到本机失败/);
  } finally { ctx.dom.window.close(); }
});

for (const kind of ["task", "project"]) {
  test(`V3 compact ${kind} conflict recovers through the drawer refresh button without closing or losing a draft`, async () => {
    const board = fixture();
    const store = fakeStore(board);
    let reads = 0;
    const ctx = await component({ board, store, refresh: async () => { reads += 1; return store.refresh(); } });
    try {
      Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, writable: true });
      if (kind === "task") openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
      else { change(ctx, "project-filter", projectId); ctx.byId("edit-project").click(); }
      const field = ctx.byId(kind === "task" ? "task-title" : "project-name");
      const form = ctx.byId(`${kind}-form`);
      field.value = "窄窗必须保留的草稿";
      const changed = store.board;
      changed.revision += 1;
      if (kind === "task") changed.tasks[0].title = "另一窗口的任务标题";
      else changed.projects[0].name = "另一窗口的项目名称";
      store.board = changed;
      await submit(ctx, `${kind}-form`);
      assert.match(activeError(ctx).textContent, /刷新记录.*核对/);
      assert.equal(ctx.byId("refresh").closest("[inert]") !== null, true, "Background refresh is inaccessible in the modal drawer");
      const refresh = ctx.byId("editor-refresh");
      assert.equal(refresh.disabled, false);
      assert.equal(refresh.closest("[hidden], [inert]"), null);
      assert.equal(refresh.getAttribute("aria-label"), "刷新当前记录");
      assert.equal(refresh.querySelectorAll("svg").length, 1);
      assert.equal(form.querySelector('[type="submit"]').disabled, true);
      refresh.click();
      assert.equal(refresh.disabled, true);
      assert.equal(refresh.getAttribute("aria-label"), "正在刷新…");
      await tick();
      assert.equal(reads, 1, "Recovery must use the actual button's read callback");
      assert.equal(field.value, "窄窗必须保留的草稿");
      assert.equal(ctx.byId("editor-panel").hidden, false);
      assert.equal(ctx.byId("discard-dialog").hidden, true);
      assert.equal(form.querySelector('[type="submit"]').disabled, true, "Conflicting values must be explicitly resolved");
      const choice = ctx.document.querySelector('[data-conflict-choice="local"]');
      assert.ok(choice);
      assert.equal(choice.closest("[hidden], [inert]"), null);
      choice.click();
      assert.equal(form.querySelector('[type="submit"]').disabled, false);
      assert.equal(refresh.disabled, false);
      assert.equal(refresh.getAttribute("aria-label"), "刷新当前记录");
      assert.equal(refresh.querySelectorAll("svg").length, 1, "Refresh labels must preserve the icon");
      await submit(ctx, `${kind}-form`);
      assert.equal(store.calls.length, 2);
      assert.equal(store.calls[1].expectedRevision, changed.revision);
      assert.notEqual(store.calls[1].requestId, store.calls[0].requestId);
      assert.equal(kind === "task" ? store.board.tasks[0].title : store.board.projects[0].name, "窄窗必须保留的草稿");
      assert.equal(ctx.byId("editor-panel").hidden, true);
      assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
    } finally { ctx.dom.window.close(); }
  });
}

for (const lostResponse of [false, true]) {
  test(`V3 ${lostResponse ? "unconfirmed" : "failed"} move remains reachable inside a compact drawer and preserves its draft on retry`, async () => {
    const board = multiTaskFixture();
    const [first, second] = board.tasks;
    const store = fakeStore(board);
    const calls = [];
    const ctx = await component({ board, store, mutate: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        if (lostResponse) { await store.mutate(request); throw Error("Move response lost"); }
        return failure("SAVE_FAILED");
      }
      return store.mutate(request);
    } });
    try {
      Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, writable: true });
      cardFor(ctx, first.id).querySelector('[data-move-control="down"]').click();
      await tick();
      const retryRegion = ctx.byId("move-feedback");
      openTaskForEditing(ctx, cardFor(ctx, second.id));
      ctx.byId("task-step").value = "必须保留的移动独立草稿";
      assert.equal(ctx.byId("editor-panel").contains(retryRegion), true);
      assert.equal(retryRegion.previousElementSibling.id, "editor-error");
      assert.equal(ctx.byId("move-retry").closest("[hidden], [inert]"), null);
      assert.equal(ctx.byId("move-retry").disabled, false);
      assert.equal(ctx.byId("move-dismiss").disabled, lostResponse);
      assert.equal(ctx.document.querySelector(".feedback").hasAttribute("inert"), true);
      assert.equal(ctx.document.querySelectorAll("#move-feedback,#move-retry").length, 2, "Use one region and one retry button");
      ctx.byId("editor-close").click();
      assert.equal(ctx.byId("discard-dialog").hidden, false);
      assert.equal(retryRegion.hasAttribute("inert"), true);
      assert.equal(ctx.byId("move-retry").disabled, true);
      ctx.byId("keep-editing").click();
      assert.equal(retryRegion.hasAttribute("inert"), false);
      assert.equal(ctx.byId("move-retry").disabled, false);
      if (lostResponse) {
        ctx.byId("editor-refresh").click();
        await tick();
        assert.equal(ctx.byId("task-step").value, "必须保留的移动独立草稿");
      }
      ctx.byId("move-retry").click();
      await tick();
      assert.deepEqual(calls[1], calls[0]);
      assert.equal(store.board.revision, board.revision + 1);
      assert.deepEqual(store.board.tasks.filter((task) => task.status === "planned").map((task) => task.id), [second.id, first.id]);
      assert.equal(ctx.byId("task-step").value, "必须保留的移动独立草稿");
      assert.equal(ctx.byId("editor-panel").hidden, false);
      assert.equal(retryRegion.hidden, true);
      ctx.byId("editor-close").click();
      ctx.byId("discard-edits").click();
      assert.equal(retryRegion.parentElement, ctx.document.querySelector(".feedback"));
    } finally { ctx.dom.window.close(); }
  });
}

test("V3 notification and filter rerenders cancel a pending drag instead of submitting its old intent at a newer revision", async () => {
  const board = multiTaskFixture();
  const [first, second] = board.tasks;
  const store = fakeStore(board);
  const ctx = await component({ board, store });
  try {
    dragEvent(ctx, cardFor(ctx, first.id), "dragstart");
    assert.equal(cardFor(ctx, first.id).classList.contains("is-dragging"), true);
    const newer = store.board;
    newer.revision += 1;
    newer.tasks[0].status = "waiting_user";
    newer.tasks[0].currentStep = "另一窗口更新的步骤";
    store.board = newer;
    ctx.view.acceptReadResult(readResult(newer));
    dragEvent(ctx, columnFor(ctx, "completed"), "drop");
    await tick();
    assert.equal(store.calls.length, 0);
    assert.deepEqual(store.board, newer);
    assert.equal(ctx.document.querySelectorAll(".is-dragging,.drop-before,.is-drop-target").length, 0);
    dragEvent(ctx, cardFor(ctx, second.id), "dragstart");
    change(ctx, "source-filter", JSON.stringify(second.sourceTool));
    dragEvent(ctx, columnFor(ctx, "completed"), "drop");
    await tick();
    assert.equal(store.calls.length, 0);
    assert.deepEqual(store.board, newer);
    ctx.byId("clear").click();
    dragEvent(ctx, cardFor(ctx, second.id), "dragstart");
    dragEvent(ctx, columnFor(ctx, "completed"), "drop");
    await tick();
    assert.equal(store.calls.length, 1, "A fresh drag remains usable after canceling the stale one");
    assert.equal(store.calls[0].expectedRevision, newer.revision);
    assert.equal(store.board.tasks.at(-1).id, second.id);
    assert.equal(store.board.tasks.at(-1).status, "completed");
    assert.equal(store.board.tasks.find((task) => task.id === first.id).status, "waiting_user");
  } finally { ctx.dom.window.close(); }
});

test("V1 starts blank and standalone preview cannot edit or save", async () => {
  let calls = 0;
  const ctx = await component({ connected: false, mutate: async () => { calls += 1; } });
  try {
    assert.equal(ctx.document.querySelectorAll("article").length, 0);
    assert.match(ctx.byId("empty").textContent, /空白/);
    assert.equal(ctx.byId("connection").textContent, "组件预览 · 不能本机保存");
    for (const id of ["new-project", "edit-project", "new-task", "refresh"]) assert.equal(ctx.byId(id).disabled, true);
    ctx.byId("new-project").click();
    ctx.byId("project-form").dispatchEvent(new ctx.dom.window.Event("submit", { cancelable: true }));
    await tick();
    assert.equal(ctx.byId("project-form").hidden, true);
    assert.equal(calls, 0);
  } finally { ctx.dom.window.close(); }
});

test("create and edit a project only on explicit save, preserving the server id", async () => {
  const ctx = await component();
  try {
    ctx.byId("new-project").click();
    ctx.byId("project-name").value = "  一建备考  ";
    ctx.byId("project-description-input").value = "安排章节练习";
    await tick();
    assert.equal(ctx.store.calls.length, 0);
    await submit(ctx, "project-form");
    assert.equal(ctx.store.calls.length, 1);
    assert.equal(ctx.store.calls[0].operation.project.name, "一建备考");
    assert.match(ctx.store.calls[0].requestId, /^[\da-f-]{36}$/);
    assert.equal(ctx.byId("project-form").hidden, true);
    assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
    assert.equal(ctx.byId("new-task").disabled, false);
    const saved = ctx.store.board.projects[0];
    change(ctx, "project-filter", saved.id);
    ctx.byId("edit-project").click();
    assert.equal(ctx.byId("project-name").value, saved.name);
    ctx.byId("project-name").value = "一建备考计划";
    ctx.byId("project-description-input").value = "每周完成一章";
    await submit(ctx, "project-form");
    assert.equal(ctx.store.calls[1].operation.project.id, saved.id);
    assert.equal(ctx.store.board.projects.length, 1);
    assert.equal(ctx.byId("project-filter").selectedOptions[0].textContent, "一建备考计划");
    assert.equal(ctx.byId("project-description").textContent, "每周完成一章");
  } finally { ctx.dom.window.close(); }
});

test("create and edit task fields, project and every manual status", async () => {
  const board = fixture();
  board.tasks = [];
  const ctx = await component({ board });
  try {
    ctx.byId("new-task").click();
    ctx.byId("task-title").value = "完成章节练习";
    ctx.byId("task-source").value = "个人笔记";
    ctx.byId("task-step").value = "先读本章";
    ctx.byId("task-blocker").value = "需要练习题";
    ctx.byId("task-conversation").value = "https://example.com/conversation";
    assert.equal(ctx.store.calls.length, 0);
    await submit(ctx, "task-form");
    const savedId = ctx.store.board.tasks[0].id;
    assert.equal(ctx.document.querySelector(".status").textContent, "计划中");
    assert.equal(ctx.document.querySelector("article .card-step").textContent, "先读本章");
    assert.equal(ctx.document.querySelector("article .card-blocker").textContent, "需要练习题");
    assert.equal(ctx.document.querySelector("article .source-tag").textContent, "来源：个人笔记");
    assert.equal(ctx.document.querySelector("article a").href, "https://example.com/conversation");
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    assert.equal(ctx.byId("editor-panel").hidden, false);
    assert.equal(ctx.byId("task-step").value, "先读本章");
    assert.equal(ctx.byId("task-blocker").value, "需要练习题");
    assert.equal(ctx.byId("task-source").value, "个人笔记");
    assert.equal(ctx.byId("task-conversation").value, "https://example.com/conversation");
    assert.match(ctx.byId("task-updated").textContent, /最后更新/);
    assert.equal(ctx.byId("task-link").querySelector("a").href, "https://example.com/conversation");
    ctx.byId("editor-close").click();
    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      ctx.document.querySelector("[data-edit-task]").click();
      const previousStatus = ctx.store.board.tasks[0].status;
      const beforeChoice = ctx.store.calls.length;
      change(ctx, "task-read-quick-status", status); await tick();
      assert.equal(ctx.store.calls.length, beforeChoice + (status === previousStatus ? 0 : 1));
      ctx.byId("task-read-edit").click();
      assert.equal(ctx.byId("task-source").value, "个人笔记");
      ctx.byId("task-title").value = `继续章节练习：${label}`;
      ctx.byId("task-project").value = otherProjectId;
      await tick();
      const before = ctx.store.calls.length;
      await submit(ctx, "task-form");
      assert.equal(ctx.store.calls.length, before + 1);
      assert.equal(ctx.store.calls.at(-1).operation.task.id, savedId);
      assert.equal(ctx.store.board.tasks.length, 1);
      assert.equal(ctx.store.board.tasks[0].projectId, otherProjectId);
      assert.equal(ctx.document.querySelector(".status").textContent, label);
      assert.equal(ctx.document.querySelector("article .project").textContent, "网站维护");
    }
  } finally { ctx.dom.window.close(); }
});

test("project selection, search, status filter and clear operate on saved tasks", async () => {
  const board = fixture();
  board.tasks.push({ ...board.tasks[0], id: randomUUID(), projectId: otherProjectId, title: "修复导航", status: "failed", blocker: "构建失败" });
  const ctx = await component({ board });
  try {
    change(ctx, "search", " 构建失败 ");
    assert.equal(ctx.document.querySelectorAll("article").length, 1);
    change(ctx, "status-filter", "completed");
    assert.equal(ctx.document.querySelectorAll("article").length, 0);
    assert.equal(ctx.byId("empty").hidden, false);
    assert.equal(ctx.byId("count").textContent, "0 / 2 项任务");
    ctx.byId("clear").click();
    assert.equal(ctx.document.querySelectorAll("article").length, 2);
    change(ctx, "project-filter", projectId);
    assert.equal(ctx.document.querySelectorAll("article").length, 1);
    assert.equal(ctx.document.querySelector("article").dataset.taskId, taskId);
    assert.equal(ctx.byId("edit-project").disabled, false);
  } finally { ctx.dom.window.close(); }
});

test("pending save disables duplicate submissions and waits for a confirmed result", async () => {
  const store = fakeStore();
  let resolve;
  let calls = 0;
  let incoming;
  const ctx = await component({ store, mutate: (request) => { calls += 1; incoming = request; return new Promise((done) => { resolve = done; }); } });
  try {
    ctx.byId("new-project").click();
    ctx.byId("project-name").value = "软件维护";
    const button = ctx.byId("project-form").querySelector('[type="submit"]');
    button.click();
    button.click();
    ctx.byId("project-form").dispatchEvent(new ctx.dom.window.Event("submit", { cancelable: true }));
    await tick();
    assert.equal(calls, 1);
    assert.equal(button.disabled, true);
    assert.equal(ctx.byId("project-name").disabled, true);
    assert.equal(ctx.byId("project-name").value, "软件维护");
    assert.equal(ctx.byId("project-form").hidden, false);
    assert.doesNotMatch(ctx.byId("save-status").textContent, /已保存/);
    resolve(await store.mutate(incoming));
    await tick();
    assert.equal(ctx.byId("project-form").hidden, true);
    assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
  } finally { ctx.dom.window.close(); }
});

test("tool failure preserves every input, reports no success and retries the same request", async () => {
  const store = fakeStore(fixture());
  const calls = [];
  const ctx = await component({ board: store.board, store, mutate: async (request) => { calls.push(request); return calls.length === 1 ? failure("SAVE_FAILED") : store.mutate(request); } });
  try {
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    ctx.byId("task-title").value = "保留我的编辑";
    ctx.byId("task-step").value = "新的步骤";
    ctx.byId("task-blocker").value = "需要材料";
    ctx.byId("task-status").value = "waiting_user";
    await submit(ctx, "task-form");
    assert.equal(ctx.byId("task-form").hidden, false);
    assert.equal(ctx.byId("task-title").value, "保留我的编辑");
    assert.equal(ctx.byId("task-step").value, "新的步骤");
    assert.equal(ctx.byId("task-blocker").value, "需要材料");
    assert.equal(ctx.byId("task-status").value, "waiting_user");
    assert.match(activeError(ctx).textContent, /保存到本机失败.*输入已保留/);
    assert.equal(ctx.byId("save-status").textContent, "");
    assert.equal(ctx.document.querySelector("article .task-title").textContent, "复习词汇");
    await submit(ctx, "task-form");
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(ctx.document.querySelector("article .task-title").textContent, "保留我的编辑");
  } finally { ctx.dom.window.close(); }
});

test("uncertain transport failure freezes the draft and retries its original id after refresh", async () => {
  const store = fakeStore();
  const calls = [];
  const ctx = await component({ store, mutate: async (request) => {
    calls.push(request);
    const result = await store.mutate(request);
    if (calls.length === 1) throw new Error("response lost after persistence");
    return result;
  } });
  try {
    ctx.byId("new-project").click();
    ctx.byId("project-name").value = "英语学习";
    await submit(ctx, "project-form");
    assert.match(activeError(ctx).textContent, /无法确认本次是否保存/);
    assert.equal(ctx.byId("project-name").value, "英语学习");
    assert.equal(ctx.byId("project-name").disabled, true);
    assert.equal(ctx.byId("project-form").querySelector("[data-cancel]").disabled, true);
    assert.equal(ctx.byId("project-form").querySelector('[type="submit"]').disabled, false);
    assert.equal(ctx.byId("save-status").textContent, "");
    await ctx.view.refresh();
    assert.equal(ctx.byId("project-name").value, "英语学习");
    await submit(ctx, "project-form");
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(store.board.projects.length, 1);
    assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
  } finally { ctx.dom.window.close(); }
});

test("revision conflict keeps edits and requires explicit refresh before a new submission", async () => {
  const store = fakeStore(fixture());
  const ctx = await component({ board: store.board, store });
  try {
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    ctx.byId("task-title").value = "我的草稿";
    const changed = store.board;
    changed.revision += 1;
    changed.tasks[0].title = "另一个窗口的修改";
    store.board = changed;
    await submit(ctx, "task-form");
    assert.equal(store.calls.length, 1);
    assert.equal(store.board.tasks[0].title, "另一个窗口的修改");
    assert.equal(ctx.document.querySelector("article .task-title").textContent, "另一个窗口的修改");
    assert.equal(ctx.byId("task-title").value, "我的草稿");
    assert.match(activeError(ctx).textContent, /刷新记录.*核对.*重新保存/);
    assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
    await submit(ctx, "task-form");
    assert.equal(store.calls.length, 1);
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-title").value, "我的草稿");
    assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
    assert.match(ctx.byId("merge-conflicts").textContent, /我的草稿.*另一个窗口的修改/s);
    await submit(ctx, "task-form");
    assert.equal(store.calls.length, 1, "A refresh alone must not overwrite the remote field");
    ctx.document.querySelector('[data-conflict-choice="local"]').click();
    assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, false);
    await submit(ctx, "task-form");
    assert.equal(store.calls[1].expectedRevision, changed.revision);
    assert.notEqual(store.calls[1].requestId, store.calls[0].requestId);
    assert.equal(store.board.tasks[0].title, "我的草稿");
  } finally { ctx.dom.window.close(); }
});

for (const [label, errorResult] of [
  ["content-only", { isError: true, content: [{ type: "text", text: "Host bridge lost the response" }] }],
  ["unknown error code", failure("UNKNOWN_BRIDGE_ERROR")],
]) {
  test(`unknown ${label} error retains the original request and freezes editing until confirmed`, async () => {
    const store = fakeStore();
    const calls = [];
    const ctx = await component({ store, mutate: async (request) => {
      calls.push(request);
      const result = await store.mutate(request);
      return calls.length === 1 ? errorResult : result;
    } });
    try {
      ctx.byId("new-project").click();
      ctx.byId("project-name").value = "需要确认的项目";
      await submit(ctx, "project-form");
      assert.equal(ctx.byId("project-name").value, "需要确认的项目");
      assert.equal(ctx.byId("project-name").disabled, true);
      assert.equal(ctx.byId("project-form").querySelector("[data-cancel]").disabled, true);
      assert.equal(ctx.byId("new-project").disabled, true);
      assert.equal(ctx.byId("save-status").textContent, "");
      assert.match(activeError(ctx).textContent, /无法确认.*请求已保留/);
      await submit(ctx, "project-form");
      assert.deepEqual(calls[1], calls[0]);
      assert.equal(store.board.projects.length, 1);
      assert.equal(ctx.byId("project-form").hidden, true);
      assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
    } finally { ctx.dom.window.close(); }
  });
}

test("uncertain save remains frozen across a retry business error until replay confirms the commit", async () => {
  const store = fakeStore();
  const calls = [];
  const ctx = await component({ store, mutate: async (request) => {
    calls.push(request);
    if (calls.length === 1) {
      await store.mutate(request);
      throw new Error("response lost after commit");
    }
    if (calls.length === 2) return failure("BUSY");
    return store.mutate(request);
  } });
  try {
    ctx.byId("new-project").click();
    ctx.byId("project-name").value = "保持原请求";
    await submit(ctx, "project-form");
    await submit(ctx, "project-form");
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(ctx.byId("project-name").disabled, true);
    assert.equal(ctx.byId("project-form").querySelector("[data-cancel]").disabled, true);
    assert.equal(ctx.byId("save-status").textContent, "");
    await submit(ctx, "project-form");
    assert.deepEqual(calls[2], calls[0]);
    assert.equal(store.board.projects.length, 1);
    assert.equal(ctx.byId("project-form").hidden, true);
    assert.equal(ctx.byId("new-project").disabled, false);
    assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
  } finally { ctx.dom.window.close(); }
});

test("uncertain uncommitted save recovers from a confirmed revision conflict through explicit refresh", async () => {
  const store = fakeStore(fixture());
  const calls = [];
  const ctx = await component({ board: store.board, store, mutate: async (request) => {
    calls.push(request);
    if (calls.length === 1) throw new Error("request never reached the server");
    return store.mutate(request);
  } });
  try {
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    ctx.byId("task-title").value = "冲突后仍保留的草稿";
    await submit(ctx, "task-form");
    assert.equal(ctx.byId("task-title").disabled, true);
    const changed = store.board;
    changed.revision += 1;
    changed.tasks[0].title = "另一个窗口已更新";
    store.board = changed;
    await submit(ctx, "task-form");
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(ctx.byId("task-title").value, "冲突后仍保留的草稿");
    assert.equal(ctx.byId("task-title").disabled, false);
    assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
    assert.match(activeError(ctx).textContent, /刷新记录.*核对/);
    assert.equal(store.board.tasks[0].title, "另一个窗口已更新");
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-title").value, "冲突后仍保留的草稿");
    assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
    ctx.document.querySelector('[data-conflict-choice="local"]').click();
    await submit(ctx, "task-form");
    assert.equal(calls[2].expectedRevision, changed.revision);
    assert.notEqual(calls[2].requestId, calls[0].requestId);
    assert.equal(store.board.tasks.length, 1);
    assert.equal(store.board.tasks[0].title, "冲突后仍保留的草稿");
    assert.equal(ctx.byId("task-form").hidden, true);
    assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
  } finally { ctx.dom.window.close(); }
});

test("newer notifications do not replace the revision captured when editing began", async () => {
  const store = fakeStore(fixture());
  const ctx = await component({ board: store.board, store });
  try {
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    ctx.byId("task-title").value = "保留草稿";
    const changed = store.board;
    changed.revision += 1;
    changed.tasks[0].title = "已经更新";
    store.board = changed;
    ctx.view.acceptReadResult(readResult(changed));
    await submit(ctx, "task-form");
    assert.equal(store.calls[0].expectedRevision, 3);
    assert.equal(store.board.tasks[0].title, "已经更新");
    assert.equal(ctx.byId("task-title").value, "保留草稿");
    const older = fixture();
    assert.equal(ctx.view.setBoard(older), true);
    assert.equal(ctx.document.querySelector("article .task-title").textContent, "已经更新");
  } finally { ctx.dom.window.close(); }
});

test("invalid data, links and markup cannot become saved records or executable content", async () => {
  const ctx = await component({ board: fixture() });
  try {
    const invalid = fixture();
    invalid.tasks[0].conversationUrl = "javascript:alert(1)";
    assert.equal(ctx.view.setBoard(invalid), false);
    assert.equal(ctx.document.querySelector("article .task-title").textContent, "复习词汇");
    const markup = fixture();
    markup.tasks[0].title = '<img src="https://example.invalid/pixel" onerror="alert(1)">';
    assert.equal(ctx.view.setBoard(markup), true);
    assert.equal(ctx.document.querySelectorAll("#cards img").length, 0);
    assert.match(ctx.document.querySelector("article .task-title").textContent, /<img/);
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    for (const link of ["javascript:alert(1)", "https://user:secret@example.com/chat", "https://example.com/has space"]) {
      ctx.byId("task-conversation").value = link;
      await submit(ctx, "task-form");
      assert.equal(ctx.store.calls.length, 0);
      assert.equal(ctx.byId("task-conversation").value, link);
      assert.match(activeError(ctx).textContent, /原对话链接/);
    }
  } finally { ctx.dom.window.close(); }
});

let bundlePromise;
async function bundledHtml() {
  bundlePromise ||= (async () => {
    const template = await loadAppTemplate();
    const result = await build({ entryPoints: [fileURLToPath(new URL("../src/app.mjs", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true, legalComments: "inline" });
    const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
    return template.replace("<!-- APP_SCRIPT -->", () => `<script>${script}</script>`);
  })();
  return bundlePromise;
}

test("actual bundled SDK standalone view is blank and clearly cannot save", async () => {
  const dom = new JSDOM(await bundledHtml(), { runScripts: "dangerously", beforeParse(window) { Object.defineProperty(window.navigator, "language", { value: "zh-CN", configurable: true }); window.structuredClone = structuredClone; window.TextEncoder = TextEncoder; } });
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll("article").length, 0);
    assert.equal(document.getElementById("connection").textContent, "组件预览 · 不能本机保存");
    assert.equal(document.getElementById("new-project").disabled, true);
    assert.equal(document.getElementById("new-task").disabled, true);
    assert.match(document.getElementById("notice").textContent, /不能本机保存/);
  } finally { dom.window.close(); }
});

async function sdkHost(store, { mutate = store.mutate, data = store.data, initializeError = false } = {}) {
  const sent = [];
  const errors = [];
  let guest;
  let initialized;
  const ready = new Promise((resolve) => { initialized = resolve; });
  const respond = (message, result, error) => guest.queueMicrotask(() => guest.dispatchEvent(new guest.MessageEvent("message", {
    source: host, data: { jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) },
  })));
  const host = {
    postMessage(message) {
      sent.push(message);
      if (message.method === "ui/initialize") {
        if (initializeError) respond(message, null, { code: -32603, message: "Host unavailable" });
        else respond(message, { protocolVersion: "2026-01-26", hostInfo: { name: "component-test-host", version: "0.2.0" }, hostCapabilities: { serverTools: {} }, hostContext: { theme: "light", displayMode: "fullscreen" } });
      }
      if (message.method === "ui/notifications/initialized") initialized();
      if (message.method === "tools/call") {
        const work = message.params.name === TOOL_NAME ? store.refresh() : message.params.name === CODEX_TOOL_NAME ? { structuredContent: { ok: true, snapshot: unavailableCodexSnapshot(timestamp) } } : message.params.name === DATA_TOOL_NAME ? data(message.params.arguments) : mutate(message.params.arguments);
        Promise.resolve(work).then((result) => respond(message, result), () => respond(message, null, { code: -32603, message: "Disconnected" }));
      }
    },
  };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(await bundledHtml(), {
    runScripts: "dangerously", virtualConsole, pretendToBeVisual: true,
    beforeParse(window) { Object.defineProperty(window.navigator, "language", { value: "zh-CN", configurable: true });
      guest = window;
      window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder;
      // JSDOM verifies DOM/protocol behavior, not native host placement or layout.
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      Object.defineProperty(window, "parent", { value: host });
    },
  });
  if (!initializeError) await ready;
  await tick();
  await tick();
  return {
    dom, sent, errors, document: dom.window.document, byId: (id) => dom.window.document.getElementById(id),
    notify(result) { guest.dispatchEvent(new guest.MessageEvent("message", { source: host, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result } })); },
    theme(theme) { guest.dispatchEvent(new guest.MessageEvent("message", { source: host, data: { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme } } })); },
    protocolError() { guest.dispatchEvent(new guest.MessageEvent("message", { source: host, data: { jsonrpc: "2.0", invalid: true } })); },
  };
}

test("bundled official SDK receives tool-result, sends mutation tools/call and reads saved data on reopen", { timeout: 10000 }, async () => {
  const store = fakeStore();
  const ctx = await sdkHost(store);
  try {
    assert.equal(ctx.sent[0].method, "ui/initialize");
    assert.equal(ctx.sent[0].params.appInfo.version, VERSION);
    assert.ok(ctx.sent.some((message) => message.method === "ui/notifications/initialized"));
    assert.ok(ctx.sent.some((message) => message.method === "tools/call" && message.params.name === TOOL_NAME));
    assert.equal(ctx.byId("new-project").disabled, false);
    const incoming = fixture();
    store.board = incoming;
    ctx.notify(readResult(incoming));
    await tick();
    assert.equal(ctx.document.querySelector("article .task-title").textContent, "复习词汇");
    ctx.document.querySelector("[data-edit-task]").click();
    change(ctx, "task-read-quick-status", "in_progress"); await tick();
    ctx.byId("task-read-edit").click();
    ctx.byId("task-title").value = "在宿主中修改词汇任务";
    await submit(ctx, "task-form");
    const sentMutation = ctx.sent.find((message) => message.method === "tools/call" && message.params.name === MUTATION_TOOL_NAME);
    assert.ok(sentMutation);
    assert.equal(sentMutation.params.arguments.expectedRevision, incoming.revision);
    assert.deepEqual(sentMutation.params.arguments.operation, { type: "patch_task", taskId, patch: { status: "in_progress" } });
    const textMutation = ctx.sent.find((message) => message.method === "tools/call" && message.params.arguments?.operation?.type === "save_task");
    assert.equal(textMutation.params.arguments.expectedRevision, incoming.revision + 1);
    assert.equal(textMutation.params.arguments.operation.task.id, taskId);
    assert.equal(ctx.byId("save-status").textContent, "已保存到本机。");
    assert.equal(ctx.document.querySelector(".status").textContent, "进行中");
    assert.deepEqual(ctx.errors, []);
    const reopened = await sdkHost(store);
    try {
      assert.equal(reopened.document.querySelector("article .task-title").textContent, "在宿主中修改词汇任务");
      assert.equal(reopened.document.querySelector(".status").textContent, "进行中");
      assert.deepEqual(reopened.errors, []);
    } finally { reopened.dom.window.close(); }
  } finally { ctx.dom.window.close(); }
});

test("bundled SDK tool errors preserve draft and SDK onerror is visible", { timeout: 10000 }, async () => {
  const store = fakeStore(fixture());
  const ctx = await sdkHost(store, { mutate: async () => failure("SAVE_FAILED") });
  try {
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    ctx.byId("task-title").value = "不能丢掉的编辑";
    await submit(ctx, "task-form");
    assert.equal(ctx.byId("task-title").value, "不能丢掉的编辑");
    assert.equal(ctx.byId("task-form").hidden, false);
    assert.match(activeError(ctx).textContent, /保存到本机失败/);
    assert.equal(ctx.byId("save-status").textContent, "");
    ctx.protocolError();
    await tick();
    assert.match(activeError(ctx).textContent, /宿主连接发生错误/);
    assert.equal(ctx.byId("task-title").value, "不能丢掉的编辑");
    ctx.notify(failure("INVALID_STORE"));
    await tick();
    assert.match(activeError(ctx).textContent, /本机记录文件无法读取/);
    assert.equal(ctx.document.querySelector("article .task-title").textContent, "复习词汇");
    assert.deepEqual(ctx.errors, []);
  } finally { ctx.dom.window.close(); }
});

test("bundled SDK routes Codex snapshots and collector receipts without disturbing the manual draft", { timeout: 10000 }, async () => {
  const ctx = await sdkHost(fakeStore(fixture()));
  try {
    openTaskForEditing(ctx, ctx.document.querySelector("[data-edit-task]").closest("article"));
    ctx.byId("task-title").value = "保留手工编辑草稿";
    const snapshot = unavailableCodexSnapshot(timestamp);
    snapshot.threads = [{ id: "55555555-5555-4555-8555-555555555555", hostId: "local", title: "独立 Codex 任务", cwd: null, updatedAt: timestamp, runtimeStatus: "unknown", attention: null, lastTurnStatus: null, goalStatus: null }];
    ctx.notify({ content: [], structuredContent: { ok: true, snapshot } });
    await tick();
    ctx.byId("sidebar-all").click(); // Unknown runtime tasks are outside the default attention view.
    assert.match(ctx.byId("cards").textContent, /独立 Codex 任务/);
    assert.equal(ctx.document.querySelectorAll("[data-codex-thread]").length, 0);
    const manualState = () => {
      assert.equal(ctx.byId("task-title").value, "保留手工编辑草稿");
      assert.equal(ctx.byId("task-form").hidden, false);
      assert.equal(ctx.document.querySelector(`#manual-board [data-task-id="${taskId}"] .task-title`).textContent, "复习词汇");
      assert.equal(ctx.byId("data-error").hidden, true);
      assert.equal(ctx.byId("editor-error").hidden, true);
    };
    manualState();
    ctx.notify({ content: [], structuredContent: { ok: true, capturedAt: timestamp, threadCount: 1, complete: true, truncated: false, unchanged: false } });
    await tick(); manualState();
    // Codex read/collector failures currently have text-only results, not manual-store errors.
    ctx.notify({ isError: true, content: [{ type: "text", text: "Codex 状态来源暂时不可用" }] });
    await tick(); manualState();
    ctx.notify({ content: [], structuredContent: { ok: true, snapshot: { version: 99 } } });
    await tick(); manualState();
    assert.match(ctx.byId("codex-read-error").textContent, /返回数据不完整/);
    assert.deepEqual(ctx.errors, []);
  } finally { ctx.dom.window.close(); }
});

test("bundled SDK handshake rejection never enables saving", { timeout: 10000 }, async () => {
  const ctx = await sdkHost(fakeStore(), { initializeError: true });
  try {
    assert.equal(ctx.byId("new-project").disabled, true);
    assert.equal(ctx.byId("new-task").disabled, true);
    assert.match(ctx.byId("connection").textContent, /连接未完成.*不能本机保存/);
    assert.match(activeError(ctx).textContent, /无法连接宿主/);
    assert.equal(ctx.sent.filter((message) => message.method === "tools/call").length, 0);
    assert.deepEqual(ctx.errors, []);
  } finally { ctx.dom.window.close(); }
});

test("V3 bundled SDK applies the initial host theme and subsequent theme changes", { timeout: 10000 }, async () => {
  const ctx = await sdkHost(fakeStore());
  try {
    assert.equal(ctx.document.documentElement.dataset.theme, "light");
    ctx.theme("dark");
    await tick();
    assert.equal(ctx.document.documentElement.dataset.theme, "dark");
    ctx.theme("light");
    await tick();
    assert.equal(ctx.document.documentElement.dataset.theme, "light");
    assert.deepEqual(ctx.errors, []);
  } finally { ctx.dom.window.close(); }
});

test("refresh merges unchanged task fields from remote while retaining only actual local edits", async () => {
  const ctx = await component({ board: fixture() });
  try {
    openTaskForEditing(ctx, cardFor(ctx, taskId));
    ctx.byId("task-title").value = "本地改标题";
    const remote = ctx.store.board;
    remote.revision += 1;
    remote.tasks[0].currentStep = "远端的新步骤";
    remote.tasks[0].priority = "urgent";
    remote.tasks[0].dueDate = "2026-12-31";
    ctx.store.board = remote;
    await submit(ctx, "task-form");
    assert.equal(ctx.store.calls.length, 1);
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-title").value, "本地改标题");
    assert.equal(ctx.byId("task-step").value, "远端的新步骤");
    assert.equal(ctx.byId("task-priority").value, "urgent");
    assert.equal(ctx.byId("task-due-date").value, "2026-12-31");
    assert.equal(ctx.byId("merge-conflicts").hidden, true);
    await submit(ctx, "task-form");
    assert.equal(ctx.store.calls[1].expectedRevision, remote.revision);
    assert.equal(ctx.store.board.tasks[0].currentStep, "远端的新步骤");
    assert.equal(ctx.store.board.tasks[0].title, "本地改标题");
    assert.equal(ctx.store.board.tasks[0].priority, "urgent");
  } finally { ctx.dom.window.close(); }
});

test("project merge offers safe latest/local choices and repeated refresh cannot implicitly resolve a conflict", async () => {
  const ctx = await component({ board: fixture() });
  try {
    change(ctx, "project-filter", projectId);
    ctx.byId("edit-project").click();
    ctx.byId("project-name").value = "本地名称";
    const remote = ctx.store.board;
    remote.revision += 1;
    remote.projects[0].name = "最新名称";
    remote.projects[0].description = "最新说明";
    ctx.store.board = remote;
    await submit(ctx, "project-form");
    await ctx.view.refresh();
    await ctx.view.refresh();
    assert.equal(ctx.byId("project-form").querySelector('[type="submit"]').disabled, true);
    assert.equal(ctx.byId("project-description-input").value, "最新说明");
    assert.equal(ctx.byId("merge-conflicts").querySelectorAll("[data-conflict-field]").length, 1);
    ctx.document.querySelector('[data-conflict-choice="remote"]').click();
    assert.equal(ctx.byId("project-name").value, "最新名称");
    await submit(ctx, "project-form");
    assert.equal(ctx.store.board.projects[0].name, "最新名称");
    assert.equal(ctx.store.board.projects[0].description, "最新说明");
  } finally { ctx.dom.window.close(); }
});

test("identical concurrent edits merge without unnecessary conflict and deleted projects do not silently reassign a draft", async () => {
  const ctx = await component({ board: fixture() });
  try {
    openTaskForEditing(ctx, cardFor(ctx, taskId));
    ctx.byId("task-title").value = "共同的标题";
    const remote = ctx.store.board;
    remote.revision += 1;
    remote.tasks[0].title = "共同的标题";
    ctx.store.board = remote;
    await ctx.view.refresh();
    assert.equal(ctx.byId("merge-conflicts").hidden, true);
    await submit(ctx, "task-form");
    assert.equal(ctx.store.calls.length, 0, "相同并发内容已合并为已保存状态，不应再次写入");
    assert.equal(ctx.store.board.revision, remote.revision);
    ctx.byId("new-task").click();
    change(ctx, "task-project", projectId);
    ctx.byId("task-title").value = "项目删除后的草稿";
    const deleted = ctx.store.board;
    deleted.projects = deleted.projects.filter((project) => project.id !== projectId);
    deleted.tasks = [];
    deleted.revision += 1;
    ctx.store.board = deleted;
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-project").value, projectId);
    assert.equal(ctx.byId("task-title").value, "项目删除后的草稿");
    await submit(ctx, "task-form");
    assert.equal(ctx.store.calls.length, 0, "相同内容与关联项目缺失都不能发送写入");
    assert.match(activeError(ctx).textContent, /请选择已保存的项目/);
  } finally { ctx.dom.window.close(); }
});

for (const creating of [false, true]) {
  test(`confirmed ${creating ? "creation" : "edit"} reveals its actual task across every filter and collapsed destination`, async () => {
    const board = fixture();
    const store = fakeStore(board);
    const ctx = await component({ board, store, mutate: async (request) => {
      const result = await store.mutate(request);
      if (creating) delete result.structuredContent.entityId; // Legacy-host unique-id fallback.
      return result;
    } });
    try {
      change(ctx, "project-filter", projectId);
      change(ctx, "source-filter", JSON.stringify("手动来源"));
      change(ctx, "status-filter", "planned");
      change(ctx, "search", "复习词汇");
      if (creating) ctx.byId("new-task").click();
      else {
        cardFor(ctx, taskId).querySelector("[data-edit-task]").click();
        change(ctx, "task-read-quick-status", "paused"); await tick();
        ctx.byId("task-read-edit").click();
        change(ctx, "status-filter", "planned");
      }
      ctx.byId("task-title").value = "保存后可见的任务";
      change(ctx, "task-project", otherProjectId);
      if (creating) change(ctx, "task-status", "paused");
      ctx.byId("task-source").value = "新来源";
      await submit(ctx, "task-form");
      const saved = store.board.tasks.find((task) => task.title === "保存后可见的任务");
      assert.ok(saved);
      assert.equal(ctx.byId("project-filter").value, "all");
      assert.equal(ctx.byId("source-filter").value, "all");
      assert.equal(ctx.byId("status-filter").value, "all");
      assert.equal(ctx.byId("search").value, "");
      assert.equal(columnFor(ctx, "paused").classList.contains("is-collapsed"), false);
      assert.equal(cardFor(ctx, saved.id).querySelector("[data-edit-task]").textContent, saved.title);
      assert.equal(ctx.document.activeElement.dataset.editTask, saved.id);
    } finally { ctx.dom.window.close(); }
  });
}

test("read rerenders retain keyboard control, open menus and independent scroll positions while canceling old drags", async () => {
  const ctx = await component({ board: multiTaskFixture() });
  try {
    const card = cardFor(ctx, taskId);
    card.querySelector("details").open = true;
    card.querySelector('[data-move-control="status"]').focus();
    ctx.byId("cards").scrollLeft = 145;
    ctx.document.querySelector(".board-area").scrollTop = 81;
    ctx.byId("column-planned").scrollTop = 62;
    dragEvent(ctx, card, "dragstart");
    const newest = ctx.store.board;
    newest.revision += 1;
    newest.tasks[0].currentStep = "最新步骤";
    ctx.view.acceptReadResult(readResult(newest));
    assert.equal(cardFor(ctx, taskId).querySelector("details").open, true);
    assert.equal(ctx.document.activeElement.dataset.moveControl, "status");
    assert.equal(ctx.document.activeElement.closest("[data-task-id]").dataset.taskId, taskId);
    assert.equal(ctx.byId("cards").scrollLeft, 145);
    assert.equal(ctx.document.querySelector(".board-area").scrollTop, 81);
    assert.equal(ctx.byId("column-planned").scrollTop, 62);
    dragEvent(ctx, columnFor(ctx, "completed"), "drop");
    assert.equal(ctx.store.calls.length, 0);
    assert.equal(ctx.document.querySelectorAll(".is-dragging").length, 0);
  } finally { ctx.dom.window.close(); }
});

test("folded columns count records without constructing hidden cards", async () => {
  const ctx = await component({ board: multiTaskFixture() });
  try {
    assert.equal(columnFor(ctx, "paused").querySelector(".column-count").textContent, "1");
    assert.equal(columnFor(ctx, "paused").querySelectorAll("article").length, 0);
    assert.equal(columnFor(ctx, "failed").querySelectorAll("article").length, 0);
    columnFor(ctx, "paused").querySelector("[data-toggle-column]").click();
    assert.equal(columnFor(ctx, "paused").querySelectorAll("article").length, 1);
    assert.equal(ctx.document.activeElement.dataset.toggleColumn, "paused");
  } finally { ctx.dom.window.close(); }
});

test("preferences persist only view/filter/folding values and storage denial leaves editing available", async () => {
  const ctx = await component({ board: fixture(), preferences: { viewMode: "list", collapsed: ["completed"], project: projectId, status: "planned", source: JSON.stringify("手动来源"), archive: "active", search: "不能恢复的搜索文本", draft: "不能恢复的草稿" } });
  try {
    assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true");
    assert.equal(ctx.byId("project-filter").value, projectId);
    assert.equal(ctx.byId("search").value, "");
    assert.equal(columnFor(ctx, "planned").classList.contains("is-collapsed"), false);
    change(ctx, "search", "私密搜索文本");
    const saved = JSON.parse(ctx.dom.window.localStorage.getItem("learning-board:view-preferences:v1"));
    assert.deepEqual(Object.keys(saved).sort(), ["archive", "collapsed", "project", "record", "source", "status", "timeZone", "viewMode"]);
    assert.equal(saved.record, "all");
    assert.equal(JSON.stringify(saved).includes("私密搜索文本"), false);
    Object.defineProperty(ctx.dom.window, "localStorage", { get() { throw new Error("Storage denied"); } });
    change(ctx, "search", "");
    ctx.byId("new-task").click();
    ctx.byId("task-title").value = "没有浏览器存储也能保存";
    await submit(ctx, "task-form");
    assert.equal(ctx.store.board.tasks.length, 2);
  } finally { ctx.dom.window.close(); }
});

test("archiving a project hides its tasks without changing their archive flags and permits separate restoration", async () => {
  const ctx = await component({ board: fixture() });
  try {
    change(ctx, "project-filter", projectId);
    ctx.byId("archive-project").click();
    await tick();
    assert.equal(ctx.store.board.projects[0].archivedAt, timestamp);
    assert.equal(ctx.store.board.tasks[0].archivedAt, null);
    change(ctx, "archive-filter", "active");
    assert.equal(ctx.document.querySelectorAll("article").length, 0);
    change(ctx, "archive-filter", "archived");
    assert.equal(cardFor(ctx, taskId).draggable, false);
    assert.equal(cardFor(ctx, taskId).querySelector('[data-move-control="status"]').disabled, true);
    ctx.byId("archive-project").click();
    await tick();
    assert.equal(ctx.store.board.projects[0].archivedAt, null);
    assert.equal(ctx.store.board.tasks[0].archivedAt, null);
    change(ctx, "archive-filter", "active");
    cardFor(ctx, taskId).querySelector("[data-archive-task]").click();
    await tick();
    assert.equal(ctx.store.board.tasks[0].archivedAt, timestamp);
    change(ctx, "archive-filter", "archived");
    cardFor(ctx, taskId).querySelector("[data-archive-task]").click();
    await tick();
    assert.equal(ctx.store.board.tasks[0].archivedAt, null);
    assert.equal(ctx.byId("save-status").textContent, "已恢复并保存到本机。");
  } finally { ctx.dom.window.close(); }
});

test("next-action view puts waiting tasks before upcoming tasks sorted by priority and due date without mutating saved order", async () => {
  const board = fixture();
  const base = board.tasks[0];
  board.tasks = [
    { ...base, title: "普通" },
    { ...base, id: randomUUID(), title: "较晚紧急", priority: "urgent", dueDate: "2026-12-10", status: "in_progress" },
    { ...base, id: randomUUID(), title: "较早紧急", priority: "urgent", dueDate: "2026-10-10" },
    { ...base, id: randomUUID(), title: "等待用户", priority: "urgent", status: "waiting_user" },
    { ...base, id: randomUUID(), title: "不含归档", priority: "urgent", archivedAt: timestamp },
  ];
  const ctx = await component({ board, now: () => Date.parse("2026-10-05T04:00:00Z") });
  try {
    ctx.byId("view-next").click();
    assert.deepEqual([...ctx.document.querySelectorAll(".task-title")].map((node) => node.textContent), ["等待用户", "较早紧急", "较晚紧急", "普通"]);
    assert.equal(cardFor(ctx, board.tasks[3].id).dataset.attentionGroup, "attention");
    assert.equal(ctx.document.querySelector(".next-actions-summary").textContent, "待处理 1 项 · 接下来 3 项");
    assert.deepEqual(ctx.store.board.tasks.map((task) => task.id), board.tasks.map((task) => task.id));
    assert.equal(ctx.store.calls.length, 0);
    cardFor(ctx, base.id).querySelector("[data-edit-task]").click();
    change(ctx, "task-read-quick-priority", "high"); await tick();
    ctx.byId("task-read-edit").click();
    change(ctx, "task-due-date", "2028-02-29");
    await submit(ctx, "task-form");
    assert.equal(ctx.store.board.tasks[0].priority, "high");
    assert.equal(ctx.store.board.tasks[0].dueDate, "2028-02-29");
  } finally { ctx.dom.window.close(); }
});

for (const kind of ["save", "move", "archive"]) {
  test(`${kind} REQUEST_EXPIRED preserves the original request and requires refreshed user review to end without resubmitting`, async () => {
    const store = fakeStore(fixture());
    const calls = [];
    const ctx = await component({ board: store.board, store, mutate: async (request) => { calls.push(request); return failure("REQUEST_EXPIRED", store.board); } });
    try {
      if (kind === "save") { openTaskForEditing(ctx, cardFor(ctx, taskId)); ctx.byId("task-title").value = "待核对的草稿"; await submit(ctx, "task-form"); }
      else if (kind === "move") { dragEvent(ctx, cardFor(ctx, taskId), "dragstart"); dragEvent(ctx, columnFor(ctx, "completed"), "drop"); await tick(); }
      else { cardFor(ctx, taskId).querySelector("[data-archive-task]").click(); await tick(); }
      assert.equal(calls.length, 1);
      assert.equal(ctx.byId("expired-feedback").hidden, false);
      assert.equal(ctx.byId("expired-reviewed").disabled, true);
      assert.equal(ctx.byId("expired-end").disabled, true);
      ctx.byId(kind === "save" ? "task-form" : kind === "move" ? "move-feedback" : "action-feedback").querySelector(kind === "save" ? '[type="submit"]' : "button").click();
      assert.equal(calls.length, 1);
      await ctx.view.refresh();
      assert.equal(ctx.byId("expired-reviewed").disabled, false);
      assert.equal(ctx.byId("expired-end").disabled, true);
      if (kind === "save") assert.equal(ctx.byId("task-title").disabled, true);
      ctx.byId("expired-reviewed").checked = true;
      ctx.byId("expired-reviewed").dispatchEvent(new ctx.dom.window.Event("change"));
      ctx.byId("expired-end").click();
      assert.equal(ctx.byId("expired-feedback").hidden, true);
      assert.equal(calls.length, 1);
      assert.equal(store.board.revision, 3);
      assert.match(ctx.byId("save-status").textContent, /没有发送新的保存请求/);
    } finally { ctx.dom.window.close(); }
  });
}

async function selectBackupFile(ctx, backup) {
  const file = new ctx.dom.window.File([JSON.stringify(backup)], "backup.json", { type: "application/json" });
  Object.defineProperty(ctx.byId("data-file"), "files", { configurable: true, value: [file] });
  ctx.byId("data-file").dispatchEvent(new ctx.dom.window.Event("change"));
  for (let count = 0; count < 5; count += 1) await tick();
}

test("backup export supplies copyable fallback and malformed imports never mutate or leave an old preview confirmable", async () => {
  const ctx = await component({ board: fixture() });
  try {
    assert.equal(await ctx.view.exportBackup(), true);
    assert.equal(ctx.byId("export-fallback").hidden, false);
    assert.deepEqual(validateBackup(JSON.parse(ctx.byId("export-json").value)).board, ctx.store.board);
    ctx.byId("export-copy").click();
    await tick();
    assert.equal(ctx.document.activeElement, ctx.byId("export-json"));
    const backup = makeBackup(emptyBoard(), timestamp);
    assert.equal(await ctx.view.previewBackup(backup), true);
    assert.equal(ctx.byId("restore-confirm").disabled, false);
    assert.equal(await ctx.view.previewBackup({ ...backup, checksum: "bad" }), false);
    assert.equal(ctx.byId("restore-preview").hidden, true);
    assert.equal(ctx.byId("restore-confirm").disabled, true);
    assert.equal(ctx.store.calls.length, 0);
    assert.equal(ctx.store.board.tasks.length, 1);
  } finally { ctx.dom.window.close(); }
});

test("confirmed manual backup restore clears automatic record filters and reveals restored tasks", async () => {
  const ctx = await component({ board: fixture() });
  try {
    change(ctx, "record-filter", "codex"); change(ctx, "search", "不会匹配的筛选");
    await ctx.view.previewBackup(makeBackup(fixture(), timestamp));
    ctx.byId("restore-confirm").click(); await tick();
    assert.equal(ctx.store.calls.length, 1); assert.equal(ctx.store.calls[0].operation.type, "restore_board");
    assert.equal(ctx.byId("record-filter").value, "all"); assert.equal(ctx.byId("search").value, "");
    assert.equal(ctx.byId("restore-preview").hidden, true); assert.ok(cardFor(ctx, taskId));
  } finally { ctx.dom.window.close(); }
});

test("restore confirmation freezes preview revision, conflicts require a fresh preview and dirty editors block restore", async () => {
  const ctx = await component({ board: fixture() });
  const backup = makeBackup(emptyBoard(), timestamp);
  try {
    openTaskForEditing(ctx, cardFor(ctx, taskId));
    ctx.byId("task-step").value = "不得丢失的草稿";
    assert.equal(await ctx.view.previewBackup(backup), false);
    assert.equal(ctx.byId("data-file").disabled, true);
    assert.equal(ctx.byId("task-step").value, "不得丢失的草稿");
    ctx.byId("editor-close").click();
    assert.equal(ctx.byId("discard-dialog").hidden, false);
    ctx.byId("discard-edits").click();
    assert.equal(await ctx.view.previewBackup(backup), true);
    const changed = ctx.store.board;
    changed.revision += 1;
    ctx.store.board = changed;
    await ctx.view.refresh();
    ctx.byId("restore-confirm").click();
    await tick();
    assert.equal(ctx.store.calls[0].expectedRevision, 3, "A normal refresh must not rebase a destructive restore intent");
    assert.equal(ctx.store.board.tasks.length, 1);
    assert.equal(ctx.byId("restore-confirm").disabled, true);
    assert.equal(ctx.byId("action-retry").textContent, "重新预览恢复");
    ctx.byId("action-retry").click();
    await tick();
    assert.equal(ctx.store.calls.length, 1, "Repreview must not mutate");
    ctx.byId("restore-confirm").click();
    await tick();
    assert.equal(ctx.store.calls[1].expectedRevision, changed.revision);
    assert.notEqual(ctx.store.calls[1].requestId, ctx.store.calls[0].requestId);
    assert.equal(ctx.store.board.tasks.length, 0);
    assert.equal(ctx.store.board.projects.length, 0);
    assert.match(ctx.byId("save-status").textContent, /恢复前的记录已自动备份/);
  } finally { ctx.dom.window.close(); }
});

test("lost restore response freezes every writer and replays exactly the original backup request after refresh", async () => {
  const store = fakeStore(fixture());
  const calls = [];
  const ctx = await component({ board: store.board, store, mutate: async (request) => {
    calls.push(structuredClone(request));
    const result = await store.mutate(request);
    if (calls.length === 1) throw new Error("restore response lost after commit");
    return result;
  } });
  try {
    await ctx.view.previewBackup(makeBackup(emptyBoard(), timestamp));
    ctx.byId("restore-confirm").click();
    await tick();
    assert.equal(ctx.byId("action-dismiss").disabled, true);
    assert.equal(ctx.byId("new-project").disabled, true);
    assert.equal(ctx.byId("restore-confirm").disabled, true);
    assert.equal(ctx.byId("data-file").disabled, true);
    assert.equal(store.board.revision, 4);
    await ctx.view.refresh();
    ctx.byId("action-retry").click();
    await tick();
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(store.board.revision, 4);
    assert.equal(ctx.byId("action-feedback").hidden, true);
  } finally { ctx.dom.window.close(); }
});

test("bundled SDK calls the data tool for export/import preview and sends restore only after explicit confirmation", { timeout: 10000 }, async () => {
  const store = fakeStore(fixture());
  const ctx = await sdkHost(store);
  try {
    ctx.byId("data-toggle").click();
    ctx.byId("data-export").click();
    for (let count = 0; count < 4; count += 1) await tick();
    const exports = ctx.sent.filter((message) => message.method === "tools/call" && message.params.name === DATA_TOOL_NAME);
    assert.deepEqual(JSON.parse(JSON.stringify(exports[0].params.arguments)), { action: "export" });
    const exported = JSON.parse(ctx.byId("export-json").value);
    assert.equal(exported.board.schemaVersion, 4);
    assert.equal(Object.hasOwn(exported.board, "appliedRequests"), false);
    const backup = makeBackup(emptyBoard(), timestamp);
    await selectBackupFile(ctx, backup);
    const preview = ctx.sent.find((message) => message.method === "tools/call" && message.params.name === DATA_TOOL_NAME && message.params.arguments.action === "preview_restore");
    assert.ok(preview);
    assert.deepEqual(JSON.parse(JSON.stringify(preview.params.arguments.backup)), backup);
    assert.equal(store.calls.length, 0);
    assert.equal(ctx.byId("restore-preview").hidden, false);
    ctx.byId("restore-confirm").click();
    for (let count = 0; count < 4; count += 1) await tick();
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0].operation.type, "restore_board");
    assert.equal(store.board.tasks.length, 0);
    assert.equal(store.board.schemaVersion, 4);
    assert.equal(ctx.byId("action-feedback").hidden, true);
    assert.equal(ctx.errors.length, 0);
  } finally { ctx.dom.window.close(); }
});

test("a host without the optional data tool keeps core editing usable and clearly disables backup controls", async () => {
  const html = await loadAppTemplate();
  const dom = new JSDOM(html);
  const store = fakeStore(fixture());
  try {
    const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), { mutate: store.mutate, refresh: store.refresh }));
    view.setHostState({ connected: true, message: "已连接" });
    view.acceptReadResult(readResult(store.board));
    assert.equal(dom.window.document.getElementById("data-export").disabled, true);
    assert.equal(dom.window.document.getElementById("data-file").disabled, true);
    assert.equal(dom.window.document.getElementById("new-task").disabled, false);
    assert.equal(await view.exportBackup(), false);
    assert.equal(await view.previewBackup(makeBackup(emptyBoard(), timestamp)), false);
    assert.equal(store.calls.length, 0);
  } finally { dom.window.close(); }
});

test("an uncertain save refresh freezes its old baseline and request until confirmed conflict permits a deliberate merge", async () => {
  const store = fakeStore(fixture());
  const calls = [];
  const ctx = await component({ board: store.board, store, mutate: async (request) => {
    calls.push(structuredClone(request));
    if (calls.length === 1) throw new Error("unconfirmed delivery");
    return store.mutate(request);
  } });
  try {
    openTaskForEditing(ctx, cardFor(ctx, taskId));
    ctx.byId("task-title").value = "本地未确认标题";
    await submit(ctx, "task-form");
    const remote = store.board;
    remote.revision += 1;
    remote.tasks[0].currentStep = "远端已变更的步骤";
    remote.tasks[0].priority = "urgent";
    store.board = remote;
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-title").value, "本地未确认标题");
    assert.equal(ctx.byId("task-step").value, "整理今日词汇");
    assert.equal(ctx.byId("task-priority").value, "normal");
    assert.equal(ctx.byId("task-step").disabled, true);
    await submit(ctx, "task-form");
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-step").value, "远端已变更的步骤");
    assert.equal(ctx.byId("task-priority").value, "urgent");
    await submit(ctx, "task-form");
    assert.notEqual(calls[2].requestId, calls[0].requestId);
    assert.equal(store.board.tasks[0].currentStep, "远端已变更的步骤");
  } finally { ctx.dom.window.close(); }
});

test("expired restore cannot be replayed or regenerated and explicit reviewed exit invalidates its old preview", async () => {
  const store = fakeStore(fixture());
  const calls = [];
  const ctx = await component({ board: store.board, store, mutate: async (request) => { calls.push(request); return failure("REQUEST_EXPIRED", store.board); } });
  try {
    await ctx.view.previewBackup(makeBackup(emptyBoard(), timestamp));
    ctx.byId("restore-confirm").click();
    await tick();
    assert.equal(ctx.byId("action-retry").disabled, true);
    assert.equal(ctx.byId("action-dismiss").disabled, true);
    assert.equal(ctx.byId("expired-end").disabled, true);
    await ctx.view.refresh();
    ctx.byId("expired-reviewed").checked = true;
    ctx.byId("expired-reviewed").dispatchEvent(new ctx.dom.window.Event("change"));
    ctx.byId("expired-end").click();
    assert.equal(ctx.byId("restore-preview").hidden, true);
    assert.equal(ctx.byId("restore-confirm").disabled, true);
    assert.equal(ctx.byId("new-project").disabled, false);
    assert.equal(calls.length, 1);
    assert.equal(store.board.tasks.length, 1);
  } finally { ctx.dom.window.close(); }
});

test("merge preserves a remote project assignment even when that project was archived concurrently", async () => {
  const ctx = await component({ board: fixture() });
  try {
    openTaskForEditing(ctx, cardFor(ctx, taskId));
    ctx.byId("task-title").value = "保留本地标题";
    const remote = ctx.store.board;
    remote.revision += 1;
    remote.tasks[0].projectId = otherProjectId;
    remote.projects[1].archivedAt = timestamp;
    ctx.store.board = remote;
    await ctx.view.refresh();
    assert.equal(ctx.byId("task-project").value, otherProjectId);
    assert.equal(ctx.byId("task-title").value, "保留本地标题");
    await submit(ctx, "task-form");
    assert.equal(ctx.store.board.tasks[0].projectId, otherProjectId);
    assert.equal(ctx.byId("archive-filter").value, "all");
    assert.ok(cardFor(ctx, taskId));
  } finally { ctx.dom.window.close(); }
});

function pagedFixture(count = 125, statuses = ["planned"]) {
  const board = fixture();
  const base = board.tasks[0];
  board.tasks = statuses.flatMap((status) => Array.from({ length: count }, (_, index) => ({
    ...base, id: randomUUID(), status, title: `批量 ${status} ${String(index + 1).padStart(3, "0")}`,
  })));
  return boardSchema.parse(board);
}

const visibleIds = (column) => [...column.querySelectorAll("article")].map((card) => card.dataset.taskId);
function nextPage(ctx, status = "planned") {
  const column = status === "next" ? ctx.document.querySelector(".next-actions") : columnFor(ctx, status);
  const button = column.querySelector('[data-page-control="next"]');
  assert.ok(button);
  assert.equal(button.disabled, false);
  button.click();
}

test("per-column pagination bounds the DOM and visits every record with unchanged total counts and status-specific labels", async () => {
  const statuses = Object.keys(STATUS_LABELS);
  const board = pagedFixture(101, statuses);
  const ctx = await component({ board });
  try {
    assert.equal(PAGE_SIZE, 50);
    assert.equal(ctx.byId("count").textContent, "606 / 606 项任务");
    for (const status of statuses) {
      if (columnFor(ctx, status).classList.contains("is-collapsed")) columnFor(ctx, status).querySelector("[data-toggle-column]").click();
      const expected = board.tasks.filter((task) => task.status === status).map((task) => task.id);
      const visited = [];
      for (let page = 0; page < 3; page += 1) {
        const column = columnFor(ctx, status);
        assert.equal(column.dataset.page, String(page));
        assert.equal(column.dataset.pageSize, String(PAGE_SIZE));
        assert.equal(column.querySelector(".column-count").textContent, "101");
        assert.deepEqual(visibleIds(column), expected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
        assert.equal(column.querySelector(".page-count").textContent, `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, 101)}/101`);
        assert.equal(column.querySelector('[data-page-control="previous"]').getAttribute("aria-label"), `${STATUS_LABELS[status]}：上一页`);
        assert.equal(column.querySelector('[data-page-control="next"]').getAttribute("aria-label"), `${STATUS_LABELS[status]}：下一页`);
        assert.equal(column.querySelector('[data-page-control="previous"]').disabled, page === 0);
        visited.push(...visibleIds(column));
        if (page < 2) nextPage(ctx, status);
        else assert.equal(column.querySelector('[data-page-control="next"]').disabled, true);
      }
      assert.deepEqual(visited, expected);
    }
    assert.equal(ctx.store.calls.length, 0, "Paging is a viewing operation");
    assert.ok(ctx.document.querySelectorAll("article").length <= PAGE_SIZE * statuses.length);
  } finally { ctx.dom.window.close(); }
});

test("small columns have no paging controls and filtering/view switching resets page state without storing pages", async () => {
  const ctx = await component({ board: pagedFixture() });
  try {
    nextPage(ctx);
    assert.equal(columnFor(ctx, "planned").dataset.page, "1");
    change(ctx, "search", "批量");
    assert.equal(columnFor(ctx, "planned").dataset.page, "0");
    nextPage(ctx);
    ctx.byId("view-list").click();
    assert.equal(columnFor(ctx, "planned").dataset.page, "0");
    nextPage(ctx);
    ctx.byId("clear").click();
    assert.equal(columnFor(ctx, "planned").dataset.page, "0");
    change(ctx, "search", "批量 planned 125");
    assert.equal(columnFor(ctx, "planned").querySelectorAll("article").length, 1);
    assert.equal(columnFor(ctx, "planned").querySelector(".column-count").textContent, "1");
    assert.equal(columnFor(ctx, "planned").querySelector(".column-pagination"), null);
    const preferences = JSON.parse(ctx.dom.window.localStorage.getItem("learning-board:view-preferences:v1"));
    assert.equal(Object.hasOwn(preferences, "pages"), false);
    assert.equal(Object.hasOwn(preferences, "page"), false);
    assert.equal(ctx.store.calls.length, 0);
  } finally { ctx.dom.window.close(); }
});

test("notification retains paged keyboard control/menu and clamps a removed last page while canceling a drag", async () => {
  const board = pagedFixture();
  const ctx = await component({ board });
  try {
    nextPage(ctx);
    const id = board.tasks[71].id;
    cardFor(ctx, id).querySelector("details").open = true;
    cardFor(ctx, id).querySelector('[data-move-control="status"]').focus();
    dragEvent(ctx, cardFor(ctx, id), "dragstart");
    const newest = ctx.store.board;
    newest.revision += 1;
    newest.tasks[71].currentStep = "通知后的步骤";
    ctx.view.acceptReadResult(readResult(newest));
    assert.equal(columnFor(ctx, "planned").dataset.page, "1");
    assert.equal(ctx.document.activeElement.closest("[data-task-id]").dataset.taskId, id);
    assert.equal(ctx.document.activeElement.dataset.moveControl, "status");
    assert.equal(cardFor(ctx, id).querySelector("details").open, true);
    dragEvent(ctx, columnFor(ctx, "completed"), "drop");
    assert.equal(ctx.store.calls.length, 0);
    nextPage(ctx);
    assert.equal(columnFor(ctx, "planned").dataset.page, "2");
    const smaller = ctx.store.board;
    smaller.revision += 1;
    smaller.tasks = smaller.tasks.slice(0, 60);
    ctx.view.acceptReadResult(readResult(smaller));
    assert.equal(columnFor(ctx, "planned").dataset.page, "1");
    assert.equal(columnFor(ctx, "planned").querySelector(".page-count").textContent, "51–60/60");
    assert.equal(columnFor(ctx, "planned").querySelector('[data-page-control="next"]').disabled, true);
    assert.equal(ctx.document.activeElement.dataset.pageControl, "previous");
  } finally { ctx.dom.window.close(); }
});

test("reading an inserted record follows keyboard focus across a page boundary without losing its open menu", async () => {
  const board = pagedFixture();
  const ctx = await component({ board });
  try {
    const id = board.tasks[49].id;
    cardFor(ctx, id).querySelector("details").open = true;
    cardFor(ctx, id).querySelector('[data-move-control="status"]').focus();
    const newest = ctx.store.board;
    newest.revision += 1;
    newest.tasks.unshift({ ...newest.tasks[0], id: randomUUID(), title: "前面插入的任务" });
    ctx.view.acceptReadResult(readResult(newest));
    assert.equal(columnFor(ctx, "planned").dataset.page, "1");
    assert.equal(ctx.document.activeElement.closest("[data-task-id]").dataset.taskId, id);
    assert.equal(cardFor(ctx, id).querySelector("details").open, true);
  } finally { ctx.dom.window.close(); }
});

test("up/down moves across a page boundary use full-column anchors and reveal the confirmed task's new page", async () => {
  const board = pagedFixture();
  const ctx = await component({ board });
  try {
    const task50 = board.tasks[49];
    const task51 = board.tasks[50];
    const task52 = board.tasks[51];
    cardFor(ctx, task50.id).querySelector('[data-move-control="down"]').click();
    await tick();
    assert.equal(ctx.store.calls[0].operation.beforeTaskId, task52.id);
    assert.deepEqual(ctx.store.board.tasks.slice(49, 52).map((task) => task.id), [task51.id, task50.id, task52.id]);
    assert.equal(columnFor(ctx, "planned").dataset.page, "1");
    assert.equal(ctx.document.activeElement.dataset.editTask, task50.id);
    cardFor(ctx, task50.id).querySelector('[data-move-control="up"]').click();
    await tick();
    assert.equal(ctx.store.calls[1].operation.beforeTaskId, task51.id);
    assert.equal(columnFor(ctx, "planned").dataset.page, "0");
    assert.equal(ctx.document.activeElement.dataset.editTask, task50.id);
    assert.deepEqual(ctx.store.board.tasks.map((task) => task.id), board.tasks.map((task) => task.id));
  } finally { ctx.dom.window.close(); }
});

test("a filtered creation reveals the new task on its actual last page rather than falsely returning an empty board", async () => {
  const board = pagedFixture();
  const ctx = await component({ board });
  try {
    change(ctx, "search", "不存在的搜索结果");
    change(ctx, "project-filter", projectId);
    change(ctx, "source-filter", JSON.stringify("手动来源"));
    ctx.byId("new-task").click();
    ctx.byId("task-title").value = "已保存的新任务";
    await submit(ctx, "task-form");
    const saved = ctx.store.board.tasks.at(-1);
    assert.equal(saved.title, "已保存的新任务");
    assert.equal(ctx.byId("search").value, "");
    assert.equal(columnFor(ctx, "planned").dataset.page, "2");
    assert.equal(columnFor(ctx, "planned").querySelector(".page-count").textContent, "101–126/126");
    assert.ok(cardFor(ctx, saved.id));
    assert.equal(ctx.document.activeElement.dataset.editTask, saved.id);
  } finally { ctx.dom.window.close(); }
});

test("paging preserves a dirty editor and task-switch decisions, and every pending or unknown writer freezes paging", async () => {
  const board = pagedFixture();
  const store = fakeStore(board);
  const calls = [];
  let release;
  const ctx = await component({ board, store, mutate: (request) => {
    calls.push(request);
    return new Promise((resolve) => { release = resolve; });
  } });
  try {
    openTaskForEditing(ctx, cardFor(ctx, board.tasks[0].id));
    ctx.byId("task-step").value = "跨页仍保留的草稿";
    nextPage(ctx);
    assert.equal(columnFor(ctx, "planned").dataset.page, "1");
    assert.equal(ctx.byId("task-step").value, "跨页仍保留的草稿");
    assert.equal(ctx.byId("discard-dialog").hidden, true);
    openTaskForEditing(ctx, cardFor(ctx, board.tasks[51].id));
    assert.equal(ctx.byId("discard-dialog").hidden, false);
    assert.equal(columnFor(ctx, "planned").querySelector('[data-page-control="next"]').disabled, true);
    ctx.byId("keep-editing").click();
    ctx.byId("task-form").querySelector('[type="submit"]').click();
    assert.equal(columnFor(ctx, "planned").querySelector('[data-page-control="previous"]').disabled, true);
    assert.equal(columnFor(ctx, "planned").querySelector('[data-page-control="next"]').disabled, true);
    release({ isError: true, content: [{ type: "text", text: "unknown bridge failure" }] });
    await tick();
    assert.equal(columnFor(ctx, "planned").querySelector('[data-page-control="next"]').disabled, true);
    assert.equal(ctx.byId("task-step").value, "跨页仍保留的草稿");
    assert.equal(calls.length, 1);
  } finally { ctx.dom.window.close(); }
});

test("next-action pagination retains the complete priority projection and locate-on-save without changing persisted order", async () => {
  const board = pagedFixture(120);
  board.tasks = board.tasks.map((task, index) => ({ ...task, priority: index >= 70 ? "urgent" : "normal" }));
  const ctx = await component({ board });
  try {
    ctx.byId("view-next").click();
    const expected = [...board.tasks.slice(70), ...board.tasks.slice(0, 70)].map((task) => task.id);
    const visited = [];
    for (let page = 0; page < 3; page += 1) {
      const container = ctx.document.querySelector(".next-actions");
      assert.equal(container.dataset.page, String(page));
      assert.deepEqual(visibleIds(container), expected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));
      visited.push(...visibleIds(container));
      if (page < 2) nextPage(ctx, "next");
    }
    assert.deepEqual(visited, expected);
    assert.deepEqual(ctx.store.board.tasks.map((task) => task.id), board.tasks.map((task) => task.id));
    assert.equal(ctx.store.calls.length, 0);
    ctx.byId("new-task").click();
    ctx.byId("task-title").value = "待处理的新任务";
    await submit(ctx, "task-form");
    const saved = ctx.store.board.tasks.at(-1);
    assert.equal(ctx.document.querySelector(".next-actions").dataset.page, "2");
    assert.equal(ctx.document.activeElement.dataset.editTask, saved.id);
    assert.ok(cardFor(ctx, saved.id));
  } finally { ctx.dom.window.close(); }
});

test("moving into another large column locates its final page and archive filtering preserves all saved records", async () => {
  const board = pagedFixture(125, ["planned", "in_progress"]);
  board.tasks[2].archivedAt = timestamp;
  const ctx = await component({ board });
  try {
    const moved = board.tasks[0];
    dragEvent(ctx, cardFor(ctx, moved.id), "dragstart");
    dragEvent(ctx, columnFor(ctx, "in_progress"), "drop");
    await tick();
    assert.equal(columnFor(ctx, "in_progress").dataset.page, "2");
    assert.equal(columnFor(ctx, "in_progress").querySelector(".page-count").textContent, "101–126/126");
    assert.equal(ctx.document.activeElement.dataset.editTask, moved.id);
    assert.equal(ctx.store.board.tasks.length, 250);
    change(ctx, "archive-filter", "archived");
    assert.equal(ctx.byId("count").textContent, "1 / 250 项任务");
    assert.deepEqual(visibleIds(columnFor(ctx, "planned")), [board.tasks[2].id]);
    change(ctx, "archive-filter", "all");
    const expected = ctx.store.board.tasks.filter((task) => task.status === "planned").map((task) => task.id);
    const visited = [];
    for (let page = 0; page < 3; page += 1) {
      visited.push(...visibleIds(columnFor(ctx, "planned")));
      if (page < 2) nextPage(ctx);
    }
    assert.deepEqual(visited, expected);
    assert.equal(ctx.store.board.tasks.length, 250);
    assert.equal(ctx.store.calls.length, 1);
  } finally { ctx.dom.window.close(); }
});

for (const allArchived of [false, true]) {
  test(`opening a task in an archived project preserves its real assignment on title-only save${allArchived ? " when every project is archived" : " with another active project"}`, async () => {
    const board = fixture();
    board.projects[0].archivedAt = timestamp;
    if (allArchived) board.projects[1].archivedAt = timestamp;
    const ctx = await component({ board });
    try {
      change(ctx, "archive-filter", "all");
      openTaskForEditing(ctx, cardFor(ctx, taskId));
      assert.equal(ctx.byId("task-project").value, projectId);
      assert.equal(ctx.byId("task-project").selectedOptions[0].textContent, "英语学习（已归档）");
      ctx.byId("task-title").value = "只修改归档项目任务的标题";
      await submit(ctx, "task-form");
      assert.equal(ctx.store.calls.length, 1);
      assert.equal(ctx.store.calls[0].operation.task.projectId, projectId);
      assert.equal(ctx.store.board.tasks[0].projectId, projectId);
      assert.equal(ctx.store.board.tasks[0].title, "只修改归档项目任务的标题");
      assert.equal(ctx.store.board.projects[0].archivedAt, timestamp);
      openTaskForEditing(ctx, cardFor(ctx, taskId));
      await ctx.view.refresh();
      assert.equal(ctx.byId("task-project").value, projectId);
      assert.equal(ctx.byId("task-title").value, "只修改归档项目任务的标题");
    } finally { ctx.dom.window.close(); }
  });
}
