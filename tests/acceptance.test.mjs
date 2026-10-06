import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

// Independent V1 acceptance: every server is a child process, imports only the
// relocated plugin bundle, and receives an explicit mkdtemp store. Never run server.js or
// use the production ~/Library/Application Support/LearningBoard directory.
const pluginDirectory = fileURLToPath(new URL("../plugins/codex-task-board/", import.meta.url));
const statuses = ["planned", "in_progress", "waiting_user", "paused", "completed", "failed"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-board-v1-acceptance-"));
  const dataDirectory = path.join(directory, "store");
  const copiedPlugin = path.join(directory, "plugin");
  const runner = path.join(directory, "runner.mjs");
  const clients = new Set();
  try {
    await mkdir(dataDirectory);
    await cp(pluginDirectory, copiedPlugin, { recursive: true });
    await writeFile(runner, `import { createServer, createFileStore, StdioServerTransport } from "./plugin/dist/server-core.js";\nimport * as fs from "node:fs/promises";\nconst options = process.argv[3] === "fail-rename" ? { io: { ...fs, rename: async () => { throw Object.assign(new Error("Synthetic acceptance write failure"), { code: "EIO" }); } } } : {};\nconst store = createFileStore(process.argv[2], options);\nawait (await createServer(store)).connect(new StdioServerTransport());\n`);
    async function open({ failRename = false } = {}) {
      const transport = new StdioClientTransport({
        command: process.execPath, args: [runner, dataDirectory, ...(failRename ? ["fail-rename"] : [])], cwd: directory, stderr: "pipe",
      });
      const client = new Client({ name: "independent-acceptance", version: "0.11.0" });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      const session = {
        client,
        async close() {
          await client.close();
          clients.delete(session);
          assert.equal(stderr, "", "Bundled server must have no runtime errors on stderr");
        },
      };
      clients.add(session);
      await client.connect(transport);
      assert.equal(client.getServerVersion().version, "0.11.0");
      return session;
    }
    await run({ open, dataDirectory, runner });
  } finally {
    for (const session of clients) await session.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function call(client, name, args) {
  return client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, { timeout: 5000 });
}

function success(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, true);
  const board = result.structuredContent.board;
  assert.equal(board.schemaVersion, 4);
  assert.equal(board.syncState, "unsynced");
  assert.equal(board.persistence, "local");
  assert.ok(Number.isSafeInteger(board.revision) && board.revision >= 0);
  assert.ok(Array.isArray(board.projects));
  assert.ok(Array.isArray(board.tasks));
  assert.ok(Array.isArray(board.sessions));
  return board;
}

function failure(result, codes) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, false);
  assert.ok(codes.includes(result.structuredContent.error.code), JSON.stringify(result));
  assert.equal(typeof result.structuredContent.error.message, "string");
  return result.structuredContent;
}

async function inputRejected(run) {
  let result;
  try { result = await run(); }
  catch (error) {
    assert.ok(Number.isInteger(error.code) && error.code < 0, "Input rejection must be a JSON-RPC error");
    assert.ok(typeof error.message === "string" && error.message.length > 0);
    return;
  }
  // The MCP SDK rejects schema-invalid arguments before the store callback.
  // Its standard isError result has text content but need not contain the
  // store's structured INVALID_INPUT envelope. Business errors stay strict.
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.ok(result.content?.some((item) => item.type === "text" && item.text.length > 0));
  if (result.structuredContent) failure(result, ["INVALID_INPUT"]);
}

const read = async (client) => success(await call(client, "learning_board", {}));
const command = (revision, operation, requestId = randomUUID()) => ({ requestId, expectedRevision: revision, operation });
const projectOperation = (name, id) => ({ type: "save_project", project: { ...(id ? { id } : {}), name, description: "Synthetic acceptance fixture" } });
const taskOperation = (projectId, status, id) => ({
  type: "save_task", task: {
    ...(id ? { id } : {}), projectId, title: "Synthetic practice task", status,
    sourceTool: "Manual fixture", currentStep: "Synthetic step", blocker: "", conversationUrl: null,
  },
});
const moveOperation = (taskId, status, beforeTaskId = null) => ({ type: "move_task", taskId, status, beforeTaskId });

