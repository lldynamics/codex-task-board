import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { boardSchema, emptyBoard } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { makeBackup } from "../src/store-data.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { waitFor } from "./helpers.mjs";

const SIDEBAR_KEY = "learning-board:sidebar-preferences:v1";
const VIEW_KEY = "learning-board:view-preferences:v1";
const timestamp = "2026-10-05T00:00:00.000Z";
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const projects = { a: id(1), b: id(2), empty: id(3), archived: id(4) };
const tasks = { planned: id(101), completed: id(102), archivedA: id(103), inProgress: id(104), inheritedArchive: id(105), archivedBoth: id(106) };
const wrap = (result) => ({ content: [], ...(result.ok ? {} : { isError: true }), structuredContent: result });
const failure = (code) => wrap({ ok: false, error: { code, message: `Independent ${code}` } });

function fixture() {
  const projectRows = [
    { id: projects.a, name: "Alpha 项目", description: "共同描述" },
    { id: projects.b, name: "Beta 项目", description: "共同描述" },
    { id: projects.empty, name: "Empty 空项目", description: "可查说明" },
    { id: projects.archived, name: "Archived 项目", description: "归档容器", archivedAt: timestamp },
  ];
  const taskRows = [
    { id: tasks.planned, projectId: projects.a, title: "共同 A 计划", status: "planned" },
    { id: tasks.completed, projectId: projects.a, title: "共同 A 完成", status: "completed" },
    { id: tasks.archivedA, projectId: projects.a, title: "共同 A 归档", status: "paused", archivedAt: timestamp },
    { id: tasks.inProgress, projectId: projects.b, title: "共同 B 进行", status: "in_progress" },
    { id: tasks.inheritedArchive, projectId: projects.archived, title: "共同 继承归档", status: "planned" },
    { id: tasks.archivedBoth, projectId: projects.archived, title: "共同 双重归档", status: "completed", archivedAt: timestamp },
  ];
  return boardSchema.parse({ ...emptyBoard(), projects: projectRows.map((project) => ({ ...project, lastUpdatedAt: timestamp })), tasks: taskRows.map((task) => ({ priority: "normal", dueDate: null, sourceTool: "Codex", currentStep: "原始步骤", blocker: "", conversationUrl: null, ...task, lastUpdatedAt: timestamp })) });
}

async function setup(t, { width = 1200, sidebarPreference, viewPreference = { viewMode: "board" }, denyStorage = false, connected = true, mutate } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "task-board-sidebar-independent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  const seeded = await store.mutate({ requestId: randomUUID(), expectedRevision: 0, operation: { type: "restore_board", backup: makeBackup(fixture(), timestamp) } });
  assert.equal(seeded.ok, true);
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://sidebar-independent.invalid/" });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: width });
  if (sidebarPreference !== undefined) dom.window.localStorage.setItem(SIDEBAR_KEY, JSON.stringify(sidebarPreference));
  if (viewPreference !== undefined) dom.window.localStorage.setItem(VIEW_KEY, JSON.stringify(viewPreference));
  if (denyStorage) {
    dom.window.Storage.prototype.getItem = () => { throw new Error("Synthetic blocked storage read"); };
    dom.window.Storage.prototype.setItem = () => { throw new Error("Synthetic blocked storage write"); };
  }
  const document = dom.window.document;
  const calls = [];
  let refreshCalls = 0;
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, emptyBoard(), {
    mutate: async (request) => { calls.push(structuredClone(request)); return mutate ? mutate(request, perform, calls.length) : perform(request); },
    refresh: async () => { refreshCalls++; return wrap(await store.read()); },
    data: async (request) => wrap(await store.data(request)),
  }));
  view.setHostState({ connected, message: connected ? "测试连接" : "只读" });
  view.acceptReadResult(wrap(await store.read()));
  const byId = (value) => document.getElementById(value);
  const row = (projectId) => document.querySelector(`[data-sidebar-project="${projectId}"]`);
  const card = (taskId = tasks.planned) => document.querySelector(`[data-task-id="${taskId}"]`);
  const read = async () => { const result = await store.read(); assert.equal(result.ok, true); return result.board; };
  const commit = async (operation) => { const board = await read(); const result = await store.mutate({ requestId: randomUUID(), expectedRevision: board.revision, operation }); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  return { dom, document, view, directory, store, calls, get refreshCalls() { return refreshCalls; }, byId, row, card, read, commit };
}

