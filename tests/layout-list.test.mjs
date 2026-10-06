import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { emptyBoard } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { codexSnapshotSchema, unavailableCodexSnapshot } from "../src/codex-domain.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";

const wrap = (structuredContent) => ({ structuredContent, ...(structuredContent.ok ? {} : { isError: true }) });
const writableTask = ({ id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl }) => ({ id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl });

async function setup(t, { mutate } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "task-board-layout-list-"));
  const store = createFileStore(directory);
  const read = async () => { const result = await store.read(); assert.equal(result.ok, true); return result.board; };
  const commit = async (operation) => {
    const result = await store.mutate({ requestId: randomUUID(), expectedRevision: (await read()).revision, operation });
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
  };
  const projectId = (await commit({ type: "save_project", project: { name: "紧凑列表项目", description: "仅隔离测试" } })).entityId;
  const ids = [];
  for (const title of ["第一项任务", "第二项任务"]) ids.push((await commit({ type: "save_task", task: {
    projectId, title, status: "planned", priority: "normal", dueDate: "2030-10-06", sourceTool: "个人笔记",
    currentStep: "详情中的步骤", blocker: "详情中的阻塞", conversationUrl: null,
  } })).entityId);
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://layout-list.invalid/", pretendToBeVisual: true });
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "list" }));
  const calls = [];
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: () => Date.parse("2030-10-05T04:00:00.000Z"),
    mutate: async (request) => { calls.push(structuredClone(request)); return mutate ? mutate(request, perform, calls.length) : perform(request); },
    refresh: async () => wrap(await store.read()),
  }));
  t.after(async () => { view.dispose(); dom.window.close(); await rm(directory, { recursive: true, force: true }); });
  view.setHostState({ connected: true, message: "隔离测试宿主" });
  view.acceptReadResult(wrap(await store.read()));
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  const card = (id = ids[0]) => document.querySelector(`[data-task-id="${id}"]`);
  const quick = (selector, id = ids[0]) => card(id)?.querySelector(selector);
  const stage = (field, value, id = ids[0]) => {
    if (quick("[data-quick-panel]", id).hidden) quick("[data-quick-toggle]", id).click();
    const control = quick(`[data-quick-field="${field}"]`, id);
    assert.equal(control.disabled, false); control.value = value;
    control.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const settle = async () => {
    const deadline = Date.now() + 5000;
    while (byId("refresh").disabled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(byId("refresh").disabled, false);
  };
  const disk = async () => ({ bytes: await readFile(path.join(directory, "data.json")), backups: (await readdir(path.join(directory, "backups"))).sort() });
  return { dom, document, view, calls, read, commit, ids, projectId, byId, card, quick, stage, settle, disk };
}

test("list expansion reads values without writes, save buttons or backups", async (t) => {
  const ctx = await setup(t), before = await ctx.disk();
  for (const id of ctx.ids) {
    assert.equal(ctx.card(id).classList.contains("task-list-row"), true);
    assert.equal(ctx.card(id).querySelector(".priority-normal").textContent, "普通优先级");
    const toggle = ctx.quick("[data-quick-toggle]", id), panel = ctx.quick("[data-quick-panel]", id);
    assert.equal(toggle.getAttribute("aria-expanded"), "false"); assert.equal(panel.hidden, true); assert.equal(toggle.getAttribute("aria-controls"), panel.id);
    assert.equal(panel.querySelector("[data-quick-save],[data-quick-cancel]"), null);
  }
  ctx.quick("[data-quick-toggle]").click();
  assert.equal(ctx.quick("[data-quick-panel]").hidden, false); assert.equal(ctx.document.activeElement, ctx.quick('[data-quick-field="status"]'));
  ctx.quick("[data-quick-toggle]").click(); assert.equal(ctx.quick("[data-quick-panel]").hidden, true);
  assert.deepEqual(ctx.calls, []); assert.deepEqual(await ctx.disk(), before);
});

test("row expansion moves freely between rows and Escape returns focus to its toggle", async (t) => {
  const ctx = await setup(t);
  ctx.quick("[data-quick-toggle]").click(); ctx.quick("[data-quick-toggle]", ctx.ids[1]).click();
  assert.equal(ctx.quick("[data-quick-panel]").hidden, true); assert.equal(ctx.quick("[data-quick-panel]", ctx.ids[1]).hidden, false);
  const control = ctx.quick('[data-quick-field="priority"]', ctx.ids[1]);
  const event = new ctx.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); control.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(ctx.quick("[data-quick-panel]", ctx.ids[1]).hidden, true);
  assert.equal(ctx.document.activeElement, ctx.quick("[data-quick-toggle]", ctx.ids[1])); assert.deepEqual(ctx.calls, []);
});

test("expanded row adopts notifications and each choice persists against its latest revision", async (t) => {
  const ctx = await setup(t); ctx.quick("[data-quick-toggle]").click();
  const updated = await ctx.commit({ type: "save_task", task: { ...writableTask((await ctx.read()).tasks[0]), priority: "high", currentStep: "另一窗口的新步骤" } });
  ctx.view.acceptReadResult(wrap({ ok: true, board: await ctx.read() }));
  assert.equal(ctx.quick("[data-quick-panel]").hidden, false); assert.equal(ctx.quick('[data-quick-field="priority"]').value, "high");
  ctx.stage("priority", "urgent"); await ctx.settle();
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.calls[0].expectedRevision, updated.board.revision);
  assert.deepEqual(ctx.calls[0].operation.patch, { priority: "urgent" }); assert.equal((await ctx.read()).tasks[0].currentStep, "另一窗口的新步骤");
});