test("V1 acceptance: blank store, create/edit project and task, six states, and restart recovery over real stdio", { timeout: 30000 }, async () => {
  await fixture(async ({ open }) => {
    const session = await open();
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["learning_board", "learning_board_codex", "learning_board_codex_sync", "learning_board_context", "learning_board_data", "learning_board_feedback", "learning_board_mutate", "learning_board_plan", "learning_board_task"]);
    let board = await read(session.client);
    assert.equal(board.revision, 0);
    assert.deepEqual(board.projects, []);
    assert.deepEqual(board.tasks, []);
    const create = command(board.revision, projectOperation("Synthetic project"));
    const created = await call(session.client, "learning_board_mutate", create);
    board = success(created);
    assert.equal(created.structuredContent.replayed, false);
    assert.equal(created.structuredContent.appliedRevision, 1);
    assert.equal(board.revision, 1);
    assert.equal(board.projects.length, 1);
    const project = board.projects[0];
    assert.match(project.id, uuidPattern);
    assert.equal(project.name, "Synthetic project");
    assert.ok(Number.isFinite(Date.parse(project.lastUpdatedAt)));

    let taskId;
    for (const status of statuses) {
      const before = board.revision;
      const result = await call(session.client, "learning_board_mutate", command(before, taskOperation(project.id, status, taskId)));
      board = success(result);
      assert.equal(board.revision, before + 1);
      assert.equal(board.tasks.length, 1);
      const task = board.tasks[0];
      taskId ??= task.id;
      assert.match(taskId, uuidPattern);
      assert.equal(task.id, taskId);
      assert.equal(task.projectId, project.id);
      assert.equal(task.status, status);
      assert.equal(task.conversationUrl, null);
      assert.ok(Number.isFinite(Date.parse(task.lastUpdatedAt)));
    }
    const editTask = taskOperation(project.id, "failed", taskId);
    Object.assign(editTask.task, {
      title: "Edited synthetic practice task", currentStep: "Edited synthetic step", blocker: "Synthetic blocker",
    });
    const beforeTaskEdit = board.revision;
    board = success(await call(session.client, "learning_board_mutate", command(beforeTaskEdit, editTask)));
    assert.equal(board.revision, beforeTaskEdit + 1);
    assert.equal(board.tasks.length, 1);
    assert.equal(board.tasks[0].title, editTask.task.title);
    assert.equal(board.tasks[0].currentStep, editTask.task.currentStep);
    assert.equal(board.tasks[0].blocker, editTask.task.blocker);
    const beforeEdit = board.revision;
    board = success(await call(session.client, "learning_board_mutate", command(beforeEdit, projectOperation("Edited synthetic project", project.id))));
    assert.equal(board.revision, beforeEdit + 1);
    assert.equal(board.projects.length, 1);
    assert.equal(board.projects[0].name, "Edited synthetic project");
    assert.equal(board.tasks[0].projectId, project.id);
    await session.close();
    const restarted = await open();
    assert.deepEqual(await read(restarted.client), board, "Restart must recover identical durable state");
    const replayed = await call(restarted.client, "learning_board_mutate", create);
    assert.deepEqual(success(replayed), board);
    assert.equal(replayed.structuredContent.replayed, true);
    assert.equal(replayed.structuredContent.appliedRevision, 1);
    failure(await call(restarted.client, "learning_board_mutate", {
      ...create, operation: projectOperation("Changed request contents"),
    }), ["REQUEST_ID_REUSE"]);
    assert.deepEqual(await read(restarted.client), board, "Request ID reuse must preserve current state");
  });
});

