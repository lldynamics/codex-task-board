import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createFileStore } from "../src/store.mjs";
import { emptyBoard } from "../src/board.mjs";
import { makeBackup } from "../src/store-data.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { waitFor } from "./helpers.mjs";

// Every persistence assertion uses an isolated real factory store. This module
// never starts the production server, reads user records or modifies old tests.
const wrap = (value) => ({ content: [], ...(value.ok ? {} : { isError: true }), structuredContent: value });
const fail = (code) => wrap({ ok: false, error: { code, message: `Independent ${code}` } });
function writableTask(task) {
  const { id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl } = task;
  return { id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl };
}

async function setup(t, { mutate, now, connected = true, timers = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "task-board-interaction-independent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  async function commit(operation) {
    const read = await store.read();
    assert.equal(read.ok, true);
    const result = await store.mutate({ requestId: randomUUID(), expectedRevision: read.board.revision, operation });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  const project = await commit({ type: "save_project", project: { name: "独立项目", description: "仅临时测试" } });
  const projectId = project.entityId;
  const ids = [];
  for (const name of ["A", "B", "C"]) {
    const result = await commit({ type: "save_task", task: {
      projectId, title: `独立任务 ${name}`, status: "planned", priority: "normal", dueDate: "2030-10-04",
      sourceTool: "独立来源", currentStep: `原始步骤 ${name}`, blocker: "原始阻塞",
      conversationUrl: "https://example.invalid/conversation",
    } });
    ids.push(result.entityId);
  }
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://independent-interaction.invalid/" });
  t.after(() => dom.window.close());
  const scheduled = [];
  if (timers) {
    const originalSet = dom.window.setTimeout.bind(dom.window);
    const originalClear = dom.window.clearTimeout.bind(dom.window);
    dom.window.setTimeout = (callback, duration, ...args) => {
      if (duration !== 3000) return originalSet(callback, duration, ...args);
      const entry = { callback: () => callback(...args), duration, cancelled: false };
      scheduled.push(entry);
      return entry;
    };
    dom.window.clearTimeout = (timer) => {
      if (scheduled.includes(timer)) timer.cancelled = true;
      else originalClear(timer);
    };
  }
  const document = dom.window.document;
  const calls = [];
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(document, { locale: "zh" }), mountBoard(document, emptyBoard(), {
    now,
    mutate: async (request) => {
      calls.push(structuredClone(request));
      return mutate ? mutate(request, perform, calls.length) : perform(request);
    },
    refresh: async () => wrap(await store.read()),
    data: async (request) => wrap(await store.data(request)),
  }));
  view.setHostState({ connected, message: connected ? "独立测试宿主" : "未连接" });
  view.acceptReadResult(wrap(await store.read()));
  const byId = (id) => document.getElementById(id);
  const card = (id = ids[0]) => document.querySelector(`[data-task-id="${id}"]`);
  const quick = (selector, id = ids[0]) => {
    const node = card(id)?.querySelector(selector);
    assert.ok(node, `Expected ${selector} for ${id}`);
    return node;
  };
  const read = async () => {
    const value = await store.read(); assert.equal(value.ok, true); return value.board;
  };
  async function remote(patch, id = ids[0]) {
    const board = await read();
    const task = board.tasks.find((item) => item.id === id);
    assert.ok(task);
    return commit({ type: "save_task", task: { ...writableTask(task), ...patch } });
  }
  const notify = async () => view.acceptReadResult(wrap(await store.read()));
  return { dom, document, view, directory, store, calls, commit, ids, projectId, byId, card, quick, read, remote, notify, scheduled };
}

function change(ctx, id, value) {
  const node = ctx.byId(id);
  node.value = value;
  node.dispatchEvent(new ctx.dom.window.Event(id === "search" || node.matches("input,textarea") ? "input" : "change", { bubbles: true }));
}
function stage(ctx, field, value, id = ctx.ids[0]) {
  if (ctx.quick("[data-quick-panel]", id).hidden) ctx.quick("[data-quick-toggle]", id).click();
  const select = ctx.quick(`[data-quick-field="${field}"]`, id);
  assert.equal(select.disabled, false);
  select.value = value;
  select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
}
const settle = (predicate) => waitFor(predicate, "Asynchronous operation must settle");
function list(ctx) { ctx.byId("view-list").click(); }
function openTask(ctx) { ctx.card().querySelector("[data-edit-task]").click(); assert.equal(ctx.byId("task-read-view").hidden, false); ctx.byId("task-read-edit").click(); assert.equal(ctx.byId("task-form").hidden, false); }
function editorState(ctx, kind = "task") { return ctx.byId(`${kind}-form`).querySelector("[data-editor-save-status]")?.dataset.state; }
function key(ctx, target, value, options = {}) {
  const event = new ctx.dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}
