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
import { mountCodex } from "../src/view-codex.mjs";
import { unavailableCodexSnapshot, codexSnapshotSchema } from "../src/codex-domain.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { tick } from "./helpers.mjs";

const KEY = "learning-board:view-preferences:v1";
const timestamp = "2030-10-05T04:00:00.000Z";
const id = (number) => `33333333-3333-4333-8333-${String(number).padStart(12, "0")}`;
const projectId = id(1), taskId = id(2);
const wrap = (structuredContent) => ({ structuredContent, ...(structuredContent.ok ? {} : { isError: true }) });
const initial = () => boardSchema.parse({ ...emptyBoard(), projects: [{ id: projectId, name: "工作项目", description: "仅临时验证", lastUpdatedAt: timestamp }], tasks: [{ id: taskId, projectId, title: "待处理任务", status: "waiting_user", priority: "normal", dueDate: null, sourceTool: "手工", currentStep: "待回复", blocker: "", conversationUrl: null, lastUpdatedAt: timestamp }] });
function snapshot(threadId = id(3)) {
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null };
  return codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(timestamp), connection: { state: "connected", lastSuccessAt: timestamp, error: null, scope: "测试来源", source: "desktop-snapshot" }, sources: { threads: source, automations: source }, completeness: { threads: true, automations: true, truncated: false }, threads: [{ id: threadId, hostId: "local", title: "原任务", cwd: "/temporary/project", updatedAt: timestamp, runtimeStatus: "idle", attention: null, lastTurnStatus: null, goalStatus: null }], automations: [{ id: "temporary-plan", name: "检查构建", status: "ACTIVE", kind: "cron", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", timeZone: "Asia/Shanghai", targetThreadId: null, lastRunAt: null, nextRunAt: null }] });
}
async function setup(t, { preference, corrupt, denyStorage = false, width = 1200, mutate, openThread, requestAutomation } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "workbench-navigation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  assert.equal((await store.mutate({ requestId: randomUUID(), expectedRevision: 0, operation: { type: "restore_board", backup: makeBackup(initial(), timestamp) } })).ok, true);
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://workbench-navigation.invalid/", pretendToBeVisual: true });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: width });
  if (preference !== undefined) dom.window.localStorage.setItem(KEY, JSON.stringify(preference));
  if (corrupt !== undefined) dom.window.localStorage.setItem(KEY, corrupt);
  if (denyStorage) {
    dom.window.Storage.prototype.getItem = () => { throw new Error("Synthetic storage denial"); };
    dom.window.Storage.prototype.setItem = () => { throw new Error("Synthetic storage denial"); };
  }
  const document = dom.window.document, calls = [], opened = [], requests = [];
  let manualReads = 0, codexReads = 0, codex;
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, emptyBoard(), {
    now: () => Date.parse(timestamp), setTimeout: () => 1, clearTimeout() {},
    mutate: async (request) => { calls.push(structuredClone(request)); return mutate ? mutate(request, perform, calls.length) : perform(request); },
    refresh: async () => { manualReads++; return wrap(await store.read()); },
    openThread: async (...args) => { opened.push(args); return openThread ? openThread(...args) : {}; },
    onOpenAutomations: () => codex.openAutomations(),
    onOpenWorkbench: () => codex.setVisible(false),
  }));
  codex = (createI18n(document, { locale: "zh" }), mountCodex(document, {
    now: () => Date.parse(timestamp), setTimeout: () => 1, clearTimeout() {},
    beforeSurfaceChange: view.prepareSurfaceChange, onSurfaceChange: view.setWorkbenchSurface, onSnapshot: view.setCodexSnapshot,
    refresh: async () => { codexReads++; return wrap({ ok: true, snapshot: snapshot() }); },
    requestAutomation: async (...args) => { requests.push(args); return requestAutomation ? requestAutomation(...args) : {}; },
    openThread: async (...args) => { opened.push(args); return openThread ? openThread(...args) : {}; },
  }));
  t.after(() => { codex.dispose(); view.dispose(); dom.window.close(); });
  view.setHostState({ connected: true, message: "测试宿主" }); view.acceptReadResult(wrap(await store.read()));
  codex.setHostState({ connected: true, requestSupported: true }); codex.acceptReadResult(wrap({ ok: true, snapshot: snapshot() }));
  const byId = (value) => document.getElementById(value);
  const change = (field, value) => { const node = byId(field); node.value = value; node.dispatchEvent(new dom.window.Event(node.matches("select") ? "change" : "input", { bubbles: true })); };
  const card = () => document.querySelector(`[data-task-id="${taskId}"]`);
  const edit = () => { card().querySelector("[data-edit-task]").click(); byId("task-read-edit").click(); assert.equal(byId("task-form").hidden, false); };
  return { dom, document, view, codex, store, calls, requests, opened, byId, change, card, edit, get manualReads() { return manualReads; }, get codexReads() { return codexReads; } };
}
function current(ctx, expected) { const entries = [...ctx.document.querySelectorAll('#project-sidebar [aria-current="page"]')]; assert.deepEqual(entries, [ctx.byId(expected)]); }
function visible(node) { if (!node || node.closest("[hidden],[inert]")) return false; const css = node.ownerDocument.defaultView.getComputedStyle(node); return css.display !== "none" && css.visibility !== "hidden"; }
function noWrites(ctx) { assert.equal(ctx.calls.length, 0); assert.equal(ctx.requests.length, 0); assert.equal(ctx.manualReads, 0); }
function resize(ctx, width) { Object.defineProperty(ctx.dom.window, "innerWidth", { configurable: true, value: width }); ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("resize")); }
function plans(ctx) { ctx.byId("sidebar-automations").click(); assert.equal(ctx.byId("codex-panel").hidden, false); assert.equal(ctx.byId("codex-panel").dataset.surface, "automations"); }
function back(ctx) { ctx.byId("codex-back-to-board").click(); assert.equal(ctx.byId("manual-board").hidden, false); assert.equal(ctx.byId("codex-panel").hidden, true); }
async function settled(predicate) { const deadline = Date.now() + 5000; while (!predicate() && Date.now() < deadline) { await tick(); await new Promise((resolve) => setTimeout(resolve, 5)); } assert.ok(predicate(), "Pending request must settle"); }
function sessionDraft(ctx) {
  ctx.byId("sidebar-learning").click(); ctx.byId("new-session").click();
  for (const [field, value] of [["session-date", "2030-10-07"], ["session-end-date", "2030-10-07"], ["session-start", "09:00"], ["session-end", "09:45"], ["session-objective", "保留学习目标"], ["session-criteria", "完成五题"]]) ctx.change(field, value);
}

