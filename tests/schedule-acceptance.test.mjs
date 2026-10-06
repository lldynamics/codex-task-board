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

// Exercise the relocated, self-contained release plugin over real stdio. Every
// child gets an explicit temporary data directory; no production server/store.
const pluginDirectory = fileURLToPath(new URL("../plugins/codex-task-board/", import.meta.url));
async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-calendar-acceptance-"));
  const dataDirectory = path.join(directory, "store");
  const clients = new Set();
  try {
    await mkdir(dataDirectory);
    await cp(pluginDirectory, path.join(directory, "plugin"), { recursive: true });
    const runner = path.join(directory, "runner.mjs");
    await writeFile(runner, 'import { createServer, createFileStore, StdioServerTransport } from "./plugin/dist/server-core.js";\nawait (await createServer(createFileStore(process.argv[2]))).connect(new StdioServerTransport());\n');
    async function open() {
      const transport = new StdioClientTransport({ command: process.execPath, args: [runner, dataDirectory], cwd: directory, stderr: "pipe" });
      const client = new Client({ name: "calendar-independent-acceptance", version: "0.11.0" });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
      const session = { client, async close() {
        await client.close();
        clients.delete(session);
        assert.equal(stderr, "", "Relocated server must have no runtime stderr errors");
      } };
      clients.add(session);
      await client.connect(transport);
      assert.equal(client.getServerVersion().version, "0.11.0");
      return session;
    }
    await run({ open, dataDirectory });
  } finally {
    for (const session of clients) await session.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const rawCall = (client, name, args) => client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema, { timeout: 5000 });
const MODEL_WRITE_TOOLS = new Set(["learning_board_plan", "learning_board_feedback", "learning_board_task"]);
// Model write tools return a compact receipt. Check it, then attach the full
// board read through the model context tool so state assertions stay complete.
async function call(client, name, args) {
  const result = await rawCall(client, name, args);
  if (!MODEL_WRITE_TOOLS.has(name)) return result;
  assert.equal(Object.hasOwn(result.structuredContent ?? {}, "board"), false, "Model write tools must not return the whole board");
  if (result.structuredContent?.ok !== true) return result;
  assert.ok(Number.isSafeInteger(result.structuredContent.revision));
  const context = await rawCall(client, "learning_board_context", { includeArchived: true });
  const board = context.structuredContent.board;
  assert.equal(board.revision, result.structuredContent.revision);
  for (const key of ["projects", "tasks", "sessions"]) for (const record of result.structuredContent.changed?.[key] ?? []) assert.deepEqual(board[key].find((item) => item.id === record.id), record);
  return { ...result, structuredContent: { ...result.structuredContent, board } };
}
function success(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, true);
  assert.equal(result.structuredContent.board.schemaVersion, 4);
  return result.structuredContent.board;
}
function failure(result, codes) {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, false);
  assert.ok(codes.includes(result.structuredContent.error.code), JSON.stringify(result));
}
async function inputRejected(run) {
  let result;
  try { result = await run(); }
  catch (error) {
    assert.ok(Number.isInteger(error.code) && error.code < 0, "Expected schema rejection as a JSON-RPC error");
    return;
  }
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.ok(result.content?.some((item) => item.type === "text" && item.text.length > 0));
  if (result.structuredContent) failure(result, ["INVALID_INPUT"]);
}
const read = async (client) => success(await call(client, "learning_board_context", {}));
const command = (revision, operation, requestId = randomUUID()) => ({ requestId, expectedRevision: revision, operation });
const slot = (taskId, hour, extra = {}) => ({ taskId, startAt: `2099-01-02T${String(hour).padStart(2, "0")}:00:00.000Z`, endAt: `2099-01-02T${String(hour + 1).padStart(2, "0")}:00:00.000Z`, timeZone: "Asia/Shanghai", objective: "Practice a section", completionCriteria: "Explain without notes", ...extra });
function newPlan() {
  const projectId = randomUUID();
  const taskIds = [randomUUID(), randomUUID()];
  return { type: "apply_schedule", newProject: { id: projectId, name: "Calendar acceptance", description: "Temporary fixture" }, newTasks: taskIds.map((id, index) => ({
    id, projectId, title: `Practice ${index + 1}`, status: "planned", sourceTool: "Independent acceptance", currentStep: "Review chapter", blocker: "", conversationUrl: null,
    priority: "normal", dueDate: "2099-01-10",
  })), sessions: [slot(taskIds[0], 9), slot(taskIds[0], 10), slot(taskIds[1], 11, { timeZone: "America/New_York" })] };
}

