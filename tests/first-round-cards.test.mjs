import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { boardSchema, emptyBoard } from "../src/board.mjs";
import { mountBoard } from "../src/view.mjs";
import { createCodexBoard, DISPLAY_COLUMN_ORDER } from "../src/view-codex-board.mjs";
import { createViewState } from "../src/view-state.mjs";
import { projectCodexSnapshot } from "../src/codex-board.mjs";
import { codexSnapshotSchema, unavailableCodexSnapshot } from "../src/codex-domain.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { tick } from "./helpers.mjs";

const timestamp = "2030-10-05T04:00:00.000Z";
const id = (number) => `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
const mainStatuses = ["planned", "in_progress", "waiting_user", "completed", "paused", "failed"];
const secondaryStatuses = ["idle", "not_loaded", "unknown", "turn_ended"];
const thread = (number, fields = {}) => ({ id: id(number), hostId: "local", title: `自动任务 ${number}`, cwd: "/workspace/project", updatedAt: timestamp, runtimeStatus: "unknown", attention: null, lastTurnStatus: null, goalStatus: null, ...fields });
function snapshot(threads, observedAt = timestamp) {
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null };
  return codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(observedAt), connection: { state: "connected", source: "desktop-snapshot", lastSuccessAt: timestamp, error: null, scope: "测试范围" }, sources: { threads: source, automations: { ...source } }, completeness: { threads: true, automations: true, truncated: false }, threads });
}
function manualBoard() {
  return boardSchema.parse({ ...emptyBoard(), projects: [{ id: id(90), name: "手工项目", description: "", lastUpdatedAt: timestamp }], tasks: mainStatuses.map((status, index) => ({ id: id(100 + index), projectId: id(90), title: `手工任务 ${index}`, status, sourceTool: "Codex", currentStep: "整理材料", blocker: "等待资料", priority: "high", dueDate: "2030-10-04", conversationUrl: null, lastUpdatedAt: timestamp })) });
}
async function setup(t, initial = manualBoard()) {
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://first-round.test/", pretendToBeVisual: true });
  const calls = [], opened = [], copied = [];
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (value) => copied.push(value) } });
  // These cases exercise the explicit board layout, independently of the landing view.
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "board" }));
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, initial, { now: () => Date.parse(timestamp), setTimeout: () => 1, clearTimeout() {},
    openThread: async (threadId, hostId) => { opened.push({ threadId, hostId }); return {}; },
    mutate: async (request) => { calls.push(request); return { isError: true }; },
  }));
  view.setHostState({ connected: true, message: "测试宿主" });
  view.setBoard(initial);
  t.after(() => { view.dispose(); dom.window.close(); });
  const document = dom.window.document;
  return { dom, document, view, calls, opened, copied, byId: (value) => document.getElementById(value),
    card: (taskId) => document.querySelector(`[data-task-id="${taskId}"]`),
    other: () => document.querySelector("[data-other-statuses]"),
    change(field, value) { const node = document.getElementById(field); node.value = value; node.dispatchEvent(new dom.window.Event(field === "search" ? "input" : "change", { bubbles: true })); },
    setSnapshot(value) { assert.equal(view.setCodexSnapshot(value), true); return projectCodexSnapshot(value, { now: Date.parse(timestamp) }); },
  };
}
const statusValues = (root) => [...root.querySelectorAll(".kanban-column")].map((column) => column.dataset.status);

test("displayColumns returns the complete status order while manual-only boards retain their six columns", (t) => {
  const dom = new JSDOM("<!doctype html><div id=cards></div>"); t.after(() => dom.window.close());
  const state = createViewState(manualBoard());
  const project = { id: "automatic", origin: "codex" };
  state.codex.projection.projects = [project];
  const refs = { projectFilter: { value: "all" } };
  const board = createCodexBoard({ document: dom.window.document, state, options: {}, refs, callbacks: {} });
  t.after(() => board.disposeCodexBoard());
  const automatic = secondaryStatuses.map((status) => ({ id: status, projectId: project.id, status, origin: "codex", readOnly: true }));
  assert.deepEqual(board.displayColumns(state.board.tasks), mainStatuses);
  assert.deepEqual(board.displayColumns([...state.board.tasks, ...automatic]), [...mainStatuses, ...secondaryStatuses]);
  assert.deepEqual(DISPLAY_COLUMN_ORDER, [...mainStatuses, ...secondaryStatuses]);
  refs.projectFilter.value = project.id;
  assert.deepEqual(board.displayColumns(automatic), secondaryStatuses);
});

test("mixed boards keep the primary workflow consecutive and count each separate secondary state", async (t) => {
  const ctx = await setup(t);
  const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "idle" }), thread(2, { runtimeStatus: "notLoaded" }), thread(3), thread(4, { lastTurnStatus: "completed" }), thread(5, { goalStatus: "complete" })]));
  assert.deepEqual(statusValues(ctx.document.querySelector(".board-main-columns")), mainStatuses);
  assert.deepEqual(statusValues(ctx.document.querySelector(".board-secondary-columns")), secondaryStatuses);
  assert.equal(ctx.other().open, false);
  assert.equal(ctx.other().querySelector(".secondary-status-count").textContent, "4 项");
  assert.equal(ctx.other().querySelector(".secondary-status-breakdown").textContent, "空闲 1 · 未加载 1 · 状态未知 1 · 本轮结束 1");
  const ended = projection.tasks.find((task) => task.threadId === id(4));
  const completed = projection.tasks.find((task) => task.threadId === id(5));
  assert.equal(ctx.card(ended.id).closest(".kanban-column").dataset.status, "turn_ended");
  assert.equal(ctx.card(completed.id).closest(".kanban-column").dataset.status, "completed");
  ctx.change("project-filter", id(90));
  assert.equal(ctx.other(), null);
  assert.deepEqual(statusValues(ctx.byId("cards")), mainStatuses);
  assert.deepEqual(ctx.calls, []);
});

test("search, explicit status, source and automatic projects expose every matching secondary card", async (t) => {
  const ctx = await setup(t);
  const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "idle" }), thread(2, { runtimeStatus: "notLoaded" }), thread(3), thread(4, { lastTurnStatus: "completed" })]));
  for (const status of secondaryStatuses) {
    ctx.change("status-filter", status);
    assert.equal(ctx.other().open, true);
    assert.deepEqual(statusValues(ctx.byId("cards")), [status]);
    assert.equal(ctx.document.querySelectorAll("#cards [data-task-id]").length, 1);
  }
  ctx.byId("clear").click();
  ctx.change("search", "/workspace/project");
  assert.equal(ctx.other().open, true);
  assert.equal(ctx.other().querySelector(".secondary-status-count").textContent, "4 项");
  assert.equal(ctx.document.querySelectorAll("#cards [data-task-id]").length, 4);
  ctx.byId("clear").click(); ctx.change("record-filter", "codex");
  assert.equal(ctx.other().open, true);
  ctx.byId("clear").click(); ctx.change("project-filter", projection.projects[0].id);
  assert.equal(ctx.other().open, true);
  assert.deepEqual(statusValues(ctx.byId("cards")), secondaryStatuses);
  assert.deepEqual(ctx.calls, []);
});

test("user expansion and secondary summary focus survive changed snapshots and list mode keeps flat columns", async (t) => {
  const ctx = await setup(t); const value = snapshot([thread(1, { runtimeStatus: "idle" })]);
  ctx.setSnapshot(value);
  const summary = ctx.other().querySelector("summary"); summary.click(); summary.focus();
  ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "idle", title: "更新后的空闲任务" })], "2030-10-05T04:00:01.000Z"));
  assert.equal(ctx.other().open, true);
  assert.equal(ctx.document.activeElement, ctx.other().querySelector("summary"));
  ctx.byId("view-list").click();
  assert.equal(ctx.other(), null);
  assert.deepEqual(statusValues(ctx.byId("cards")), [...mainStatuses, "idle"]);
  ctx.byId("view-board").click();
  assert.equal(ctx.other().open, true);
  ctx.other().querySelector("summary").click();
  ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "idle", title: "再次更新" })], "2030-10-05T04:00:02.000Z"));
  assert.equal(ctx.other().open, false);
});

test("secondary columns retain pagination and an explicit search can reveal records beyond the first page", async (t) => {
  const ctx = await setup(t);
  const threads = Array.from({ length: 70 }, (_, index) => thread(index + 1, { runtimeStatus: "idle", title: `空闲任务 ${String(index + 1).padStart(3, "0")}` }));
  const projection = ctx.setSnapshot(snapshot(threads));
  ctx.other().querySelector("summary").click();
  ctx.document.querySelector('[data-status="idle"] [data-page-control="next"]').click();
  assert.equal(ctx.other().open, true);
  assert.equal(ctx.document.querySelector('[data-status="idle"]').dataset.page, "1");
  assert.equal(ctx.document.querySelector('[data-status="idle"] .page-count').textContent, "51–70/70");
  ctx.setSnapshot(snapshot(threads.map((item) => item.id === id(1) ? { ...item, title: "更新的第一页任务" } : item), "2030-10-05T04:00:01.000Z"));
  assert.equal(ctx.document.querySelector('[data-status="idle"]').dataset.page, "1");
  const last = projection.tasks.find((task) => task.threadId === id(70));
  ctx.change("search", "空闲任务 070");
  assert.equal(ctx.other().open, true); assert.ok(ctx.card(last.id));
  assert.equal(ctx.document.querySelectorAll('#cards [data-origin="codex"]').length, 1);
  assert.deepEqual(ctx.calls, []);
});

test("manual Codex records have a manual badge and important content; automatic metadata stays safe and accessible", async (t) => {
  const ctx = await setup(t);
  const hostId = `remote-${"很长的主机名称".repeat(8)}`;
  const cwd = '/workspace/<img src=x onerror="alert(1)">';
  const title = '<script>alert("title")</script>';
  const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "active", title, hostId, cwd })]));
  const manual = ctx.card(id(100));
  assert.equal(manual.dataset.origin, "manual");
  assert.equal(manual.querySelector(".origin-badge-manual").textContent, "手工记录");
  assert.equal(manual.querySelector(".source-tag").textContent, "来源：Codex");
  assert.equal(manual.querySelector(".card-step").textContent, "整理材料");
  assert.equal(manual.querySelector(".card-blocker").textContent, "等待资料");
  assert.ok(manual.querySelector(".task-labels > .card-date"));
  assert.equal(manual.querySelector(".card-date").dateTime, "2030-10-04");
  assert.match(manual.querySelector(".card-date").getAttribute("aria-label"), /已逾期/);
  const task = projection.tasks[0], card = ctx.card(task.id), details = card.querySelector("[data-card-source-details]");
  assert.equal(card.querySelector(".task-title").textContent, title);
  assert.equal(card.querySelectorAll("script,img").length, 0);
  assert.equal(details.open, false);
  assert.ok(!card.querySelector(".card-footer").textContent.includes(cwd));
  assert.ok(!card.querySelector(".card-footer").textContent.includes(id(1)));
  assert.equal(Array.from(card.querySelector(".source-host").textContent.replace("主机：", "")).length, 20);
  assert.ok(details.textContent.includes(hostId)); assert.ok(details.textContent.includes(cwd)); assert.ok(details.textContent.includes(id(1)));
  assert.equal(card.querySelector(".card-date").dateTime, timestamp);
  // Card times follow the display zone, which defaults to the machine's zone.
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(timestamp));
  const dateLabel = card.querySelector(".card-date").getAttribute("aria-label");
  assert.ok(dateLabel.includes(`（${zone}）`) && dateLabel.includes(clock), dateLabel);
  assert.equal(card.draggable, false);
  assert.equal(card.querySelectorAll("[data-edit-task],[data-move-control],[data-archive-task],[data-quick-task],[data-session-id]").length, 0);
  card.querySelector("[data-codex-task-open]").click(); details.querySelector("summary").click(); details.querySelector("[data-codex-task-copy]").click();
  await tick();
  assert.deepEqual(ctx.opened, [{ threadId: id(1), hostId }]); assert.deepEqual(ctx.copied, [id(1)]); assert.deepEqual(ctx.calls, []);
});

test("source detail expansion and copy focus survive status moves into the secondary region", async (t) => {
  const ctx = await setup(t);
  const projection = ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "active" })]));
  const taskId = projection.tasks[0].id;
  let details = ctx.card(taskId).querySelector("[data-card-source-details]");
  details.querySelector("summary").focus();
  ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "active", title: "标题变化" })], "2030-10-05T04:00:01.000Z"));
  details = ctx.card(taskId).querySelector("[data-card-source-details]");
  assert.equal(details.open, false);
  assert.equal(ctx.document.activeElement, details.querySelector("summary"));
  details.querySelector("summary").click(); details.querySelector("[data-codex-task-copy]").focus();
  ctx.setSnapshot(snapshot([thread(1, { runtimeStatus: "idle" })], "2030-10-05T04:00:02.000Z"));
  details = ctx.card(taskId).querySelector("[data-card-source-details]");
  assert.equal(details.open, true); assert.equal(ctx.other().open, true);
  assert.equal(ctx.document.activeElement, details.querySelector("[data-codex-task-copy]"));
  ctx.byId("view-list").click();
  assert.equal(ctx.card(taskId).querySelector("[data-card-source-details]").open, true);
  ctx.document.querySelector('[data-toggle-column="idle"]').click();
  assert.equal(ctx.card(taskId), null);
  ctx.document.querySelector('[data-toggle-column="idle"]').click();
  assert.equal(ctx.card(taskId).querySelector("[data-card-source-details]").open, true);
  ctx.change("project-filter", id(90));
  assert.equal(ctx.card(taskId), null);
  ctx.change("project-filter", projection.projects[0].id);
  assert.equal(ctx.card(taskId).querySelector("[data-card-source-details]").open, true);
  assert.deepEqual(ctx.calls, []);
});

test("deadline badges use the same display-zone civil date as attention reasons", async (t) => {
  const board = manualBoard();
  board.tasks = [{ ...board.tasks[0], dueDate: "2030-10-04" }];
  const ctx = await setup(t, board);
  ctx.change("display-time-zone", "America/Los_Angeles");
  ctx.byId("sidebar-next").click();
  let date = ctx.card(board.tasks[0].id).querySelector(".card-date");
  assert.equal(date.classList.contains("due-overdue"), false);
  assert.equal(date.getAttribute("aria-label"), "截止日期：2030-10-04");
  assert.match(ctx.card(board.tasks[0].id).querySelector(".task-attention-reason").textContent, /今日到期/);
  ctx.change("display-time-zone", "Asia/Shanghai");
  date = ctx.card(board.tasks[0].id).querySelector(".card-date");
  assert.equal(date.classList.contains("due-overdue"), true);
  assert.equal(date.getAttribute("aria-label"), "截止日期：2030-10-04（已逾期）");
  assert.match(ctx.card(board.tasks[0].id).querySelector(".task-attention-reason").textContent, /已逾期/);
  assert.deepEqual(ctx.calls, []);
});
