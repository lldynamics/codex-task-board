import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { emptyBoard } from "../src/board.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2030-10-05T00:00:00.000Z";

async function setup(t, viewMode = "board") {
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://schedule-layout.invalid/" });
  t.after(() => dom.window.close());
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode }));
  const board = {
    ...emptyBoard(), revision: 1,
    projects: [{ id: projectId, name: "学习", description: "", lastUpdatedAt: timestamp }],
    tasks: [{ id: taskId, projectId, title: "阅读与练习", status: "planned", sourceTool: "手动", currentStep: "", blocker: "", conversationUrl: null, lastUpdatedAt: timestamp }],
  };
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: () => timestamp,
    mutate: async () => { throw new Error("This navigation test must not write records"); },
    refresh: async () => ({ structuredContent: { ok: true, board } }),
  }));
  view.setHostState({ connected: true, message: "测试宿主" });
  assert.equal(view.acceptReadResult({ structuredContent: { ok: true, board } }), true);
  return { document: dom.window.document, byId: (id) => dom.window.document.getElementById(id) };
}

test("calendar views expose their session action and restore the task action on every task view", async (t) => {
  const ctx = await setup(t);
  for (const mode of ["today", "week", "board", "list", "today", "next", "week", "list"]) {
    ctx.byId(mode === "next" ? "sidebar-next" : `view-${mode}`).click();
    const calendar = ["today", "week"].includes(mode);
    assert.equal(ctx.byId("new-task").hidden, calendar, `${mode}: task action visibility`);
    assert.equal(ctx.byId("schedule-toolbar").hidden, !calendar, `${mode}: calendar actions visibility`);
    assert.equal(ctx.byId(calendar ? "new-session" : "new-task").disabled, false, `${mode}: primary action remains available`);
  }
  ctx.byId("new-task").click();
  assert.equal(ctx.byId("task-form").hidden, false, "Task view still supports creating a task");
});

test("restored calendar preferences hide the task action before interaction and expose a session shortcut", async (t) => {
  for (const mode of ["today", "week"]) {
    const ctx = await setup(t, mode);
    assert.equal(ctx.byId("new-task").hidden, true);
    assert.equal(ctx.byId(`view-${mode}`).getAttribute("aria-pressed"), "true");
    assert.equal(ctx.byId("new-session").getAttribute("aria-keyshortcuts"), "N");
    ctx.byId("new-session").click();
    assert.equal(ctx.byId("schedule-panel").hidden, false);
    assert.equal(ctx.byId("session-editor-title").textContent, "新增学习时段");
    assert.equal(ctx.byId("session-context").hidden, true, "Feedback context does not appear in a new-session form");
  }
});