test("V1 acceptance: two real stdio processes race on the same revision without losing an update", { timeout: 30000 }, async () => {
  await fixture(async ({ open }) => {
    const first = await open();
    const second = await open();
    let board = await read(first.client);
    for (let round = 0; round < 6; round++) {
      assert.deepEqual(await read(second.client), board);
      const before = board.revision;
      const results = await Promise.all([
        call(first.client, "learning_board_mutate", command(before, projectOperation(`Synthetic left ${round}`))),
        call(second.client, "learning_board_mutate", command(before, projectOperation(`Synthetic right ${round}`))),
      ]);
      const winners = results.filter((result) => result.structuredContent?.ok === true);
      const losers = results.filter((result) => result.structuredContent?.ok === false);
      assert.equal(winners.length, 1, JSON.stringify(results));
      assert.equal(losers.length, 1, JSON.stringify(results));
      failure(losers[0], ["BUSY", "REVISION_CONFLICT"]);
      board = success(winners[0]);
      assert.equal(board.revision, before + 1);
      assert.equal(board.projects.length, round + 1);
      assert.deepEqual(await read(first.client), board);
      assert.deepEqual(await read(second.client), board);
    }
    await first.close();
    await second.close();
    const restarted = await open();
    assert.deepEqual(await read(restarted.client), board);
  });
});

test("V1 acceptance: malformed JSON and unsupported schema reject reads and writes while preserving bytes", { timeout: 30000 }, async () => {
  for (const damage of ["malformed-json", "unsupported-schema"]) {
    await fixture(async ({ open, dataDirectory }) => {
      const filename = path.join(dataDirectory, "data.json");
      const seed = await open();
      success(await call(seed.client, "learning_board_mutate", command(0, projectOperation("Synthetic preservation fixture"))));
      await seed.close();
      const original = JSON.parse(await readFile(filename, "utf8"));
      const bytes = Buffer.from(damage === "malformed-json" ? "{broken-json" : JSON.stringify({ ...original, schemaVersion: 999 }));
      await writeFile(filename, bytes);
      const session = await open();
      failure(await call(session.client, "learning_board", {}), ["INVALID_STORE"]);
      failure(await call(session.client, "learning_board_mutate", command(0, projectOperation("Synthetic rejected write"))), ["INVALID_STORE"]);
      assert.deepEqual(await readFile(filename), bytes);
      await session.close();
      const restarted = await open();
      failure(await call(restarted.client, "learning_board", {}), ["INVALID_STORE"]);
      assert.deepEqual(await readFile(filename), bytes);
    });
  }
});

test("V1 acceptance: injected atomic rename failure reports SAVE_FAILED and preserves durable bytes", { timeout: 30000 }, async () => {
  await fixture(async ({ open, dataDirectory }) => {
    const seed = await open();
    const board = success(await call(seed.client, "learning_board_mutate", command(0, projectOperation("Synthetic durable project"))));
    await seed.close();
    const filename = path.join(dataDirectory, "data.json");
    const before = await readFile(filename);
    const failing = await open({ failRename: true });
    const attempted = command(board.revision, projectOperation("Synthetic retry fixture"));
    failure(await call(failing.client, "learning_board_mutate", attempted), ["SAVE_FAILED"]);
    assert.deepEqual(await readFile(filename), before);
    assert.deepEqual(await read(failing.client), board);
    await failing.close();
    const restarted = await open();
    assert.deepEqual(await read(restarted.client), board);
    const retry = await call(restarted.client, "learning_board_mutate", attempted);
    const recovered = success(retry);
    assert.equal(retry.structuredContent.replayed, false, "An uncommitted request must be applied on retry");
    assert.equal(recovered.revision, board.revision + 1);
    assert.equal(recovered.projects.length, 2, "Failure must release the lock and permit a later save");
  });
});

