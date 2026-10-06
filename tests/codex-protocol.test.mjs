import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, createFileStore } from "../src/server-core.mjs";
import { CODEX_TOOL_NAME, CODEX_SYNC_TOOL_NAME, codexSnapshotSchema, unavailableCodexSnapshot } from "../src/codex-domain.mjs";

async function fixture(t, options) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-board-protocol-"));
  const server = await createServer(createFileStore(path.join(directory, "manual")), options);
  const client = new Client({ name: "codex-board-protocol", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  return { client, directory };
}

test("Codex snapshot tool is app-only and defaults to an unavailable source without accessing user data", async (t) => {
  const { client, directory } = await fixture(t);
  const tool = (await client.listTools()).tools.find((entry) => entry.name === CODEX_TOOL_NAME);
  assert.deepEqual(tool._meta.ui.visibility, ["app"]);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const result = await client.callTool({ name: CODEX_TOOL_NAME, arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  const snapshot = codexSnapshotSchema.parse(result.structuredContent.snapshot);
  assert.equal(snapshot.connection.state, "unsupported");
  assert.deepEqual(snapshot.threads, []);
  assert.deepEqual(await readdir(directory), [], "Reading Codex must not create the manual store or backups");
});

test("Codex metadata is isolated from the manual board and input cannot choose a private path", async (t) => {
  const snapshot = unavailableCodexSnapshot("2026-10-05T08:00:00.000Z");
  let reads = 0;
  const { client, directory } = await fixture(t, { codex: { read: async () => { reads++; return snapshot; } } });
  const invalid = await client.request({ method: "tools/call", params: { name: CODEX_TOOL_NAME, arguments: { path: "/private/anything" } } }, CallToolResultSchema);
  assert.equal(invalid.isError, true);
  assert.equal(reads, 0);
  const result = await client.callTool({ name: CODEX_TOOL_NAME, arguments: {} });
  assert.deepEqual(result.structuredContent, { ok: true, snapshot });
  assert.equal(reads, 1);
  const manual = await client.callTool({ name: "learning_board", arguments: {} });
  assert.equal(manual.structuredContent.board.revision, 0);
  assert.deepEqual(manual.structuredContent.board.tasks, []);
  assert.deepEqual(await readdir(directory), []);
});

test("Invalid or failing Codex sources never emit an apparently successful snapshot", async (t) => {
  for (const read of [async () => ({ ...unavailableCodexSnapshot(), unexpected: "private" }), async () => { throw new Error("Synthetic source unavailable"); }]) {
    const { client } = await fixture(t, { codex: { read } });
    const result = await client.request({ method: "tools/call", params: { name: CODEX_TOOL_NAME, arguments: {} } }, CallToolResultSchema);
    assert.equal(result.isError, true);
    assert.notEqual(result.structuredContent?.ok, true);
  }
});

test("Codex schema rejects duplicate source identity and accidental private fields", () => {
  const snapshot = unavailableCodexSnapshot();
  const thread = { id: "id", hostId: "local", title: "任务", cwd: null, updatedAt: null, runtimeStatus: "idle", attention: null, lastTurnStatus: null, goalStatus: null };
  snapshot.threads = [thread, { ...thread }];
  assert.equal(codexSnapshotSchema.safeParse(snapshot).success, false);
  snapshot.threads[1].hostId = "fedora";
  assert.equal(codexSnapshotSchema.safeParse(snapshot).success, true);
  snapshot.threads[0].prompt = "must not escape";
  assert.equal(codexSnapshotSchema.safeParse(snapshot).success, false);
});

test("Native collector is model-only, metadata-only and cannot control threads or write the manual board", async (t) => {
  const input = { capturedAt: "2026-10-05T08:00:00.000Z", limit: 50, result: { pinnedThreads: [], threads: [{ id: "thread-1", kind: "codex", hostId: "local", title: "Test", cwd: null, status: "idle", updatedAt: 1791187200 }], unavailableHosts: [], unavailableSources: [] } };
  let accepted;
  const receipt = { ok: true, capturedAt: input.capturedAt, threadCount: 1, complete: true, truncated: false, unchanged: false };
  const { client, directory } = await fixture(t, { collectCodex: async (value) => { accepted = value; return receipt; } });
  const tool = (await client.listTools()).tools.find((entry) => entry.name === CODEX_SYNC_TOOL_NAME);
  assert.deepEqual(tool._meta.ui.visibility, ["model"]);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false);
  const result = await client.callTool({ name: CODEX_SYNC_TOOL_NAME, arguments: input });
  assert.deepEqual(accepted, input);
  assert.deepEqual(result.structuredContent, receipt);
  for (const invalid of [
    { ...input, directory: "/arbitrary" },
    { ...input, operation: "start-thread" },
    { ...input, result: { ...input.result, threads: [{ ...input.result.threads[0], summary: "private content" }] } },
  ]) {
    const response = await client.request({ method: "tools/call", params: { name: CODEX_SYNC_TOOL_NAME, arguments: invalid } }, CallToolResultSchema);
    assert.equal(response.isError, true);
  }
  assert.deepEqual(await readdir(directory), []);
});