for (const storage of [{}, { corrupt: "{" }, { corrupt: "null" }, { corrupt: "[]" }, { preference: { viewMode: "unexpected" } }, { denyStorage: true }]) {
  test(`workbench default next survives storage ${JSON.stringify(storage)}`, async (t) => {
    const ctx = await setup(t, storage); assert.equal(ctx.byId("cards").classList.contains("next-view"), true); current(ctx, "sidebar-next"); noWrites(ctx);
  });
}
for (const mode of ["board", "list", "next", "today", "week"]) {
  test(`workbench restores existing ${mode} preference without migrating its key`, async (t) => {
    const ctx = await setup(t, { preference: { viewMode: mode, timeZone: "America/New_York" } });
    assert.equal(ctx.byId(`view-${mode}`).getAttribute("aria-pressed"), "true");
    assert.equal(JSON.parse(ctx.dom.window.localStorage.getItem(KEY)).viewMode, mode);
    current(ctx, ["today", "week"].includes(mode) ? "sidebar-learning" : mode === "next" ? "sidebar-next" : "sidebar-all");
    if (!["today", "week"].includes(mode)) ctx.byId("sidebar-learning").click();
    assert.equal(ctx.byId("display-time-zone").value, "America/New_York"); noWrites(ctx);
  });
}

