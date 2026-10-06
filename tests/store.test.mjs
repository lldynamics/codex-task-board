import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createFileStore } from "../src/store.mjs";
import { boardSchema, emptyBoard, LIMITS, STATUS_VALUES } from "../src/board.mjs";

const projectRequest = (expectedRevision = 0, project = { name: "项目", description: "说明" }, requestId = randomUUID()) => ({ requestId, expectedRevision, operation: { type: "save_project", project } });
const taskRequest = (expectedRevision, projectId, task = {}) => ({ requestId: randomUUID(), expectedRevision, operation: { type: "save_task", task: { projectId, title: "任务", status: "planned", sourceTool: "手动", currentStep: "下一步", blocker: "", conversationUrl: null, ...task } } });
const moveRequest = (expectedRevision, taskId, status, beforeTaskId = null, requestId = randomUUID()) => ({ requestId, expectedRevision, operation: { type: "move_task", taskId, status, beforeTaskId } });
async function orderedFixture(directory) {
  const lastUpdatedAt = "2026-10-04T00:00:00.000Z";
  const projects = ["原项目", "其他项目"].map((name) => ({ id: randomUUID(), name, description: "旧版数据", lastUpdatedAt }));
  const tasks = ["planned", "in_progress", "planned", "completed", "planned"].map((status, index) => ({
    id: randomUUID(), projectId: projects[index === 4 ? 1 : 0].id, title: `任务 ${index + 1}`, status,
    sourceTool: "手动", currentStep: `步骤 ${index + 1}`, blocker: "保留说明", lastUpdatedAt,
    conversationUrl: `https://example.org/thread/${index + 1}`,
  }));
  const { sessions, ...legacyBase } = emptyBoard();
  const legacy = { ...legacyBase, schemaVersion: 2, projects, tasks };
  const board = boardSchema.parse({ ...legacy, schemaVersion: 4, sessions: [] });
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify({ ...legacy, appliedRequests: [] }));
  return board;
}
async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "learning-board-store-"));
  const directory = path.join(temporary, "data");
  try { await run(directory, temporary); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

test("absent store reads blank without creating any directory", async () => fixture(async (directory) => {
  const result = await createFileStore(directory).read();
  assert.deepEqual(result, { ok: true, board: emptyBoard() });
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
}));

test("create, edit and all six manual states persist across new store instances", async () => fixture(async (directory) => {
  let store = createFileStore(directory);
  let result = await store.mutate(projectRequest(0, { name: "  项目  ", description: "  说明  " }));
  assert.equal(result.ok, true);
  const project = result.board.projects[0];
  assert.equal(project.name, "项目");
  assert.equal(project.description, "说明");
  assert.match(project.id, /^[\da-f-]{36}$/);
  assert.equal(new Date(project.lastUpdatedAt).toISOString(), project.lastUpdatedAt);
  result = await store.mutate(taskRequest(1, project.id, { conversationUrl: "https://example.org/thread/123" }));
  assert.equal(result.ok, true);
  const taskId = result.board.tasks[0].id;
  let revision = 2;
  for (const status of STATUS_VALUES) {
    result = await store.mutate(taskRequest(revision, project.id, { id: taskId, title: "编辑后的任务", status }));
    assert.equal(result.ok, true);
    assert.equal(result.board.tasks.length, 1);
    assert.equal(result.board.tasks[0].status, status);
    revision += 1;
    store = createFileStore(directory);
    assert.deepEqual(await store.read(), { ok: true, board: result.board });
  }
  result = await store.mutate(projectRequest(revision, { id: project.id, name: "修改项目", description: "" }));
  assert.equal(result.board.projects.length, 1);
  assert.equal(result.board.projects[0].name, "修改项目");
  assert.equal(result.board.syncState, "unsynced");
  assert.equal(result.board.persistence, "local");
  assert.doesNotThrow(() => boardSchema.parse(result.board));
  assert.equal((await fs.stat(path.join(directory, "data.json"))).mode & 0o777, 0o600);
}));

test("request replay uses committed fingerprint before CAS and rejects id reuse", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  const first = projectRequest();
  const created = await store.mutate(first);
  await store.mutate(projectRequest(1, { name: "其他项目", description: "" }));
  const replay = await createFileStore(directory).mutate(first);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.appliedRevision, 1);
  assert.equal(replay.board.revision, 2);
  assert.equal(replay.board.projects.length, 2);
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  const changed = await store.mutate({ ...first, expectedRevision: 2 });
  assert.equal(changed.error.code, "REQUEST_ID_REUSE");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
  assert.equal(created.replayed, false);
}));