function visibleError(ctx) { return ctx.document.querySelector(".error:not([hidden])"); }

async function choose(ctx, field, value, id = ctx.ids[0]) {
  stage(ctx, field, value, id);
  await settle(() => !ctx.byId("refresh").disabled);
}
const fieldButton = (ctx, action) => ctx.document.querySelector(`[data-field-action="${action}"]`);
const retry = async (ctx) => { ctx.byId("action-retry").click(); await settle(() => !ctx.byId("refresh").disabled); };

test("independent list selections persist immediately one field at a time without changing text, order or filters", async (t) => {
  const ctx = await setup(t); list(ctx);
  const before = await ctx.read();
  change(ctx, "source-filter", JSON.stringify("独立来源")); change(ctx, "search", "独立任务");
  await choose(ctx, "status", "in_progress"); await choose(ctx, "priority", "urgent");
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls.map(({ operation }) => operation), [
    { type: "patch_task", taskId: ctx.ids[0], patch: { status: "in_progress" } },
    { type: "patch_task", taskId: ctx.ids[0], patch: { priority: "urgent" } },
  ]);
  const after = await ctx.read();
  assert.equal(after.revision, before.revision + 2);
  assert.deepEqual(after.tasks.map((task) => task.id), before.tasks.map((task) => task.id));
  assert.deepEqual(writableTask(after.tasks[0]), { ...writableTask(before.tasks[0]), status: "in_progress", priority: "urgent" });
  assert.deepEqual(after.tasks.slice(1), before.tasks.slice(1));
  assert.equal(ctx.byId("source-filter").value, JSON.stringify("独立来源")); assert.equal(ctx.byId("search").value, "独立任务");
  assert.equal(ctx.card().querySelector("[data-quick-save]"), null);
  assert.equal(ctx.card().querySelector("[data-quick-cancel]"), null);
  assert.equal(fieldButton(ctx, "undo").disabled, false);
  assert.equal(ctx.byId("new-task").disabled, false);
  assert.equal(ctx.card().querySelector("[data-edit-task]").disabled, false);
});

test("choosing an unchanged list value writes zero bytes, revision or backup", async (t) => {
  const ctx = await setup(t); list(ctx);
  const before = await readFile(path.join(ctx.directory, "data.json"));
  const revision = (await ctx.read()).revision;
  await choose(ctx, "status", "planned"); await choose(ctx, "priority", "normal");
  assert.deepEqual(ctx.calls, []); assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before);
  assert.equal((await ctx.read()).revision, revision); assert.equal(fieldButton(ctx, "undo"), null);
});

test("single-field undo preserves later remote text and unrelated fields and uses the current revision", async (t) => {
  const ctx = await setup(t); list(ctx); await choose(ctx, "status", "in_progress");
  await ctx.remote({ title: "撤销前新标题", currentStep: "撤销前新步骤", priority: "urgent" }); await ctx.notify();
  const before = await ctx.read();
  assert.equal(fieldButton(ctx, "undo").disabled, false); fieldButton(ctx, "undo").click();
  await settle(() => !ctx.byId("refresh").disabled);
  assert.deepEqual(ctx.calls[1].operation, { type: "patch_task", taskId: ctx.ids[0], patch: { status: "planned" } });
  assert.equal(ctx.calls[1].expectedRevision, before.revision);
  const after = (await ctx.read()).tasks[0];
  assert.equal(after.title, "撤销前新标题"); assert.equal(after.currentStep, "撤销前新步骤"); assert.equal(after.priority, "urgent"); assert.equal(after.status, "planned");
  assert.equal(fieldButton(ctx, "undo"), null);
});