test("workbench template keeps every original ID exactly once, calendar controls in learning, and CSP intact", async () => {
  const current = new JSDOM(await loadAppTemplate());
  try {
    const originalIds = ["manual-tab", "codex-tab", "manual-board", "project-sidebar", "sidebar-close", "sidebar-all", "sidebar-next", "sidebar-archive", "sidebar-new-project", "sidebar-project-search", "sidebar-selected-project", "project-menu", "new-project", "edit-project", "archive-project", "sidebar-projects", "sidebar-backdrop", "main-title", "project-description", "sidebar-toggle", "sidebar-current-project", "search", "view-today", "view-week", "view-board", "view-list", "view-next", "filter-toggle", "refresh", "data-toggle", "new-task", "filter-panel", "filter-close", "status-filter", "source-filter", "archive-filter", "project-filter", "data-panel", "data-export", "data-file", "restore-preview", "restore-summary", "restore-session-warning", "restore-confirm", "restore-cancel", "export-fallback", "export-json", "export-copy", "count", "project-count", "filter-summary", "filter-chips", "clear", "data-error", "save-status", "move-feedback", "move-retry", "move-dismiss", "action-feedback", "action-retry", "action-dismiss", "expired-feedback", "expired-reviewed", "expired-end", "codex-board-status", "codex-board-source", "codex-board-interaction", "codex-board-id-fallback", "codex-board-thread-id", "workspace", "schedule-toolbar", "calendar-range", "week-previous", "week-today", "week-next", "new-session", "calendar-summary", "display-time-zone", "calendar-remaining", "time-zone-choices", "learning-prompt", "learning-prompt-copy", "cards", "empty", "editor-panel", "editor-kind", "editor-refresh", "editor-close", "editor-error", "merge-conflicts", "discard-dialog", "discard-title", "keep-editing", "discard-edits", "project-form", "project-editor-title", "project-name", "project-description-input", "task-read-view", "task-read-title", "task-read-unavailable", "task-read-record", "task-read-project", "task-read-status", "task-read-priority", "task-read-date", "task-read-step-heading", "task-read-step", "task-read-blocker-heading", "task-read-blocker", "task-read-source", "task-read-updated", "task-read-link", "task-read-draft", "task-read-close", "task-read-edit", "task-form", "task-editor-title", "task-edit-read", "task-title", "task-project", "task-status", "task-priority", "task-due-date", "task-source", "task-step", "task-blocker", "task-conversation", "task-updated", "task-link", "schedule-panel", "schedule-refresh", "schedule-close", "schedule-notices", "schedule-error", "session-lock-note", "schedule-review", "schedule-review-message", "schedule-reviewed", "schedule-discard-dialog", "schedule-discard-title", "schedule-keep-editing", "schedule-discard-edits", "session-form", "session-editor-title", "session-context", "session-context-time", "session-context-objective", "session-context-criteria", "session-task", "session-timing-fields", "session-date", "session-start", "session-end-date", "session-end", "session-zone", "session-objective", "session-criteria", "session-feedback-fields", "session-outcome", "session-reasons", "session-reasons-label", "session-minutes", "session-feedback", "session-save-state", "session-cancel", "session-submit", "notice", "mode-tag", "connection", "codex-panel", "codex-refresh", "codex-search", "codex-poll-status", "codex-connection", "codex-observed", "codex-scope", "codex-read-error", "codex-threads-heading", "codex-thread-count", "codex-thread-source", "codex-thread-groups", "codex-thread-empty", "codex-thread-more", "codex-automations-heading", "codex-automation-count", "codex-automation-source", "codex-automation-list", "codex-automation-empty", "codex-automation-more", "codex-automation-action", "codex-action-text", "codex-action-send", "codex-action-copy", "codex-action-cancel", "codex-action-status", "codex-action-review-row", "codex-action-reviewed", "codex-automation-disclosure", "codex-automation-form", "codex-automation-content", "codex-automation-frequency", "codex-automation-date-row", "codex-automation-date", "codex-automation-day-row", "codex-automation-day", "codex-automation-time", "codex-automation-validation", "codex-automation-preview", "codex-automation-send", "codex-automation-copy", "codex-automation-status", "codex-automation-review-row", "codex-automation-reviewed", "codex-interaction-status", "codex-open-fallback", "codex-thread-id", "codex-thread-id-copy"];
    const removedIds = ["time-zone-choices", "codex-search", "codex-threads-heading", "codex-thread-count", "codex-thread-groups", "codex-thread-empty", "codex-thread-more", "codex-interaction-status", "codex-open-fallback", "codex-thread-id", "codex-thread-id-copy", "codex-automation-action", "codex-action-text", "codex-action-send", "codex-action-copy", "codex-action-cancel", "codex-action-status", "codex-action-review-row", "codex-action-reviewed", "codex-automation-disclosure", "codex-automation-form", "codex-automation-content", "codex-automation-frequency", "codex-automation-date-row", "codex-automation-date", "codex-automation-day-row", "codex-automation-day", "codex-automation-time", "codex-automation-validation", "codex-automation-preview", "codex-automation-send", "codex-automation-copy", "codex-automation-status", "codex-automation-review-row", "codex-automation-reviewed"];
    for (const id of removedIds) assert.equal(current.window.document.querySelectorAll(`[id="${id}"]`).length, 0, id);
    for (const id of [...originalIds.filter((id) => !removedIds.includes(id)), "task-surface", "record-filter", "codex-diagnostics", "codex-diagnostic-count", "session-time-zone-choices", "codex-request-fallback", "codex-request-text", "codex-copy-status"]) assert.equal(current.window.document.querySelectorAll(`[id="${id}"]`).length, 1, id);
    assert.equal(current.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    const top = current.window.document.querySelector(".toolbar .view-switch");
    assert.deepEqual([...top.querySelectorAll("button:not([hidden])")].map((node) => node.id), ["view-board", "view-list"]);
    for (const id of ["view-today", "view-week"]) assert.ok(current.window.document.getElementById("learning-view-switch").contains(current.window.document.getElementById(id)));
    assert.equal(current.window.document.querySelectorAll('link[rel="stylesheet"],script[src],img[src^="http"]').length, 0);
  } finally { current.window.close(); }
});

test("learning navigation preserves week while calendar project/all navigation returns to list with one current page", async (t) => {
  const ctx = await setup(t); ctx.byId("sidebar-learning").click(); current(ctx, "sidebar-learning");
  assert.equal(ctx.byId("view-today").getAttribute("aria-pressed"), "true");
  ctx.byId("view-week").click(); ctx.byId("sidebar-learning").click(); assert.equal(ctx.byId("view-week").getAttribute("aria-pressed"), "true");
  ctx.document.querySelector(`[data-sidebar-project="${projectId}"]`).click(); assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true");
  ctx.byId("sidebar-learning").click(); ctx.byId("sidebar-all").click(); assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true"); current(ctx, "sidebar-all"); noWrites(ctx);
});

test("plans navigation displays source freshness, focuses heading, sends no prompt and restores a visible control", async (t) => {
  const ctx = await setup(t); plans(ctx); await tick();
  assert.equal(ctx.document.activeElement, ctx.byId("codex-automations-heading"));
  current(ctx, "sidebar-automations"); assert.equal(visible(ctx.byId("project-sidebar")), true); assert.equal(ctx.byId("manual-board").hidden, false); assert.equal(visible(ctx.byId("codex-diagnostics")), false);
  assert.equal(visible(ctx.byId("codex-automation-source")), true); assert.match(ctx.byId("codex-automation-source").textContent, /采集|来源/);
  ctx.document.querySelector("[data-codex-automation] button").click(); await tick(); back(ctx); assert.equal(visible(ctx.document.activeElement), true);
  plans(ctx); assert.equal(ctx.byId("codex-request-text").value.includes("计划 ID：temporary-plan"), true);
  ctx.byId("codex-tab").click(); assert.notEqual(ctx.byId("codex-panel").dataset.surface, "automations"); assert.equal(visible(ctx.byId("codex-diagnostics")), true); current(ctx, "codex-tab"); assert.equal(ctx.document.querySelector("[data-codex-thread]"), null); noWrites(ctx);
});

for (const width of [800, 801]) {
  test(`plans navigation cleans sidebar drawer and inert state at ${width}px`, async (t) => {
    const ctx = await setup(t, { width });
    if (width === 800) { ctx.byId("sidebar-toggle").click(); assert.equal(ctx.byId("project-sidebar").getAttribute("aria-modal"), "true"); ctx.byId("codex-tab").click(); assert.equal(ctx.byId("manual-board").hidden, false, "Global source tab cannot penetrate a modal drawer"); }
    plans(ctx); assert.equal(ctx.byId("project-sidebar").hasAttribute("aria-modal"), false); assert.equal(ctx.byId("sidebar-backdrop").hidden, true); assert.equal(ctx.document.querySelector('[hidden][aria-modal="true"]'), null);
    back(ctx); assert.equal(visible(ctx.document.activeElement), true); assert.equal(ctx.document.querySelector(".app-main").hasAttribute("inert"), false); noWrites(ctx);
  });
}

test("desktop manual edit draft survives plans round trip without submission", async (t) => {
  const ctx = await setup(t, { preference: { viewMode: "board" } }); ctx.edit(); ctx.change("task-title", "尚未保存的标题"); ctx.change("task-step", "尚未保存的步骤"); plans(ctx); back(ctx);
  assert.equal(ctx.byId("task-title").value, "尚未保存的标题"); assert.equal(ctx.byId("task-step").value, "尚未保存的步骤"); assert.equal(ctx.byId("task-form").hidden, false); noWrites(ctx);
});

test("desktop quick choice is saved immediately and survives plans round trip", async (t) => {
  const ctx = await setup(t, { preference: { viewMode: "list" } });
  const select = ctx.card().querySelector('[data-quick-field="priority"]'); select.value = "urgent"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  await settled(() => ctx.calls.length === 1 && !ctx.byId("refresh").disabled);
  plans(ctx); back(ctx);
  assert.equal(ctx.card().querySelector('[data-quick-field="priority"]').value, "urgent");
  assert.equal(ctx.card().querySelector("[data-quick-save]"), null);
  assert.equal((await ctx.store.read()).board.tasks.find((task) => task.id === taskId).priority, "urgent");
  assert.equal(ctx.calls[0].operation.type, "patch_task");
  assert.equal(ctx.requests.length, 0);
});

test("desktop learning draft survives plans round trip without submission", async (t) => {
  const ctx = await setup(t); sessionDraft(ctx); plans(ctx); back(ctx); assert.equal(ctx.byId("session-objective").value, "保留学习目标"); assert.equal(ctx.byId("session-criteria").value, "完成五题"); assert.equal(ctx.byId("schedule-panel").hidden, false); noWrites(ctx);
});

for (const kind of ["task", "session"]) {
  test(`compact ${kind} modal blocks source tab and keyboard surface changes until explicitly closed`, async (t) => {
    const ctx = await setup(t, { preference: { viewMode: "board" }, width: 800 }); if (kind === "task") ctx.edit(); else sessionDraft(ctx);
    assert.equal(ctx.byId(kind === "task" ? "editor-panel" : "schedule-panel").getAttribute("aria-modal"), "true");
    ctx.byId("codex-tab").click(); assert.equal(ctx.byId("manual-board").hidden, false);
    ctx.byId("codex-tab").dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    assert.equal(ctx.byId("manual-board").hidden, false); assert.equal(visible(ctx.document.activeElement), true); noWrites(ctx);
  });
}

test("pending discard decision blocks source tab and direct plans API", async (t) => {
  const ctx = await setup(t, { preference: { viewMode: "board" } }); ctx.edit(); ctx.change("task-title", "脏草稿"); ctx.byId("task-form").querySelector("[data-cancel]").click(); assert.equal(ctx.byId("discard-dialog").hidden, false);
  ctx.byId("codex-tab").click(); ctx.codex.openAutomations(); assert.equal(ctx.byId("manual-board").hidden, false); assert.equal(ctx.byId("discard-dialog").getAttribute("aria-modal"), "true"); assert.equal(ctx.byId("task-title").value, "脏草稿"); noWrites(ctx);
});

for (const kind of ["task", "quick", "session"]) {
  test(`unknown ${kind} write preserves original requestId and CAS across plans return and exact replay`, async (t) => {
    const ctx = await setup(t, { preference: { viewMode: kind === "quick" ? "list" : "board" }, mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("Lost successful receipt"); return result; } });
    if (kind === "task") { ctx.edit(); ctx.change("task-title", "只提交一次的标题"); ctx.byId("task-form").querySelector('[type="submit"]').click(); }
    else if (kind === "quick") { const choice = ctx.card().querySelector('[data-quick-field="priority"]'); choice.value = "urgent"; choice.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); }
    else { sessionDraft(ctx); ctx.byId("session-submit").click(); }
    await settled(() => ctx.calls.length === 1 && !ctx.byId("refresh").disabled);
    const frozen = structuredClone(ctx.calls[0]); assert.ok(frozen.requestId); assert.equal(typeof frozen.expectedRevision, "number"); const revision = (await ctx.store.read()).board.revision;
    plans(ctx); back(ctx); assert.deepEqual(ctx.calls, [frozen]); assert.equal(ctx.requests.length, 0);
    if (kind === "task") ctx.byId("task-form").querySelector('[type="submit"]').click(); else ctx.byId("action-retry").click();
    await settled(() => ctx.calls.length === 2 && !ctx.byId("refresh").disabled); assert.deepEqual(ctx.calls[1], frozen); assert.equal((await ctx.store.read()).board.revision, revision);
  });
}

