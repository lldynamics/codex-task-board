import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { emptyBoard } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { makeBackup } from "../src/store-data.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { codexSnapshotSchema, unavailableCodexSnapshot } from "../src/codex-domain.mjs";
import { waitFor } from "./helpers.mjs";

// All persistence checks use a real isolated store, never the user's records.
const wrap = (structuredContent) => ({ structuredContent, ...(structuredContent.ok ? {} : { isError: true }) });
const writableTask = ({ id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl }) => ({ id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl });
const settle = (predicate) => waitFor(predicate, "异步操作必须结束");

async function setup(t, { mutate, refresh } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "task-board-first-round-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  const read = async () => { const result = await store.read(); assert.equal(result.ok, true); return result.board; };
  const commit = async (operation) => {
    const result = await store.mutate({ requestId: randomUUID(), expectedRevision: (await read()).revision, operation });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const projectId = (await commit({ type: "save_project", project: { name: "阅读态项目", description: "临时验收" } })).entityId;
  const taskId = (await commit({ type: "save_task", task: {
    projectId, title: "先阅读任务", status: "in_progress", priority: "high", dueDate: "2030-10-10",
    sourceTool: "Codex", currentStep: "第一行步骤\n第二行步骤", blocker: "等待用户输入",
    conversationUrl: "https://example.invalid/saved-conversation",
  } })).entityId;
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://first-round-reader.invalid/", pretendToBeVisual: true });
  const calls = [], opened = [];
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: () => Date.parse("2030-10-05T04:00:00.000Z"),
    mutate: async (request) => { calls.push(structuredClone(request)); return mutate ? mutate(request, perform, calls.length) : perform(request); },
    refresh: async () => refresh ? refresh(store) : wrap(await store.read()),
    openThread: async (threadId, hostId) => { opened.push({ threadId, hostId }); return {}; },
  }));
  t.after(() => { view.dispose(); dom.window.close(); });
  view.setHostState({ connected: true, message: "临时测试宿主" });
  view.acceptReadResult(wrap(await store.read()));
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  const card = () => document.querySelector(`[data-edit-task="${taskId}"]`);
  const open = () => { card().focus(); card().click(); assert.equal(byId("task-read-view").hidden, false); };
  const edit = () => { byId("task-read-edit").click(); assert.equal(byId("task-form").hidden, false); };
  const change = (id, value) => { byId(id).value = value; byId(id).dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  const key = (node, value, options = {}) => { const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }); node.dispatchEvent(event); return event; };
  const save = async () => { const button = byId("task-form").querySelector("[type=submit]"); assert.equal(button.disabled, false); button.click(); await settle(() => !byId("refresh").disabled); };
  const remote = async (patch) => { const task = (await read()).tasks.find((item) => item.id === taskId); return commit({ type: "save_task", task: { ...writableTask(task), ...patch } }); };
  const notify = async () => { assert.equal(view.acceptReadResult(wrap(await store.read())), true); };
  return { dom, document, view, store, directory, read, commit, projectId, taskId, calls, opened, byId, card, open, edit, change, key, save, remote, notify };
}

test("existing manual tasks open in reader and every hidden form submission/shortcut writes zero bytes", async (t) => {
  const ctx = await setup(t);
  const before = await readFile(path.join(ctx.directory, "data.json"));
  ctx.open();
  assert.equal(ctx.byId("task-form").hidden, true);
  assert.equal(ctx.document.activeElement, ctx.byId("task-read-title"));
  assert.equal(ctx.byId("task-read-title").textContent, "先阅读任务");
  assert.equal(ctx.byId("task-read-project").textContent, "阅读态项目");
  assert.equal(ctx.byId("task-read-status").textContent, "进行中");
  assert.equal(ctx.byId("task-read-priority").textContent, "高");
  assert.equal(ctx.byId("task-read-date").textContent, "2030-10-10");
  assert.equal(ctx.byId("task-read-step").textContent, "第一行步骤\n第二行步骤");
  assert.equal(ctx.byId("task-read-blocker").textContent, "等待用户输入");
  assert.match(ctx.byId("task-read-source").textContent, /^手工记录.*Codex/);
  assert.equal(ctx.byId("task-read-source").textContent, "手工记录 · 来源：Codex");
  assert.match(ctx.byId("task-read-updated").textContent, /^保存更新时间：/);
  assert.equal(ctx.byId("task-read-link").querySelector("a").href, "https://example.invalid/saved-conversation");
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) assert.equal(ctx.key(ctx.byId("task-read-title"), "Enter", modifiers).defaultPrevented, true);
  ctx.key(ctx.byId("task-title"), "Enter");
  for (const id of ["task-form", "project-form"]) {
    const form = ctx.byId(id);
    const event = new ctx.dom.window.Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    form.requestSubmit();
    form.querySelector("[type=submit]").click();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before);
});