test("CAS conflict and unknown edit references preserve committed bytes", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  await store.mutate(projectRequest());
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  const conflict = await store.mutate(projectRequest());
  assert.equal(conflict.error.code, "REVISION_CONFLICT");
  assert.equal(conflict.board.revision, 1);
  const missing = await store.mutate(projectRequest(1, { id: randomUUID(), name: "未存在", description: "" }));
  assert.equal(missing.error.code, "NOT_FOUND");
  assert.equal((await store.mutate(taskRequest(1, randomUUID()))).error.code, "NOT_FOUND");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
}));

test("strict mutation validation rejects paths, deletion, invalid states and unsafe links", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  const projectId = randomUUID();
  const invalid = [
    { ...projectRequest(), directory: "/tmp/other" },
    { ...projectRequest(), operation: { type: "delete_project", id: projectId } },
    projectRequest(0, { name: " ", description: "" }),
    taskRequest(0, projectId, { status: "unknown" }),
    taskRequest(0, projectId, { conversationUrl: "javascript:alert(1)" }),
    taskRequest(0, projectId, { conversationUrl: "file:///tmp/test" }),
    taskRequest(0, projectId, { conversationUrl: "https://user:password@example.org/" }),
    taskRequest(0, projectId, { conversationUrl: "https://example.org/\npath" }),
    { ...projectRequest(), expectedRevision: -1 },
    { ...projectRequest(), requestId: "invalid" },
  ];
  for (const request of invalid) assert.equal((await store.mutate(request)).error.code, "INVALID_INPUT");
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
}));

test("damaged, unknown schema, invalid references and oversized files never reset", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const missingProject = { id: randomUUID(), projectId: randomUUID(), title: "孤立任务", status: "planned", sourceTool: "", currentStep: "", blocker: "", lastUpdatedAt: "2026-10-04T00:00:00.000Z", conversationUrl: null };
  const records = ["broken {", JSON.stringify({ ...emptyBoard(), schemaVersion: 99, appliedRequests: [] }), JSON.stringify({ ...emptyBoard(), revision: 1, appliedRequests: [] }), JSON.stringify({ ...emptyBoard(), tasks: [missingProject], appliedRequests: [] }), " ".repeat(LIMITS.bytes + 1)];
  for (const bytes of records) {
    await fs.writeFile(path.join(directory, "data.json"), bytes);
    const store = createFileStore(directory);
    assert.equal((await store.read()).error.code, "INVALID_STORE");
    assert.equal((await store.mutate(projectRequest())).error.code, "INVALID_STORE");
    assert.equal(await fs.readFile(path.join(directory, "data.json"), "utf8"), bytes);
  }
}));

test("existing lock returns BUSY and is never stolen or removed", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  await fs.mkdir(path.join(directory, ".save-lock"));
  const store = createFileStore(directory);
  assert.equal((await store.mutate(projectRequest())).error.code, "BUSY");
  assert.equal((await fs.stat(path.join(directory, ".save-lock"))).isDirectory(), true);
  await assert.rejects(fs.stat(path.join(directory, "data.json")), { code: "ENOENT" });
}));

test("precommit write, fsync and rename failures keep old bytes and permit retry", async () => fixture(async (directory) => {
  await createFileStore(directory).mutate(projectRequest());
  const previous = await fs.readFile(path.join(directory, "data.json"));
  for (const method of ["writeFile", "sync", "rename"]) {
    const io = { ...fs, ...(method === "rename" ? { rename: async () => { throw Error("injected rename failure"); } } : { open: async (...args) => {
      const handle = await fs.open(...args);
      if (args[1] !== "wx") return handle;
      return { writeFile: (...value) => method === "writeFile" ? Promise.reject(Error("injected write failure")) : handle.writeFile(...value), sync: () => method === "sync" ? Promise.reject(Error("injected sync failure")) : handle.sync(), close: () => handle.close() };
    } }) };
    const request = projectRequest(1, { name: "重试项目", description: "" });
    const failed = await createFileStore(directory, { io }).mutate(request);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, "SAVE_FAILED");
    assert.equal(failed.board.revision, 1);
    assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), previous);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name !== ".save-lock.sqlite").sort(), ["data.json"]);
  }
  const success = await createFileStore(directory).mutate(projectRequest(1, { name: "成功重试", description: "" }));
  assert.equal(success.ok, true);
  assert.equal(success.board.revision, 2);
}));