for (const result of ["success", "failure", "unavailable"]) {
  test(`original task opening ${result} keeps UUID host protocol and fallback without navigation writes`, async (t) => {
    const ctx = await setup(t, { openThread: result === "failure" ? async () => { throw new Error("Host rejected"); } : undefined });
    ctx.codex.acceptReadResult(wrap({ ok: true, snapshot: snapshot(result === "unavailable" ? "legacy-thread-id" : id(3)) })); ctx.byId("codex-tab").click();
    ctx.byId("manual-tab").click(); ctx.byId("sidebar-all").click(); ctx.document.querySelector('#cards [data-origin="codex"] [data-codex-task-open]').click(); await tick();
    if (result === "unavailable") assert.equal(ctx.opened.length, 0); else assert.deepEqual(ctx.opened[0], [id(3), "local"]);
    assert.match(ctx.byId("codex-board-interaction").textContent, result === "success" ? /请求打开/ : /任务 ID|任务/); noWrites(ctx);
  });
}

for (const kind of ["task", "session"]) {
  test(`hidden desktop ${kind} draft cannot become a modal during plans resize; return restores its compact modal`, async (t) => {
    const ctx = await setup(t, { preference: { viewMode: "board" } }); if (kind === "task") { ctx.edit(); ctx.change("task-title", "跨尺寸草稿"); } else sessionDraft(ctx);
    plans(ctx); resize(ctx, 800);
    assert.equal(ctx.document.querySelector('[hidden][aria-modal="true"]'), null); assert.equal(ctx.document.querySelector(".surface-tabs").hasAttribute("inert"), false);
    assert.equal(visible(ctx.byId("codex-back-to-board")), true); back(ctx);
    const panel = ctx.byId(kind === "task" ? "editor-panel" : "schedule-panel"); assert.equal(panel.getAttribute("aria-modal"), "true"); assert.equal(panel.contains(ctx.document.activeElement), true);
    const modals = [...ctx.document.querySelectorAll('[aria-modal="true"]')].filter(visible); assert.deepEqual(modals, [panel]);
    assert.equal(ctx.byId(kind === "task" ? "task-title" : "session-objective").value, kind === "task" ? "跨尺寸草稿" : "保留学习目标"); noWrites(ctx);
  });
}

