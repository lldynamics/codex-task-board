import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { emptyBoard, boardSchema } from "../src/board.mjs";
import { mountBoard } from "../src/view.mjs";
import { mountCodex } from "../src/view-codex.mjs";
import { codexSnapshotSchema, unavailableCodexSnapshot } from "../src/codex-domain.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { i18nFor, LOCALE_PREFERENCE_KEY } from "../src/i18n.mjs";
import { tick } from "./helpers.mjs";

const at = "2030-10-05T04:00:00.000Z";
const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const result = (board, request) => ({ structuredContent: { ok: true, board: structuredClone(board), replayed: false, appliedRevision: board.revision, entityId: request?.operation.taskId } });
function boardFixture(user = false) {
  return boardSchema.parse({ ...emptyBoard(), revision: 2,
    projects: [{ id: id(1), name: user ? "编辑" : "Example project", description: user ? "未填写" : "Project objectives", lastUpdatedAt: at }],
    tasks: [{ id: id(2), projectId: id(1), title: user ? "已完成" : "Example task", status: "in_progress", priority: "high", sourceTool: user ? "未填写" : "Notes", currentStep: user ? "编辑" : "Continue reading", blocker: user ? "已完成" : "", conversationUrl: "https://example.com/original", lastUpdatedAt: at }],
    sessions: [{ id: id(3), taskId: id(2), startAt: "2030-10-05T06:00:00.000Z", endAt: "2030-10-05T06:30:00.000Z", timeZone: "Asia/Shanghai", status: "scheduled", objective: "Read one chapter", completionCriteria: "Answer five questions", feedback: "", actualMinutes: null, lastUpdatedAt: at }],
  });
}
function snapshotFixture() {
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: at, complete: true, truncated: false, error: null };
  return codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(at), connection: { state: "connected", source: "desktop-snapshot", lastSuccessAt: at, error: null, scope: "桌面已缓存记录" }, sources: { threads: source, automations: source }, completeness: { threads: true, automations: true, truncated: false },
    threads: [{ id: id(5), hostId: "host/raw", title: "Codex user title", cwd: null, updatedAt: at, runtimeStatus: "active", attention: null, lastTurnStatus: "running", goalStatus: "active" }],
    automations: [{ id: "raw-plan-id", name: "Existing plan", status: "ACTIVE", kind: "heartbeat", rrule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0", timeZone: "Asia/Shanghai", targetThreadId: id(5), lastRunAt: at, nextRunAt: "2030-10-06T01:00:00.000Z" }],
  });
}
async function setup(t, { locale = "zh", user = false, mutate, width = 600 } = {}) {
  let board = boardFixture(user); const calls = []; let reads = 0; const copied = [];
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://locale.test/", pretendToBeVisual: true });
  Object.defineProperty(dom.window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "board" }));
  const view = mountBoard(dom.window.document, emptyBoard(), { locale, now: () => at, refresh: async () => { reads += 1; return result(board); }, mutate: async (request) => {
    calls.push(structuredClone(request));
    if (mutate) return mutate(request, board, calls.length);
    const task = board.tasks.find((task) => task.id === request.operation.taskId);
    if (request.operation.type === "patch_task") Object.assign(task, request.operation.patch);
    board.revision += 1; return result(board, request);
  }, setTimeout: () => 1, clearTimeout() {} });
  view.setHostState({ connected: true, message: "已连接 · 记录保存于本机" }); view.setBoard(board);
  const document = dom.window.document;
  const ctx = { dom, document, view, calls, copied, byId: (value) => document.getElementById(value), get board() { return board; }, get reads() { return reads; }, change(node, value) { node.value = value; node.dispatchEvent(new dom.window.Event("change", { bubbles: true })); } };
  t.after(() => { view.dispose(); dom.window.close(); }); return ctx;
}
function assertEnglishSystem(document) {
  const walker = document.createTreeWalker(document.body, document.defaultView.NodeFilter.SHOW_TEXT);
  const leftovers = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement.closest("script, style, textarea, noscript, [data-locale-select]")) continue;
    if (/\p{Script=Han}/u.test(node.data)) leftovers.push(`${node.parentElement.tagName}#${node.parentElement.id}: ${node.data}`);
  }
  for (const node of document.querySelectorAll("*")) for (const name of ["aria-label", "title", "placeholder", "label"]) {
    if (node.closest("[data-locale-select]")) continue;
    if (/\p{Script=Han}/u.test(node.getAttribute(name) || "")) leftovers.push(`${node.tagName}#${node.id}[${name}]: ${node.getAttribute(name)}`);
  }
  assert.deepEqual(leftovers, []);
}

