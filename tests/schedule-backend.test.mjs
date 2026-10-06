import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { emptyBoard, VERSION, LIMITS, mutationInputSchema, CONTEXT_TOOL_NAME, PLAN_TOOL_NAME, FEEDBACK_TOOL_NAME, TASK_TOOL_NAME } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { createServer } from "../src/server-core.mjs";
import { checksum, parseDiskBytes } from "../src/store-data.mjs";
import { rawChecksum } from "../src/store-files.mjs";
import { activeScheduledSessions } from "../src/schedule-domain.mjs";

const command = (revision, operation, requestId = randomUUID()) => ({ requestId, expectedRevision: revision, operation });
const taskInput = (projectId, values = {}) => ({ id: randomUUID(), projectId, title: "学习任务", status: "planned", sourceTool: "Codex", currentStep: "阅读教材", blocker: "", conversationUrl: null, ...values });
const slot = (taskId, hour = 9, values = {}) => ({ taskId, startAt: `2099-10-05T${String(hour).padStart(2, "0")}:00:00.000Z`, endAt: `2099-10-05T${String(hour + 1).padStart(2, "0")}:00:00.000Z`, timeZone: "Asia/Shanghai", ...values });
const batch = (values = {}) => ({ type: "apply_schedule", newTasks: [], sessions: [], ...values });
const save = (session) => ({ type: "save_session", session });
const feedback = (sessionId, values = {}) => ({ type: "record_session_feedback", sessionId, status: "completed", feedback: "完成练习", actualMinutes: 50, ...values });
async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "learning-schedule-backend-"));
  const directory = path.join(temporary, "data");
  try { await run(directory); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function seed(directory) {
  const store = createFileStore(directory);
  const projectId = randomUUID();
  const first = taskInput(projectId, { dueDate: "2099-10-06", priority: "high" });
  const second = taskInput(projectId);
  const result = await store.mutate(command(0, batch({ newProject: { id: projectId, name: "学习计划", description: "" }, newTasks: [first, second] })));
  assert.equal(result.ok, true, JSON.stringify(result));
  return { store, projectId, firstId: first.id, secondId: second.id, board: result.board };
}
async function snapshot(directory) {
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  const backups = (await fs.readdir(path.join(directory, "backups")).catch((error) => { if (error.code === "ENOENT") return []; throw error; })).sort();
  return { bytes, backups };
}
async function rejectsWithoutWrites(store, directory, input, code) {
  const before = await snapshot(directory);
  const result = await store.mutate(input);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
  assert.deepEqual(await snapshot(directory), before);
  return result;
}

test("session save persists objective defaults, preserves omitted text, and keeps task due dates independent", async () => fixture(async (directory) => {
  const { store, board, firstId } = await seed(directory);
  const request = command(board.revision, save(slot(firstId, 9, { objective: "  读懂章节  ", completionCriteria: "写出五个要点" })));
  const created = await store.mutate(request);
  assert.equal(created.ok, true);
  assert.equal(created.entityId, created.board.sessions[0].id);
  const original = created.board.sessions[0];
  assert.deepEqual({ objective: original.objective, completionCriteria: original.completionCriteria, feedback: original.feedback, actualMinutes: original.actualMinutes, status: original.status }, { objective: "读懂章节", completionCriteria: "写出五个要点", feedback: "", actualMinutes: null, status: "scheduled" });
  const changed = await store.mutate(command(created.board.revision, save(slot(firstId, 10, { id: original.id }))));
  assert.equal(changed.ok, true);
  assert.equal(changed.board.sessions[0].objective, original.objective);
  assert.equal(changed.board.sessions[0].completionCriteria, original.completionCriteria);
  assert.deepEqual(changed.board.tasks, board.tasks);
  assert.deepEqual((await createFileStore(directory).read()).board, changed.board);
  const before = await snapshot(directory);
  const replay = await store.mutate(request);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entityId, original.id);
  assert.deepEqual(replay.board, changed.board);
  assert.deepEqual(await snapshot(directory), before);
  const blank = await store.mutate(command(changed.board.revision, save(slot(firstId, 11))));
  assert.equal(blank.board.sessions[1].objective, "");
  assert.equal(blank.board.sessions[1].completionCriteria, "");
}));