test("a remote change to the same field disables undo even after its notification", async (t) => {
  const ctx = await setup(t); list(ctx); await choose(ctx, "priority", "urgent");
  await ctx.remote({ priority: "high" }); await ctx.notify();
  const before = await readFile(path.join(ctx.directory, "data.json"));
  assert.equal(fieldButton(ctx, "undo").disabled, true);
  fieldButton(ctx, "undo").dispatchEvent(new ctx.dom.window.Event("click"));
  assert.equal(ctx.calls.length, 1); assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before);
  assert.match(ctx.document.querySelector(".field-save-notice").textContent, /不能撤销/);
});

test("a race during undo creates no mutation and refreshed same-field changes cannot be forcefully undone", async (t) => {
  const ctx = await setup(t); list(ctx); await choose(ctx, "status", "in_progress");
  await ctx.remote({ status: "paused", title: "不可丢失" });
  fieldButton(ctx, "undo").click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.calls.length, 2); assert.equal((await ctx.read()).tasks[0].status, "paused");
  await ctx.view.refresh();
  assert.equal(fieldButton(ctx, "confirm"), null); assert.equal(fieldButton(ctx, "remote"), null);
  assert.match(ctx.document.querySelector(".field-save-notice").textContent, /不能撤销/);
  fieldButton(ctx, "dismiss").click(); assert.equal((await ctx.read()).tasks[0].title, "不可丢失");
});

test("independent quick CAS conflict requires explicit refresh and confirmation while remote text survives", async (t) => {
  const ctx = await setup(t); list(ctx); const initial = await ctx.read();
  await ctx.remote({ title: "远端标题", currentStep: "远端步骤", priority: "high" });
  await choose(ctx, "status", "in_progress");
  assert.equal(ctx.calls[0].expectedRevision, initial.revision);
  assert.equal(ctx.byId("action-retry").disabled, true);
  const before = await ctx.read(); await ctx.view.refresh();
  assert.equal(ctx.calls.length, 1); assert.equal(fieldButton(ctx, "confirm").disabled, false);
  fieldButton(ctx, "confirm").click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.notEqual(ctx.calls[1].requestId, ctx.calls[0].requestId); assert.equal(ctx.calls[1].expectedRevision, before.revision);
  const task = (await ctx.read()).tasks[0];
  assert.equal(task.title, "远端标题"); assert.equal(task.currentStep, "远端步骤"); assert.equal(task.priority, "high"); assert.equal(task.status, "in_progress");
});

for (const side of ["local", "remote"]) {
  test(`same-field conflict survives repeated refresh until explicit ${side} confirmation`, async (t) => {
    const ctx = await setup(t); list(ctx); await ctx.remote({ priority: "high", title: "远端保护字段" });
    await choose(ctx, "priority", "urgent"); await ctx.view.refresh(); await ctx.view.refresh();
    assert.match(ctx.document.querySelector(".field-save-notice").textContent, /相同字段/); assert.equal(ctx.calls.length, 1);
    fieldButton(ctx, side === "local" ? "confirm" : "remote").click(); await settle(() => !ctx.byId("refresh").disabled);
    assert.equal((await ctx.read()).tasks[0].priority, side === "local" ? "urgent" : "high");
    assert.equal(ctx.calls.length, side === "local" ? 2 : 1); assert.equal((await ctx.read()).tasks[0].title, "远端保护字段");
  });
}

test("lost quick response retains exact ID/CAS/patch through refresh and replay without another commit", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("lost receipt"); return result; } });
  list(ctx); await choose(ctx, "priority", "urgent");
  assert.equal(fieldButton(ctx, "undo"), null); assert.equal(fieldButton(ctx, "dismiss").disabled, true);
  assert.equal(ctx.quick('[data-quick-field="priority"]').disabled, true);
  const original = structuredClone(ctx.calls[0]);
  await ctx.remote({ title: "落盘后远端新标题", currentStep: "落盘后远端步骤", priority: "low" }); await ctx.view.refresh();
  assert.equal(ctx.quick('[data-quick-field="priority"]').value, "urgent");
  const before = await readFile(path.join(ctx.directory, "data.json")); await retry(ctx);
  assert.deepEqual(ctx.calls[1], original); assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before);
  assert.equal(ctx.quick('[data-quick-field="priority"]').value, "low"); assert.equal(fieldButton(ctx, "undo").disabled, true);
});