test("V1 acceptance: no delete, storage path override, invalid status, or orphan task can mutate state", { timeout: 30000 }, async () => {
  await fixture(async ({ open, dataDirectory }) => {
    const session = await open();
    const board = success(await call(session.client, "learning_board_mutate", command(0, projectOperation("Synthetic validation fixture"))));
    const filename = path.join(dataDirectory, "data.json");
    const before = await readFile(filename);
    const invalidInputs = [
      command(board.revision, { type: "delete_project", id: randomUUID() }),
      command(board.revision, { type: "delete_task", id: randomUUID() }),
      { ...command(board.revision, projectOperation("Synthetic invalid path")), path: path.join(dataDirectory, "other.json") },
      command(board.revision, { ...projectOperation("Synthetic nested path"), path: path.join(dataDirectory, "other.json") }),
      command(board.revision, taskOperation(randomUUID(), "unknown")),
      "invalid-scalar",
    ];
    for (const input of invalidInputs) {
      await inputRejected(() => call(session.client, "learning_board_mutate", input));
      assert.deepEqual(await read(session.client), board);
      assert.deepEqual(await readFile(filename), before);
    }
    await inputRejected(() => call(session.client, "learning_board", { path: dataDirectory }));
    await inputRejected(() => call(session.client, "learning_board", "invalid-scalar"));
    failure(await call(session.client, "learning_board_mutate", command(board.revision, taskOperation(randomUUID(), "planned"))), ["NOT_FOUND"]);
    assert.deepEqual(await read(session.client), board);
    assert.deepEqual(await readFile(filename), before);
    const recovered = success(await call(session.client, "learning_board_mutate", command(board.revision, projectOperation("Synthetic valid follow-up"))));
    assert.equal(recovered.revision, board.revision + 1);
    assert.equal(recovered.projects.length, 2);
  });
});

test("V3 acceptance: real stdio persists column ordering and cross-column moves through restart, replay, validation, and CAS", { timeout: 30000 }, async () => {
  await fixture(async ({ open, dataDirectory }) => {
    const session = await open();
    let board = await read(session.client);
    async function mutate(operation) {
      const input = command(board.revision, operation);
      const result = await call(session.client, "learning_board_mutate", input);
      board = success(result);
      return { input, result };
    }
    await mutate(projectOperation("Synthetic ordering project"));
    await mutate(projectOperation("Synthetic second ordering project"));
    for (const [index, status] of ["planned", "in_progress", "planned", "planned", "completed"].entries()) {
      const operation = taskOperation(board.projects[index >= 3 ? 1 : 0].id, status);
      operation.task.title = `Synthetic ordering task ${index + 1}`;
      await mutate(operation);
    }
    const original = board;
    const [a, b, c, d, e] = board.tasks;
    const firstMove = await mutate(moveOperation(a.id, "planned", d.id));
    assert.deepEqual(board.tasks.map((task) => task.id), [b.id, c.id, a.id, d.id, e.id]);
    await mutate(moveOperation(d.id, "planned", c.id));
    assert.deepEqual(board.tasks.map((task) => task.id), [b.id, d.id, c.id, a.id, e.id]);
    await mutate(moveOperation(c.id, "completed", e.id));
    assert.deepEqual(board.tasks.map((task) => task.id), [b.id, d.id, a.id, c.id, e.id]);
    const moved = board.tasks.find((task) => task.id === c.id);
    assert.deepEqual(moved, { ...c, status: "completed", lastUpdatedAt: moved.lastUpdatedAt });
    await mutate(moveOperation(d.id, "planned"));
    assert.deepEqual(board.tasks.map((task) => task.id), [b.id, a.id, c.id, e.id, d.id]);
    const edited = taskOperation(a.projectId, "planned", a.id);
    edited.task.title = "Synthetic edited task preserves order";
    await mutate(edited);
    assert.deepEqual(board.tasks.map((task) => task.id), [b.id, a.id, c.id, e.id, d.id]);
    assert.deepEqual(Object.keys(board).sort(), Object.keys(original).sort());
    assert.deepEqual(Object.keys(board.tasks[0]).sort(), Object.keys(original.tasks[0]).sort());
    await session.close();
    const restarted = await open();
    assert.deepEqual(await read(restarted.client), board);
    const filename = path.join(dataDirectory, "data.json");
    const bytes = await readFile(filename);
    const replay = await call(restarted.client, "learning_board_mutate", firstMove.input);
    assert.deepEqual(success(replay), board);
    assert.equal(replay.structuredContent.replayed, true);
    assert.equal(replay.structuredContent.appliedRevision, firstMove.result.structuredContent.appliedRevision);
    const invalid = [
      [moveOperation(randomUUID(), "planned"), "NOT_FOUND"],
      [moveOperation(a.id, "planned", randomUUID()), "NOT_FOUND"],
      [moveOperation(a.id, "planned", a.id), "INVALID_INPUT"],
      [moveOperation(a.id, "planned", e.id), "INVALID_INPUT"],
    ];
    for (const [operation, code] of invalid) {
      const result = failure(await call(restarted.client, "learning_board_mutate", command(board.revision, operation)), [code]);
      assert.deepEqual(result.board, board);
      assert.deepEqual(await readFile(filename), bytes);
    }
    await inputRejected(() => call(restarted.client, "learning_board_mutate", command(board.revision, moveOperation(a.id, "unknown"))));
    await inputRejected(() => call(restarted.client, "learning_board_mutate", command(board.revision, { ...moveOperation(a.id, "planned"), projectId: d.projectId })));
    assert.deepEqual(await readFile(filename), bytes);
    const competitor = await open();
    const concurrent = await Promise.all([
      call(restarted.client, "learning_board_mutate", command(board.revision, moveOperation(a.id, "in_progress", b.id))),
      call(competitor.client, "learning_board_mutate", command(board.revision, moveOperation(d.id, "completed"))),
    ]);
    const winners = concurrent.filter((result) => result.structuredContent?.ok === true);
    const losers = concurrent.filter((result) => result.structuredContent?.ok === false);
    assert.equal(winners.length, 1, JSON.stringify(concurrent));
    assert.equal(losers.length, 1, JSON.stringify(concurrent));
    failure(losers[0], ["BUSY", "REVISION_CONFLICT"]);
    const winningBoard = success(winners[0]);
    assert.equal(winningBoard.revision, board.revision + 1);
    assert.equal(winningBoard.tasks.length, 5);
    assert.deepEqual(await read(restarted.client), winningBoard);
    assert.deepEqual(await read(competitor.client), winningBoard);
    await restarted.close();
    await competitor.close();
    const afterRace = await open();
    assert.deepEqual(await read(afterRace.client), winningBoard);
  });
});