test("learning entry keeps existing project/status/source/archive filters and uniquely owns navigation selection", async (t) => {
  const ctx = await setup(t, { preference: { viewMode: "list", project: projectId, status: "waiting_user", source: JSON.stringify("手工"), archive: "all" } });
  const fields = ["project-filter", "status-filter", "source-filter", "archive-filter"];
  const before = fields.map((field) => ctx.byId(field).value);
  ctx.byId("sidebar-learning").click(); assert.deepEqual(fields.map((field) => ctx.byId(field).value), before); current(ctx, "sidebar-learning");
  assert.match(ctx.byId("sidebar-current-project").textContent, /学习安排/);
  ctx.byId("sidebar-all").click(); assert.equal(ctx.byId("view-list").getAttribute("aria-pressed"), "true"); current(ctx, "sidebar-all"); noWrites(ctx);
});

test("pending learning discard decision blocks source tab and direct plans API while retaining its input", async (t) => {
  const ctx = await setup(t); sessionDraft(ctx); ctx.byId("session-cancel").click(); assert.equal(ctx.byId("schedule-discard-dialog").hidden, false);
  ctx.byId("codex-tab").click(); ctx.codex.openAutomations(); assert.equal(ctx.byId("manual-board").hidden, false); assert.equal(ctx.byId("schedule-discard-dialog").getAttribute("aria-modal"), "true");
  assert.equal(ctx.byId("session-objective").value, "保留学习目标"); assert.equal(visible(ctx.document.activeElement), true); noWrites(ctx);
});