for (const code of ["BUSY", "SAVE_FAILED", "NOT_FOUND", "INVALID_INPUT", "REQUEST_ID_REUSE", "CAPACITY_EXCEEDED", "INVALID_STORE"]) {
  test(`unknown quick request remains protected through ${code} before exact receipt confirmation`, async (t) => {
    const ctx = await setup(t, { mutate: async (request, perform, count) => { if (count === 1) { await perform(request); throw new Error("lost response"); } if (count === 2) return fail(code); return perform(request); } });
    list(ctx); await choose(ctx, "priority", "high"); await ctx.view.refresh(); await retry(ctx);
    assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.equal(fieldButton(ctx, "dismiss").disabled, true); assert.equal(fieldButton(ctx, "undo"), null);
    const before = await ctx.read(); await ctx.view.refresh(); await retry(ctx);
    assert.deepEqual(ctx.calls[2], ctx.calls[0]); assert.deepEqual(await ctx.read(), before); assert.equal(fieldButton(ctx, "undo").disabled, false);
  });
}

test("known failed patch retries unchanged request and expiry requires refresh, review and end with zero new requests", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => count === 1 ? fail("SAVE_FAILED") : perform(request) });
  list(ctx); const before = await ctx.read(); await choose(ctx, "priority", "urgent"); assert.deepEqual(await ctx.read(), before);
  await retry(ctx); assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.equal((await ctx.read()).tasks[0].priority, "urgent");
  const expired = await setup(t, { mutate: async () => fail("REQUEST_EXPIRED") }); list(expired); await choose(expired, "priority", "urgent");
  assert.equal(fieldButton(expired, "dismiss").disabled, true); assert.equal(expired.byId("expired-reviewed").disabled, true);
  expired.byId("action-retry").click(); await expired.view.refresh();
  expired.byId("expired-reviewed").checked = true; expired.byId("expired-reviewed").dispatchEvent(new expired.dom.window.Event("change", { bubbles: true })); expired.byId("expired-end").click();
  assert.equal(expired.calls.length, 1); assert.equal(expired.byId("expired-feedback").hidden, true); assert.equal(expired.quick('[data-quick-field="priority"]').value, "normal");
});

test("failed choice stays reachable after filtering and collapse without preventing opening task details", async (t) => {
  const ctx = await setup(t, { mutate: async () => fail("SAVE_FAILED") }); list(ctx); await choose(ctx, "priority", "urgent");
  ctx.quick("[data-quick-toggle]").click(); assert.equal(ctx.quick("[data-quick-panel]").hidden, true);
  assert.equal(ctx.card().querySelector("[data-edit-task]").disabled, false);
  change(ctx, "search", "不存在的結果"); assert.equal(ctx.card(), null);
  assert.equal(fieldButton(ctx, "dismiss").disabled, false); fieldButton(ctx, "dismiss").click(); assert.equal(ctx.document.querySelector(".field-save-notice"), null);
  assert.equal(ctx.calls.length, 1);
});

test("dirty complete editor and backup preview prevent synthetic list writes without losing text", async (t) => {
  const ctx = await setup(t); list(ctx); openTask(ctx); change(ctx, "task-title", "详情未保存草稿");
  const select = ctx.quick('[data-quick-field="priority"]'); assert.equal(select.disabled, true);
  select.value = "urgent"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  assert.equal(ctx.byId("task-title").value, "详情未保存草稿"); assert.deepEqual(ctx.calls, []);
  ctx.byId("editor-close").click(); assert.equal(ctx.byId("discard-dialog").hidden, false); ctx.byId("discard-edits").click();
  await ctx.view.previewBackup(makeBackup(await ctx.read(), "2030-10-05T00:00:00.000Z"));
  assert.equal(ctx.quick('[data-quick-field="priority"]').disabled, true); assert.deepEqual(ctx.calls, []);
});

