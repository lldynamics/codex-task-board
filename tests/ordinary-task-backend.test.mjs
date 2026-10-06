import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, TASK_TOOL_NAME, CONTEXT_TOOL_NAME, STATUS_VALUES, PRIORITY_VALUES, LIMITS, boardSchema, conversationUrlSchema, taskInputSchema } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { createServer } from "../src/server-core.mjs";
import { parseDiskBytes } from "../src/store-data.mjs";
import { rawChecksum } from "../src/store-files.mjs";

const command = (expectedRevision, operation, requestId = randomUUID()) => ({ requestId, expectedRevision, operation });
const create = (projectId, task = {}, currentThreadId) => ({ type: "create_task", task: { projectId, title: "普通任务", ...task }, ...(currentThreadId ? { currentThreadId } : {}) });
const patch = (taskId, fields) => ({ type: "patch_task", taskId, patch: fields });
async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "learning-board-ordinary-task-"));
  const directory = path.join(temporary, "data");
  try { await run(directory, createFileStore(directory)); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function seed(store) {
  const result = await store.mutate(command(0, { type: "save_project", project: { name: "普通项目", description: "保留项目说明" } }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
async function snapshot(directory) {
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  const backups = await fs.readdir(path.join(directory, "backups")).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  const backupBytes = await Promise.all(backups.sort().map(async (name) => [name, await fs.readFile(path.join(directory, "backups", name))]));
  await assert.rejects(fs.stat(path.join(directory, ".save-lock")), { code: "ENOENT" });
  return { bytes, backupBytes };
}
async function rejectUnchanged(directory, store, request, code = "INVALID_INPUT") {
  const before = await snapshot(directory);
  const result = await store.mutate(request);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
  assert.deepEqual(await snapshot(directory), before);
}
async function withClient(store, run) {
  const server = await createServer(store);
  const client = new Client({ name: "ordinary-task-protocol", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    await run(client);
  } finally { await client.close(); await server.close(); }
}

test("ordinary creation persists explicit thread links, defaults, normalized text, backups and identical-request replay", async () => fixture(async (directory, store) => {
  const project = await seed(store);
  const before = await snapshot(directory);
  const threadId = randomUUID();
  const request = command(1, create(project.entityId, { title: "  处理普通任务  ", currentStep: "  第一步  ", priority: "high", dueDate: "2099-10-06" }, threadId.toUpperCase()));
  const first = await store.mutate(request);
  assert.equal(first.ok, true, JSON.stringify(first));
  const task = first.board.tasks[0];
  assert.equal(first.entityId, task.id);
  assert.deepEqual({ title: task.title, status: task.status, currentStep: task.currentStep, blocker: task.blocker, sourceTool: task.sourceTool, priority: task.priority, dueDate: task.dueDate, conversationUrl: task.conversationUrl, archivedAt: task.archivedAt }, {
    title: "处理普通任务", status: "planned", currentStep: "第一步", blocker: "", sourceTool: "Codex", priority: "high", dueDate: "2099-10-06", conversationUrl: `codex://threads/${threadId}`, archivedAt: null,
  });
  assert.deepEqual(first.board.projects, project.board.projects);
  assert.deepEqual((await createFileStore(directory).read()).board, first.board);
  const backups = await fs.readdir(path.join(directory, "backups"));
  const backupName = backups.find((name) => name.includes(rawChecksum(before.bytes)));
  assert.ok(backupName);
  assert.deepEqual(await fs.readFile(path.join(directory, "backups", backupName)), before.bytes);
  const exported = await store.data({ action: "export" });
  assert.equal((await store.data({ action: "preview_restore", backup: exported.backup })).ok, true);
  const after = await snapshot(directory);
  const replay = await store.mutate(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entityId, task.id);
  assert.equal(replay.appliedRevision, 2);
  assert.deepEqual(await snapshot(directory), after);
  await rejectUnchanged(directory, store, { ...request, operation: create(project.entityId, { title: "另一个内容" }, threadId) }, "REQUEST_ID_REUSE");
  await rejectUnchanged(directory, store, command(1, create(project.entityId)), "REVISION_CONFLICT");
}));

test("task patches retain other fields, record order and sessions, support app priority, and replay across later writes", async () => fixture(async (directory, store) => {
  const project = await seed(store);
  const first = await store.mutate(command(1, { type: "save_task", task: {
    projectId: project.entityId, title: "保留标题", status: "planned", currentStep: "旧步骤", blocker: "旧阻塞", sourceTool: "原来源", conversationUrl: "https://example.org/original", priority: "urgent", dueDate: "2099-10-09",
  } }));
  const second = await store.mutate(command(2, create(project.entityId, { title: "保留顺序" })));
  const session = await store.mutate(command(3, { type: "save_session", session: { taskId: first.entityId, startAt: "2099-10-05T09:00:00.000Z", endAt: "2099-10-05T10:00:00.000Z", timeZone: "Asia/Shanghai", objective: "保留学习时段" } }));
  const request = command(4, patch(first.entityId, { currentStep: "  新步骤  " }));
  const changed = await store.mutate(request);
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(changed.entityId, first.entityId);
  const original = session.board.tasks[0];
  assert.deepEqual(changed.board.tasks[0], { ...original, currentStep: "新步骤", lastUpdatedAt: changed.board.tasks[0].lastUpdatedAt });
  assert.deepEqual(changed.board.tasks[1], second.board.tasks[1]);
  assert.deepEqual(changed.board.projects, session.board.projects);
  assert.deepEqual(changed.board.sessions, session.board.sessions);
  let result = changed;
  for (const status of STATUS_VALUES) {
    result = await store.mutate(command(result.board.revision, patch(first.entityId, { status, blocker: "" })));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.board.tasks[0].status, status);
    assert.equal(result.board.tasks[0].conversationUrl, original.conversationUrl);
    assert.deepEqual(result.board.sessions, session.board.sessions);
  }
  for (const priority of PRIORITY_VALUES) {
    result = await store.mutate(command(result.board.revision, patch(first.entityId, { priority })));
    assert.equal(result.board.tasks[0].priority, priority);
  }
  const beforeReplay = await snapshot(directory);
  const replay = await store.mutate(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.appliedRevision, changed.appliedRevision);
  assert.deepEqual(replay.board, result.board);
  assert.deepEqual(await snapshot(directory), beforeReplay);
}));

test("restricted writes reject arbitrary fields, empty patches, missing or archived records without changing disk or backups", async () => fixture(async (directory, store) => {
  const project = await seed(store);
  const created = await store.mutate(command(1, create(project.entityId)));
  const taskId = created.entityId;
  for (const operation of [
    create(project.entityId, { id: randomUUID() }), create(project.entityId, { sourceTool: "arbitrary" }),
    create(project.entityId, { conversationUrl: "https://example.org" }), create(project.entityId, { archivedAt: null }),
    { ...create(project.entityId), currentThreadId: "guessed-thread" }, { ...create(project.entityId), newProject: { name: "new" } },
    patch(taskId, {}), patch(taskId, { status: undefined }), patch(taskId, { title: "overwrite" }),
    patch(taskId, { projectId: randomUUID() }), patch(taskId, { conversationUrl: null }), patch(taskId, { archivedAt: null }),
    patch(taskId, { status: "unknown" }), patch(taskId, { currentStep: "x".repeat(4001) }),
  ]) await rejectUnchanged(directory, store, command(2, operation));
  await rejectUnchanged(directory, store, command(2, create(randomUUID())), "NOT_FOUND");
  await rejectUnchanged(directory, store, command(2, patch(randomUUID(), { status: "planned" })), "NOT_FOUND");
  assert.equal((await store.mutate(command(2, { type: "archive_task", taskId, archived: true }))).ok, true);
  await rejectUnchanged(directory, store, command(3, patch(taskId, { currentStep: "不能复活任务" })));
  assert.equal((await store.mutate(command(3, { type: "archive_task", taskId, archived: false }))).ok, true);
  const archived = await store.mutate(command(4, { type: "archive_project", projectId: project.entityId, archived: true }));
  await rejectUnchanged(directory, store, command(archived.board.revision, patch(taskId, { status: "completed" })));
  await rejectUnchanged(directory, store, command(archived.board.revision, create(project.entityId)));
}));

test("patch precommit failure retains old bytes, receipt lineage and backups for original-request retry", async () => fixture(async (directory, store) => {
  const project = await seed(store);
  const task = await store.mutate(command(1, create(project.entityId)));
  const before = await snapshot(directory);
  const request = command(2, patch(task.entityId, { status: "waiting_user", blocker: "等待用户资料" }));
  const broken = createFileStore(directory, { io: { ...fs, rename: async () => { throw new Error("injected rename failure"); } } });
  const failed = await broken.mutate(request);
  assert.equal(failed.error.code, "SAVE_FAILED");
  assert.deepEqual(await snapshot(directory), before);
  assert.deepEqual(parseDiskBytes(before.bytes).disk.appliedRequests, parseDiskBytes((await snapshot(directory)).bytes).disk.appliedRequests);
  const retried = await store.mutate(request);
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.replayed, false);
  assert.equal(retried.board.tasks[0].status, "waiting_user");
  assert.equal((await store.mutate(request)).replayed, true);
}));

test("new task at capacity is a zero-write failure while a permitted patch still succeeds", async () => fixture(async (directory, store) => {
  const project = await seed(store);
  const disk = parseDiskBytes(await fs.readFile(path.join(directory, "data.json"))).disk;
  disk.tasks = Array.from({ length: LIMITS.tasks }, () => ({ id: randomUUID(), projectId: project.entityId, title: "已存在", status: "planned", sourceTool: "", currentStep: "", blocker: "", conversationUrl: null, priority: "normal", dueDate: null, archivedAt: null, lastUpdatedAt: disk.projects[0].lastUpdatedAt }));
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify(disk));
  await rejectUnchanged(directory, store, command(1, create(project.entityId)), "CAPACITY_EXCEEDED");
  const result = await store.mutate(command(1, patch(disk.tasks[0].id, { currentStep: "仍可记录进展" })));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.board.tasks.length, LIMITS.tasks);
}));

test("conversation links allow compatible HTTP(S) and exact Codex thread URLs while rejecting unsafe variants", () => {
  const threadId = randomUUID();
  for (const url of [null, "https://example.org/thread?q=a#b", "http://localhost:8080/thread", `codex://threads/${threadId}`]) assert.equal(conversationUrlSchema.safeParse(url).success, true, String(url));
  for (const url of [
    "javascript:alert(1)", "file:///tmp/test", "https://name:secret@example.org", "https://example.org/\npath",
    "codex://threads/not-a-uuid", `codex://threads/${threadId}?view=review`, `codex://threads/${threadId}/`,
    `codex://threads/${threadId}#other`, `codex://name@threads/${threadId}`, `codex://threads:123/${threadId}`,
    `codex://review/${threadId}`, `codex://THREADS/${threadId}`, `codex://threads/%30${threadId.slice(1)}`,
  ]) assert.equal(conversationUrlSchema.safeParse(url).success, false, url);
});

test("model-only ordinary tool permits create or limited patches and ignores unverified host metadata and process identity", async () => fixture(async (directory, store) => {
  const project = await seed(store);
  await withClient(store, async (client) => {
    const tool = (await client.listTools()).tools.find((item) => item.name === TASK_TOOL_NAME);
    assert.deepEqual(tool._meta.ui.visibility, ["model"]);
    assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.match(tool.description, /learning_board_context/);
    assert.match(tool.description, /不得.*臆测 completed/);
    const variants = tool.inputSchema.properties.operation.anyOf ?? tool.inputSchema.properties.operation.oneOf;
    assert.deepEqual(variants.map((variant) => variant.properties.type.const).sort(), ["create_task", "patch_task"]);
    const patchVariant = variants.find((variant) => variant.properties.type.const === "patch_task");
    assert.deepEqual(Object.keys(patchVariant.properties.patch.properties).sort(), ["blocker", "currentStep", "status"]);
    const context = await client.callTool({ name: CONTEXT_TOOL_NAME, arguments: {} });
    assert.equal(context.structuredContent.board.revision, 1);
    const previousThreadId = process.env.CODEX_THREAD_ID;
    let created;
    try {
      process.env.CODEX_THREAD_ID = randomUUID();
      created = await client.callTool({ name: TASK_TOOL_NAME, arguments: command(1, create(project.entityId)), _meta: { "openai/session": randomUUID(), threadId: randomUUID() } });
    } finally {
      if (previousThreadId === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previousThreadId;
    }
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.equal(created.structuredContent.board, undefined);
    assert.equal(created.structuredContent.changed.tasks[0].conversationUrl, null);
    assert.match(created.content[0].text, /链接为空/);
    const taskId = created.structuredContent.entityId;
    const updated = await client.callTool({ name: TASK_TOOL_NAME, arguments: command(2, patch(taskId, { status: "in_progress", currentStep: "开始实施" })) });
    assert.equal(updated.structuredContent.changed.tasks[0].status, "in_progress");
    const before = await snapshot(directory);
    for (const operation of [
      patch(taskId, { priority: "urgent" }), patch(taskId, { dueDate: "2099-10-09" }),
      { type: "save_project", project: { name: "not allowed", description: "" } },
      { type: "archive_task", taskId, archived: true }, { type: "move_task", taskId, status: "completed", beforeTaskId: null },
      { type: "restore_board", backup: (await store.data({ action: "export" })).backup },
    ]) {
      assert.equal(taskInputSchema.safeParse(command(3, operation)).success, false);
      const result = await client.request({ method: "tools/call", params: { name: TASK_TOOL_NAME, arguments: command(3, operation) } }, CallToolResultSchema);
      assert.equal(result.isError, true, JSON.stringify(result));
    }
    assert.deepEqual(await snapshot(directory), before);
    const explicit = randomUUID();
    const linked = await client.callTool({ name: TASK_TOOL_NAME, arguments: command(3, create(project.entityId, { title: "明确来源" }, explicit)) });
    assert.equal(linked.structuredContent.changed.tasks[0].conversationUrl, `codex://threads/${explicit}`);
    assert.match(linked.content[0].text, /未由宿主自动确认/);
    const latest = (await client.callTool({ name: CONTEXT_TOOL_NAME, arguments: {} })).structuredContent.board;
    assert.doesNotThrow(() => boardSchema.parse(latest));
  });
}));