test("plans and diagnostics share the workbench while sidebar routes restore task and calendar controls", async (t) => {
  const ctx = await setup(t); plans(ctx); current(ctx, "sidebar-automations");
  assert.equal(ctx.byId("manual-board").hidden, false);
  assert.ok(ctx.document.querySelector(".app-main").contains(ctx.byId("codex-panel")));
  assert.equal(visible(ctx.byId("search")), false); assert.equal(visible(ctx.byId("task-filter-summary")), false);
  ctx.byId("sidebar-all").click(); current(ctx, "sidebar-all"); assert.equal(ctx.byId("codex-panel").hidden, true); assert.equal(visible(ctx.byId("search")), true);
  plans(ctx); ctx.document.querySelector(`[data-sidebar-project="${projectId}"]`).click(); assert.equal(ctx.byId("codex-panel").hidden, true); assert.equal(ctx.document.querySelectorAll('#project-sidebar [aria-current="page"]').length, 1); assert.equal(ctx.document.querySelector('#project-sidebar [aria-current="page"]').dataset.sidebarProject, projectId); noWrites(ctx);
});

test("learning hides task search and filter summaries without discarding existing filters", async (t) => {
  const ctx = await setup(t, { preference: { viewMode: "list", source: JSON.stringify("手工"), status: "waiting_user", record: "manual" } });
  const before = ["search", "status-filter", "source-filter", "record-filter"].map((id) => ctx.byId(id).value);
  ctx.byId("filter-toggle").click(); ctx.byId("sidebar-learning").click();
  for (const id of ["search", "filter-toggle", "task-view-switch", "count", "clear", "filter-panel"]) assert.equal(visible(ctx.byId(id)), false, id);
  assert.equal(visible(ctx.byId("sidebar-toggle")), true); assert.equal(visible(ctx.byId("display-time-zone")), true);
  ctx.document.body.focus(); ctx.document.body.dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "/", bubbles: true })); assert.notEqual(ctx.document.activeElement, ctx.byId("search"));
  ctx.byId("sidebar-all").click(); assert.deepEqual(["search", "status-filter", "source-filter", "record-filter"].map((id) => ctx.byId(id).value), before);
  assert.equal(visible(ctx.byId("search")), true); noWrites(ctx);
});

