import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION, TOOL_NAME, MUTATION_TOOL_NAME, TASK_TOOL_NAME, UI_URI, MIME_TYPE, boardSchema, emptyBoard } from "../src/board.mjs";
import { PRODUCT_ID, PRODUCT_NAME, LEGACY_UI_URIS } from "../src/product-identity.mjs";
import { createServer, createFileStore } from "../src/server-core.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const pluginRoot = path.join(root, "plugins", PRODUCT_ID);

async function withClient(pluginDirectory, run) {
  const temporary = await mkdtemp(path.join(tmpdir(), "learning-board-protocol-"));
  const dataDirectory = path.join(temporary, "data");
  // Never launch production server.js: inject tmp storage into the bundled factory.
  const bootstrap = `import { createServer, createFileStore, StdioServerTransport } from ${JSON.stringify(pathToFileURL(path.join(pluginDirectory, "dist/server-core.js")).href)}; const server = await createServer(createFileStore(${JSON.stringify(dataDirectory)})); await server.connect(new StdioServerTransport());`;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", bootstrap], cwd: pluginDirectory, stderr: "pipe" });
  const client = new Client({ name: "learning-board-test", version: VERSION });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    await run(client, dataDirectory);
    assert.equal(stderr, "", "Bundled factory server must not emit runtime errors");
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

test("real stdio exposes readonly global app plus an app-only strict mutation tool", { timeout: 15000 }, async () => {
  await withClient(pluginRoot, async (client, dataDirectory) => {
    assert.equal(client.getServerVersion().name, PRODUCT_ID);
    assert.equal(client.getServerVersion().title, PRODUCT_NAME);
    assert.equal(client.getServerVersion().version, VERSION);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    const readTool = tools.find((tool) => tool.name === TOOL_NAME);
    const writeTool = tools.find((tool) => tool.name === MUTATION_TOOL_NAME);
    assert.equal(readTool.title, PRODUCT_NAME);
    assert.equal(readTool.inputSchema.additionalProperties, false);
    assert.deepEqual(readTool.inputSchema.properties, {});
    assert.equal(readTool.annotations.readOnlyHint, true);
    assert.equal(readTool._meta.ui.resourceUri, UI_URI);
    // The read-only entry is model-visible so "open the task board" in chat can launch it.
    assert.deepEqual(readTool._meta.ui.visibility, ["model", "app"]);
    assert.deepEqual(readTool._meta["openai/ui"].entrypoints, [{ type: "global" }]);
    assert.deepEqual(writeTool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(writeTool._meta.ui.visibility, ["app"]);
    assert.equal(writeTool._meta["openai/ui"], undefined);
    assert.equal(writeTool.inputSchema.additionalProperties, false);
    const result = await client.callTool({ name: TOOL_NAME, arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, { ok: true, board: emptyBoard() });
    await assert.rejects(stat(dataDirectory), { code: "ENOENT" });

    const { resources } = await client.listResources();
    assert.equal(resources.length, 1 + LEGACY_UI_URIS.length);
    assert.deepEqual(resources.map((resource) => resource.uri).sort(), [UI_URI, ...LEGACY_UI_URIS].sort());
    assert.equal(resources.find((resource) => resource.uri === UI_URI).mimeType, MIME_TYPE);
    const read = await client.readResource({ uri: UI_URI });
    const resource = read.contents[0];
    assert.equal(resource.uri, UI_URI);
    assert.equal(resource.mimeType, MIME_TYPE);
    assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.equal(resource._meta["openai/ui"].preferredDisplayMode, "fullscreen");
    assert.match(resource.text, /任务看板/);
    assert.ok(resource.text.includes("<script>"));
    assert.doesNotMatch(resource.text, /<script\b[^>]*\bsrc\s*=/i);
    assert.doesNotMatch(resource.text, /<link\b[^>]*\bhref\s*=/i);
    assert.match(resource.text, /connect-src 'none'/);
  });
});

test("real stdio saves and returns structured replay/conflict results", { timeout: 15000 }, async () => {
  await withClient(pluginRoot, async (client) => {
    const input = { requestId: randomUUID(), expectedRevision: 0, operation: { type: "save_project", project: { name: "协议项目", description: "测试" } } };
    const first = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: input });
    assert.equal(first.structuredContent.ok, true);
    assert.equal(first.structuredContent.replayed, false);
    const board = boardSchema.parse(first.structuredContent.board);
    assert.equal(board.projects.length, 1);
    assert.equal(board.revision, 1);
    const replay = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: input });
    assert.equal(replay.structuredContent.replayed, true);
    assert.equal(replay.structuredContent.appliedRevision, 1);
    const conflict = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: { ...input, requestId: randomUUID() } });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.structuredContent.ok, false);
    assert.equal(conflict.structuredContent.error.code, "REVISION_CONFLICT");
    assert.deepEqual(conflict.structuredContent.board, board);
    const read = await client.callTool({ name: TOOL_NAME, arguments: {} });
    assert.deepEqual(read.structuredContent.board, board);
  });
});