test("English covers new dynamic cards, attention, reader, calendar, time zones, feedback, and errors", async (t) => {
  const ctx = await setup(t, { locale: "en" });
  assertEnglishSystem(ctx.document);
  assert.equal(ctx.byId("count").textContent, "1 / 1 task");
  assert.equal(ctx.byId("project-count").textContent, "1 project");
  ctx.byId("view-next").click(); assertEnglishSystem(ctx.document);
  ctx.document.querySelector("[data-edit-task]").click(); assertEnglishSystem(ctx.document);
  ctx.view.reportError("保存到本机失败。输入已保留，请重试。"); assertEnglishSystem(ctx.document);
  ctx.byId("task-read-edit").click(); assertEnglishSystem(ctx.document);
  ctx.byId("editor-close").click();
  ctx.byId("view-today").click(); assertEnglishSystem(ctx.document);
  const zone = ctx.byId("display-time-zone"); const optionNodes = [...zone.options]; const value = zone.value;
  ctx.view.setLocale("zh"); ctx.view.setLocale("en");
  assert.deepEqual([...zone.options], optionNodes); assert.equal(zone.value, value); assertEnglishSystem(ctx.document);
  ctx.document.querySelector('[data-session-action="feedback"]').click(); assertEnglishSystem(ctx.document);
  assert.equal(ctx.byId("language-schedule").closest("[inert]"), null);
  ctx.change(ctx.byId("session-outcome"), "not_completed");
  ctx.document.querySelector('[data-feedback-reason="时间不够"]').click();
  assert.equal(ctx.byId("session-feedback").value, "Not enough time");
});

test("English filter labels, chips, and ARIA update in place while source names stay raw", async (t) => {
  const ctx = await setup(t, { locale: "en", width: 1200 });
  ctx.change(ctx.byId("project-filter"), id(1));
  ctx.change(ctx.byId("status-filter"), "in_progress");
  ctx.change(ctx.byId("source-filter"), JSON.stringify("Notes"));
  const summary = ctx.byId("filter-summary");
  assert.match(summary.textContent, /In progress.*Notes/); assert.doesNotMatch(summary.textContent, /\[object Object\]/);
  assertEnglishSystem(ctx.document);
  const chips = [...ctx.document.querySelectorAll("[data-clear-filter]")]; const selects = [...ctx.document.querySelectorAll("select")];
  ctx.view.setLocale("zh"); ctx.view.setLocale("en");
  assert.deepEqual([...ctx.document.querySelectorAll("[data-clear-filter]")], chips); assert.deepEqual([...ctx.document.querySelectorAll("select")], selects);
  assert.match(chips.find((node) => node.dataset.clearFilter === "source").getAttribute("aria-label"), /Notes/);
  assertEnglishSystem(ctx.document); assert.equal(ctx.calls.length, 0); assert.equal(ctx.reads, 0);
});

test("language switching keeps dictionary-shaped user content, focused controls, dirty drafts, and pending request arguments", async (t) => {
  const ctx = await setup(t, { user: true, mutate: async () => { throw new Error("Lost response"); } });
  ctx.document.querySelector("[data-edit-task]").click();
  const status = ctx.byId("task-read-quick-status"); status.focus();
  const controls = [...ctx.document.querySelectorAll("input,select,textarea,button")];
  ctx.view.setLocale("en");
  assert.equal(ctx.document.activeElement, status); assert.deepEqual([...ctx.document.querySelectorAll("input,select,textarea,button")], controls);
  assert.equal(ctx.byId("task-read-title").textContent, "已完成"); assert.equal(ctx.byId("task-read-step").textContent, "编辑"); assert.equal(ctx.byId("task-read-blocker").textContent, "已完成");
  assert.equal(ctx.byId("task-read-source").textContent, "Manual record · Source: 未填写");
  ctx.change(status, "completed"); await tick();
  assert.equal(ctx.calls.length, 1); const original = structuredClone(ctx.calls[0]);
  const pendingControls = [...ctx.document.querySelectorAll("input,select,textarea,button")]; const reads = ctx.reads;
  ctx.view.setLocale("zh"); ctx.view.setLocale("en");
  assert.deepEqual([...ctx.document.querySelectorAll("input,select,textarea,button")], pendingControls);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.reads, reads); assert.equal(ctx.byId("task-read-quick-status"), status);
  assert.match(ctx.byId("editor-error").textContent, /could not be confirmed|Connection error/);
  const notice = ctx.document.querySelector(".field-save-notice");
  assert.match(notice.firstElementChild.textContent, /^已完成: The save result needs confirmation; retry the original request\.$/);
  ctx.byId("action-retry").click(); await tick(); assert.deepEqual(ctx.calls[1], original);
});

