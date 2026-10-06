import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { boardSchema, emptyBoard } from "../src/board.mjs";
import { createI18n } from "../src/i18n.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";

const at = "2026-10-04T12:00:00.000Z";
const projectId = "11111111-1111-4111-8111-111111111111";
const board = (revision, titles) => boardSchema.parse({
  ...emptyBoard(), revision, projects: [{ id: projectId, name: "项目", description: "", lastUpdatedAt: at }],
  tasks: titles.map((title, index) => ({ id: `33333333-3333-4333-8333-33333333333${index}`, projectId, title, status: "planned", sourceTool: "Codex", currentStep: "", blocker: "", lastUpdatedAt: at, conversationUrl: null })),
});
const wait = async (predicate) => { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(predicate()); };

async function mount(server, boardPollMs = 20) {
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://board.test/", pretendToBeVisual: true });
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "board" }));
  const document = dom.window.document;
  createI18n(document, { locale: "zh" });
  let reads = 0;
  const refresh = async () => { reads += 1; return { content: [], structuredContent: { ok: true, board: structuredClone(server.board) } }; };
  const view = mountBoard(document, emptyBoard(), { refresh, mutate: async () => { throw new Error("unused"); }, data: async () => ({}), boardPollMs });
  view.setHostState({ connected: true, message: "已连接" });
  await view.refresh();
  return { dom, document, view, reads: () => reads };
}
const titles = (document) => [...document.querySelectorAll(".task-title")].map((node) => node.textContent);

test("an idle visible board picks up a task Codex recorded through the model tool", async () => {
  const server = { board: board(1, ["已有任务"]) };
  const ctx = await mount(server);
  try {
    assert.deepEqual(titles(ctx.document), ["已有任务"]);
    server.board = board(2, ["已有任务", "Codex 新记录"]);
    await wait(() => titles(ctx.document).includes("Codex 新记录"));
  } finally { ctx.view.dispose(); ctx.dom.window.close(); }
});

test("background checks never replace the board while a task editor is open", async () => {
  const server = { board: board(1, ["已有任务"]) };
  const ctx = await mount(server);
  try {
    ctx.document.querySelector("[data-edit-task]").click();
    server.board = board(2, ["已有任务", "暂不显示"]);
    const before = ctx.reads();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!titles(ctx.document).includes("暂不显示"));
    assert.equal(ctx.reads(), before, "No read is issued while the editor is open");
  } finally { ctx.view.dispose(); ctx.dom.window.close(); }
});

test("a restore blocked by hidden overlapping sessions names both sessions", async () => {
  const archivedId = "33333333-3333-4333-8333-333333333330", activeId = "33333333-3333-4333-8333-333333333331";
  const base = board(5, ["已归档任务", "当前任务"]);
  base.tasks[0].archivedAt = at;
  const slot = (id, taskId) => ({ id, taskId, startAt: "2099-01-01T01:00:00.000Z", endAt: "2099-01-01T02:00:00.000Z", timeZone: "Asia/Shanghai", status: "scheduled", objective: "", completionCriteria: "", feedback: "", actualMinutes: null, lastUpdatedAt: at });
  base.sessions = [slot("44444444-4444-4444-8444-444444444440", archivedId), slot("44444444-4444-4444-8444-444444444441", activeId)];
  const server = { board: boardSchema.parse(base) };
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://board.test/" });
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "board", timeZone: "Asia/Shanghai" }));
  const document = dom.window.document;
  createI18n(document, { locale: "zh" });
  const mutate = async () => ({ isError: true, content: [], structuredContent: { ok: false, error: { code: "SCHEDULE_CONFLICT", message: "conflict" }, board: structuredClone(server.board) } });
  const view = mountBoard(document, emptyBoard(), { refresh: async () => ({ content: [], structuredContent: { ok: true, board: structuredClone(server.board) } }), mutate, data: async () => ({}) });
  try {
    view.setHostState({ connected: true, message: "已连接" });
    await view.refresh();
    const filter = document.getElementById("archive-filter");
    filter.value = "archived"; filter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    document.querySelector(`[data-archive-task="${archivedId}"]`).click();
    await wait(() => /会重叠/.test(document.getElementById("save-status").textContent + document.body.textContent));
    const text = document.body.textContent;
    assert.match(text, /「已归档任务」2099-01-01 09:00–10:00 与「当前任务」2099-01-01 09:00–10:00 的学习时段会重叠/);
  } finally { view.dispose(); dom.window.close(); }
});