test("successful choices preserve focused selects and do not lock expansion, details or subsequent actions", async (t) => {
  const ctx = await setup(t), before = await ctx.read();
  ctx.quick("[data-quick-toggle]").click(); ctx.quick('[data-quick-field="priority"]').focus();
  ctx.stage("priority", "urgent"); await ctx.settle();
  assert.equal(ctx.calls.length, 1); assert.equal((await ctx.read()).revision, before.revision + 1);
  assert.equal(ctx.quick("[data-quick-panel]").hidden, false); assert.equal(ctx.document.activeElement, ctx.quick('[data-quick-field="priority"]'));
  assert.equal(ctx.byId("new-task").disabled, false); assert.equal(ctx.card().querySelector("[data-edit-task]").disabled, false);
  ctx.quick("[data-quick-toggle]").click(); assert.equal(ctx.quick("[data-quick-panel]").hidden, true);
  ctx.quick("[data-quick-toggle]", ctx.ids[1]).click(); assert.equal(ctx.quick("[data-quick-panel]", ctx.ids[1]).hidden, false);
  ctx.byId("view-board").click(); ctx.byId("view-list").click(); assert.equal(ctx.quick("[data-quick-panel]", ctx.ids[1]).hidden, false);
});

test("status and priority selections create separate single-field commits and undo the most recent field", async (t) => {
  const ctx = await setup(t), before = await ctx.read();
  ctx.stage("status", "in_progress"); await ctx.settle(); ctx.stage("priority", "high"); await ctx.settle();
  assert.equal(ctx.calls.length, 2); assert.equal((await ctx.read()).revision, before.revision + 2);
  ctx.document.querySelector('[data-field-action="undo"]').click(); await ctx.settle();
  const task = (await ctx.read()).tasks.find((task) => task.id === ctx.ids[0]);
  assert.equal(task.priority, "normal"); assert.equal(task.status, "in_progress"); assert.deepEqual(ctx.calls[2].operation.patch, { priority: "normal" });
});

test("unknown list save can collapse its row but its request remains frozen and reachable until receipt replay", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("落盘后的响应丢失"); return result; } });
  ctx.stage("priority", "urgent"); await ctx.settle(); const committed = await ctx.disk();
  assert.equal(ctx.quick('[data-quick-field="priority"]').disabled, true);
  ctx.quick("[data-quick-toggle]").click(); assert.equal(ctx.quick("[data-quick-panel]").hidden, true);
  assert.equal(ctx.document.querySelector('[data-field-action="dismiss"]').disabled, true);
  await ctx.view.refresh(); ctx.byId("action-retry").click(); await ctx.settle();
  assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.deepEqual(await ctx.disk(), committed);
  assert.equal(ctx.quick('[data-quick-field="priority"]').disabled, false);
});

test("failed CAS keeps only its write intent and requires refreshed explicit conflict confirmation", async (t) => {
  const ctx = await setup(t);
  await ctx.commit({ type: "save_task", task: { ...writableTask((await ctx.read()).tasks[0]), priority: "high" } });
  ctx.stage("priority", "urgent"); await ctx.settle(); await ctx.view.refresh();
  assert.equal(ctx.calls.length, 1); assert.ok(ctx.document.querySelector('[data-field-action="confirm"]'));
  ctx.quick("[data-quick-toggle]").click(); assert.equal(ctx.quick("[data-quick-panel]").hidden, true);
  ctx.document.querySelector('[data-field-action="confirm"]').click(); await ctx.settle();
  assert.equal(ctx.calls.length, 2); assert.notEqual(ctx.calls[0].requestId, ctx.calls[1].requestId); assert.equal((await ctx.read()).tasks[0].priority, "urgent");
});

test("Codex list rows remain read-only and card/next modes retain their existing controls", async (t) => {
  const ctx = await setup(t), timestamp = "2030-10-05T04:00:00.000Z";
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: timestamp, complete: true, truncated: false, error: null };
  ctx.view.setCodexSnapshot(codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(timestamp),
    connection: { state: "connected", source: "desktop-snapshot", lastSuccessAt: timestamp, error: null, scope: "临时测试" },
    sources: { threads: source, automations: { ...source } }, completeness: { threads: true, automations: true, truncated: false },
    threads: [{ id: randomUUID(), hostId: "local", title: "只读自动任务", cwd: "/temporary/list-test", updatedAt: timestamp, runtimeStatus: "active", attention: null, lastTurnStatus: null, goalStatus: null }],
  }));
  const automatic = ctx.document.querySelector('[data-origin="codex"][data-task-id]');
  assert.equal(automatic.classList.contains("task-list-row"), true);
  assert.equal(automatic.querySelector(".list-origin").textContent, "Codex · 只读");
  assert.equal(automatic.querySelector("[data-quick-toggle],[data-quick-task],[data-edit-task]"), null);
  for (const viewId of ["view-board", "view-next"]) {
    ctx.byId(viewId).click();
    assert.equal(ctx.document.querySelector("[data-quick-toggle],[data-quick-panel]"), null);
    if (ctx.card()) assert.equal(ctx.card().classList.contains("task-list-row"), false);
  }
  assert.deepEqual(ctx.calls, []);
});