function change(ctx, field, value) {
  const node = ctx.byId(field); node.value = value;
  node.dispatchEvent(new ctx.dom.window.Event(node.matches("input,textarea") ? "input" : "change", { bubbles: true }));
}
function key(ctx, target, value, options = {}) {
  const event = new ctx.dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event); return event;
}
function resize(ctx, width) { Object.defineProperty(ctx.dom.window, "innerWidth", { configurable: true, value: width }); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("resize")); }
function count(node) { assert.ok(node); return Number(node.querySelector("[data-sidebar-count]").textContent); }
function current(ctx, expected) { const nodes = [...ctx.document.querySelectorAll('#project-sidebar [aria-current="page"]')]; assert.equal(nodes.length, 1); assert.equal(nodes[0], expected); }
function openDrawer(ctx) { ctx.byId("sidebar-toggle").click(); assert.equal(ctx.byId("project-sidebar").hidden, false); assert.equal(ctx.byId("project-sidebar").getAttribute("aria-modal"), "true"); }
function openTask(ctx) { ctx.card().querySelector("[data-edit-task]").click(); assert.equal(ctx.byId("task-read-view").hidden, false); ctx.byId("task-read-edit").click(); assert.equal(ctx.byId("task-form").hidden, false); }
const settle = (predicate) => waitFor(predicate, "Operation must finish without an extra request");
function noNavigationIO(ctx) { assert.equal(ctx.calls.length, 0); assert.equal(ctx.refreshCalls, 0); }
function visible(node) {
  if (!node || node.disabled || node.closest("[hidden],[inert]")) return false;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) if (parent.matches("details:not([open])") && !(node.matches("summary") && node.parentElement === parent)) return false;
  const css = node.ownerDocument.defaultView.getComputedStyle(node); return css.display !== "none" && css.visibility !== "hidden";
}
function focusable(scope) { return [...scope.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex]:not([tabindex="-1"])')].filter(visible); }

test("independent sidebar counts include full-board project archive inheritance once and ignore task search, status and source filters", async (t) => {
  const ctx = await setup(t);
  assert.equal(ctx.byId("project-sidebar").hidden, false);
  assert.equal(ctx.document.querySelector(".app").classList.contains("sidebar-collapsed"), false);
  assert.equal(count(ctx.byId("sidebar-all")), 3); assert.equal(count(ctx.byId("sidebar-next")), 2); assert.equal(count(ctx.byId("sidebar-archive")), 3);
  assert.equal(count(ctx.row(projects.a)), 2); assert.equal(count(ctx.row(projects.b)), 1); assert.equal(count(ctx.row(projects.empty)), 0);
  assert.equal(ctx.row(projects.archived), null);
  current(ctx, ctx.byId("sidebar-all"));
  change(ctx, "search", "不存在的任务"); change(ctx, "status-filter", "failed"); change(ctx, "source-filter", JSON.stringify("Codex"));
  assert.equal(ctx.document.querySelectorAll("[data-task-id]").length, 0);
  assert.equal(count(ctx.byId("sidebar-all")), 3); assert.equal(count(ctx.byId("sidebar-next")), 2); assert.equal(count(ctx.byId("sidebar-archive")), 3);
  assert.equal(count(ctx.row(projects.a)), 2);
  ctx.byId("sidebar-archive").click();
  assert.equal(count(ctx.row(projects.a)), 1); assert.equal(count(ctx.row(projects.archived)), 2);
  assert.equal(ctx.row(projects.b), null); assert.equal(ctx.row(projects.empty), null);
  current(ctx, ctx.byId("sidebar-archive")); noNavigationIO(ctx);
});

test("independent sidebar navigation applies project/all/next/archive context without clearing unrelated filters or issuing I/O", async (t) => {
  const ctx = await setup(t);
  change(ctx, "search", "共同"); change(ctx, "status-filter", "planned"); change(ctx, "source-filter", JSON.stringify("Codex"));
  ctx.row(projects.a).click();
  assert.equal(ctx.byId("project-filter").value, projects.a); assert.equal(ctx.byId("archive-filter").value, "active");
  current(ctx, ctx.row(projects.a)); assert.match(ctx.byId("sidebar-current-project").textContent, /Alpha/);
  ctx.byId("sidebar-next").click();
  assert.equal(ctx.byId("project-filter").value, "all"); assert.equal(ctx.byId("archive-filter").value, "active");
  assert.equal(ctx.byId("cards").classList.contains("next-view"), true); current(ctx, ctx.byId("sidebar-next"));
  ctx.row(projects.b).click();
  assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true"); assert.equal(ctx.byId("cards").classList.contains("next-view"), false);
  ctx.byId("sidebar-archive").click();
  assert.equal(ctx.byId("project-filter").value, "all"); assert.equal(ctx.byId("archive-filter").value, "archived");
  assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true"); current(ctx, ctx.byId("sidebar-archive"));
  ctx.row(projects.a).click();
  assert.equal(ctx.byId("archive-filter").value, "archived", "Active projects listed in archive context must keep that context"); current(ctx, ctx.row(projects.a));
  ctx.row(projects.archived).click(); assert.equal(ctx.byId("archive-filter").value, "archived"); current(ctx, ctx.row(projects.archived));
  ctx.byId("sidebar-all").click();
  assert.equal(ctx.byId("project-filter").value, "all"); assert.equal(ctx.byId("archive-filter").value, "active"); current(ctx, ctx.byId("sidebar-all"));
  ctx.byId("view-board").click(); ctx.row(projects.a).click(); assert.equal(ctx.byId("view-board").getAttribute("aria-pressed"), "true");
  assert.equal(ctx.byId("search").value, "共同"); assert.equal(ctx.byId("status-filter").value, "planned"); assert.equal(ctx.byId("source-filter").value, JSON.stringify("Codex"));
  noNavigationIO(ctx);
});

test("independent project search is local to project rows and legacy project filter updates the unique current page", async (t) => {
  const ctx = await setup(t); change(ctx, "search", "共同");
  change(ctx, "sidebar-project-search", "可查说明");
  assert.equal(ctx.document.querySelectorAll("[data-sidebar-project]").length, 1); assert.ok(ctx.row(projects.empty));
  assert.equal(ctx.byId("search").value, "共同"); assert.equal(Number.parseInt(ctx.byId("count").textContent, 10), 3);
  assert.equal(count(ctx.byId("sidebar-all")), 3);
  change(ctx, "sidebar-project-search", "未知项目"); assert.match(ctx.byId("sidebar-projects").textContent, /没有匹配/);
  change(ctx, "sidebar-project-search", ""); change(ctx, "project-filter", projects.b);
  current(ctx, ctx.row(projects.b)); assert.match(ctx.byId("sidebar-current-project").textContent, /Beta/);
  change(ctx, "project-filter", "all"); current(ctx, ctx.byId("sidebar-all")); noNavigationIO(ctx);
});

test("independent sidebar collapse stores only its boolean while preserving the view preferences including the display time zone", async (t) => {
  const preference = { viewMode: "list", collapsed: ["paused", "failed"], project: projects.a, status: "all", source: "all", archive: "active" };
  const ctx = await setup(t, { viewPreference: preference });
  const savedView = ctx.dom.window.localStorage.getItem(VIEW_KEY);
  ctx.byId("sidebar-toggle").click();
  assert.equal(ctx.byId("project-sidebar").hidden, true); assert.equal(ctx.byId("sidebar-toggle").getAttribute("aria-expanded"), "false");
  assert.deepEqual(JSON.parse(ctx.dom.window.localStorage.getItem(SIDEBAR_KEY)), { sidebarCollapsed: true });
  assert.equal(ctx.dom.window.localStorage.getItem(VIEW_KEY), savedView);
  ctx.byId("sidebar-toggle").click(); change(ctx, "sidebar-project-search", "Alpha");
  assert.deepEqual(JSON.parse(ctx.dom.window.localStorage.getItem(SIDEBAR_KEY)), { sidebarCollapsed: false });
  assert.deepEqual(Object.keys(JSON.parse(ctx.dom.window.localStorage.getItem(VIEW_KEY))).sort(), ["archive", "collapsed", "project", "record", "source", "status", "timeZone", "viewMode"]);
  noNavigationIO(ctx);
});

test("independent sidebar preferences reject wrong types/extra fields and storage denial leaves navigation and core editing available", async (t) => {
  for (const preference of [true, [], { sidebarCollapsed: "true" }, { sidebarCollapsed: true, open: true }]) {
    const ctx = await setup(t, { sidebarPreference: preference });
    assert.equal(ctx.byId("project-sidebar").hidden, false); assert.equal(ctx.byId("sidebar-toggle").getAttribute("aria-expanded"), "true"); noNavigationIO(ctx);
  }
  const denied = await setup(t, { denyStorage: true });
  denied.byId("sidebar-toggle").click(); denied.byId("sidebar-toggle").click(); denied.row(projects.b).click();
  assert.equal(denied.byId("project-filter").value, projects.b); assert.equal(denied.byId("new-task").disabled, false); noNavigationIO(denied);
});

test("independent mobile drawer opens closed by default, traps forward/backward Tab, isolates background and closes by backdrop", async (t) => {
  const ctx = await setup(t, { width: 800 });
  assert.equal(ctx.byId("project-sidebar").hidden, true); assert.equal(ctx.byId("sidebar-backdrop").hidden, true);
  assert.equal(ctx.document.querySelector(".app-main").hasAttribute("inert"), false);
  openDrawer(ctx);
  assert.equal(ctx.document.querySelectorAll('[aria-modal="true"]').length, 1);
  assert.equal(ctx.document.querySelector(".app-main").hasAttribute("inert"), true);
  assert.equal(ctx.byId("project-sidebar").hasAttribute("inert"), false);
  assert.equal(ctx.byId("sidebar-backdrop").hidden, false);
  assert.equal(ctx.document.activeElement, ctx.byId("sidebar-close"));
  const controls = focusable(ctx.byId("project-sidebar")); assert.ok(controls.length > 5);
  assert.ok(!controls.includes(ctx.byId("new-project")), "Closed details actions must not enter the Tab cycle");
  controls.at(-1).focus(); assert.equal(key(ctx, controls.at(-1), "Tab").defaultPrevented, true); assert.equal(ctx.document.activeElement, controls[0]);
  controls[0].focus(); assert.equal(key(ctx, controls[0], "Tab", { shiftKey: true }).defaultPrevented, true); assert.equal(ctx.document.activeElement, controls.at(-1));
  ctx.byId("sidebar-backdrop").click();
  assert.equal(ctx.byId("project-sidebar").hidden, true); assert.equal(ctx.document.querySelectorAll('[aria-modal="true"]').length, 0);
  assert.equal(ctx.document.querySelectorAll("[inert]").length, 0); assert.equal(ctx.document.activeElement, ctx.byId("sidebar-toggle")); noNavigationIO(ctx);
});

test("independent Escape closes an open project menu before the drawer, then drawer before any editor, one layer per event", async (t) => {
  const ctx = await setup(t, { width: 600 }); openDrawer(ctx);
  const menu = ctx.document.querySelector(`[data-sidebar-project-menu="${projects.a}"]`); menu.open = true;
  menu.dispatchEvent(new ctx.dom.window.Event("toggle"));
  assert.equal(menu.open, true, "Project management must be usable inside the drawer");
  const action = menu.querySelector('[data-sidebar-project-action="edit"]'); action.focus();
  assert.equal(key(ctx, action, "Escape").defaultPrevented, true);
  assert.equal(menu.open, false); assert.equal(ctx.byId("project-sidebar").hidden, false);
  assert.equal(ctx.document.activeElement, menu.querySelector("summary"));
  assert.equal(key(ctx, menu.querySelector("summary"), "Escape").defaultPrevented, true);
  assert.equal(ctx.byId("project-sidebar").hidden, true); assert.equal(ctx.document.activeElement, ctx.byId("sidebar-toggle")); noNavigationIO(ctx);
});

test("independent mobile navigation closes drawer without I/O and shortcuts cannot cross its inert boundary", async (t) => {
  const ctx = await setup(t, { width: 600 }); openDrawer(ctx);
  const active = ctx.document.activeElement;
  for (const [value, options] of [["n", {}], ["/", {}], ["Enter", { ctrlKey: true }], ["Enter", { metaKey: true }]]) {
    assert.equal(key(ctx, active, value, options).defaultPrevented, false);
    assert.equal(ctx.document.activeElement, active); assert.equal(ctx.byId("editor-panel").hidden, true);
  }
  ctx.row(projects.b).click();
  assert.equal(ctx.byId("project-filter").value, projects.b); assert.equal(ctx.byId("project-sidebar").hidden, true);
  assert.equal(ctx.document.querySelectorAll("[inert]").length, 0); assert.equal(ctx.document.activeElement, ctx.byId("sidebar-toggle")); noNavigationIO(ctx);
});

test("independent mobile new-project proxy uses the original form and returns focus to visible navigation toggle after close/save", async (t) => {
  const ctx = await setup(t, { width: 600 }); openDrawer(ctx);
  ctx.byId("sidebar-new-project").focus(); ctx.byId("sidebar-new-project").click();
  assert.equal(ctx.byId("project-sidebar").hidden, true); assert.equal(ctx.byId("sidebar-backdrop").hidden, true);
  assert.equal(ctx.byId("project-form").hidden, false); assert.equal(ctx.byId("editor-panel").getAttribute("aria-modal"), "true");
  assert.equal(ctx.document.querySelectorAll('[aria-modal="true"]').length, 1); assert.equal(ctx.document.querySelector(".app-main").hasAttribute("inert"), false);
  ctx.byId("editor-close").click();
  assert.equal(ctx.byId("editor-panel").hidden, true); assert.equal(ctx.document.activeElement, ctx.byId("sidebar-toggle")); assert.ok(visible(ctx.document.activeElement));
  openDrawer(ctx); ctx.byId("sidebar-new-project").click(); change(ctx, "project-name", "侧栏新项目");
  ctx.byId("project-form").querySelector('[type="submit"]').click(); await settle(() => ctx.byId("editor-panel").hidden);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0].operation.type, "save_project");
  assert.ok((await ctx.read()).projects.some((project) => project.name === "侧栏新项目"));
  assert.equal(ctx.document.activeElement, ctx.byId("sidebar-toggle")); assert.ok(visible(ctx.document.activeElement));
});