test("strict session input rejects invalid dates, offsets, durations, time zones, text and record references", async () => fixture(async (directory) => {
  const { store, board, firstId, secondId } = await seed(directory);
  for (const values of [
    { startAt: "2099-02-29T09:00:00.000Z" }, { startAt: "2099-10-05T09:00:00+08:00" },
    { endAt: "2099-10-05T09:00:00.000Z" }, { endAt: "2099-10-05T08:59:59.000Z" },
    { endAt: "2099-10-06T09:00:00.001Z" }, { timeZone: "Mars/Olympus" }, { timeZone: "+08:00" },
    { objective: "x".repeat(4001) }, { completionCriteria: "x".repeat(4001) },
    { feedback: "client cannot edit history here" }, { status: "completed" },
    { startAt: "2020-10-05T09:00:00.000Z", endAt: "2020-10-05T10:00:00.000Z" },
  ]) await rejectsWithoutWrites(store, directory, command(board.revision, save(slot(firstId, 9, values))), "INVALID_INPUT");
  await rejectsWithoutWrites(store, directory, command(board.revision, save(slot(randomUUID()))), "NOT_FOUND");
  await rejectsWithoutWrites(store, directory, command(board.revision, save(slot(firstId, 9, { id: randomUUID() }))), "NOT_FOUND");
  const saved = await store.mutate(command(board.revision, save(slot(firstId, 9, { endAt: "2099-10-06T09:00:00.000Z" }))));
  assert.equal(saved.ok, true, "Exactly 24 hours is valid");
  await rejectsWithoutWrites(store, directory, command(saved.board.revision, save(slot(secondId, 9, { id: saved.entityId }))), "INVALID_INPUT");
}));

test("whole-board single-person conflict detection allows adjacency and atomic exchanges", async () => fixture(async (directory) => {
  const { store, board, firstId, secondId } = await seed(directory);
  let result = await store.mutate(command(board.revision, batch({ sessions: [slot(firstId), slot(secondId, 10)] })));
  assert.equal(result.ok, true, JSON.stringify(result));
  const [first, second] = result.board.sessions;
  await rejectsWithoutWrites(store, directory, command(result.board.revision, save(slot(firstId, 9, { startAt: "2099-10-05T09:59:59.999Z" }))), "SCHEDULE_CONFLICT");
  await rejectsWithoutWrites(store, directory, command(result.board.revision, save(slot(firstId, 10, { id: first.id }))), "SCHEDULE_CONFLICT");
  result = await store.mutate(command(result.board.revision, batch({ sessions: [slot(firstId, 10, { id: first.id }), slot(secondId, 9, { id: second.id })] })));
  assert.equal(result.ok, true, "An atomic swap validates its final state only");
  assert.equal(result.board.sessions[0].startAt, slot(firstId, 10).startAt);
  assert.equal(result.board.sessions[1].startAt, slot(secondId, 9).startAt);
  assert.equal(result.board.tasks.length, 2);
}));

test("feedback corrects history without completing tasks or modifying timing; cancelled history is protected", async () => fixture(async (directory) => {
  const { store, board, firstId } = await seed(directory);
  let result = await store.mutate(command(board.revision, save(slot(firstId))));
  const session = result.board.sessions[0];
  result = await store.mutate(command(result.board.revision, feedback(session.id, { feedback: "  提前完成  ", actualMinutes: 0 })));
  assert.equal(result.ok, true, "Explicit user feedback can complete a future session early");
  assert.equal(result.board.tasks[0].status, "planned");
  assert.deepEqual(result.board.tasks, board.tasks);
  result = await store.mutate(command(result.board.revision, feedback(session.id, { status: "not_completed", feedback: "更正：练习未完成", actualMinutes: null })));
  assert.equal(result.ok, true);
  assert.equal(result.board.sessions[0].status, "not_completed");
  assert.equal(result.board.sessions[0].startAt, session.startAt);
  assert.equal(result.board.sessions[0].endAt, session.endAt);
  await rejectsWithoutWrites(store, directory, command(result.board.revision, save(slot(firstId, 11, { id: session.id }))), "SESSION_LOCKED");
  await rejectsWithoutWrites(store, directory, command(result.board.revision, { type: "cancel_session", sessionId: session.id }), "SESSION_LOCKED");
  for (const values of [{ status: "scheduled" }, { actualMinutes: -1 }, { actualMinutes: 1441 }, { actualMinutes: 1.5 }, { feedback: "x".repeat(4001) }]) {
    await rejectsWithoutWrites(store, directory, command(result.board.revision, feedback(session.id, values)), "INVALID_INPUT");
  }
  result = await store.mutate(command(result.board.revision, save(slot(firstId))));
  const cancelInput = command(result.board.revision, { type: "cancel_session", sessionId: result.entityId });
  const cancelled = await store.mutate(cancelInput);
  assert.equal(cancelled.ok, true, "Completed history no longer blocks a new scheduled interval");
  assert.equal(cancelled.board.sessions[1].status, "cancelled");
  assert.equal((await store.mutate(cancelInput)).replayed, true);
  await rejectsWithoutWrites(store, directory, command(cancelled.board.revision, feedback(result.entityId)), "SESSION_LOCKED");
  await rejectsWithoutWrites(store, directory, command(cancelled.board.revision, save(slot(firstId, 12, { id: result.entityId }))), "SESSION_LOCKED");
}));