test("V3 acceptance: failed move rename keeps durable order and status and permits an identical request retry", { timeout: 30000 }, async () => {
  await fixture(async ({ open, dataDirectory }) => {
    const seed = await open();
    let board = success(await call(seed.client, "learning_board_mutate", command(0, projectOperation("Synthetic move failure project"))));
    board = success(await call(seed.client, "learning_board_mutate", command(board.revision, taskOperation(board.projects[0].id, "planned"))));
    board = success(await call(seed.client, "learning_board_mutate", command(board.revision, taskOperation(board.projects[0].id, "completed"))));
    await seed.close();
    const filename = path.join(dataDirectory, "data.json");
    const bytes = await readFile(filename);
    const attempted = command(board.revision, moveOperation(board.tasks[0].id, "completed"));
    const failing = await open({ failRename: true });
    const failed = failure(await call(failing.client, "learning_board_mutate", attempted), ["SAVE_FAILED"]);
    assert.deepEqual(failed.board, board);
    assert.deepEqual(await readFile(filename), bytes);
    assert.deepEqual(await read(failing.client), board);
    await failing.close();
    const restarted = await open();
    const retry = await call(restarted.client, "learning_board_mutate", attempted);
    const moved = success(retry);
    assert.equal(retry.structuredContent.replayed, false);
    assert.equal(moved.revision, board.revision + 1);
    assert.deepEqual(moved.tasks.map((task) => task.id), [board.tasks[1].id, board.tasks[0].id]);
    assert.equal(moved.tasks.at(-1).status, "completed");
    const replay = await call(restarted.client, "learning_board_mutate", attempted);
    assert.equal(replay.structuredContent.replayed, true);
    assert.deepEqual(success(replay), moved);
  });
});