test("independent per-row mobile project editor targets its row and closes the drawer without restoring hidden menu focus", async (t) => {
  const ctx = await setup(t, { width: 600 }); openDrawer(ctx); ctx.row(projects.a).click(); openDrawer(ctx);
  const menu = ctx.document.querySelector(`[data-sidebar-project-menu="${projects.b}"]`); menu.open = true;
  const action = menu.querySelector('[data-sidebar-project-action="edit"]'); action.focus(); action.click();
  assert.equal(ctx.byId("project-form").hidden, false); assert.equal(ctx.byId("project-sidebar").hidden, true);
  assert.equal(ctx.byId("project-name").value, "Beta 项目"); assert.equal(ctx.byId("project-filter").value, projects.a); ctx.byId("editor-close").click();
  assert.equal(ctx.document.activeElement, ctx.byId("sidebar-toggle")); assert.ok(visible(ctx.document.activeElement)); noNavigationIO(ctx);
});

test("independent viewport transitions at 800/801 clear stale drawer/inert/modal/focus while retaining desktop collapse preference", async (t) => {
  const ctx = await setup(t, { width: 801 }); ctx.byId("sidebar-toggle").click();
  assert.deepEqual(JSON.parse(ctx.dom.window.localStorage.getItem(SIDEBAR_KEY)), { sidebarCollapsed: true });
  resize(ctx, 800); assert.equal(ctx.byId("project-sidebar").hidden, true); openDrawer(ctx); change(ctx, "sidebar-project-search", "Alpha");
  ctx.byId("sidebar-project-search").focus(); resize(ctx, 801);
  assert.equal(ctx.byId("project-sidebar").hidden, true); assert.equal(ctx.byId("sidebar-backdrop").hidden, true);
  assert.equal(ctx.document.querySelectorAll('[aria-modal="true"], [inert]').length, 0);
  assert.equal(ctx.document.activeElement, ctx.byId("sidebar-toggle")); assert.ok(visible(ctx.document.activeElement));
  assert.deepEqual(JSON.parse(ctx.dom.window.localStorage.getItem(SIDEBAR_KEY)), { sidebarCollapsed: true });
  resize(ctx, 800); assert.equal(ctx.byId("project-sidebar").hidden, true);
  ctx.byId("sidebar-toggle").click(); ctx.byId("sidebar-close").click();
  assert.deepEqual(JSON.parse(ctx.dom.window.localStorage.getItem(SIDEBAR_KEY)), { sidebarCollapsed: true });
  resize(ctx, 801); ctx.byId("sidebar-toggle").click();
  assert.equal(ctx.byId("project-sidebar").hidden, false); assert.equal(ctx.byId("project-sidebar").hasAttribute("aria-modal"), false); noNavigationIO(ctx);
});