test("scheduled history that has started cannot change its time but may receive user feedback", async () => fixture(async (directory) => {
  const { board, firstId } = await seed(directory);
  const session = { id: randomUUID(), ...slot(firstId, 9, { startAt: "2020-10-05T09:00:00.000Z", endAt: "2020-10-05T10:00:00.000Z" }), status: "scheduled", objective: "旧学习", completionCriteria: "", feedback: "", actualMinutes: null, lastUpdatedAt: "2020-10-05T08:00:00.000Z" };
  const disk = { ...board, sessions: [session], historyStartRevision: board.revision, appliedRequests: [] };
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify(disk));
  const store = createFileStore(directory);
  await rejectsWithoutWrites(store, directory, command(board.revision, save(slot(firstId, 12, { id: session.id }))), "SESSION_LOCKED");
  const reported = await store.mutate(command(board.revision, feedback(session.id, { actualMinutes: 1440 })));
  assert.equal(reported.ok, true);
  assert.equal(reported.board.sessions[0].startAt, session.startAt);
  assert.equal(reported.board.sessions[0].objective, "旧学习");
}));

test("batch creates referenced project, tasks and sessions in one revision and replays identical IDs", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  const projectId = randomUUID();
  const task = taskInput(projectId);
  const input = command(0, batch({ newProject: { id: projectId, name: "  新学习项目  ", description: "目标" }, newTasks: [task], sessions: [slot(task.id)] }));
  const result = await store.mutate(input);
  assert.equal(result.ok, true);
  assert.equal(result.board.revision, 1);
  assert.equal(result.board.projects[0].id, projectId);
  assert.equal(result.board.projects[0].name, "新学习项目");
  assert.equal(result.board.tasks[0].id, task.id);
  assert.equal(result.board.sessions[0].taskId, task.id);
  assert.equal(result.board.tasks[0].priority, "normal");
  assert.equal(result.board.tasks[0].dueDate, null);
  const replay = await createFileStore(directory).mutate(input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.board, result.board);
  const disk = parseDiskBytes(await fs.readFile(path.join(directory, "data.json"))).disk;
  assert.equal(disk.appliedRequests.length, 1);
  assert.equal(disk.appliedRequests[0].fingerprint, checksum(mutationInputSchema.parse(input)));
  assert.equal((await fs.readdir(directory)).includes("backups"), false);
}));