test("idempotency history compacts at its cap while preserving continuous revision lineage", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const appliedRequests = Array.from({ length: LIMITS.retainedRequests }, (_, index) => ({ requestId: randomUUID(), fingerprint: "a".repeat(64), appliedRevision: index + 1 }));
  const bytes = JSON.stringify({ ...emptyBoard(), revision: LIMITS.retainedRequests, historyStartRevision: 0, appliedRequests });
  await fs.writeFile(path.join(directory, "data.json"), bytes);
  const result = await createFileStore(directory).mutate(projectRequest(LIMITS.retainedRequests));
  assert.equal(result.ok, true);
  assert.equal(result.board.revision, LIMITS.retainedRequests + 1);
  const disk = JSON.parse(await fs.readFile(path.join(directory, "data.json"), "utf8"));
  assert.equal(disk.historyStartRevision, 1);
  assert.equal(disk.appliedRequests.length, LIMITS.retainedRequests);
  assert.equal(disk.appliedRequests[0].requestId, appliedRequests[1].requestId);
  assert.equal(disk.appliedRequests.at(-1).appliedRevision, LIMITS.retainedRequests + 1);
  assert.equal((await createFileStore(directory).mutate(projectRequest(0))).error.code, "REQUEST_EXPIRED");
  assert.equal((await createFileStore(directory).read()).board.revision, LIMITS.retainedRequests + 1);
}));

test("cleanup failure after commit reports success and the leaked marker self-heals on the next save", async () => fixture(async (directory) => {
  const io = { ...fs, rmdir: async () => { throw Error("injected lock cleanup failure"); } };
  const saved = await createFileStore(directory, { io }).mutate(projectRequest());
  assert.equal(saved.ok, true);
  assert.equal(saved.board.revision, 1);
  assert.deepEqual(await createFileStore(directory).read(), { ok: true, board: saved.board });
  assert.equal((await fs.stat(path.join(directory, ".save-lock"))).isDirectory(), true);
  assert.equal((await createFileStore(directory).mutate(projectRequest(1))).ok, true);
  assert.equal((await fs.readdir(directory)).filter((name) => name.startsWith(".save-lock-quarantine-")).length, 1);
}));

test("record caps reject new records but still allow editing existing records", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const updated = "2026-10-04T00:00:00.000Z";
  const projects = Array.from({ length: LIMITS.projects }, () => ({ id: randomUUID(), name: "项目", description: "", lastUpdatedAt: updated }));
  const projectDisk = { ...boardSchema.parse({ ...emptyBoard(), projects }), historyStartRevision: 0, appliedRequests: [] };
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify(projectDisk));
  const store = createFileStore(directory);
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  assert.equal((await store.mutate(projectRequest())).error.code, "CAPACITY_EXCEEDED");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
  assert.equal((await store.mutate(projectRequest(0, { id: projects[0].id, name: "编辑项目", description: "" }))).ok, true);

  const tasks = Array.from({ length: LIMITS.tasks }, () => ({ id: randomUUID(), projectId: projects[0].id, title: "任务", status: "planned", sourceTool: "", currentStep: "", blocker: "", lastUpdatedAt: updated, conversationUrl: null }));
  const taskDisk = { ...boardSchema.parse({ ...emptyBoard(), projects: [projects[0]], tasks }), historyStartRevision: 0, appliedRequests: [] };
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify(taskDisk));
  const taskBytes = await fs.readFile(path.join(directory, "data.json"));
  assert.equal((await store.mutate(taskRequest(0, projects[0].id))).error.code, "CAPACITY_EXCEEDED");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), taskBytes);
  const edited = await store.mutate(taskRequest(0, projects[0].id, { id: tasks[0].id, title: "编辑任务" }));
  assert.equal(edited.ok, true);
  assert.equal(edited.board.tasks.length, LIMITS.tasks);
}));

test("root and leaf symlinks are rejected without touching their targets", async () => fixture(async (directory, temporary) => {
  const outside = path.join(temporary, "outside");
  await fs.mkdir(outside);
  const bytes = "private target must stay intact";
  await fs.writeFile(path.join(outside, "data.json"), bytes);
  await fs.symlink(outside, directory);
  assert.equal((await createFileStore(directory).read()).error.code, "INVALID_STORE");
  assert.equal((await createFileStore(directory).mutate(projectRequest())).error.code, "INVALID_STORE");
  assert.equal(await fs.readFile(path.join(outside, "data.json"), "utf8"), bytes);
  await fs.unlink(directory);
  await fs.mkdir(directory);
  await fs.symlink(path.join(outside, "data.json"), path.join(directory, "data.json"));
  assert.equal((await createFileStore(directory).read()).error.code, "INVALID_STORE");
  assert.equal((await createFileStore(directory).mutate(projectRequest())).error.code, "INVALID_STORE");
  assert.equal(await fs.readFile(path.join(outside, "data.json"), "utf8"), bytes);
  assert.equal((await fs.lstat(path.join(directory, "data.json"))).isSymbolicLink(), true);
  assert.deepEqual(await fs.readdir(outside), ["data.json"]);
}));