test("Calendar stdio: authorized batch, replay, early feedback correction and restart preserve task independence", { timeout: 30000 }, async () => fixture(async ({ open }) => {
  const session = await open();
  const context = await call(session.client, "learning_board_context", {});
  const board0 = success(context);
  assert.equal(board0.revision, 0);
  assert.deepEqual(board0.sessions, []);
  assert.ok(Math.abs(Date.parse(context.structuredContent.serverNow) - Date.now()) < 10000);
  const tools = (await session.client.listTools()).tools;
  for (const name of ["learning_board_context", "learning_board_plan", "learning_board_feedback"]) {
    assert.deepEqual(tools.find((tool) => tool.name === name)._meta.ui.visibility, ["model"]);
  }
  const operation = newPlan();
  const request = command(board0.revision, operation);
  const applied = await call(session.client, "learning_board_plan", request);
  let board = success(applied);
  assert.equal(board.revision, 1, "One batch must commit one revision");
  assert.equal(applied.structuredContent.appliedRevision, 1);
  assert.equal(applied.structuredContent.replayed, false);
  assert.equal(board.projects.length, 1);
  assert.equal(board.tasks.length, 2);
  assert.equal(board.sessions.length, 3, "A task can have multiple adjacent sessions");
  const taskBefore = structuredClone(board.tasks);
  const sessionId = board.sessions[0].id;
  assert.equal(board.sessions[2].timeZone, "America/New_York");
  assert.equal(board.tasks[0].dueDate, "2099-01-10", "Deadline remains separate from session date");
  const replay = await call(session.client, "learning_board_plan", request);
  assert.deepEqual(success(replay), board);
  assert.equal(replay.structuredContent.replayed, true);
  failure(await call(session.client, "learning_board_plan", { ...request, operation: { ...operation, sessions: operation.sessions.slice(1) } }), ["REQUEST_ID_REUSE"]);
  board = success(await call(session.client, "learning_board_feedback", command(board.revision, { type: "record_session_feedback", sessionId, status: "completed", feedback: "Finished early", actualMinutes: 25 })));
  assert.equal(board.sessions[0].status, "completed", "Future sessions may be completed early");
  assert.deepEqual(board.tasks, taskBefore, "Completing a session must not complete or edit its task");
  board = success(await call(session.client, "learning_board_feedback", command(board.revision, { type: "record_session_feedback", sessionId, status: "not_completed", feedback: "Corrected report", actualMinutes: 0 })));
  assert.equal(board.sessions[0].status, "not_completed");
  assert.equal(board.sessions[0].feedback, "Corrected report");
  assert.equal(board.sessions[0].actualMinutes, 0);
  assert.deepEqual(board.tasks, taskBefore);
  failure(await call(session.client, "learning_board_plan", command(board.revision, { type: "apply_schedule", newTasks: [], sessions: [slot(board.tasks[0].id, 14, { id: sessionId })] })), ["SESSION_LOCKED"]);
  const cancelId = board.sessions[1].id;
  board = success(await call(session.client, "learning_board_mutate", command(board.revision, { type: "cancel_session", sessionId: cancelId })));
  failure(await call(session.client, "learning_board_feedback", command(board.revision, { type: "record_session_feedback", sessionId: cancelId, status: "completed", feedback: "Invalid cancelled feedback", actualMinutes: null })), ["SESSION_LOCKED"]);
  await session.close();
  const restarted = await open();
  assert.deepEqual(await read(restarted.client), board);
  const replayAfterRestart = await call(restarted.client, "learning_board_plan", request);
  assert.deepEqual(success(replayAfterRestart), board);
  assert.equal(replayAfterRestart.structuredContent.replayed, true);
  assert.equal(replayAfterRestart.structuredContent.appliedRevision, 1);
}));