for (const unavailable of ["archived-task", "archived-project", "missing"]) {
  test(`${unavailable} prevents undo and synthetic single-field writes`, async (t) => {
    const ctx = await setup(t); list(ctx); await choose(ctx, "priority", "urgent");
    if (unavailable === "archived-task") await ctx.commit({ type: "archive_task", taskId: ctx.ids[0], archived: true });
    else if (unavailable === "archived-project") await ctx.commit({ type: "archive_project", projectId: ctx.projectId, archived: true });
    else { const board = await ctx.read(); board.tasks = board.tasks.filter((task) => task.id !== ctx.ids[0]); await ctx.commit({ type: "restore_board", backup: makeBackup(board, "2030-10-05T00:00:00.000Z") }); }
    await ctx.notify(); change(ctx, "archive-filter", "all");
    assert.equal(fieldButton(ctx, "undo").disabled, true); fieldButton(ctx, "undo").dispatchEvent(new ctx.dom.window.Event("click"));
    if (ctx.card()) { const select = ctx.quick('[data-quick-field="priority"]'); assert.equal(select.disabled, true); select.value = "high"; select.dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true })); }
    assert.equal(ctx.calls.length, 1);
  });
}

for (const unavailable of ["archived", "missing"]) {
  test(`unknown patch receipt remains replayable after target becomes ${unavailable}`, async (t) => {
    const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw new Error("lost response"); return result; } });
    list(ctx); await choose(ctx, "status", "in_progress");
    if (unavailable === "archived") await ctx.commit({ type: "archive_task", taskId: ctx.ids[0], archived: true });
    else { const board = await ctx.read(); board.tasks = board.tasks.filter((task) => task.id !== ctx.ids[0]); await ctx.commit({ type: "restore_board", backup: makeBackup(board, "2030-10-05T00:00:00.000Z") }); }
    await ctx.view.refresh(); const before = await ctx.read(); await retry(ctx);
    assert.deepEqual(ctx.calls[1], ctx.calls[0]); assert.deepEqual(await ctx.read(), before); assert.equal(fieldButton(ctx, "undo").disabled, true);
  });
}

test("undo with an unobserved unrelated text change requires refresh and confirmation and preserves that text", async (t) => {
  const ctx = await setup(t); list(ctx); await choose(ctx, "priority", "urgent");
  await ctx.remote({ title: "撤销竞态中的新标题", currentStep: "撤销竞态中的新步骤" });
  fieldButton(ctx, "undo").click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.calls.length, 2); assert.equal((await ctx.read()).tasks[0].priority, "urgent");
  await ctx.view.refresh(); assert.equal(fieldButton(ctx, "confirm").disabled, false); fieldButton(ctx, "confirm").click(); await settle(() => !ctx.byId("refresh").disabled);
  const task = (await ctx.read()).tasks[0]; assert.equal(task.priority, "normal"); assert.equal(task.title, "撤销竞态中的新标题"); assert.equal(task.currentStep, "撤销竞态中的新步骤");
  assert.notEqual(ctx.calls[2].requestId, ctx.calls[1].requestId); assert.deepEqual(ctx.calls[2].operation.patch, { priority: "normal" });
});

test("unknown undo replays its exact request and preserves subsequent remote text without another commit", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 2) throw Error("undo receipt lost"); return result; } });
  list(ctx); await choose(ctx, "status", "in_progress"); fieldButton(ctx, "undo").click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(fieldButton(ctx, "undo"), null); assert.equal(fieldButton(ctx, "dismiss").disabled, true); assert.equal(ctx.calls.length, 2);
  await ctx.remote({ title: "撤销落盘后的新标题", priority: "high" }); await ctx.view.refresh();
  const before = await readFile(path.join(ctx.directory, "data.json")); await retry(ctx);
  assert.deepEqual(ctx.calls[2], ctx.calls[1]); assert.deepEqual(await readFile(path.join(ctx.directory, "data.json")), before);
  assert.equal((await ctx.read()).tasks[0].title, "撤销落盘后的新标题"); assert.equal((await ctx.read()).tasks[0].priority, "high"); assert.equal((await ctx.read()).tasks[0].status, "planned");
  assert.equal(fieldButton(ctx, "undo"), null);
});