test("schema 2 reads normalize in memory without writing and task edits migrate with saved array order", async () => fixture(async (directory) => {
  const original = await orderedFixture(directory);
  const filename = path.join(directory, "data.json");
  const bytes = await fs.readFile(filename);
  assert.deepEqual(await createFileStore(directory).read(), { ok: true, board: original });
  assert.deepEqual(await fs.readFile(filename), bytes, "Reading old data must not rewrite it");
  const edited = { ...original.tasks[2], title: "编辑旧任务", status: "paused" };
  delete edited.lastUpdatedAt;
  delete edited.archivedAt;
  const result = await createFileStore(directory).mutate(taskRequest(0, edited.projectId, edited));
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.tasks.map((task) => task.id), original.tasks.map((task) => task.id));
  assert.equal(result.board.tasks[2].status, "paused");
  assert.equal(result.board.schemaVersion, 4);
  assert.deepEqual(Object.keys(result.board).sort(), Object.keys(original).sort());
  assert.deepEqual(Object.keys(result.board.tasks[2]).sort(), Object.keys(original.tasks[2]).sort());
  assert.deepEqual(await createFileStore(directory).read(), { ok: true, board: result.board });
}));

test("move_task persists both directions within a column, column end, and cross-project anchors", async () => fixture(async (directory) => {
  const original = await orderedFixture(directory);
  const [a, b, c, d, e] = original.tasks;
  const store = createFileStore(directory);
  let result = await store.mutate(moveRequest(0, a.id, "planned", e.id));
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.tasks.map((task) => task.id), [b.id, c.id, d.id, a.id, e.id]);
  assert.deepEqual(result.board.tasks.find((task) => task.id === a.id), { ...a, lastUpdatedAt: result.board.tasks.find((task) => task.id === a.id).lastUpdatedAt });
  assert.notEqual(result.board.tasks.find((task) => task.id === a.id).lastUpdatedAt, a.lastUpdatedAt);
  result = await store.mutate(moveRequest(1, e.id, "planned", c.id));
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.tasks.map((task) => task.id), [b.id, e.id, c.id, d.id, a.id]);
  result = await store.mutate(moveRequest(2, e.id, "planned"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.tasks.map((task) => task.id), [b.id, c.id, d.id, a.id, e.id]);
  assert.deepEqual(result.board.tasks.filter((task) => task.status === "planned").map((task) => task.id), [c.id, a.id, e.id]);
  assert.equal(result.board.tasks.find((task) => task.id === e.id).projectId, e.projectId);
  assert.deepEqual(await createFileStore(directory).read(), { ok: true, board: result.board });
  const noop = await store.mutate(moveRequest(3, e.id, "planned"));
  assert.equal(noop.ok, true);
  assert.equal(noop.board.revision, 4, "An accepted no-op is still a committed request");
  assert.deepEqual(noop.board.tasks.map((task) => task.id), result.board.tasks.map((task) => task.id));
}));

test("move_task changes status across all columns without changing task content or project", async () => fixture(async (directory) => {
  const original = await orderedFixture(directory);
  const [a, b, c, d, e] = original.tasks;
  let result = await createFileStore(directory).mutate(moveRequest(0, c.id, "in_progress", b.id));
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.tasks.map((task) => task.id), [a.id, c.id, b.id, d.id, e.id]);
  assert.deepEqual(result.board.tasks[1], { ...c, status: "in_progress", lastUpdatedAt: result.board.tasks[1].lastUpdatedAt });
  let revision = 1;
  for (const status of STATUS_VALUES) {
    result = await createFileStore(directory).mutate(moveRequest(revision, a.id, status));
    assert.equal(result.ok, true);
    const moved = result.board.tasks.at(-1);
    assert.deepEqual(moved, { ...a, status, lastUpdatedAt: moved.lastUpdatedAt });
    assert.deepEqual(result.board.projects, original.projects);
    assert.deepEqual(result.board.tasks.slice(0, -1).map((task) => task.id), [c.id, b.id, d.id, e.id]);
    assert.deepEqual(await createFileStore(directory).read(), { ok: true, board: result.board });
    revision += 1;
  }
}));