test("English instant-field notices cover saving and uncertain receipts without changing the retained request", async (t) => {
  let rejectWrite;
  const ctx = await setup(t, { locale: "en", mutate: () => new Promise((resolve, reject) => { rejectWrite = reject; }) });
  ctx.document.querySelector("[data-edit-task]").click();
  const status = ctx.byId("task-read-quick-status"); ctx.change(status, "completed");
  assert.equal(ctx.calls.length, 1); const request = structuredClone(ctx.calls[0]);
  const saving = ctx.document.querySelector(".field-save-notice");
  assert.equal(saving.firstElementChild.textContent, "Example task: Saving…"); assertEnglishSystem(ctx.document);
  const savingNodes = [...saving.querySelectorAll("*")];
  ctx.view.setLocale("zh"); ctx.view.setLocale("en");
  assert.deepEqual([...saving.querySelectorAll("*")], savingNodes); assert.deepEqual(ctx.calls[0], request); assert.equal(ctx.reads, 0);
  assertEnglishSystem(ctx.document);
  rejectWrite(new Error("Lost response")); await tick();
  const uncertain = ctx.document.querySelector(".field-save-notice");
  assert.equal(uncertain.firstElementChild.textContent, "Example task: The save result needs confirmation; retry the original request.");
  assertEnglishSystem(ctx.document);
  const uncertainNodes = [...uncertain.querySelectorAll("*")];
  ctx.view.setLocale("zh"); ctx.view.setLocale("en");
  assert.deepEqual([...uncertain.querySelectorAll("*")], uncertainNodes); assert.equal(ctx.calls.length, 1); assert.equal(ctx.reads, 0); assert.equal(status.value, "completed");
  assert.deepEqual(ctx.calls[0], request); assertEnglishSystem(ctx.document);
});

test("English instant-field notices cover CAS and same-field conflicts after refresh", async (t) => {
  const ctx = await setup(t, { locale: "en", mutate: async (request, board) => {
    board.tasks[0].priority = "low"; board.revision += 1;
    return { isError: true, structuredContent: { ok: false, error: { code: "REVISION_CONFLICT", message: "Concurrent change" }, board: structuredClone(board) } };
  } });
  ctx.document.querySelector("[data-edit-task]").click(); ctx.change(ctx.byId("task-read-quick-priority"), "urgent"); await tick();
  assert.equal(ctx.document.querySelector(".field-save-notice").firstElementChild.textContent, "Example task: Records changed. Refresh and check them.");
  assertEnglishSystem(ctx.document); const request = structuredClone(ctx.calls[0]);
  await ctx.view.refresh();
  const notice = ctx.document.querySelector(".field-save-notice");
  assert.equal(notice.firstElementChild.textContent, "Example task: The same field changed. Confirm which value to keep."); assertEnglishSystem(ctx.document);
  const controls = [...notice.querySelectorAll("*")]; const reads = ctx.reads;
  ctx.view.setLocale("zh"); ctx.view.setLocale("en");
  assert.deepEqual([...notice.querySelectorAll("*")], controls); assert.equal(ctx.reads, reads); assert.equal(ctx.calls.length, 1); assert.deepEqual(ctx.calls[0], request);
  assert.equal(ctx.byId("task-read-quick-priority").value, "urgent"); assertEnglishSystem(ctx.document);
});

test("English instant-field notices cover expired receipts while keeping writes and review controls intact", async (t) => {
  const ctx = await setup(t, { locale: "en", mutate: async () => ({ isError: true, structuredContent: { ok: false, error: { code: "REQUEST_EXPIRED", message: "Expired receipt" } } }) });
  ctx.document.querySelector("[data-edit-task]").click(); ctx.change(ctx.byId("task-read-quick-status"), "completed"); await tick();
  const notice = ctx.document.querySelector(".field-save-notice");
  assert.equal(notice.firstElementChild.textContent, "Example task: The request expired. Refresh and check the records, then end this retry.");
  assert.equal(notice.querySelector('[data-field-action="dismiss"]').disabled, true); assert.equal(ctx.byId("expired-end").disabled, true); assertEnglishSystem(ctx.document);
  const controls = [...notice.querySelectorAll("*")]; const request = structuredClone(ctx.calls[0]);
  ctx.view.setLocale("zh"); ctx.view.setLocale("en");
  assert.deepEqual([...notice.querySelectorAll("*")], controls); assert.deepEqual(ctx.calls[0], request); assert.equal(ctx.calls.length, 1); assert.equal(ctx.reads, 0);
  assert.equal(ctx.byId("expired-end").disabled, true); assertEnglishSystem(ctx.document);
});