test("independent expanded desktop transition does not leave focus on the mobile-only close button that becomes hidden", async (t) => {
  const ctx = await setup(t, { width: 800, sidebarPreference: { sidebarCollapsed: false } });
  openDrawer(ctx); assert.equal(ctx.document.activeElement, ctx.byId("sidebar-close"));
  resize(ctx, 801);
  assert.equal(ctx.byId("project-sidebar").hidden, false); assert.equal(ctx.byId("sidebar-close").hidden, true);
  assert.equal(ctx.byId("sidebar-backdrop").hidden, true); assert.equal(ctx.document.querySelectorAll('[aria-modal="true"], [inert]').length, 0);
  assert.ok(visible(ctx.document.activeElement), "Resize must move focus off a mobile-only control before it becomes hidden");
  assert.deepEqual(JSON.parse(ctx.dom.window.localStorage.getItem(SIDEBAR_KEY)), { sidebarCollapsed: false });
  noNavigationIO(ctx);
});

test("independent compact project editor resize restores desktop sidebar navigation, search and new-project controls", async (t) => {
  const ctx = await setup(t, { width: 800 });
  openDrawer(ctx); ctx.byId("sidebar-new-project").click();
  assert.equal(ctx.byId("project-form").hidden, false); assert.equal(ctx.byId("editor-panel").getAttribute("aria-modal"), "true");
  assert.equal(ctx.byId("project-sidebar").hasAttribute("inert"), true);
  change(ctx, "project-name", "保留项目详情草稿");
  resize(ctx, 801);
  assert.equal(ctx.byId("project-sidebar").hidden, false); assert.equal(ctx.byId("project-sidebar").hasAttribute("inert"), false);
  assert.equal(ctx.document.querySelectorAll('[aria-modal="true"], [inert]').length, 0);
  for (const control of ["sidebar-all", "sidebar-next", "sidebar-archive", "sidebar-project-search", "sidebar-new-project", "sidebar-toggle"]) {
    assert.equal(ctx.byId(control).disabled, false, `${control} must become available after leaving the compact editor layout`);
  }
  assert.equal(ctx.row(projects.b).disabled, false); ctx.row(projects.b).click();
  assert.equal(ctx.byId("project-filter").value, projects.b); assert.equal(ctx.byId("project-name").value, "保留项目详情草稿");
  noNavigationIO(ctx);
});