test("explicit edit persists through the original save path while new tasks and projects still open in editing", async (t) => {
  const ctx = await setup(t);
  ctx.open(); ctx.edit();
  assert.equal(ctx.byId("task-read-view").hidden, true);
  assert.equal(ctx.document.activeElement, ctx.byId("task-title"));
  ctx.change("task-title", "显式编辑后保存"); await ctx.save();
  assert.equal((await ctx.read()).tasks[0].title, "显式编辑后保存");
  assert.equal(ctx.calls.length, 1);
  ctx.byId("new-task").click();
  assert.equal(ctx.byId("task-form").hidden, false);
  assert.equal(ctx.byId("task-read-view").hidden, true);
  assert.equal(ctx.byId("task-edit-read").hidden, true);
  ctx.byId("editor-close").click();
  ctx.byId("new-project").click();
  assert.equal(ctx.byId("project-form").hidden, false);
  assert.equal(ctx.byId("task-read-view").hidden, true);
  assert.equal(ctx.document.activeElement, ctx.byId("project-name"));
});

test("reader notifications show latest fields and clean edit starts at the newest revision", async (t) => {
  const ctx = await setup(t);
  ctx.open();
  await ctx.remote({ title: "外部新标题", priority: "urgent", status: "waiting_user", currentStep: "外部下一步", blocker: "外部阻塞", conversationUrl: "https://example.invalid/latest" });
  await ctx.notify();
  assert.equal(ctx.byId("task-read-title").textContent, "外部新标题");
  assert.equal(ctx.byId("task-read-priority").textContent, "紧急");
  assert.equal(ctx.byId("task-read-status").textContent, "等待用户");
  assert.equal(ctx.byId("task-read-step").textContent, "外部下一步");
  assert.equal(ctx.byId("task-read-blocker").textContent, "外部阻塞");
  assert.equal(ctx.byId("task-read-link").querySelector("a").href, "https://example.invalid/latest");
  const revision = (await ctx.read()).revision;
  ctx.edit();
  assert.equal(ctx.byId("task-title").value, "外部新标题");
  ctx.change("task-title", "在最新记录上编辑"); await ctx.save();
  assert.equal(ctx.calls[0].expectedRevision, revision);
  assert.equal((await ctx.read()).tasks[0].title, "在最新记录上编辑");
});

test("explicit reader refresh replaces the displayed metadata and saved timestamp with the current store record", async (t) => {
  const ctx = await setup(t); ctx.open();
  await ctx.remote({ title: "刷新后的标题", dueDate: null, sourceTool: "新来源", currentStep: "最新步骤", blocker: "", conversationUrl: null });
  assert.equal(ctx.byId("task-read-title").textContent, "先阅读任务");
  await ctx.view.refresh();
  const task = (await ctx.read()).tasks[0];
  assert.equal(ctx.byId("task-read-title").textContent, "刷新后的标题");
  assert.equal(ctx.byId("task-read-date").textContent, "未设置");
  assert.equal(ctx.byId("task-read-step").textContent, "最新步骤");
  assert.equal(ctx.byId("task-read-blocker").textContent, "暂无阻塞项");
  assert.match(ctx.byId("task-read-source").textContent, /手工记录.*新来源/);
  assert.equal(ctx.byId("task-read-updated").textContent, `保存更新时间：${new Date(task.lastUpdatedAt).toLocaleString("zh-CN", { hour12: false })}`);
  assert.equal(ctx.byId("task-read-link").querySelector("a"), null);
  assert.equal(ctx.byId("task-form").hidden, true);
  assert.deepEqual(ctx.calls, []);
});