test("batch rejects duplicates, reference errors, archived targets and overlap without any partial records", async () => fixture(async (directory) => {
  const { store, board, firstId, projectId } = await seed(directory);
  const nextProject = { id: randomUUID(), name: "不能部分保存", description: "" };
  const newTask = taskInput(nextProject.id);
  const newSession = slot(newTask.id);
  const cases = [
    [batch({ newProject: { ...nextProject, id: projectId } }), "INVALID_INPUT"],
    [batch({ newProject: nextProject, newTasks: [newTask, newTask] }), "INVALID_INPUT"],
    [batch({ newTasks: [taskInput(projectId, { id: firstId })] }), "INVALID_INPUT"],
    [batch({ newProject: nextProject, newTasks: [taskInput(randomUUID())] }), "NOT_FOUND"],
    [batch({ newProject: nextProject, newTasks: [newTask], sessions: [slot(randomUUID())] }), "NOT_FOUND"],
    [batch({ newProject: nextProject, newTasks: [newTask], sessions: [newSession, newSession] }), "SCHEDULE_CONFLICT"],
    [batch({ newProject: nextProject, newTasks: [newTask], sessions: [newSession, { ...newSession, timeZone: "Unknown/Time" }] }), "INVALID_INPUT"],
    [batch({ newTasks: [taskInput(projectId, { status: "completed" })] }), "INVALID_INPUT"],
    [{ type: "apply_schedule", sessions: [] }, "INVALID_INPUT"],
    [{ type: "apply_schedule", newTasks: [] }, "INVALID_INPUT"],
    [batch(), "INVALID_INPUT"],
  ];
  for (const [operation, code] of cases) await rejectsWithoutWrites(store, directory, command(board.revision, operation), code);
  const created = await store.mutate(command(board.revision, save(slot(firstId))));
  const updated = slot(firstId, 10, { id: created.entityId });
  await rejectsWithoutWrites(store, directory, command(created.board.revision, batch({ newProject: nextProject, newTasks: [newTask], sessions: [updated, updated] })), "INVALID_INPUT");
  const archived = await store.mutate(command(created.board.revision, { type: "archive_project", projectId, archived: true }));
  await rejectsWithoutWrites(store, directory, command(archived.board.revision, batch({ newTasks: [taskInput(projectId)] })), "INVALID_INPUT");
  await rejectsWithoutWrites(store, directory, command(archived.board.revision, save(slot(firstId, 12))), "INVALID_INPUT");
  await rejectsWithoutWrites(store, directory, command(archived.board.revision, save(slot(firstId, 12, { id: created.entityId }))), "INVALID_INPUT");
}));

test("invalid first batch and save failures keep storage absent or byte-exact and allow original-request retry", async () => fixture(async (directory) => {
  const projectId = randomUUID();
  const task = taskInput(projectId);
  const input = command(0, batch({ newProject: { id: projectId, name: "原子保存", description: "" }, newTasks: [task], sessions: [slot(task.id)] }));
  const invalid = { ...input, operation: { ...input.operation, sessions: [slot(task.id), slot(task.id)] } };
  assert.equal((await createFileStore(directory).mutate(invalid)).error.code, "SCHEDULE_CONFLICT");
  await assert.rejects(fs.stat(path.join(directory, "data.json")), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name !== ".save-lock.sqlite"), []);
  const io = { ...fs, rename: async () => { throw Error("injected batch commit failure"); } };
  assert.equal((await createFileStore(directory, { io }).mutate(input)).error.code, "SAVE_FAILED");
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name !== ".save-lock.sqlite"), []);
  const result = await createFileStore(directory).mutate(input);
  assert.equal(result.ok, true);
  assert.equal(result.replayed, false);
  const update = command(result.board.revision, batch({ sessions: [slot(task.id, 11, { id: result.board.sessions[0].id })] }));
  await rejectsWithoutWrites(createFileStore(directory, { io }), directory, update, "SAVE_FAILED");
  assert.equal((await createFileStore(directory).mutate(update)).ok, true);
}));

test("archiving releases calendar capacity and restoring a conflicting project or task is atomic", async () => fixture(async (directory) => {
  const { store, board, firstId, secondId, projectId } = await seed(directory);
  let result = await store.mutate(command(board.revision, save(slot(firstId))));
  result = await store.mutate(command(result.board.revision, { type: "archive_task", taskId: firstId, archived: true }));
  assert.equal(activeScheduledSessions(result.board).length, 0);
  result = await store.mutate(command(result.board.revision, save(slot(secondId))));
  await rejectsWithoutWrites(store, directory, command(result.board.revision, { type: "archive_task", taskId: firstId, archived: false }), "SCHEDULE_CONFLICT");
  result = await store.mutate(command(result.board.revision, { type: "archive_project", projectId, archived: true }));
  const otherProjectId = randomUUID();
  const otherTask = taskInput(otherProjectId);
  result = await store.mutate(command(result.board.revision, batch({ newProject: { id: otherProjectId, name: "其他项目", description: "" }, newTasks: [otherTask], sessions: [slot(otherTask.id)] })));
  assert.equal(result.ok, true);
  await rejectsWithoutWrites(store, directory, command(result.board.revision, { type: "archive_project", projectId, archived: false }), "SCHEDULE_CONFLICT");
  assert.equal(result.board.sessions.length, 3, "Archive preserves historical session records");
}));