test("real stdio records ordinary tasks through the restricted model tool with durable thread links and patch replay", { timeout: 15000 }, async () => {
  await withClient(pluginRoot, async (client, dataDirectory) => {
    const savedProject = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: { requestId: randomUUID(), expectedRevision: 0, operation: { type: "save_project", project: { name: "普通任务协议项目", description: "" } } } });
    const projectId = savedProject.structuredContent.entityId;
    const currentThreadId = randomUUID();
    const input = { requestId: randomUUID(), expectedRevision: 1, operation: { type: "create_task", currentThreadId, task: { projectId, title: "对话记录普通任务", dueDate: "2099-10-06", priority: "high" } } };
    const created = await client.callTool({ name: TASK_TOOL_NAME, arguments: input });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    const taskId = created.structuredContent.entityId;
    assert.equal(created.structuredContent.board, undefined);
    assert.equal(created.structuredContent.revision, 2);
    const [task] = created.structuredContent.changed.tasks;
    assert.equal(task.id, taskId);
    assert.equal(task.conversationUrl, `codex://threads/${currentThreadId}`);
    const patchInput = { requestId: randomUUID(), expectedRevision: 2, operation: { type: "patch_task", taskId, patch: { status: "waiting_user", blocker: "等待资料" } } };
    const patched = await client.callTool({ name: TASK_TOOL_NAME, arguments: patchInput });
    assert.notEqual(patched.isError, true, JSON.stringify(patched));
    const [patchedTask] = patched.structuredContent.changed.tasks;
    assert.deepEqual(boardSchema.parse((await client.callTool({ name: "learning_board_context", arguments: {} })).structuredContent.board).tasks, [patchedTask]);
    assert.deepEqual(patchedTask, { ...task, status: "waiting_user", blocker: "等待资料", lastUpdatedAt: patchedTask.lastUpdatedAt });
    const bytes = await readFile(path.join(dataDirectory, "data.json"));
    for (const request of [input, patchInput]) {
      const replay = await client.callTool({ name: TASK_TOOL_NAME, arguments: request });
      assert.equal(replay.structuredContent.replayed, true);
      assert.equal(replay.structuredContent.entityId, taskId);
      assert.equal(replay.structuredContent.revision, 3);
      assert.equal(replay.structuredContent.changed, undefined);
    }
    assert.deepEqual(await readFile(path.join(dataDirectory, "data.json")), bytes);
    const rejected = await client.callTool({ name: TASK_TOOL_NAME, arguments: { requestId: randomUUID(), expectedRevision: 3, operation: { type: "archive_task", taskId, archived: true } } });
    assert.equal(rejected.isError, true);
    assert.deepEqual(await readFile(path.join(dataDirectory, "data.json")), bytes);
  });
});

test("real stdio rejects unknown tools, paths, deletion and bad arguments without writes", { timeout: 15000 }, async () => {
  await withClient(pluginRoot, async (client, dataDirectory) => {
    const requests = [
      { name: "missing_tool", arguments: {} },
      { name: TOOL_NAME, arguments: { path: "/tmp/other" } },
      { name: MUTATION_TOOL_NAME, arguments: { requestId: randomUUID(), expectedRevision: 0, directory: "/tmp/other", operation: { type: "save_project", project: { name: "x", description: "" } } } },
      { name: MUTATION_TOOL_NAME, arguments: { requestId: randomUUID(), expectedRevision: 0, operation: { type: "delete_project", id: randomUUID() } } },
    ];
    for (const params of requests) {
      const result = await client.request({ method: "tools/call", params }, CallToolResultSchema);
      assert.equal(result.isError, true);
      assert.ok(result.content.some((item) => item.type === "text" && item.text.length > 0));
    }
    await assert.rejects(client.request({ method: "tools/call", params: { name: TOOL_NAME, arguments: "wrong" } }, CallToolResultSchema));
    await assert.rejects(client.readResource({ uri: "ui://learning-board/missing" }));
    await assert.rejects(stat(dataDirectory), { code: "ENOENT" });
    const valid = await client.callTool({ name: TOOL_NAME, arguments: {} });
    assert.deepEqual(valid.structuredContent, { ok: true, board: emptyBoard() });
  });
});