test("independent N and slash shortcuts reject editable, IME, repeat and modifier events but work from a plain focused board", async (t) => {
  const ctx = await setup(t);
  const editable = ctx.document.createElement("div"); editable.contentEditable = "true"; editable.setAttribute("contenteditable", "true"); editable.tabIndex = 0; ctx.document.body.append(editable);
  const textbox = ctx.document.createElement("div"); textbox.setAttribute("role", "textbox"); ctx.document.body.append(textbox);
  for (const target of [ctx.byId("search"), ctx.byId("project-filter"), editable, textbox]) {
    target.focus(); const active = ctx.document.activeElement;
    assert.equal(key(ctx, target, "n").defaultPrevented, false);
    assert.equal(key(ctx, target, "/").defaultPrevented, false);
    assert.equal(ctx.document.activeElement, active);
    assert.equal(ctx.byId("editor-panel").hidden, true);
  }
  for (const options of [{ isComposing: true }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { keyCode: 229 }]) {
    ctx.byId("view-board").focus();
    const active = ctx.document.activeElement;
    assert.equal(key(ctx, active, "n", options).defaultPrevented, false);
    assert.equal(key(ctx, active, "/", options).defaultPrevented, false);
    assert.equal(ctx.document.activeElement, active);
    assert.equal(ctx.byId("editor-panel").hidden, true);
  }
  ctx.byId("view-board").focus();
  assert.equal(key(ctx, ctx.byId("view-board"), "/").defaultPrevented, true);
  assert.equal(ctx.document.activeElement, ctx.byId("search"));
  ctx.byId("view-board").focus();
  assert.equal(key(ctx, ctx.byId("view-board"), "n").defaultPrevented, true);
  assert.equal(ctx.byId("task-form").hidden, false);
  assert.equal(ctx.calls.length, 0);
  change(ctx, "task-title", "快捷键不能截获正文");
  assert.equal(key(ctx, ctx.byId("task-title"), "n").defaultPrevented, false);
  assert.equal(key(ctx, ctx.byId("task-title"), "/").defaultPrevented, false);
  assert.equal(ctx.byId("task-title").value, "快捷键不能截获正文");
});

for (const kind of ["task", "project"]) for (const modifier of ["ctrlKey", "metaKey"]) {
  test(`independent ${modifier}+Enter explicitly saves ${kind} form and does not double submit pending/repeat/IME events`, async (t) => {
    let release;
    const ctx = await setup(t, { mutate: async (request, perform) => {
      await new Promise((resolve) => { release = resolve; }); return perform(request);
    } });
    if (kind === "task") { openTask(ctx); change(ctx, "task-title", "任务键盘保存"); }
    else { ctx.byId("new-project").click(); change(ctx, "project-name", "项目键盘保存"); }
    const target = ctx.byId(kind === "task" ? "task-title" : "project-name");
    assert.equal(editorState(ctx, kind), "dirty");
    for (const options of [{ [modifier]: true, isComposing: true }, { [modifier]: true, repeat: true }, { [modifier]: true, altKey: true }, { [modifier]: true, shiftKey: true }, { ctrlKey: true, metaKey: true }, { [modifier]: true, keyCode: 229 }]) {
      assert.equal(key(ctx, target, "Enter", options).defaultPrevented, false);
      assert.equal(ctx.calls.length, 0);
    }
    assert.equal(key(ctx, target, "Enter", { [modifier]: true }).defaultPrevented, true);
    assert.equal(ctx.calls.length, 1);
    assert.equal(editorState(ctx, kind), "saving");
    assert.equal(target.disabled, true);
    const active = ctx.document.activeElement;
    key(ctx, target, "Enter", { [modifier]: true }); key(ctx, ctx.document.body, "n");
    assert.equal(key(ctx, ctx.document.body, "/").defaultPrevented, false);
    assert.equal(ctx.document.activeElement, active, "Busy shortcuts must not redirect focus outside the pending editor");
    assert.equal(ctx.calls.length, 1);
    release(); await settle(() => ctx.byId("editor-panel").hidden);
    assert.equal(ctx.calls[0].operation.type, `save_${kind}`);
    assert.match(ctx.byId("save-status").textContent, /已保存/);
  });
}