test("batch and board session limits reject new records while permitting an existing future session update", async () => fixture(async (directory) => {
  const { store, board, projectId, firstId } = await seed(directory);
  await rejectsWithoutWrites(store, directory, command(board.revision, batch({ newTasks: Array.from({ length: 51 }, () => taskInput(projectId)) })), "INVALID_INPUT");
  await rejectsWithoutWrites(store, directory, command(board.revision, batch({ sessions: Array.from({ length: 101 }, () => slot(firstId)) })), "INVALID_INPUT");
  const sessions = Array.from({ length: LIMITS.sessions }, (_, index) => ({
    id: randomUUID(), ...slot(firstId), status: index === 0 ? "scheduled" : "cancelled", objective: "", completionCriteria: "", feedback: "", actualMinutes: null, lastUpdatedAt: "2099-01-01T00:00:00.000Z",
  }));
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify({ ...board, sessions, historyStartRevision: board.revision, appliedRequests: [] }));
  await rejectsWithoutWrites(store, directory, command(board.revision, save(slot(firstId, 11))), "CAPACITY_EXCEEDED");
  const updated = await store.mutate(command(board.revision, save(slot(firstId, 11, { id: sessions[0].id }))));
  assert.equal(updated.ok, true, JSON.stringify(updated.error));
  assert.equal(updated.board.sessions.length, LIMITS.sessions);
}));

test("strict schema 3 disk migration reads and replays without writes, then backs up exact bytes on next mutation", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const input = command(0, { type: "save_project", project: { name: "旧版项目", description: "" } });
  const { sessions, ...base } = emptyBoard();
  const projectId = randomUUID();
  const old = { ...base, schemaVersion: 3, revision: 1, projects: [{ id: projectId, name: "旧版项目", description: "", archivedAt: null, lastUpdatedAt: "2026-01-01T00:00:00.000Z" }], historyStartRevision: 0, appliedRequests: [{ requestId: input.requestId, fingerprint: checksum(input), appliedRevision: 1, entityId: projectId }] };
  const bytes = Buffer.from(JSON.stringify(old, null, 3) + "\n");
  await fs.writeFile(path.join(directory, "data.json"), bytes);
  const store = createFileStore(directory);
  const read = await store.read();
  assert.equal(read.ok, true);
  assert.equal(read.board.schemaVersion, 4);
  assert.deepEqual(read.board.sessions, []);
  assert.equal((await store.mutate(input)).replayed, true);
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name !== ".save-lock.sqlite").sort(), ["data.json"]);
  const next = await store.mutate(command(1, { type: "save_project", project: { id: projectId, name: "迁移成功", description: "" } }));
  assert.equal(next.ok, true);
  const name = `revision-0000000000000001-${rawChecksum(bytes)}.json`;
  assert.deepEqual(await fs.readdir(path.join(directory, "backups")), [name]);
  assert.deepEqual(await fs.readFile(path.join(directory, "backups", name)), bytes);
  const current = parseDiskBytes(await fs.readFile(path.join(directory, "data.json"))).disk;
  assert.equal(current.appliedRequests[0].fingerprint, checksum(input));
  assert.equal((await store.mutate(input)).entityId, projectId);
}));