test("reading/editing round trips preserve every draft field and closing a retained draft offers recovery", async (t) => {
  const ctx = await setup(t);
  const otherProject = await ctx.commit({ type: "save_project", project: { name: "草稿目标项目", description: "" } }); await ctx.notify();
  ctx.open(); ctx.edit();
  const draft = { "task-project": otherProject.entityId, "task-title": "未保存标题", "task-due-date": "2030-11-05", "task-source": "本地来源", "task-step": "本地步骤", "task-blocker": "本地阻塞", "task-conversation": "https://example.invalid/draft" };
  for (const [id, value] of Object.entries(draft)) ctx.change(id, value);
  ctx.byId("task-edit-read").click();
  assert.equal(ctx.byId("task-form").hidden, true);
  assert.equal(ctx.byId("task-read-title").textContent, "先阅读任务");
  assert.equal(ctx.byId("task-read-draft").hidden, false);
  ctx.key(ctx.byId("task-read-title"), "Enter", { metaKey: true });
  ctx.byId("task-read-close").click();
  assert.equal(ctx.byId("discard-dialog").hidden, false);
  ctx.byId("keep-editing").click();
  assert.equal(ctx.byId("task-form").hidden, false);
  assert.equal(ctx.document.activeElement, ctx.byId("task-title"));
  for (const [id, value] of Object.entries(draft)) assert.equal(ctx.byId(id).value, value);
  assert.deepEqual(ctx.calls, []);
  await ctx.save(); assert.equal((await ctx.read()).tasks[0].title, draft["task-title"]);
});

test("retained drafts keep stale-revision and merge conflict protection after returning from reader", async (t) => {
  const ctx = await setup(t); ctx.open(); ctx.edit(); ctx.change("task-title", "我的标题");
  ctx.byId("task-edit-read").click();
  await ctx.remote({ title: "外部标题", currentStep: "外部步骤" }); await ctx.notify();
  assert.equal(ctx.byId("task-read-title").textContent, "外部标题");
  ctx.edit(); assert.equal(ctx.byId("task-title").value, "我的标题");
  await ctx.save(); assert.equal(ctx.byId("task-form").querySelector("[type=submit]").disabled, true);
  await ctx.view.refresh();
  assert.equal(ctx.byId("task-title").value, "我的标题");
  assert.equal(ctx.byId("task-step").value, "外部步骤");
  assert.equal(ctx.byId("merge-conflicts").hidden, false);
  ctx.byId("task-edit-read").click(); assert.equal(ctx.byId("merge-conflicts").hidden, true);
  ctx.edit(); assert.equal(ctx.byId("merge-conflicts").hidden, false);
  ctx.document.querySelector('[data-conflict-field="title"] [data-conflict-choice="local"]').click();
  await ctx.save();
  assert.equal((await ctx.read()).tasks[0].title, "我的标题");
  assert.equal(ctx.calls.length, 2);
});

test("archived task/project readers show their latest archive identity instead of presenting them as active", async (t) => {
  const ctx = await setup(t); ctx.open();
  await ctx.commit({ type: "archive_task", taskId: ctx.taskId, archived: true }); await ctx.notify();
  assert.equal(ctx.byId("task-read-unavailable").hidden, false);
  assert.match(ctx.byId("task-read-unavailable").textContent, /任务已归档/);
  assert.equal(ctx.byId("task-read-record").hidden, false);
  await ctx.commit({ type: "archive_task", taskId: ctx.taskId, archived: false });
  await ctx.commit({ type: "archive_project", projectId: ctx.projectId, archived: true });
  await ctx.view.refresh();
  assert.match(ctx.byId("task-read-unavailable").textContent, /所属项目已归档/);
  assert.equal(ctx.byId("task-read-project").textContent, "阅读态项目（已归档）");
  assert.deepEqual(ctx.calls, []);
});

