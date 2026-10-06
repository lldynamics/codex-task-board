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
import { unavailableCodexSnapshot } from "../src/codex-domain.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { waitFor } from "./helpers.mjs";

const timestamp = "2026-10-06T00:00:00.000Z";
const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
const taskId = "00000000-0000-4000-8000-000000000101";
const wrap = (result) => ({ content: [], ...(result.ok ? {} : { isError: true }), structuredContent: result });

async function setup(t, { width = 1600, connected = true, mutate } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "task-board-layout-sidebar-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  const board = boardSchema.parse({ ...emptyBoard(), projects: [
    { id: a, name: "Alpha", description: "第一个项目", lastUpdatedAt: timestamp },
    { id: b, name: "Beta", description: "第二个项目", lastUpdatedAt: timestamp },
  ], tasks: [{ id: taskId, projectId: a, title: "保留草稿的任务", status: "planned", sourceTool: "个人记录", currentStep: "原步骤", blocker: "", conversationUrl: null, lastUpdatedAt: timestamp }] });
  assert.equal((await store.mutate({ requestId: randomUUID(), expectedRevision: 0, operation: { type: "restore_board", backup: makeBackup(board, timestamp) } })).ok, true);
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://layout-sidebar.invalid/" });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: width });
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "board" }));
  const document = dom.window.document;
  const calls = [];
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, emptyBoard(), {
    mutate: async (request) => { calls.push(structuredClone(request)); return mutate ? mutate(request, perform, calls.length) : perform(request); },
    refresh: async () => wrap(await store.read()), now: () => timestamp,
  }));
  t.after(() => { view.dispose(); dom.window.close(); });
  view.setHostState({ connected, message: connected ? "已连接" : "只读" });
  view.acceptReadResult(wrap(await store.read()));
  const byId = (id) => document.getElementById(id);
  const menu = (id) => document.querySelector(`[data-sidebar-project-menu="${id}"]`);
  const row = (id) => document.querySelector(`[data-sidebar-project="${id}"]`);
  const read = async () => (await store.read()).board;
  const commit = async (operation) => {
    const result = await store.mutate({ requestId: randomUUID(), expectedRevision: (await read()).revision, operation });
    assert.equal(result.ok, true); return result;
  };
  return { dom, document, store, view, calls, byId, menu, row, read, commit };
}

function key(ctx, target, value) {
  const event = new ctx.dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event); return event;
}
function change(ctx, id, value) {
  const input = ctx.byId(id); input.value = value;
  input.dispatchEvent(new ctx.dom.window.Event(input.matches("input,textarea") ? "input" : "change", { bubbles: true }));
}
function openMenu(ctx, id) {
  const menu = ctx.menu(id); assert.ok(menu);
  const summary = menu.querySelector("summary"); summary.focus(); key(ctx, summary, "ArrowDown");
  assert.equal(menu.open, true); return menu;
}
function action(ctx, id, kind) { return openMenu(ctx, id).querySelector(`[data-sidebar-project-action="${kind}"]`); }
const settle = (predicate) => waitFor(predicate, "Operation must finish", 4000);

test("sidebar row editing targets its own project from all-projects and retains a live desktop return-focus trigger", async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.byId("project-filter").value, "all");
  const summary = ctx.menu(b).querySelector("summary");
  action(ctx, b, "edit").click();
  assert.equal(ctx.byId("project-name").value, "Beta");
  assert.equal(ctx.byId("project-filter").value, "all");
  assert.equal(summary, ctx.menu(b).querySelector("summary"), "Rerenders must retain the editor opener");
  ctx.byId("editor-close").click();
  assert.equal(ctx.document.activeElement, summary);
  assert.equal(ctx.calls.length, 0);
});

test("row project switching honors the dirty-editor decision and does not change filters or persist a draft", async (t) => {
  const ctx = await setup(t);
  action(ctx, a, "edit").click(); change(ctx, "project-name", "未保存 Alpha");
  action(ctx, b, "edit").click();
  assert.equal(ctx.byId("discard-dialog").hidden, false);
  assert.equal(ctx.byId("project-name").value, "未保存 Alpha");
  assert.equal(ctx.calls.length, 0); assert.equal(ctx.byId("project-filter").value, "all");
  ctx.byId("keep-editing").click();
  assert.equal(ctx.byId("project-name").value, "未保存 Alpha");
  action(ctx, b, "edit").click(); ctx.byId("discard-edits").click();
  assert.equal(ctx.byId("project-name").value, "Beta");
  assert.equal(ctx.byId("discard-dialog").hidden, true);
  assert.equal((await ctx.read()).projects.find((project) => project.id === a).name, "Alpha");
  assert.equal(ctx.calls.length, 0);
});

test("row archive keeps unrelated selected project and can restore inherited task visibility", async (t) => {
  const ctx = await setup(t); ctx.row(b).click();
  action(ctx, a, "archive").click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.deepEqual(ctx.calls[0].operation, { type: "archive_project", projectId: a, archived: true });
  assert.equal(ctx.byId("project-filter").value, b);
  assert.ok((await ctx.read()).projects.find((project) => project.id === a).archivedAt);
  assert.equal(ctx.byId("sidebar-archive").querySelector("[data-sidebar-count]").textContent, "1");
  const restore = action(ctx, a, "archive"); assert.equal(restore.textContent, "恢复项目");
  restore.click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.deepEqual(ctx.calls[1].operation, { type: "archive_project", projectId: a, archived: false });
  assert.equal((await ctx.read()).projects.find((project) => project.id === a).archivedAt, null);
  assert.equal(ctx.byId("project-filter").value, b);
});