test("schema 3 portable backup verifies its original checksum before migration and restores empty sessions", async () => fixture(async (directory) => {
  const { store, board, firstId } = await seed(directory);
  const scheduled = await store.mutate(command(board.revision, save(slot(firstId))));
  const { sessions, ...oldBoard } = board;
  oldBoard.schemaVersion = 3;
  const backup = { format: "learning-board-backup", formatVersion: 1, createdAt: "2026-10-05T00:00:00.000Z", board: oldBoard, checksum: checksum(oldBoard) };
  const before = await snapshot(directory);
  const preview = await store.data({ action: "preview_restore", backup });
  assert.equal(preview.ok, true);
  assert.equal(preview.preview.sessionCount, 0);
  assert.deepEqual(await snapshot(directory), before);
  const invalid = { ...backup, checksum: checksum({ ...oldBoard, schemaVersion: 4, sessions: [] }) };
  assert.equal((await store.data({ action: "preview_restore", backup: invalid })).error.code, "INVALID_INPUT");
  await rejectsWithoutWrites(store, directory, command(scheduled.board.revision, { type: "restore_board", backup: invalid }), "INVALID_INPUT");
  const request = command(scheduled.board.revision, { type: "restore_board", backup });
  const restored = await store.mutate(request);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.board.sessions, []);
  assert.equal(restored.board.schemaVersion, 4);
  assert.equal((await store.mutate(request)).replayed, true);
  const disk = parseDiskBytes(await fs.readFile(path.join(directory, "data.json"))).disk;
  assert.equal(disk.appliedRequests.at(-1).fingerprint, checksum(request), "Restore migration must not normalize the original request fingerprint");
}));

test("strict schema 4 disk and portable backups reject missing sessions or corrupt session records", async () => fixture(async (directory) => {
  const { store, board, firstId } = await seed(directory);
  const created = await store.mutate(command(board.revision, save(slot(firstId))));
  const disk = JSON.parse((await snapshot(directory)).bytes);
  const badBoards = [];
  const missing = { ...created.board }; delete missing.sessions; badBoards.push(missing);
  for (const values of [{ taskId: randomUUID() }, { timeZone: "invalid" }, { status: "unknown" }, { actualMinutes: 1441 }, { objective: " untrimmed " }, { lastUpdatedAt: "2026-02-30T00:00:00.000Z" }]) {
    badBoards.push({ ...created.board, sessions: [{ ...created.board.sessions[0], ...values }] });
  }
  const incomplete = structuredClone(created.board); delete incomplete.sessions[0].feedback; badBoards.push(incomplete);
  badBoards.push({ ...created.board, sessions: [created.board.sessions[0], created.board.sessions[0]] });
  const backup = (await store.data({ action: "export" })).backup;
  for (const badBoard of badBoards) {
    const invalidBackup = { ...backup, board: badBoard, checksum: checksum(badBoard) };
    assert.equal((await store.data({ action: "preview_restore", backup: invalidBackup })).error.code, "INVALID_INPUT");
    await rejectsWithoutWrites(store, directory, command(created.board.revision, { type: "restore_board", backup: invalidBackup }), "INVALID_INPUT");
  }
  for (const badBoard of badBoards) {
    const bytes = Buffer.from(JSON.stringify({ ...badBoard, historyStartRevision: disk.historyStartRevision, appliedRequests: disk.appliedRequests }));
    await fs.writeFile(path.join(directory, "data.json"), bytes);
    assert.equal((await store.read()).error.code, "INVALID_STORE");
    assert.equal((await store.mutate(command(created.board.revision, save(slot(firstId, 12))))).error.code, "INVALID_STORE");
    assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
  }
}));