test("record type and tool source are independent and old automatic source preferences retain intent", async (t) => {
  const ctx = await setup(t, { preference: { viewMode: "list", source: JSON.stringify("Codex 自动同步"), status: "idle" } });
  assert.equal(ctx.byId("record-filter").value, "codex"); assert.equal(ctx.byId("source-filter").value, "all"); assert.equal(ctx.byId("status-filter").value, "idle");
  ctx.codex.acceptReadResult(wrap({ ok: true, snapshot: snapshot() }));
  const board = (await ctx.store.read()).board; board.tasks[0].sourceTool = "Codex"; ctx.view.setBoard(board);
  assert.equal([...ctx.byId("source-filter").options].filter((option) => option.textContent === "Codex").length, 1);
  assert.equal([...ctx.byId("source-filter").options].some((option) => option.textContent === "Codex 自动同步"), false);
  assert.deepEqual([...ctx.byId("status-filter").querySelectorAll("optgroup")].map((group) => [...group.querySelectorAll("option")].map((option) => option.value)), [["planned", "in_progress", "waiting_user", "paused", "completed", "failed"], ["idle", "not_loaded", "unknown", "turn_ended"]]);
  ctx.byId("clear").click(); ctx.change("source-filter", JSON.stringify("Codex")); assert.equal(ctx.byId("count").textContent, "2 / 2 项任务");
  ctx.change("record-filter", "manual"); assert.equal(ctx.byId("count").textContent, "1 / 2 项任务"); assert.equal(ctx.document.querySelectorAll('#cards [data-origin="codex"]').length, 0);
  ctx.change("record-filter", "codex"); assert.equal(ctx.byId("count").textContent, "1 / 2 项任务"); assert.equal(ctx.document.querySelectorAll('#cards [data-origin="codex"]').length, 1);
  ctx.byId("clear").click(); assert.equal(ctx.byId("record-filter").value, "all"); noWrites(ctx);
});

for (const surface of ["automations", "diagnostics"]) {
  test(`hidden retained task draft cannot submit from keyboard or synthetic form on ${surface}`, async (t) => {
    const ctx = await setup(t, { preference: { viewMode: "board" } }); ctx.edit(); ctx.change("task-title", "只保留不提交的草稿");
    ctx.codex.setVisible(true, surface);
    ctx.document.body.dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
    ctx.byId("task-form").dispatchEvent(new ctx.dom.window.Event("submit", { bubbles: true, cancelable: true })); await tick();
    assert.equal(ctx.byId("task-title").value, "只保留不提交的草稿"); noWrites(ctx);
    back(ctx); assert.equal(ctx.byId("task-title").value, "只保留不提交的草稿");
  });
}

test("first Codex read, failure, recovery and partial sources label provisional counts without losing manual tasks", async (t) => {
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://codex-initial-read.invalid/", pretendToBeVisual: true });
  const document = dom.window.document; const byId = (id) => document.getElementById(id); let resolveRead, rejectRead; let reads = 0;
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, initial(), { now: () => Date.parse(timestamp), setTimeout: () => 1, clearTimeout() {} }));
  const codex = (createI18n(document, { locale: "zh" }), mountCodex(document, { pollInManual: true, now: () => Date.parse(timestamp), setTimeout: () => 1, clearTimeout() {}, onSnapshot: view.setCodexSnapshot, onReadError: view.safeCodexError, onReadState: view.setCodexReadState, refresh: () => { reads++; return new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }); } }));
  t.after(() => { codex.dispose(); view.dispose(); dom.window.close(); });
  view.setHostState({ connected: true, message: "测试宿主" }); codex.setHostState({ connected: true }); await tick();
  assert.equal(reads, 1); assert.match(byId("count").textContent, /1 \/ 1.*正在读取 Codex.*数量暂不完整/); assert.equal(byId("count").dataset.complete, "false"); assert.equal(byId("codex-board-status").hidden, false);
  rejectRead(new Error("Temporary offline")); await tick(); assert.match(byId("count").textContent, /Codex 任务未读取.*数量暂不完整/); assert.match(byId("codex-board-source").textContent, /读取失败/); assert.equal(document.querySelectorAll('#cards [data-edit-task]').length, 1);
  const retry = codex.refresh(); await tick(); resolveRead(wrap({ ok: true, snapshot: snapshot() })); await retry; await tick();
  assert.equal(byId("count").textContent, "1 / 2 项任务"); assert.equal(byId("count").dataset.complete, "true"); assert.match(byId("codex-board-source").textContent, /读取完成/); assert.equal(document.querySelectorAll('[data-codex-thread]').length, 0);
  const value = snapshot(); value.sources.threads = { ...value.sources.threads, state: "partial", complete: false }; value.completeness.threads = false;
  codex.acceptReadResult(wrap({ ok: true, snapshot: value })); assert.match(byId("count").textContent, /来源范围不完整/); assert.equal(byId("count").dataset.complete, "false");
});