test("deleted task and project clear current reader context, disable editing and keep narrow-window focus inside", async (t) => {
  const ctx = await setup(t);
  Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, configurable: true });
  ctx.open();
  const link = ctx.byId("task-read-link").querySelector("a"); link.focus();
  await ctx.commit({ type: "restore_board", backup: makeBackup(emptyBoard(), "2030-10-05T05:00:00.000Z") });
  await ctx.view.refresh();
  assert.equal(ctx.byId("task-read-title").textContent, "任务已不可用");
  assert.equal(ctx.byId("task-read-record").hidden, true);
  assert.equal(ctx.byId("task-read-project").textContent, "");
  assert.equal(ctx.byId("task-read-link").querySelector("a"), null);
  assert.equal(ctx.byId("task-read-edit").disabled, true);
  assert.ok(ctx.byId("editor-panel").contains(ctx.document.activeElement));
  ctx.byId("task-read-edit").dispatchEvent(new ctx.dom.window.Event("click"));
  assert.equal(ctx.byId("task-form").hidden, true);
  ctx.key(ctx.byId("task-read-title"), "Enter", { ctrlKey: true });
  assert.deepEqual(ctx.calls, []);
  ctx.byId("task-read-close").focus();
  assert.equal(ctx.key(ctx.byId("task-read-close"), "Tab").defaultPrevented, true);
  assert.equal(ctx.document.activeElement, ctx.byId("editor-refresh"));
  ctx.key(ctx.byId("editor-refresh"), "Tab", { shiftKey: true });
  assert.equal(ctx.document.activeElement, ctx.byId("task-read-close"));
  ctx.key(ctx.byId("task-read-close"), "Escape");
  assert.equal(ctx.byId("editor-panel").hidden, true);
  assert.ok(!ctx.document.activeElement.closest("[hidden],[inert]"));
});

test("narrow reader focus trap includes visible reader actions and restores the opening card", async (t) => {
  const ctx = await setup(t);
  Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, configurable: true });
  ctx.open();
  assert.equal(ctx.byId("editor-panel").getAttribute("aria-modal"), "true");
  ctx.byId("task-read-edit").focus(); ctx.key(ctx.byId("task-read-edit"), "Tab");
  assert.equal(ctx.document.activeElement, ctx.byId("editor-refresh"));
  ctx.key(ctx.byId("editor-refresh"), "Tab", { shiftKey: true });
  assert.equal(ctx.document.activeElement, ctx.byId("task-read-edit"));
  ctx.byId("task-read-close").click(); assert.equal(ctx.document.activeElement, ctx.card());
});

test("unknown saves cannot switch into reading and retries replay the exact original request", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("丢失已落盘的响应"); return result; } });
  ctx.open(); ctx.edit(); ctx.change("task-title", "已落盘但未确认"); await ctx.save();
  const revision = (await ctx.read()).revision;
  assert.equal(ctx.byId("task-edit-read").disabled, true);
  ctx.byId("task-edit-read").dispatchEvent(new ctx.dom.window.Event("click"));
  assert.equal(ctx.byId("task-form").hidden, false);
  assert.equal(ctx.byId("task-read-view").hidden, true);
  assert.equal(ctx.byId("task-title").disabled, true);
  await ctx.view.refresh(); await ctx.save();
  assert.deepEqual(ctx.calls[1], ctx.calls[0]);
  assert.equal((await ctx.read()).revision, revision);
  assert.equal(ctx.byId("editor-panel").hidden, true);
});

test("failed reader refresh exposes the read error while retaining the last loaded details without writes", async (t) => {
  const ctx = await setup(t, { refresh: async () => { throw new Error("读取断线"); } });
  ctx.open(); assert.equal(await ctx.view.refresh(), false);
  assert.equal(ctx.byId("editor-error").hidden, false);
  assert.match(ctx.byId("editor-error").textContent, /读取.*连接异常/);
  assert.equal(ctx.byId("task-read-title").textContent, "先阅读任务");
  assert.equal(ctx.byId("task-form").hidden, true);
  assert.deepEqual(ctx.calls, []);
});