test("confirmed instant saves keep undo reachable and use the original field CAS after language switching", async (t) => {
  const ctx = await setup(t); ctx.document.querySelector("[data-edit-task]").click();
  const priority = ctx.byId("task-read-quick-priority"); ctx.change(priority, "urgent"); await tick();
  const undo = ctx.document.querySelector('[data-field-action="undo"]'); assert.ok(undo);
  priority.focus(); const before = structuredClone(ctx.calls[0]); const revision = ctx.board.revision;
  ctx.view.setLocale("en"); assert.equal(ctx.document.activeElement, priority); assert.equal(ctx.document.querySelector('[data-field-action="undo"]'), undo);
  assert.equal(undo.textContent, "Undo Priority"); assert.deepEqual(ctx.calls[0], before);
  undo.click(); await tick(); assert.equal(ctx.calls.length, 2);
  assert.equal(ctx.calls[1].expectedRevision, revision); assert.deepEqual(ctx.calls[1].operation, { type: "patch_task", taskId: id(2), patch: { priority: "high" } });
});

test("the editor language selector preserves a dirty draft and an uncertain full-save receipt", async (t) => {
  const ctx = await setup(t, { mutate: async () => { throw new Error("Lost response"); } });
  ctx.document.querySelector("[data-edit-task]").click(); ctx.byId("task-read-edit").click();
  const form = ctx.byId("task-form"); const draft = ctx.byId("task-step");
  draft.value = "编辑 user draft"; draft.dispatchEvent(new ctx.dom.window.Event("input", { bubbles: true }));
  draft.focus(); draft.setSelectionRange(2, 8, "backward");
  const controls = [...form.querySelectorAll("input,select,textarea")];
  const values = controls.map((node) => [node.value, node.checked]);
  ctx.change(ctx.byId("language-editor"), "en");
  assert.equal(ctx.document.activeElement, draft); assert.equal(draft.selectionStart, 2); assert.equal(draft.selectionEnd, 8); assert.equal(draft.selectionDirection, "backward");
  assert.deepEqual([...form.querySelectorAll("input,select,textarea")], controls); assert.deepEqual(controls.map((node) => [node.value, node.checked]), values);
  assert.equal(ctx.calls.length, 0); assert.equal(ctx.reads, 0); assert.match(form.querySelector("[data-editor-save-status]").textContent, /Unsaved changes/);
  form.querySelector('[type="submit"]').click(); await tick();
  const receipt = structuredClone(ctx.calls[0]); assert.equal(ctx.calls.length, 1);
  ctx.change(ctx.byId("language-editor"), "zh"); ctx.change(ctx.byId("language-editor"), "en");
  assert.equal(ctx.calls.length, 1); assert.deepEqual(controls.map((node) => [node.value, node.checked]), values);
  form.querySelector('[type="submit"]').click(); await tick(); assert.deepEqual(ctx.calls[1], receipt);
});

test("English Codex projection and diagnostics translate generated labels while preserving source fields", async (t) => {
  const ctx = await setup(t, { locale: "en", width: 1024 }); const snapshot = snapshotFixture(); const before = structuredClone(snapshot);
  const codex = mountCodex(ctx.document, { locale: "en", now: () => at, setTimeout: () => 1, clearTimeout() {} }); t.after(() => codex.dispose());
  ctx.view.setCodexSnapshot(snapshot); codex.acceptReadResult({ structuredContent: { ok: true, snapshot } }); assertEnglishSystem(ctx.document);
  const card = ctx.document.querySelector('[data-origin="codex"].task-card'); assert.equal(card.querySelector(".task-title").textContent, "Codex user title");
  assert.equal(card.querySelector(".status").textContent, "Running"); assert.equal(card.querySelector(".card-step").textContent, "Running");
  ctx.view.setLocale("zh"); ctx.view.setLocale("en"); assertEnglishSystem(ctx.document); assert.deepEqual(snapshot, before);
});

test("copying the readonly learning prompt uses the current language without changing its value on a toggle", async (t) => {
  const ctx = await setup(t); ctx.byId("view-today").click();
  const prompt = ctx.byId("learning-prompt"); const old = prompt.value;
  ctx.view.setLocale("en"); assert.equal(prompt.value, old);
  ctx.byId("learning-prompt-copy").click(); await tick();
  assert.match(ctx.copied[0], /^Use learning_board_context/); assert.doesNotMatch(ctx.copied[0], /\p{Script=Han}/u);
  assert.match(ctx.copied[0], /learning_board_plan/); assert.equal(ctx.calls.length, 0);
});

test("stored language and denied storage both work with real mounted UI in independent documents", async (t) => {
  const first = await setup(t); const second = await setup(t);
  Object.defineProperty(first.dom.window, "localStorage", { configurable: true, get() { throw new Error("Denied"); } });
  first.view.setLocale("en"); assert.equal(first.byId("language-main").value, "en"); assert.equal(second.byId("language-main").value, "zh");
  assert.equal(second.dom.window.localStorage.getItem(LOCALE_PREFERENCE_KEY), null);
  assert.equal(i18nFor(first.document).locale, "en"); assert.equal(first.calls.length, 0);
});