test("independent compact editor and dirty decision take modal priority, block sidebar handlers and keep exactly one focus trap", async (t) => {
  const ctx = await setup(t); openTask(ctx); change(ctx, "task-title", "保留详情草稿"); resize(ctx, 600);
  assert.equal(ctx.byId("sidebar-toggle").disabled, true); assert.equal(ctx.byId("project-sidebar").hidden, true);
  assert.equal(ctx.byId("editor-panel").getAttribute("aria-modal"), "true");
  const beforeProject = ctx.byId("project-filter").value;
  ctx.byId("sidebar-toggle").dispatchEvent(new ctx.dom.window.Event("click", { bubbles: true }));
  ctx.byId("sidebar-all").dispatchEvent(new ctx.dom.window.Event("click", { bubbles: true }));
  assert.equal(ctx.byId("project-filter").value, beforeProject); assert.equal(ctx.document.querySelectorAll('[aria-modal="true"]').length, 1);
  ctx.byId("editor-close").click();
  assert.equal(ctx.byId("discard-dialog").hidden, false); assert.equal(ctx.byId("discard-dialog").getAttribute("aria-modal"), "true");
  assert.equal(ctx.byId("editor-panel").hasAttribute("aria-modal"), false); assert.equal(ctx.document.querySelectorAll('[aria-modal="true"]').length, 1);
  ctx.byId("sidebar-next").dispatchEvent(new ctx.dom.window.Event("click", { bubbles: true }));
  assert.equal(ctx.byId("project-filter").value, beforeProject); assert.equal(ctx.byId("cards").classList.contains("next-view"), false);
  const controls = focusable(ctx.byId("discard-dialog")); controls.at(-1).focus(); key(ctx, controls.at(-1), "Tab"); assert.equal(ctx.document.activeElement, controls[0]);
  key(ctx, controls[0], "Escape"); assert.equal(ctx.byId("discard-dialog").hidden, true); assert.equal(ctx.byId("task-title").value, "保留详情草稿");
  assert.equal(ctx.byId("editor-panel").getAttribute("aria-modal"), "true"); resize(ctx, 801);
  assert.equal(ctx.document.querySelectorAll('[aria-modal="true"], [inert]').length, 0); noNavigationIO(ctx);
});