test("automatic Codex cards still open the original task and never enter the manual reader/editor", async (t) => {
  const ctx = await setup(t);
  const timestamp = "2030-10-05T04:00:00.000Z", threadId = randomUUID();
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null };
  const snapshot = codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(timestamp),
    connection: { state: "connected", source: "desktop-snapshot", lastSuccessAt: timestamp, error: null, scope: "临时测试" },
    sources: { threads: source, automations: { ...source } }, completeness: { threads: true, automations: true, truncated: false },
    threads: [{ id: threadId, hostId: "local", title: "自动任务", cwd: "/temporary/reader-test", updatedAt: timestamp, runtimeStatus: "active", attention: null, lastTurnStatus: null, goalStatus: null }],
  });
  assert.equal(ctx.view.setCodexSnapshot(snapshot), true);
  const card = ctx.document.querySelector('[data-origin="codex"][data-task-id]');
  assert.ok(card); assert.equal(card.querySelector("[data-edit-task]"), null);
  assert.equal(card.querySelector("[data-quick-task]"), null);
  card.querySelector("[data-codex-task-open]").click(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ctx.opened, [{ threadId, hostId: "local" }]);
  assert.equal(ctx.byId("task-read-view").hidden, true);
  assert.equal(ctx.byId("task-form").hidden, true);
  assert.deepEqual(ctx.calls, []);
});

function stageReader(ctx, field, value) {
  const select = ctx.byId(`task-read-quick-${field}`); assert.equal(select.disabled, false); select.value = value;
  select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
}
async function chooseReader(ctx, field, value) { stageReader(ctx, field, value); await settle(() => !ctx.byId("refresh").disabled); }
const fieldButton = (ctx, action) => ctx.document.querySelector(`[data-field-action="${action}"]`);
const retryReader = async (ctx) => { ctx.byId("action-retry").click(); await settle(() => !ctx.byId("refresh").disabled); };

test("reader state and priority each save immediately and undo is reachable within the narrow reader", async (t) => {
  const ctx = await setup(t); Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, configurable: true }); ctx.open();
  const before = (await ctx.read()).tasks[0];
  ctx.byId("task-read-quick-status").focus(); await chooseReader(ctx, "status", "paused");
  assert.equal(ctx.byId("task-form").hidden, true); assert.equal(ctx.byId("task-read-status").textContent, "暂停");
  assert.equal(ctx.document.activeElement, ctx.byId("task-read-quick-status"));
  await chooseReader(ctx, "priority", "urgent");
  const after = (await ctx.read()).tasks[0]; assert.deepEqual(writableTask(after), { ...writableTask(before), status: "paused", priority: "urgent" });
  assert.equal(ctx.calls.length, 2); assert.deepEqual(ctx.calls[0].operation.patch, { status: "paused" }); assert.deepEqual(ctx.calls[1].operation.patch, { priority: "urgent" });
  assert.equal(ctx.byId("task-read-quick-save"), null); assert.equal(ctx.byId("task-read-quick-cancel"), null);
  assert.equal(ctx.byId("task-read-close").disabled, false); assert.equal(ctx.byId("task-read-edit").disabled, false);
  assert.ok(ctx.byId("editor-panel").contains(fieldButton(ctx, "undo"))); assert.equal(fieldButton(ctx, "undo").closest("[hidden],[inert]"), null);
  fieldButton(ctx, "undo").focus(); fieldButton(ctx, "undo").click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal((await ctx.read()).tasks[0].priority, "high"); assert.equal((await ctx.read()).tasks[0].status, "paused");
  assert.equal(ctx.document.activeElement, ctx.byId("task-read-quick-priority"));
  ctx.edit(); assert.equal(ctx.byId("task-status").closest("label").hidden, true); assert.equal(ctx.byId("task-priority").closest("label").hidden, true);
  ctx.change("task-title", "快捷修改后的完整编辑"); await ctx.save(); assert.equal((await ctx.read()).tasks[0].status, "paused");
});

