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
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { tick, waitFor } from "./helpers.mjs";

const wrap = (structuredContent) => ({ structuredContent, ...(structuredContent.ok ? {} : { isError: true }) });
const failure = (code) => wrap({ ok: false, error: { code, message: "临时测试错误" } });
const writableTask = ({ id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl }) => ({ id, projectId, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl });

const settle = (predicate) => waitFor(predicate, "异步保存必须结束");

async function setup(t, { mutate, refresh } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "task-board-no-op-save-"));
  const store = createFileStore(directory);
  const read = async () => {
    const result = await store.read();
    assert.equal(result.ok, true);
    return result.board;
  };
  const commit = async (operation) => {
    const result = await store.mutate({ requestId: randomUUID(), expectedRevision: (await read()).revision, operation });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const projectId = (await commit({ type: "save_project", project: { name: "保存验证项目", description: "项目说明" } })).entityId;
  const taskId = (await commit({ type: "save_task", task: {
    projectId, title: "原始任务标题", status: "planned", priority: "normal", dueDate: null,
    sourceTool: "手工", currentStep: "原始步骤", blocker: "", conversationUrl: null,
  } })).entityId;
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://no-op-save.invalid/", pretendToBeVisual: true });
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "board" }));
  const calls = [];
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: () => Date.parse("2030-10-05T04:00:00.000Z"),
    mutate: async (request) => {
      calls.push(structuredClone(request));
      return mutate ? mutate(request, perform, calls.length) : perform(request);
    },
    refresh: async () => refresh ? refresh(store) : wrap(await store.read()),
  }));
  t.after(async () => { view.dispose(); dom.window.close(); await rm(directory, { recursive: true, force: true }); });
  view.setHostState({ connected: true, message: "临时测试宿主" });
  view.acceptReadResult(wrap(await store.read()));
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  const form = (kind = "task") => byId(`${kind}-form`);
  const button = (kind = "task") => form(kind).querySelector("[type=submit]");
  const open = (kind = "task") => {
    if (kind === "task") {
      document.querySelector(`[data-edit-task="${taskId}"]`).click();
      byId("task-read-edit").click();
    } else {
      byId("project-filter").value = projectId;
      byId("project-filter").dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      byId("edit-project").click();
    }
    assert.equal(form(kind).hidden, false);
  };
  const change = (id, value, type = "input") => {
    byId(id).value = value;
    byId(id).dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  };
  const submit = async (kind = "task", synthetic = false) => {
    if (synthetic) form(kind).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    else button(kind).click();
    await settle(() => !byId("refresh").disabled);
    await tick();
  };
  const disk = async () => {
    const backupDirectory = path.join(directory, "backups");
    const names = (await readdir(backupDirectory)).sort();
    return {
      bytes: await readFile(path.join(directory, "data.json")),
      backups: await Promise.all(names.map(async (name) => [name, await readFile(path.join(backupDirectory, name))])),
      revision: (await read()).revision,
    };
  };
  const remoteTask = async (patch) => commit({ type: "save_task", task: { ...writableTask((await read()).tasks.find((task) => task.id === taskId)), ...patch } });
  return { dom, document, view, store, directory, read, commit, calls, byId, form, button, open, change, submit, disk, remoteTask, projectId, taskId };
}

for (const kind of ["task", "project"]) {
  test(`${kind}: clean saved editors disable saving and every submit route preserves real store bytes, backups and revision`, async (t) => {
    const ctx = await setup(t);
    const before = await ctx.disk();
    ctx.open(kind);
    assert.equal(ctx.button(kind).disabled, true);
    assert.equal(ctx.form(kind).querySelector("[data-editor-save-status]").dataset.state, "clean");
    ctx.button(kind).click();
    for (const modifier of ["ctrlKey", "metaKey"]) {
      ctx.byId(kind === "task" ? "task-title" : "project-name").dispatchEvent(new ctx.dom.window.KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true, cancelable: true }));
    }
    ctx.form(kind).requestSubmit();
    await ctx.submit(kind, true);
    assert.equal(ctx.calls.length, 0);
    assert.deepEqual(await ctx.disk(), before);
    assert.equal(ctx.form(kind).hidden, false);
  });

  test(`${kind}: genuine edits enable save, reverting to initial or trimmed initial value writes nothing`, async (t) => {
    const ctx = await setup(t);
    const before = await ctx.disk();
    ctx.open(kind);
    const field = kind === "task" ? "task-title" : "project-name";
    const original = ctx.byId(field).value;
    ctx.change(field, "确实修改", "change");
    assert.equal(ctx.button(kind).disabled, false);
    ctx.change(field, original);
    assert.equal(ctx.button(kind).disabled, true);
    await ctx.submit(kind, true);
    ctx.change(field, `  ${original}  `);
    assert.equal(ctx.button(kind).disabled, true);
    assert.equal(ctx.byId(field).value, `  ${original}  `, "无改动判断保留用户输入原文");
    await ctx.submit(kind, true);
    assert.equal(ctx.calls.length, 0);
    assert.deepEqual(await ctx.disk(), before);
  });

  test(`${kind}: one genuine edit creates exactly one mutation, revision and backup`, async (t) => {
    const ctx = await setup(t);
    const before = await ctx.disk();
    ctx.open(kind);
    ctx.change(kind === "task" ? "task-title" : "project-name", "真正的新内容");
    await ctx.submit(kind);
    const after = await ctx.disk();
    assert.equal(ctx.calls.length, 1);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.backups.length, before.backups.length + 1);
    assert.equal(ctx.byId("editor-panel").hidden, true);
    const records = kind === "task" ? (await ctx.read()).tasks : (await ctx.read()).projects;
    assert.equal(records[0][kind === "task" ? "title" : "name"], "真正的新内容");
  });

  test(`${kind}: new editors remain saveable and create one record`, async (t) => {
    const ctx = await setup(t);
    const before = await ctx.disk();
    ctx.byId(`new-${kind}`).click();
    assert.equal(ctx.button(kind).disabled, false, "新记录不能按已有记录的 clean 快照阻止保存");
    ctx.change(kind === "task" ? "task-title" : "project-name", "新增记录");
    await ctx.submit(kind);
    assert.equal(ctx.calls.length, 1);
    assert.equal((await ctx.read()).revision, before.revision + 1);
    const records = kind === "task" ? (await ctx.read()).tasks : (await ctx.read()).projects;
    assert.equal(records.length, 2);
  });
}

