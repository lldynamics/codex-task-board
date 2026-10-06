import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, createFileStore } from "../src/server-core.mjs";
import { UI_URI, VERSION } from "../src/board.mjs";
import { PRODUCT_ID, PRODUCT_NAME, LEGACY_UI_URIS } from "../src/product-identity.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "task-board-release-compatibility-"));
  const directory = path.join(root, "LearningBoard");
  await mkdir(directory);
  const server = await createServer(createFileStore(directory));
  const client = new Client({ name: "release-compatibility", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, directory };
}

test("public server identity keeps all legacy tool names and readable panel aliases with one global entrypoint", async (t) => {
  const { client } = await fixture(t);
  assert.equal(client.getServerVersion().name, PRODUCT_ID);
  assert.equal(client.getServerVersion().title, PRODUCT_NAME);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "learning_board", "learning_board_codex", "learning_board_codex_sync", "learning_board_context",
    "learning_board_data", "learning_board_feedback", "learning_board_mutate", "learning_board_plan", "learning_board_task",
  ].sort());
  const entrypoints = tools.filter((tool) => tool._meta?.["openai/ui"]?.entrypoints?.some((entry) => entry.type === "global"));
  assert.deepEqual(entrypoints.map((tool) => tool.name), ["learning_board"]);
  assert.equal(entrypoints[0]._meta.ui.resourceUri, UI_URI);
  const current = (await client.readResource({ uri: UI_URI })).contents[0];
  for (const uri of LEGACY_UI_URIS) {
    const legacy = (await client.readResource({ uri })).contents[0];
    assert.equal(legacy.uri, uri);
    assert.equal(legacy.text, current.text);
    assert.deepEqual(legacy._meta, current._meta);
  }
});

test("legacy LearningBoard data remains byte-for-byte intact during reads and old backup export and preview", async (t) => {
  const { client, directory } = await fixture(t);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const timestamp = "2026-10-05T00:00:00.000Z";
  const project = { id: projectId, name: "Existing project", description: "保留旧资料", lastUpdatedAt: timestamp };
  const task = {
    id: taskId, projectId, title: "Existing task", status: "in_progress", sourceTool: "Legacy",
    currentStep: "保留下一步", blocker: "Needs feedback", lastUpdatedAt: timestamp, conversationUrl: "https://example.org/existing-thread",
  };
  const appliedRequests = Array.from({ length: 7 }, (_, index) => ({ requestId: randomUUID(), fingerprint: "a".repeat(64), appliedRevision: index + 1 }));
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, revision: 7, syncState: "unsynced", persistence: "local", projects: [project], tasks: [task], appliedRequests }, null, 2) + "\n");
  const filename = path.join(directory, "data.json");
  await writeFile(filename, bytes);
  const read = await client.callTool({ name: "learning_board_context", arguments: {} });
  assert.notEqual(read.isError, true);
  assert.equal(read.structuredContent.board.revision, 7);
  assert.deepEqual(read.structuredContent.board.projects[0], { ...project, archivedAt: null });
  assert.deepEqual(read.structuredContent.board.tasks[0], { ...task, archivedAt: null, priority: "normal", dueDate: null });
  const exported = await client.callTool({ name: "learning_board_data", arguments: { action: "export" } });
  assert.notEqual(exported.isError, true);
  assert.equal(exported.structuredContent.backup.format, "learning-board-backup");
  const preview = await client.callTool({ name: "learning_board_data", arguments: { action: "preview_restore", backup: exported.structuredContent.backup } });
  assert.notEqual(preview.isError, true);
  assert.deepEqual(preview.structuredContent.board, read.structuredContent.board);
  assert.deepEqual(await readFile(filename), bytes);
});

test("renamed server reports damaged legacy data without replacing or resetting it", async (t) => {
  const { client, directory } = await fixture(t);
  const filename = path.join(directory, "data.json");
  const bytes = Buffer.from("{damaged legacy data");
  await writeFile(filename, bytes);
  const result = await client.callTool({ name: "learning_board", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "INVALID_STORE");
  assert.deepEqual(await readFile(filename), bytes);
});