test("independent desktop navigation preserves dirty editor fields and original CAS even after a newer notification", async (t) => {
  const ctx = await setup(t); const before = await ctx.read(); openTask(ctx); change(ctx, "task-title", "保留本地草稿"); change(ctx, "task-step", "保留本地步骤");
  await ctx.commit({ type: "archive_task", taskId: tasks.inProgress, archived: true }); ctx.view.acceptReadResult(wrap(await ctx.store.read()));
  ctx.row(projects.b).click(); ctx.byId("sidebar-next").click(); ctx.byId("sidebar-archive").click(); ctx.byId("sidebar-all").click();
  assert.equal(ctx.byId("editor-panel").hidden, false); assert.equal(ctx.byId("discard-dialog").hidden, true);
  assert.equal(ctx.byId("task-title").value, "保留本地草稿"); assert.equal(ctx.byId("task-step").value, "保留本地步骤"); noNavigationIO(ctx);
  ctx.byId("task-form").querySelector('[type="submit"]').click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0].expectedRevision, before.revision);
  assert.equal(ctx.calls[0].operation.task.title, "保留本地草稿"); assert.equal((await ctx.read()).tasks.find((task) => task.id === tasks.planned).title, "共同 A 计划");
});

test("successful instant choice leaves sidebar navigation and undo available without background reads", async (t) => {
  const ctx = await setup(t); ctx.byId("view-list").click();
  const priority = ctx.card().querySelector('[data-quick-field="priority"]'); priority.value = "urgent"; priority.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.byId("sidebar-new-project").disabled, false); assert.equal(ctx.byId("new-project").disabled, false);
  ctx.row(projects.b).click(); ctx.byId("sidebar-archive").click();
  assert.equal(ctx.card(), null); const notice = ctx.document.querySelector(".field-save-notice"); assert.ok(notice);
  assert.equal(notice.querySelector('[data-field-action="undo"]').disabled, false);
  assert.equal(ctx.refreshCalls, 0); assert.equal(ctx.calls.length, 1); assert.equal((await ctx.read()).tasks.find((task) => task.id === tasks.planned).priority, "urgent");
  notice.querySelector('[data-field-action="undo"]').click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal((await ctx.read()).tasks.find((task) => task.id === tasks.planned).priority, "normal"); assert.equal(ctx.calls.length, 2);
});