test("reader unchanged selections cause zero bytes and no undo prompt", async (t) => {
  const ctx = await setup(t); ctx.open(); const before = await readFile(path.join(ctx.directory, "data.json"));
  await chooseReader(ctx, "status", "in_progress"); await chooseReader(ctx, "priority", "high");
  assert.deepEqual(ctx.calls, []); assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before); assert.equal(fieldButton(ctx, "undo"), null);
});

test("reader selectors cannot submit retained full-editor text drafts and existing hidden fields cannot become text changes", async (t) => {
  const ctx = await setup(t); ctx.open(); ctx.edit(); ctx.change("task-title", "详情中的未保存标题");
  ctx.change("task-status", "completed"); ctx.change("task-priority", "urgent");
  ctx.byId("task-edit-read").click(); const select = ctx.byId("task-read-quick-status"); assert.equal(select.disabled, true);
  select.value = "paused"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  assert.deepEqual(ctx.calls, []); ctx.edit(); assert.equal(ctx.byId("task-title").value, "详情中的未保存标题");
  await ctx.save(); assert.equal((await ctx.read()).tasks[0].status, "in_progress"); assert.equal((await ctx.read()).tasks[0].priority, "high");
  ctx.byId("new-task").click(); assert.equal(ctx.byId("task-status").closest("label").hidden, false); assert.equal(ctx.byId("task-priority").closest("label").hidden, false);
});

test("reader choice uses newest clean notification and returns focus to the same select", async (t) => {
  const ctx = await setup(t); ctx.open(); ctx.byId("task-read-quick-priority").focus();
  await ctx.remote({ title: "通知标题", currentStep: "通知步骤", priority: "low" }); await ctx.notify();
  assert.equal(ctx.byId("task-read-quick-priority").value, "low"); assert.equal(ctx.document.activeElement, ctx.byId("task-read-quick-priority"));
  const revision = (await ctx.read()).revision; await chooseReader(ctx, "priority", "urgent");
  assert.equal(ctx.calls[0].expectedRevision, revision); assert.equal((await ctx.read()).tasks[0].currentStep, "通知步骤");
  assert.equal(ctx.document.activeElement, ctx.byId("task-read-quick-priority"));
});

test("reader CAS conflict requires refresh and explicit confirmation while preserving other remote fields", async (t) => {
  const ctx = await setup(t); ctx.open(); await ctx.remote({ title: "并发标题", currentStep: "并发步骤", priority: "low" });
  await chooseReader(ctx, "status", "paused"); assert.equal(ctx.byId("action-retry").disabled, true); assert.match(ctx.byId("editor-error").textContent, /刷新/);
  await ctx.view.refresh(); assert.equal(ctx.calls.length, 1); assert.equal(fieldButton(ctx, "confirm").disabled, false);
  fieldButton(ctx, "confirm").click(); await settle(() => !ctx.byId("refresh").disabled);
  const task = (await ctx.read()).tasks[0]; assert.equal(task.status, "paused"); assert.equal(task.title, "并发标题"); assert.equal(task.currentStep, "并发步骤"); assert.equal(task.priority, "low");
  assert.notEqual(ctx.calls[1].requestId, ctx.calls[0].requestId); assert.equal(ctx.byId("task-read-view").hidden, false);
});

for (const side of ["local", "remote"]) {
  test(`reader same-field conflict survives refresh until explicit ${side} choice`, async (t) => {
    const ctx = await setup(t); ctx.open(); await ctx.remote({ priority: "low" }); await chooseReader(ctx, "priority", "urgent");
    await ctx.view.refresh(); await ctx.view.refresh(); assert.match(ctx.document.querySelector(".field-save-notice").textContent, /相同字段/);
    fieldButton(ctx, side === "local" ? "confirm" : "remote").focus(); fieldButton(ctx, side === "local" ? "confirm" : "remote").click(); await settle(() => !ctx.byId("refresh").disabled);
    assert.equal((await ctx.read()).tasks[0].priority, side === "local" ? "urgent" : "low"); assert.equal(ctx.calls.length, side === "local" ? 2 : 1);
    assert.ok(ctx.byId("editor-panel").contains(ctx.document.activeElement)); assert.equal(ctx.byId("task-read-view").hidden, false);
  });
}