test("independent disconnected and compact/modal shortcut gates cannot create, focus outside, or write", async (t) => {
  const disconnected = await setup(t, { connected: false });
  assert.equal(key(disconnected, disconnected.document.body, "n").defaultPrevented, false);
  assert.equal(disconnected.byId("editor-panel").hidden, true);
  assert.equal(disconnected.calls.length, 0);
  const ctx = await setup(t); openTask(ctx);
  change(ctx, "task-title", "保留模态草稿");
  Object.defineProperty(ctx.dom.window, "innerWidth", { configurable: true, value: 600 });
  ctx.dom.window.dispatchEvent(new ctx.dom.window.Event("resize"));
  const active = ctx.document.activeElement;
  assert.equal(key(ctx, ctx.document.body, "/").defaultPrevented, false);
  assert.equal(key(ctx, ctx.document.body, "n").defaultPrevented, false);
  assert.equal(ctx.document.activeElement, active);
  ctx.byId("editor-close").click();
  assert.equal(ctx.byId("discard-dialog").hidden, false);
  key(ctx, ctx.byId("keep-editing"), "Enter", { metaKey: true });
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.byId("task-title").value, "保留模态草稿");
});

test("independent editor status follows clean/dirty/saving/unknown/expired and does not let success timers clear subsequent errors", async (t) => {
  let release;
  const ctx = await setup(t, { timers: true, mutate: async (request, perform, count) => {
    if (count === 1) return perform(request);
    if (count === 2) { await new Promise((resolve) => { release = resolve; }); throw new Error("lost before response"); }
    return fail("REQUEST_EXPIRED");
  } });
  openTask(ctx); assert.equal(editorState(ctx), "clean");
  change(ctx, "task-title", "先成功保存"); assert.equal(editorState(ctx), "dirty");
  ctx.byId("task-form").querySelector('[type="submit"]').click(); await settle(() => ctx.byId("editor-panel").hidden);
  assert.equal(ctx.scheduled.length, 1); assert.equal(ctx.scheduled[0].duration, 3000);
  assert.match(ctx.byId("save-status").textContent, /已保存/);
  ctx.scheduled[0].callback(); assert.equal(ctx.byId("save-status").textContent, "");
  openTask(ctx); change(ctx, "task-title", "保留未知草稿");
  ctx.byId("task-form").querySelector('[type="submit"]').click();
  assert.equal(editorState(ctx), "saving"); release(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(editorState(ctx), "confirm"); assert.ok(visibleError(ctx));
  const unknownText = visibleError(ctx).textContent;
  ctx.scheduled[0].callback(); assert.equal(visibleError(ctx).textContent, unknownText);
  await ctx.view.refresh();
  key(ctx, ctx.byId("task-title"), "Enter", { ctrlKey: true });
  await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(editorState(ctx), "expired");
  const expiredText = visibleError(ctx).textContent;
  ctx.scheduled[0].callback(); assert.equal(visibleError(ctx).textContent, expiredText);
  assert.equal(ctx.byId("task-title").value, "保留未知草稿");
  const count = ctx.calls.length;
  key(ctx, ctx.byId("task-title"), "Enter", { metaKey: true }); key(ctx, ctx.document.body, "n");
  assert.equal(ctx.calls.length, count);
});

test("independent editor conflict state persists with visible conflict/error until explicitly resolved; later error cancels success timeout", async (t) => {
  const ctx = await setup(t, { timers: true });
  list(ctx); await choose(ctx, "priority", "high");
  const timer = ctx.scheduled[0]; assert.ok(timer);
  ctx.view.reportError("随后独立错误不能消失");
  assert.equal(timer.cancelled, true);
  timer.callback(); assert.equal(visibleError(ctx).textContent, "随后独立错误不能消失");
  openTask(ctx); change(ctx, "task-title", "我的冲突标题");
  await ctx.remote({ title: "远端冲突标题" });
  ctx.byId("task-form").querySelector('[type="submit"]').click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(editorState(ctx), "conflict"); assert.ok(visibleError(ctx));
  const error = visibleError(ctx).textContent; timer.callback(); assert.equal(visibleError(ctx).textContent, error);
  await ctx.view.refresh(); await ctx.view.refresh();
  assert.equal(editorState(ctx), "conflict");
  assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
  assert.ok(ctx.document.querySelector('[data-conflict-field="title"]'));
});

test("independent due dates abbreviate only the current year, retain full ISO time/title, and mark only active unfinished tasks overdue", async (t) => {
  const ctx = await setup(t, { now: () => new Date(2030, 9, 5, 12).getTime() });
  await ctx.remote({ dueDate: "2029-12-31", status: "completed" }, ctx.ids[1]);
  await ctx.remote({ dueDate: "2030-01-01" }, ctx.ids[2]);
  await ctx.commit({ type: "archive_task", taskId: ctx.ids[2], archived: true });
  await ctx.notify(); list(ctx); change(ctx, "archive-filter", "all");
  const current = ctx.card(ctx.ids[0]).querySelector("time");
  assert.equal(current.textContent, "截止 10-04"); assert.equal(current.dateTime, "2030-10-04");
  assert.match(current.title, /2030-10-04/); assert.match(current.getAttribute("aria-label"), /2030-10-04/); assert.equal(current.classList.contains("due-overdue"), true);
  const completed = ctx.card(ctx.ids[1]).querySelector("time");
  assert.equal(completed.textContent, "截止 2029-12-31"); assert.equal(completed.dateTime, "2029-12-31"); assert.equal(completed.classList.contains("due-overdue"), false);
  const archived = ctx.card(ctx.ids[2]).querySelector("time");
  assert.equal(archived.classList.contains("due-overdue"), false);
  await ctx.commit({ type: "archive_project", projectId: ctx.projectId, archived: true }); await ctx.notify();
  assert.equal(ctx.card(ctx.ids[0]).querySelector("time").classList.contains("due-overdue"), false);
  assert.equal(ctx.calls.length, 0);
});

test("independent editor status prioritizes a coexisting uncertain or expired move above an earlier known failed save", async (t) => {
  const ctx = await setup(t, { mutate: async (_request, _perform, count) => {
    if (count === 1) return fail("SAVE_FAILED");
    if (count === 2) throw new Error("Unknown move response while failed editor save is retained");
    return fail("REQUEST_EXPIRED");
  } });
  openTask(ctx); change(ctx, "task-title", "失败保存仍保留");
  ctx.byId("task-form").querySelector('[type="submit"]').click();
  await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(editorState(ctx), "error");
  const move = ctx.card().querySelector('[data-move-control="down"]');
  assert.equal(move.disabled, false); move.click();
  await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(ctx.calls[1].operation.type, "move_task");
  assert.equal(editorState(ctx), "confirm", "An uncertain move must outrank a retained known save failure");
  assert.equal(ctx.byId("task-title").value, "失败保存仍保留");
  assert.equal(ctx.byId("task-form").querySelector('[type="submit"]').disabled, true);
  key(ctx, ctx.byId("task-title"), "Enter", { ctrlKey: true });
  assert.equal(ctx.calls.length, 2);
  ctx.byId("move-retry").click(); await settle(() => !ctx.byId("refresh").disabled);
  assert.equal(editorState(ctx), "expired", "An expired move must outrank every retained known failure");
  assert.deepEqual(ctx.calls[2], ctx.calls[1]);
  assert.equal(ctx.byId("expired-feedback").hidden, false);
  assert.equal(ctx.byId("task-title").value, "失败保存仍保留");
});

test("independent empty new editors show unsaved status and ignore prevented shortcuts plus ordinary textarea typing", async (t) => {
  const ctx = await setup(t);
  const prevented = new ctx.dom.window.KeyboardEvent("keydown", { key: "n", bubbles: true, cancelable: true });
  prevented.preventDefault(); ctx.document.body.dispatchEvent(prevented);
  assert.equal(ctx.byId("editor-panel").hidden, true);
  ctx.byId("new-project").click(); assert.equal(editorState(ctx, "project"), "dirty");
  assert.match(ctx.byId("project-form").querySelector("[data-editor-save-status]").textContent, /未保存/);
  ctx.byId("editor-close").click();
  ctx.byId("new-task").click(); assert.equal(editorState(ctx), "dirty");
  const textarea = ctx.byId("task-step"); textarea.focus();
  assert.equal(key(ctx, textarea, "n").defaultPrevented, false);
  assert.equal(key(ctx, textarea, "/").defaultPrevented, false);
  assert.equal(ctx.document.activeElement, textarea);
  assert.equal(ctx.calls.length, 0);
});