test("learning sessions ignore hidden task filters while keeping visible project scope and restoring every task filter", async (t) => {
  const ctx = await setup(t, { preference: { viewMode: "list" } });
  const board = (await ctx.store.read()).board;
  const saved = await ctx.store.mutate({ requestId: randomUUID(), expectedRevision: board.revision, operation: { type: "save_session", session: { taskId, startAt: "2030-10-05T05:00:00Z", endAt: "2030-10-05T06:00:00Z", timeZone: "Asia/Shanghai", objective: "必须可见的学习目标", completionCriteria: "完成验证" } } });
  assert.equal(saved.ok, true); ctx.view.setBoard(saved.board);
  ctx.change("project-filter", projectId); ctx.change("search", "不会匹配的任务"); ctx.change("record-filter", "codex"); ctx.change("status-filter", "completed"); ctx.change("source-filter", JSON.stringify("手工"));
  const fields = ["project-filter", "search", "record-filter", "status-filter", "source-filter", "archive-filter"];
  const before = fields.map((field) => ctx.byId(field).value); assert.equal(ctx.document.querySelectorAll('#cards [data-task-id]').length, 0);
  ctx.byId("sidebar-learning").click(); current(ctx, "sidebar-learning"); assert.match(ctx.byId("cards").textContent, /必须可见的学习目标/); assert.deepEqual(fields.map((field) => ctx.byId(field).value), before);
  ctx.byId("view-week").click(); assert.match(ctx.byId("cards").textContent, /必须可见的学习目标/);
  ctx.document.querySelector(`[data-sidebar-project="${projectId}"]`).click(); assert.deepEqual(fields.map((field) => ctx.byId(field).value), before); assert.equal(ctx.document.querySelectorAll('#cards [data-task-id]').length, 0); noWrites(ctx);
});

test("successful task save receipt preserves focused copy fallback after navigating during the write", async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const ctx = await setup(t, { preference: { viewMode: "board" }, mutate: async (request, perform) => { await pending; return perform(request); } });
  ctx.edit(); ctx.change("task-title", "保存期间继续核对计划");
  ctx.byId("task-form").querySelector("[type=submit]").click();
  await settled(() => ctx.calls.length === 1);
  plans(ctx);
  ctx.document.querySelector("[data-codex-automation] button").click(); await tick();
  const input = ctx.byId("codex-request-text");
  input.value = "仍在编写的计划内容"; input.focus();
  release();
  await settled(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.byId("codex-panel").hidden, false);
  assert.equal(ctx.byId("codex-panel").dataset.surface, "automations");
  assert.equal(ctx.document.activeElement, input);
  assert.equal(input.value, "仍在编写的计划内容");
  assert.equal((await ctx.store.read()).board.tasks.find((task) => task.id === taskId).title, "保存期间继续核对计划");
  assert.equal(ctx.requests.length, 0);
  back(ctx);
  assert.equal(ctx.byId("editor-panel").hidden, true);
  assert.ok(visible(ctx.document.activeElement));
});

test("successful learning save receipt preserves focused copy fallback after navigating during the write", async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const ctx = await setup(t, { mutate: async (request, perform) => { await pending; return perform(request); } });
  sessionDraft(ctx); ctx.byId("session-submit").click();
  await settled(() => ctx.calls.length === 1);
  plans(ctx); ctx.document.querySelector("[data-codex-automation] button").click(); await tick();
  const input = ctx.byId("codex-request-text"); input.value = "保存回执期间保留计划输入"; input.focus();
  release();
  await settled(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.byId("codex-panel").dataset.surface, "automations");
  assert.equal(ctx.document.activeElement, input);
  assert.equal(input.value, "保存回执期间保留计划输入");
  assert.equal((await ctx.store.read()).board.sessions.length, 1);
  assert.equal(ctx.requests.length, 0);
  back(ctx);
  assert.equal(ctx.byId("schedule-panel").hidden, true);
  assert.ok(visible(ctx.document.activeElement));
});

for (const surface of ["automations", "diagnostics"]) {
  test(`compact navigation drawer on ${surface} makes the shared header inert and restores it after dismissal`, async (t) => {
    const ctx = await setup(t, { width: 390 });
    if (surface === "automations") ctx.codex.openAutomations(); else ctx.codex.setVisible(true, "diagnostics");
    ctx.byId("sidebar-toggle").click();
    assert.equal(ctx.byId("project-sidebar").getAttribute("aria-modal"), "true");
    assert.equal(ctx.document.querySelector(".surface-tabs").hasAttribute("inert"), true);
    assert.equal(ctx.byId("manual-tab").disabled, true);
    assert.equal(ctx.document.querySelector(".app-main").hasAttribute("inert"), true);
    ctx.byId("sidebar-close").click();
    assert.equal(ctx.document.querySelector(".surface-tabs").hasAttribute("inert"), false);
    assert.equal(ctx.byId("manual-tab").disabled, false);
    assert.equal(ctx.byId("codex-panel").hidden, false);
    assert.ok(visible(ctx.document.activeElement));
    noWrites(ctx);
  });
}