test("lost reader receipt prevents undo and exact replay preserves later text without a second durable commit", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("reader receipt lost"); return result; } });
  Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, configurable: true }); ctx.open(); await chooseReader(ctx, "priority", "urgent");
  assert.equal(ctx.byId("task-read-quick-priority").disabled, true); assert.equal(fieldButton(ctx, "dismiss").disabled, true); assert.equal(fieldButton(ctx, "undo"), null);
  assert.equal(ctx.byId("action-retry").closest("[hidden],[inert]"), null);
  await ctx.remote({ title: "落盘后并发标题", priority: "low" }); await ctx.view.refresh();
  assert.equal(ctx.byId("task-read-quick-priority").value, "urgent"); const before = await readFile(path.join(ctx.directory, "data.json")); await retryReader(ctx);
  assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before);
  assert.equal(ctx.byId("task-read-title").textContent, "落盘后并发标题"); assert.equal(ctx.byId("task-read-quick-priority").value, "low"); assert.equal(fieldButton(ctx, "undo").disabled, true);
});

test("reader storage failure retains only its field intent and exact request retry", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => count === 1 ? wrap({ ok: false, error: { code: "INVALID_STORE", message: "invalid test store" } }) : perform(request) });
  ctx.open(); const before = await readFile(path.join(ctx.directory, "data.json")); await chooseReader(ctx, "priority", "urgent");
  assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before); assert.equal(ctx.byId("task-read-quick-priority").value, "urgent");
  assert.match(ctx.byId("editor-error").textContent, /读取/); await retryReader(ctx); assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.equal((await ctx.read()).tasks[0].priority, "urgent");
});

test("reader expiry needs refresh and review before ending without new writes", async (t) => {
  const ctx = await setup(t, { mutate: async () => wrap({ ok: false, error: { code: "REQUEST_EXPIRED", message: "expired" } }) }); ctx.open(); await chooseReader(ctx, "priority", "urgent");
  assert.equal(fieldButton(ctx, "dismiss").disabled, true); assert.equal(ctx.byId("expired-end").disabled, true);
  await ctx.view.refresh(); ctx.byId("expired-reviewed").checked = true; ctx.byId("expired-reviewed").dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); ctx.byId("expired-end").click();
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.byId("task-read-quick-priority").value, "high"); assert.equal(ctx.byId("task-read-view").hidden, false);
});

test("readonly host and archived reader reject synthetic selections without writes", async (t) => {
  const ctx = await setup(t); ctx.open(); ctx.view.setHostState({ connected: false, message: "只读" });
  const select = ctx.byId("task-read-quick-status"); assert.equal(select.disabled, true); select.value = "completed"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  ctx.view.setHostState({ connected: true, message: "可写" }); await ctx.commit({ type: "archive_task", taskId: ctx.taskId, archived: true }); await ctx.notify();
  assert.equal(ctx.byId("task-read-quick-status").disabled, true); ctx.byId("task-read-quick-status").value = "planned"; ctx.byId("task-read-quick-status").dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); assert.deepEqual(ctx.calls, []);
});

test("deleted reader during known failed intent retains reachable dismissal and safe narrow focus", async (t) => {
  const ctx = await setup(t, { mutate: async () => wrap({ ok: false, error: { code: "SAVE_FAILED", message: "failed" } }) });
  Object.defineProperty(ctx.dom.window, "innerWidth", { value: 390, configurable: true }); ctx.open(); await chooseReader(ctx, "status", "paused");
  await ctx.commit({ type: "restore_board", backup: makeBackup(emptyBoard(), "2030-10-05T05:00:00.000Z") }); await ctx.view.refresh();
  assert.equal(ctx.byId("task-read-title").textContent, "任务已不可用"); assert.equal(fieldButton(ctx, "confirm"), null); assert.equal(fieldButton(ctx, "dismiss").disabled, false);
  assert.equal(fieldButton(ctx, "dismiss").closest("[inert],[hidden]"), null); fieldButton(ctx, "dismiss").click(); assert.equal(ctx.calls.length, 1); ctx.byId("task-read-close").click(); assert.equal(ctx.byId("editor-panel").hidden, true);
});