test("a refreshed project menu keeps its action focus and open state, updates names and drops removed rows", async (t) => {
  const ctx = await setup(t);
  const menu = openMenu(ctx, b); const focused = menu.querySelector('[data-sidebar-project-action="edit"]'); focused.focus();
  await ctx.commit({ type: "save_project", project: { id: b, name: "Beta 新名称", description: "更新" } });
  ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  assert.equal(ctx.menu(b), menu); assert.equal(menu.open, true); assert.equal(ctx.document.activeElement, focused);
  assert.equal(menu.querySelector("summary").getAttribute("aria-label"), "Beta 新名称的项目操作");
  const board = await ctx.read();
  ctx.view.setBoard({ ...board, revision: board.revision + 1, projects: board.projects.filter((project) => project.id !== b) });
  assert.equal(ctx.menu(b), null); assert.equal(ctx.document.activeElement, ctx.byId("sidebar-project-search"));
  focused.dispatchEvent(new ctx.dom.window.Event("click", { bubbles: true }));
  assert.equal(ctx.byId("editor-panel").hidden, true); assert.equal(ctx.calls.length, 0);
});

test("row menus close one layer at a time, dismiss outside, and never act through closed or disconnected controls", async (t) => {
  const ctx = await setup(t, { width: 375 }); ctx.byId("sidebar-toggle").click();
  const menu = openMenu(ctx, a); const edit = menu.querySelector('[data-sidebar-project-action="edit"]');
  assert.equal(ctx.document.activeElement, edit);
  assert.equal(key(ctx, edit, "Escape").defaultPrevented, true); assert.equal(menu.open, false);
  assert.equal(ctx.byId("project-sidebar").hidden, false); assert.equal(ctx.document.activeElement, menu.querySelector("summary"));
  edit.dispatchEvent(new ctx.dom.window.Event("click", { bubbles: true }));
  assert.equal(ctx.byId("editor-panel").hidden, true);
  openMenu(ctx, a); ctx.byId("sidebar-project-search").click(); assert.equal(menu.open, false);
  key(ctx, ctx.byId("sidebar-project-search"), "Escape"); assert.equal(ctx.byId("project-sidebar").hidden, true);
  const disconnected = await setup(t, { connected: false });
  const summary = disconnected.menu(a).querySelector("summary"); summary.click();
  assert.equal(disconnected.menu(a).open, false);
  disconnected.menu(a).querySelector('[data-sidebar-project-action="archive"]').dispatchEvent(new disconnected.dom.window.Event("click", { bubbles: true }));
  assert.equal(disconnected.calls.length, 0);
});

test("uncertain archive receipt disables row actions and retries exactly the original target and request", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, index) => { const result = await perform(request); if (index === 1) throw new Error("Lost response after commit"); return result; } });
  action(ctx, a, "archive").click(); await settle(() => !ctx.byId("refresh").disabled);
  const original = structuredClone(ctx.calls[0]); const board = await ctx.read();
  assert.equal(ctx.menu(a).querySelector('[data-sidebar-project-action="archive"]').disabled, true);
  ctx.menu(b).querySelector('[data-sidebar-project-action="archive"]').dispatchEvent(new ctx.dom.window.Event("click", { bubbles: true }));
  assert.equal(ctx.calls.length, 1);
  ctx.byId("action-retry").click(); await settle(() => ctx.calls.length === 2 && !ctx.byId("refresh").disabled);
  assert.deepEqual(ctx.calls[1], original); assert.deepEqual(await ctx.read(), board);
});

test("automatic projects display directory name and host with full path in title and remain read-only", async (t) => {
  const ctx = await setup(t);
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null };
  ctx.view.setCodexSnapshot({ ...unavailableCodexSnapshot(timestamp), sources: { threads: source, automations: source }, threads: [{ id: "thread", hostId: "local", title: "自动任务", cwd: "/private/work/a/目录名", updatedAt: timestamp, runtimeStatus: "idle", attention: null, lastTurnStatus: null, goalStatus: null }] });
  const automatic = ctx.document.querySelector('[data-sidebar-project][data-origin="codex"]');
  assert.ok(automatic); assert.match(automatic.textContent, /目录名.*主机：local/s);
  assert.doesNotMatch(automatic.textContent, /\/private\/work/); assert.match(automatic.title, /\/private\/work\/a\/目录名/);
  assert.equal(automatic.parentElement.querySelector("[data-sidebar-project-menu]"), null);
  assert.equal(ctx.document.querySelectorAll("[data-sidebar-project-menu]").length, 2);
  automatic.click(); assert.match(ctx.byId("project-filter").value, /^codex-project-/);
  assert.equal(ctx.byId("edit-project").disabled, true); assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.document.querySelector(".sidebar-management").hidden, true);
  assert.equal(ctx.document.querySelectorAll(".sidebar-note p").length, 0); assert.ok(ctx.byId("codex-tab"));
});