for (const lane of ["editor", "quick"]) {
  test(`independent ${lane} unknown request survives sidebar navigation and newer records with original ID/CAS/operation receipt replay`, async (t) => {
    const ctx = await setup(t, { mutate: async (request, perform, number) => { const result = await perform(request); if (number === 1) throw new Error("Lost response after temporary-store commit"); return result; } });
    if (lane === "editor") { openTask(ctx); change(ctx, "task-title", "保留未知请求"); ctx.byId("task-form").querySelector('[type="submit"]').click(); }
    else { ctx.byId("view-list").click(); const select = ctx.card().querySelector('[data-quick-field="priority"]'); select.value = "urgent"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); }
    await settle(() => !ctx.byId("refresh").disabled); const original = structuredClone(ctx.calls[0]);
    await ctx.commit({ type: "archive_task", taskId: tasks.inProgress, archived: true }); ctx.view.acceptReadResult(wrap(await ctx.store.read()));
    ctx.row(projects.b).click(); ctx.byId("sidebar-archive").click(); ctx.byId("sidebar-all").click();
    assert.equal(ctx.calls.length, 1); assert.equal(ctx.refreshCalls, 0); assert.equal(ctx.byId("sidebar-new-project").disabled, lane === "editor");
    if (lane === "editor") { assert.equal(ctx.byId("task-title").value, "保留未知请求"); assert.equal(ctx.byId("task-title").disabled, true); }
    else { const notice = ctx.document.querySelector(".field-save-notice"); assert.ok(notice); assert.equal(notice.querySelector('[data-field-action="dismiss"]').disabled, true); }
    const before = await ctx.read(); const diskBefore = JSON.parse(await readFile(path.join(ctx.directory, "data.json"), "utf8"));
    if (lane === "editor") ctx.byId("task-form").querySelector('[type="submit"]').click(); else ctx.byId("action-retry").click();
    await settle(() => !ctx.byId("refresh").disabled);
    assert.equal(ctx.calls.length, 2); assert.deepEqual(ctx.calls[1], original); assert.deepEqual(await ctx.read(), before);
    const diskAfter = JSON.parse(await readFile(path.join(ctx.directory, "data.json"), "utf8")); assert.equal(diskAfter.revision, diskBefore.revision); assert.equal(diskAfter.appliedRequests.length, diskBefore.appliedRequests.length);
  });
}