test("bundled factories and UI run after relocation without source tree or node_modules", { timeout: 15000 }, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "learning-board-relocation-"));
  const copied = path.join(temporary, "plugin");
  try {
    await cp(pluginRoot, copied, { recursive: true });
    await withClient(copied, async (client) => {
      const result = await client.callTool({ name: TOOL_NAME, arguments: {} });
      assert.equal(result.structuredContent.board.tasks.length, 0);
      const read = await client.readResource({ uri: UI_URI });
      assert.match(read.contents[0].text, /任务看板/);
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("manifest preserves registered marketplace path and production has no path override", async () => {
  const marketplace = JSON.parse(await readFile(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].category, "Productivity");
  assert.equal(marketplace.plugins[0].source.path, `./plugins/${PRODUCT_ID}`);
  assert.equal(path.resolve(root, marketplace.plugins[0].source.path), pluginRoot);
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.interface.displayName, PRODUCT_NAME);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.hooks, undefined);
  const launch = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers[PRODUCT_ID];
  assert.deepEqual(launch, { command: "node", args: ["./dist/server.js"], cwd: "." });
  const production = await readFile(path.join(root, "src/server.mjs"), "utf8");
  assert.match(production, /homedir\(\).*"Library".*"Application Support".*"LearningBoard"/);
  assert.doesNotMatch(production, /process\.env|process\.argv|parseArgs/);
});

test("source factory exposes strict move_task through MCP with durable order, replay, and business errors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-board-source-protocol-"));
  const store = createFileStore(path.join(directory, "data"));
  const server = await createServer(store);
  const client = new Client({ name: "source-move-protocol", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.equal(client.getServerVersion().version, VERSION);
    const { tools } = await client.listTools();
    const operation = tools.find((tool) => tool.name === MUTATION_TOOL_NAME).inputSchema.properties.operation;
    const moveSchema = (operation.anyOf ?? operation.oneOf).find((variant) => variant.properties.type.const === "move_task");
    assert.equal(moveSchema.additionalProperties, false);
    assert.deepEqual(moveSchema.required.sort(), ["beforeTaskId", "status", "taskId", "type"]);
    let board = emptyBoard();
    async function mutate(operation, requestId = randomUUID()) {
      const input = { requestId, expectedRevision: board.revision, operation };
      const result = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: input });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      board = boardSchema.parse(result.structuredContent.board);
      return { input, result };
    }
    await mutate({ type: "save_project", project: { name: "协议项目一", description: "" } });
    await mutate({ type: "save_project", project: { name: "协议项目二", description: "" } });
    const taskInput = (projectId, title, status) => ({ type: "save_task", task: { projectId, title, status, sourceTool: "协议测试", currentStep: "", blocker: "", conversationUrl: null } });
    await mutate(taskInput(board.projects[0].id, "任务一", "planned"));
    await mutate(taskInput(board.projects[1].id, "任务二", "planned"));
    await mutate(taskInput(board.projects[0].id, "任务三", "in_progress"));
    const [first, second, third] = board.tasks;
    const moved = await mutate({ type: "move_task", taskId: second.id, status: "planned", beforeTaskId: first.id });
    assert.deepEqual(board.tasks.map((task) => task.id), [second.id, first.id, third.id]);
    assert.equal(board.tasks[0].projectId, second.projectId);
    await mutate({ type: "move_task", taskId: first.id, status: "in_progress", beforeTaskId: third.id });
    const durable = board;
    for (const [beforeTaskId, status, code] of [[randomUUID(), "planned", "NOT_FOUND"], [first.id, "in_progress", "INVALID_INPUT"], [second.id, "in_progress", "INVALID_INPUT"]]) {
      const result = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: {
        requestId: randomUUID(), expectedRevision: board.revision, operation: { type: "move_task", taskId: first.id, status, beforeTaskId },
      } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, code);
      assert.deepEqual(result.structuredContent.board, durable);
    }
    const replay = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: moved.input });
    assert.equal(replay.structuredContent.replayed, true);
    assert.equal(replay.structuredContent.appliedRevision, moved.result.structuredContent.appliedRevision);
    assert.deepEqual(replay.structuredContent.board, durable);
    const conflict = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: { ...moved.input, requestId: randomUUID() } });
    assert.equal(conflict.structuredContent.error.code, "REVISION_CONFLICT");
    const invalid = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: {
      requestId: randomUUID(), expectedRevision: board.revision, operation: { type: "move_task", taskId: first.id, status: "planned", beforeTaskId: null, projectId: second.projectId },
    } });
    assert.equal(invalid.isError, true);
    assert.deepEqual(await store.read(), { ok: true, board: durable });
    await writeFile(path.join(directory, "data/data.json"), "{broken");
    const damaged = await client.callTool({ name: TOOL_NAME, arguments: {} });
    assert.equal(damaged.isError, true);
    assert.equal(damaged.structuredContent.error.code, "INVALID_STORE");
    assert.equal(damaged.structuredContent.board, undefined, "Read failures may omit a board");
  } finally {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("source factory retains required successful output fields when publishing both result forms", async () => {
  const server = await createServer({ read: async () => ({ ok: true }), mutate: async () => ({ ok: true, board: emptyBoard() }) });
  const client = new Client({ name: "source-output-validation", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools();
    for (const [name, args] of [
      [TOOL_NAME, {}],
      [MUTATION_TOOL_NAME, { requestId: randomUUID(), expectedRevision: 0, operation: { type: "save_project", project: { name: "Fixture", description: "" } } }],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.ok(result.content.some((item) => item.type === "text" && /Output validation error/.test(item.text)));
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("source factory publishes app-only backup tool with strict read-only operations and valid SDK output variants", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-board-backup-protocol-"));
  const store = createFileStore(path.join(directory, "data"));
  const server = await createServer(store);
  const client = new Client({ name: "source-backup-protocol", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 9);
    const dataTool = tools.find((tool) => tool.name === "learning_board_data");
    assert.equal(dataTool.inputSchema.type, "object");
    assert.equal(dataTool.inputSchema.additionalProperties, false);
    assert.deepEqual(dataTool.inputSchema.required, ["action"]);
    assert.deepEqual(dataTool._meta.ui.visibility, ["app"]);
    assert.equal(dataTool._meta["openai/ui"], undefined);
    assert.equal(dataTool.annotations.readOnlyHint, true);
    const mutation = tools.find((tool) => tool.name === MUTATION_TOOL_NAME);
    assert.equal(mutation.annotations.destructiveHint, true);
    const operation = mutation.inputSchema.properties.operation;
    assert.ok((operation.anyOf ?? operation.oneOf).some((variant) => variant.properties.type.const === "restore_board"));
    const exported = await client.callTool({ name: "learning_board_data", arguments: { action: "export" } });
    assert.notEqual(exported.isError, true, JSON.stringify(exported));
    assert.equal(exported.structuredContent.backup.format, "learning-board-backup");
    const backup = exported.structuredContent.backup;
    const preview = await client.callTool({ name: "learning_board_data", arguments: { action: "preview_restore", backup } });
    assert.notEqual(preview.isError, true, JSON.stringify(preview));
    assert.deepEqual(preview.structuredContent.board, emptyBoard());
    assert.deepEqual(preview.structuredContent.preview, { sourceRevision: 0, projectCount: 0, taskCount: 0, sessionCount: 0, archivedProjectCount: 0, archivedTaskCount: 0 });
    for (const args of [{ action: "preview_restore" }, { action: "export", backup }, { action: "export", path: directory }, { action: "unknown" }]) {
      const result = await client.callTool({ name: "learning_board_data", arguments: args });
      assert.equal(result.isError, true, JSON.stringify(result));
    }
    const badChecksum = await client.callTool({ name: "learning_board_data", arguments: { action: "preview_restore", backup: { ...backup, checksum: "a".repeat(64) } } });
    assert.equal(badChecksum.structuredContent.error.code, "INVALID_INPUT");
    await assert.rejects(stat(path.join(directory, "data")), { code: "ENOENT" });
    const input = { requestId: randomUUID(), expectedRevision: 0, operation: { type: "save_project", project: { name: "备份协议项目", description: "" } } };
    const created = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: input });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.equal(created.structuredContent.entityId, created.structuredContent.board.projects[0].id);
    const replay = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: input });
    assert.equal(replay.structuredContent.entityId, created.structuredContent.entityId);
    const restored = await client.callTool({ name: MUTATION_TOOL_NAME, arguments: { requestId: randomUUID(), expectedRevision: 1, operation: { type: "restore_board", backup } } });
    assert.notEqual(restored.isError, true, JSON.stringify(restored));
    assert.equal(restored.structuredContent.board.revision, 2);
    assert.deepEqual(restored.structuredContent.board.projects, []);
    assert.equal(restored.structuredContent.entityId, undefined);
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