test("unchanged text fields normalized by storage do not create whitespace-only saves", async (t) => {
  const ctx = await setup(t);
  ctx.open();
  const before = await ctx.disk();
  for (const field of ["task-source", "task-step", "task-blocker", "task-conversation"]) {
    ctx.change(field, ` \n${ctx.byId(field).value}\n `);
    assert.equal(ctx.button().disabled, true, field);
    await ctx.submit("task", true);
  }
  assert.equal(ctx.calls.length, 0);
  assert.deepEqual(await ctx.disk(), before);
});

test("choosing every remote conflict value produces a clean editor without another backup", async (t) => {
  const ctx = await setup(t);
  ctx.open();
  ctx.change("task-title", "我的标题");
  await ctx.remoteTask({ title: "最新标题" });
  await ctx.submit();
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.button().disabled, true);
  await ctx.view.refresh();
  assert.ok(ctx.document.querySelector('[data-conflict-field="title"]'));
  const before = await ctx.disk();
  ctx.document.querySelector('[data-conflict-choice="remote"]').click();
  assert.equal(ctx.byId("task-title").value, "最新标题");
  assert.equal(ctx.button().disabled, true);
  await ctx.submit("task", true);
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(await ctx.disk(), before);
});

test("choosing a local conflict value still saves it against the refreshed revision", async (t) => {
  const ctx = await setup(t);
  ctx.open();
  ctx.change("task-title", "保留本地标题");
  await ctx.remoteTask({ title: "另一处标题" });
  await ctx.submit();
  await ctx.view.refresh();
  ctx.document.querySelector('[data-conflict-choice="local"]').click();
  assert.equal(ctx.button().disabled, false);
  await ctx.submit();
  assert.equal(ctx.calls.length, 2);
  assert.notEqual(ctx.calls[1].requestId, ctx.calls[0].requestId);
  assert.equal((await ctx.read()).tasks[0].title, "保留本地标题");
});

test("an unknown committed save remains retryable after refresh and replays without another backup", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => {
    const result = await perform(request);
    if (count === 1) throw new Error("保存落盘后响应丢失");
    return result;
  } });
  ctx.open();
  ctx.change("task-title", "已保存但待确认");
  await ctx.submit();
  assert.equal(ctx.button().disabled, false);
  assert.equal(ctx.button().textContent, "重试确认保存");
  assert.equal(ctx.byId("task-title").disabled, true);
  const committed = await ctx.disk();
  await ctx.view.refresh();
  assert.equal(ctx.button().disabled, false);
  await ctx.submit();
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(ctx.calls[1], ctx.calls[0]);
  assert.deepEqual(await ctx.disk(), committed);
  assert.equal(ctx.byId("editor-panel").hidden, true);
});

test("a known failed save reverted to its baseline sends no request and a later edit uses a fresh request", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => count === 1 ? failure("SAVE_FAILED") : perform(request) });
  ctx.open();
  const initialTitle = ctx.byId("task-title").value;
  const before = await ctx.disk();
  ctx.change("task-title", "第一次修改");
  await ctx.submit();
  assert.equal(ctx.button().disabled, false);
  ctx.change("task-title", initialTitle);
  assert.equal(ctx.button().disabled, true);
  await ctx.submit("task", true);
  assert.equal(ctx.calls.length, 1);
  assert.deepEqual(await ctx.disk(), before);
  ctx.change("task-title", "后续真实修改");
  await ctx.submit();
  assert.equal(ctx.calls.length, 2);
  assert.notEqual(ctx.calls[1].requestId, ctx.calls[0].requestId);
  assert.equal((await ctx.read()).tasks[0].title, "后续真实修改");
});

test("record availability protection still runs before the no-op submit guard", async (t) => {
  const ctx = await setup(t, { refresh: async (store) => {
    const result = await store.read();
    result.board.revision += 1;
    result.board.tasks = [];
    return wrap(result);
  } });
  ctx.open();
  await ctx.view.refresh();
  assert.equal(ctx.button().disabled, true);
  assert.match(ctx.byId("editor-error").textContent, /已不可用/);
  const before = await ctx.disk();
  await ctx.submit("task", true);
  assert.equal(ctx.calls.length, 0);
  assert.match(ctx.byId("editor-error").textContent, /刷新记录/);
  assert.deepEqual(await ctx.disk(), before);
});