test("model tools expose context, restricted atomic plans and user feedback while app-only tools retain archive and restore", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  const server = await createServer(store);
  const client = new Client({ name: "learning-schedule-test", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 9);
    assert.deepEqual(tools.filter((tool) => tool._meta.ui.visibility.includes("model")).map((tool) => tool.name).sort(), ["learning_board", CONTEXT_TOOL_NAME, PLAN_TOOL_NAME, FEEDBACK_TOOL_NAME, TASK_TOOL_NAME, "learning_board_codex_sync"].sort());
    for (const name of [CONTEXT_TOOL_NAME, PLAN_TOOL_NAME, FEEDBACK_TOOL_NAME]) {
      const tool = tools.find((item) => item.name === name);
      assert.deepEqual(tool._meta.ui.visibility, ["model"]);
      assert.equal(tool._meta["openai/ui"], undefined);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(tool.annotations.openWorldHint, false);
    }
    const context = await client.callTool({ name: CONTEXT_TOOL_NAME, arguments: {} });
    assert.notEqual(context.isError, true, JSON.stringify(context));
    assert.deepEqual(context.structuredContent.board, emptyBoard());
    assert.deepEqual(context.structuredContent.omitted, { projects: 0, tasks: 0, sessions: 0 });
    assert.ok(Number.isFinite(Date.parse(context.structuredContent.serverNow)));
    await assert.rejects(fs.stat(directory), { code: "ENOENT" });
    const projectId = randomUUID();
    const task = taskInput(projectId);
    const input = command(0, batch({ newProject: { id: projectId, name: "模型学习项目", description: "" }, newTasks: [task], sessions: [slot(task.id)] }));
    const planned = await client.callTool({ name: PLAN_TOOL_NAME, arguments: input });
    assert.notEqual(planned.isError, true, JSON.stringify(planned));
    assert.equal(planned.structuredContent.board, undefined);
    assert.equal(planned.structuredContent.revision, 1);
    assert.deepEqual(planned.structuredContent.changed.projects.map((item) => item.id), [projectId]);
    assert.deepEqual(planned.structuredContent.changed.tasks.map((item) => item.id), [task.id]);
    const sessionId = planned.structuredContent.changed.sessions[0].id;
    assert.equal((await client.callTool({ name: PLAN_TOOL_NAME, arguments: input })).structuredContent.replayed, true);
    const reported = await client.callTool({ name: FEEDBACK_TOOL_NAME, arguments: command(1, feedback(sessionId)) });
    assert.notEqual(reported.isError, true, JSON.stringify(reported));
    assert.deepEqual(reported.structuredContent.changed.tasks, []);
    assert.equal(reported.structuredContent.changed.sessions[0].id, sessionId);
    assert.equal((await client.callTool({ name: CONTEXT_TOOL_NAME, arguments: {} })).structuredContent.board.tasks[0].status, "planned");
    const before = await snapshot(directory);
    for (const [name, operation] of [
      [PLAN_TOOL_NAME, { type: "archive_project", projectId, archived: true }],
      [PLAN_TOOL_NAME, { type: "restore_board", backup: (await store.data({ action: "export" })).backup }],
      [PLAN_TOOL_NAME, save(slot(task.id))],
      [FEEDBACK_TOOL_NAME, batch()],
      [FEEDBACK_TOOL_NAME, { type: "cancel_session", sessionId }],
    ]) {
      const rejected = await client.callTool({ name, arguments: command(2, operation) });
      assert.equal(rejected.isError, true);
    }
    assert.deepEqual(await snapshot(directory), before);
    const locked = await client.callTool({ name: PLAN_TOOL_NAME, arguments: command(2, batch({ sessions: [slot(task.id, 12, { id: sessionId })] })) });
    assert.equal(locked.structuredContent.error.code, "SESSION_LOCKED");
    const conflict = await client.callTool({ name: PLAN_TOOL_NAME, arguments: { ...input, requestId: randomUUID() } });
    assert.equal(conflict.structuredContent.error.code, "REVISION_CONFLICT");
  } finally { await client.close(); await server.close(); }
}));

test("the model context omits archived records unless asked, and keeps references complete", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  const server = await createServer(store);
  const client = new Client({ name: "context-filter-test", version: VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const projectId = randomUUID(); const kept = taskInput(projectId); const hidden = taskInput(projectId);
    let board = (await store.mutate(command(0, batch({ newProject: { id: projectId, name: "过滤项目", description: "" }, newTasks: [kept, hidden], sessions: [slot(hidden.id)] })))).board;
    board = (await store.mutate(command(board.revision, { type: "archive_task", taskId: hidden.id, archived: true }))).board;
    const active = (await client.callTool({ name: CONTEXT_TOOL_NAME, arguments: {} })).structuredContent;
    assert.deepEqual(active.board.tasks.map((item) => item.id), [kept.id]);
    assert.deepEqual(active.board.sessions, []);
    assert.deepEqual(active.omitted, { projects: 0, tasks: 1, sessions: 1 });
    assert.equal(active.board.revision, board.revision);
    const full = (await client.callTool({ name: CONTEXT_TOOL_NAME, arguments: { includeArchived: true } })).structuredContent;
    assert.deepEqual(full.board, board);
    assert.deepEqual(full.omitted, { projects: 0, tasks: 0, sessions: 0 });
  } finally { await client.close(); await server.close(); }
}));