test("independent per-row project archive/recovery remains explicit and proxy disabled follows disconnected, busy and unknown writers", async (t) => {
  const ctx = await setup(t); ctx.row(projects.b).click();
  const archive = () => {
    const menu = ctx.document.querySelector(`[data-sidebar-project-menu="${projects.a}"]`); menu.open = true;
    return menu.querySelector('[data-sidebar-project-action="archive"]');
  };
  archive().click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.calls.length, 1); assert.deepEqual(ctx.calls[0].operation, { type: "archive_project", projectId: projects.a, archived: true });
  assert.equal(ctx.byId("project-filter").value, projects.b);
  assert.equal(count(ctx.byId("sidebar-all")), 1); assert.equal(count(ctx.byId("sidebar-archive")), 5);
  assert.equal(archive().textContent, "恢复项目"); archive().click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.calls.length, 2); assert.deepEqual(ctx.calls[1].operation, { type: "archive_project", projectId: projects.a, archived: false });
  assert.equal(count(ctx.byId("sidebar-all")), 3); assert.equal(count(ctx.byId("sidebar-archive")), 3);
  const disconnected = await setup(t, { connected: false }); assert.equal(disconnected.byId("sidebar-new-project").disabled, true); disconnected.byId("sidebar-new-project").click(); assert.equal(disconnected.byId("editor-panel").hidden, true); noNavigationIO(disconnected);
  let release;
  const pending = await setup(t, { mutate: async () => { await new Promise((resolve) => { release = resolve; }); return failure("SAVE_FAILED"); } });
  openTask(pending); change(pending, "task-title", "挂起保存"); pending.byId("task-form").querySelector('[type="submit"]').click();
  assert.equal(pending.byId("sidebar-new-project").disabled, true); assert.equal(pending.byId("new-project").disabled, true);
  release(); await settle(() => !pending.byId("refresh").disabled);
});