test("Calendar stdio: model tools reject generic writes and malformed scheduling without durable changes", { timeout: 30000 }, async () => fixture(async ({ open, dataDirectory }) => {
  const session = await open();
  let board = success(await call(session.client, "learning_board_plan", command(0, newPlan())));
  const filename = path.join(dataDirectory, "data.json");
  const before = await readFile(filename);
  const backup = (await call(session.client, "learning_board_data", { action: "export" })).structuredContent.backup;
  const generic = [
    { type: "save_project", project: { name: "Unauthorized generic write", description: "" } },
    { type: "archive_task", taskId: board.tasks[0].id, archived: true },
    { type: "restore_board", backup },
    { type: "save_session", session: slot(board.tasks[0].id, 14) },
  ];
  for (const operation of generic) await inputRejected(() => call(session.client, "learning_board_plan", command(board.revision, operation)));
  await inputRejected(() => call(session.client, "learning_board_feedback", command(board.revision, { type: "cancel_session", sessionId: board.sessions[0].id })));
  const badInputs = [
    slot(board.tasks[0].id, 14, { startAt: "2099-02-30T14:00:00.000Z" }),
    slot(board.tasks[0].id, 14, { startAt: "2099-01-02T14:00:00+08:00" }),
    slot(board.tasks[0].id, 14, { endAt: "2099-01-02T14:00:00.000Z" }),
    slot(board.tasks[0].id, 14, { timeZone: "+08:00" }),
    slot(board.tasks[0].id, 14, { status: "completed" }),
  ];
  for (const input of badInputs) await inputRejected(() => call(session.client, "learning_board_plan", command(board.revision, { type: "apply_schedule", newTasks: [], sessions: [input] })));
  failure(await call(session.client, "learning_board_mutate", command(board.revision, { type: "save_session", session: slot(board.tasks[0].id, 14, { id: randomUUID() }) })), ["NOT_FOUND"]);
  failure(await call(session.client, "learning_board_plan", command(board.revision, { type: "apply_schedule", newTasks: [], sessions: [slot(board.tasks[1].id, 14, { id: board.sessions[0].id })] })), ["INVALID_INPUT"]);
  failure(await call(session.client, "learning_board_plan", command(board.revision, { type: "apply_schedule", newTasks: [], sessions: [slot(board.tasks[0].id, 14, { startAt: "2000-01-01T14:00:00.000Z", endAt: "2000-01-01T15:00:00.000Z" })] })), ["INVALID_INPUT"]);
  assert.deepEqual(await readFile(filename), before);
  assert.deepEqual(await read(session.client), board);
}));

test("Calendar stdio: final half-open schedule accepts swap and rejects overlapping batch atomically", { timeout: 30000 }, async () => fixture(async ({ open, dataDirectory }) => {
  const session = await open();
  let board = success(await call(session.client, "learning_board_plan", command(0, newPlan())));
  const left = board.sessions[0], right = board.sessions[1];
  board = success(await call(session.client, "learning_board_plan", command(board.revision, { type: "apply_schedule", newTasks: [], sessions: [
    slot(left.taskId, 10, { id: left.id }), slot(right.taskId, 9, { id: right.id }),
  ] })));
  assert.equal(board.sessions.find((item) => item.id === left.id).startAt, right.startAt);
  assert.equal(board.sessions.find((item) => item.id === right.id).startAt, left.startAt);
  const rejectedPlan = newPlan();
  rejectedPlan.sessions = [slot(rejectedPlan.newTasks[0].id, 8, { endAt: "2099-01-02T09:00:01.000Z", timeZone: "Europe/London" })];
  const filename = path.join(dataDirectory, "data.json");
  const before = await readFile(filename);
  const request = command(board.revision, rejectedPlan);
  failure(await call(session.client, "learning_board_plan", request), ["SCHEDULE_CONFLICT"]);
  assert.deepEqual(await readFile(filename), before, "Failed batch must write no project, task, session or receipt");
  assert.deepEqual(await read(session.client), board);
  // A rejected command has no durable receipt: correcting its content using the
  // same request ID is safe, whereas modifying a committed command is rejected.
  rejectedPlan.sessions = [slot(rejectedPlan.newTasks[0].id, 8)];
  board = success(await call(session.client, "learning_board_plan", request));
  assert.equal(board.projects.length, 2);
  assert.equal(board.tasks.length, 4);
  assert.equal(board.sessions.length, 4);
}));

test("Calendar stdio: two competing schedule batches commit once with no partial loser", { timeout: 30000 }, async () => fixture(async ({ open }) => {
  const first = await open();
  const second = await open();
  const requests = [command(0, newPlan()), command(0, newPlan())];
  const results = await Promise.all(requests.map((request, index) => call([first, second][index].client, "learning_board_plan", request)));
  const winnerIndex = results.findIndex((result) => result.structuredContent?.ok === true);
  assert.ok(winnerIndex >= 0);
  assert.equal(results.filter((result) => result.structuredContent?.ok === true).length, 1);
  const loserIndex = 1 - winnerIndex;
  failure(results[loserIndex], ["BUSY", "REVISION_CONFLICT"]);
  const board = success(results[winnerIndex]);
  assert.equal(board.revision, 1);
  assert.equal(board.projects.length, 1);
  assert.equal(board.tasks.length, 2);
  assert.equal(board.sessions.length, 3);
  assert.equal(board.projects[0].id, requests[winnerIndex].operation.newProject.id);
  assert.ok(!board.projects.some((item) => item.id === requests[loserIndex].operation.newProject.id));
  assert.deepEqual(await read(first.client), board);
  assert.deepEqual(await read(second.client), board);
  await first.close();
  await second.close();
  assert.deepEqual(await read((await open()).client), board);
}));