test("move_task validates task and anchor references before committing and preserves bytes on rejection", async () => fixture(async (directory) => {
  const original = await orderedFixture(directory);
  const [a, b, c] = original.tasks;
  const filename = path.join(directory, "data.json");
  const bytes = await fs.readFile(filename);
  const store = createFileStore(directory);
  const cases = [
    [moveRequest(0, randomUUID(), "planned", c.id), "NOT_FOUND"],
    [moveRequest(0, a.id, "planned", randomUUID()), "NOT_FOUND"],
    [moveRequest(0, a.id, "planned", a.id), "INVALID_INPUT"],
    [moveRequest(0, a.id, "planned", b.id), "INVALID_INPUT"],
    [moveRequest(0, a.id, "unknown"), "INVALID_INPUT"],
    [moveRequest(0, "invalid", "planned"), "INVALID_INPUT"],
    [moveRequest(0, a.id, "planned", "invalid"), "INVALID_INPUT"],
    [{ ...moveRequest(0, a.id, "planned"), operation: { type: "move_task", taskId: a.id, status: "planned" } }, "INVALID_INPUT"],
    [{ ...moveRequest(0, a.id, "planned"), operation: { type: "move_task", taskId: a.id, status: "planned", beforeTaskId: null, projectId: b.projectId } }, "INVALID_INPUT"],
  ];
  for (const [input, code] of cases) {
    const result = await store.mutate(input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(await fs.readFile(filename), bytes);
    assert.deepEqual(await store.read(), { ok: true, board: original });
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name !== ".save-lock.sqlite"), ["data.json"]);
  }
  assert.equal((await store.mutate(moveRequest(0, a.id, "planned", c.id))).ok, true);
}));

test("move_task CAS and request replay retain the newest durable order without applying a move twice", async () => fixture(async (directory) => {
  const original = await orderedFixture(directory);
  const [a, b, c, d, e] = original.tasks;
  const store = createFileStore(directory);
  const request = moveRequest(0, e.id, "planned", a.id);
  const first = await store.mutate(request);
  assert.equal(first.ok, true);
  assert.equal(first.appliedRevision, 1);
  const conflict = await store.mutate(moveRequest(0, a.id, "completed", d.id));
  assert.equal(conflict.error.code, "REVISION_CONFLICT");
  assert.deepEqual(conflict.board, first.board);
  const next = await store.mutate(moveRequest(1, a.id, "in_progress", b.id));
  assert.equal(next.ok, true);
  assert.deepEqual(next.board.tasks.map((task) => task.id), [e.id, a.id, b.id, c.id, d.id]);
  const filename = path.join(directory, "data.json");
  const bytes = await fs.readFile(filename);
  const replay = await createFileStore(directory).mutate(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.appliedRevision, 1);
  assert.deepEqual(replay.board, next.board);
  const reused = await store.mutate({ ...request, operation: { ...request.operation, beforeTaskId: c.id } });
  assert.equal(reused.error.code, "REQUEST_ID_REUSE");
  assert.deepEqual(await fs.readFile(filename), bytes);
}));

test("move_task rename failure keeps original status, order, and request history until the same request retries", async () => fixture(async (directory) => {
  const original = await orderedFixture(directory);
  const [, , c] = original.tasks;
  const filename = path.join(directory, "data.json");
  const bytes = await fs.readFile(filename);
  const request = moveRequest(0, c.id, "completed");
  const io = { ...fs, rename: async () => { throw Error("injected move rename failure"); } };
  const failed = await createFileStore(directory, { io }).mutate(request);
  assert.equal(failed.error.code, "SAVE_FAILED");
  assert.deepEqual(failed.board, original);
  assert.deepEqual(await fs.readFile(filename), bytes);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name !== ".save-lock.sqlite"), ["data.json"]);
  const retried = await createFileStore(directory).mutate(request);
  assert.equal(retried.ok, true);
  assert.equal(retried.replayed, false);
  assert.equal(retried.board.revision, 1);
  assert.equal(retried.board.tasks.at(-1).id, c.id);
  assert.equal(retried.board.tasks.at(-1).status, "completed");
  assert.deepEqual(retried.board.tasks.slice(0, -1).map((task) => task.id), original.tasks.filter((task) => task.id !== c.id).map((task) => task.id));
  const replay = await createFileStore(directory).mutate(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.board, retried.board);
}));