for (const surface of ["automations", "diagnostics"]) {
  test(`hidden ${surface} reader rejects synthetic choices and retries, then restores the pending receipt`, async (t) => {
    const ctx = await setup(t, { mutate: async (request, perform, count) => { if (count === 1) throw new Error("unknown"); return perform(request); } });
    ctx.open(); await chooseReader(ctx, "status", "paused"); ctx.view.setWorkbenchSurface(true, surface);
    const select = ctx.byId("task-read-quick-priority"); select.value = "urgent"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); ctx.byId("action-retry").dispatchEvent(new ctx.dom.window.Event("click"));
    assert.equal(ctx.calls.length, 1); ctx.view.setWorkbenchSurface(false); assert.equal(ctx.byId("task-read-quick-status").value, "paused");
    await retryReader(ctx); assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.equal((await ctx.read()).tasks[0].status, "paused"); assert.equal((await ctx.read()).tasks[0].priority, "high");
  });
}

test("board selectors reject synthetic changes while the reader controls own its in-flight request", async (t) => {
  let release; const ctx = await setup(t, { mutate: (request, perform) => new Promise((resolve) => { release = () => perform(request).then(resolve); }) });
  ctx.byId("view-list").click(); ctx.open(); stageReader(ctx, "priority", "urgent");
  const boardControls = ctx.card().closest("article").querySelector('[data-quick-surface="board"]');
  const select = boardControls.querySelector('[data-quick-field="priority"]'); assert.equal(select.disabled, true); select.value = "low"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); assert.equal(ctx.calls.length, 1);
  release(); await settle(() => !ctx.byId("refresh").disabled); assert.equal((await ctx.read()).tasks[0].priority, "urgent");
});

test("Codex conversation links render and remain editable while invalid deep links cannot write", async (t) => {
  const ctx = await setup(t); const url = `codex://threads/${randomUUID()}`; await ctx.remote({ conversationUrl: url }); await ctx.notify(); ctx.open();
  assert.equal(ctx.byId("task-read-link").querySelector("a").href, url); ctx.edit(); ctx.change("task-title", "保留Codex链接"); await ctx.save();
  assert.equal((await ctx.read()).tasks[0].conversationUrl, url); ctx.open(); ctx.edit(); ctx.change("task-conversation", `${url}?view=review`); ctx.change("task-title", "无效链接不能写");
  const before = await readFile(path.join(ctx.directory, "data.json")); await ctx.save(); assert.match(ctx.byId("editor-error").textContent, /链接/); assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before); assert.equal(ctx.calls.length, 1);
});

for (const surface of ["automations", "diagnostics"]) for (const mode of ["read", "edit"]) {
  test(`${surface} Escape leaves a hidden ${mode} draft untouched and does not consume the event`, async (t) => {
    const ctx = await setup(t); ctx.open(); ctx.edit(); ctx.change("task-title", "隐藏时保留的标题");
    if (mode === "read") ctx.byId("task-edit-read").click();
    ctx.view.setWorkbenchSurface(true, surface);
    const event = ctx.key(ctx.byId("codex-surface-title"), "Escape");
    assert.equal(event.defaultPrevented, false);
    assert.equal(ctx.byId("discard-dialog").hidden, true);
    assert.equal(ctx.byId("task-title").value, "隐藏时保留的标题");
    assert.deepEqual(ctx.calls, []);
    ctx.view.setWorkbenchSurface(false);
    assert.equal(ctx.byId("editor-panel").hidden, false);
    assert.equal(ctx.byId("task-read-view").hidden, mode !== "read");
    assert.equal(ctx.byId("task-title").value, "隐藏时保留的标题");
  });
}
