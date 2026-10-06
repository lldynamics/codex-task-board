import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir, hostname as osHostname } from "node:os";
import { randomUUID } from "node:crypto";
import { boardSchema, emptyBoard, LIMITS } from "../src/board.mjs";
import { createFileStore } from "../src/store.mjs";
import { checksum, parseDiskBytes } from "../src/store-data.mjs";
import { rawChecksum, MIGRATION_CHECKSUM } from "../src/store-files.mjs";

function emptyLegacyBoard() { const { sessions, ...board } = emptyBoard(); return board; }
const command = (expectedRevision, operation, requestId = randomUUID()) => ({ requestId, expectedRevision, operation });
const project = (name = "测试项目", id) => ({ type: "save_project", project: { ...(id ? { id } : {}), name, description: "" } });
const task = (projectId, values = {}) => ({ type: "save_task", task: { projectId, title: "测试任务", status: "planned", sourceTool: "", currentStep: "", blocker: "", conversationUrl: null, ...values } });
async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "learning-board-backend-"));
  const directory = path.join(temporary, "data");
  try { await run(directory, temporary); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function seed(directory) {
  const store = createFileStore(directory);
  const first = await store.mutate(command(0, project()));
  const second = await store.mutate(command(1, task(first.entityId)));
  assert.equal(second.ok, true);
  return { store, board: second.board, projectId: first.entityId, taskId: second.entityId };
}
async function backupNames(directory) {
  try { return (await fs.readdir(path.join(directory, "backups"))).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

test("schema 2 request replay keeps its original fingerprint and exact bytes before migration", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const originalInput = command(0, project("旧项目"));
  const oldProject = { id: randomUUID(), name: "旧项目", description: "", lastUpdatedAt: "2026-10-04T00:00:00.000Z" };
  const legacy = { ...emptyLegacyBoard(), schemaVersion: 2, revision: 1, projects: [oldProject], appliedRequests: [{ requestId: originalInput.requestId, fingerprint: checksum(originalInput), appliedRevision: 1 }] };
  const bytes = Buffer.from(JSON.stringify(legacy));
  await fs.writeFile(path.join(directory, "data.json"), bytes);
  const store = createFileStore(directory);
  const read = await store.read();
  assert.equal(read.ok, true);
  assert.deepEqual(read.board.projects[0], { ...oldProject, archivedAt: null });
  const replay = await store.mutate(originalInput);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entityId, undefined, "Old receipts do not invent an entity identity");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
  assert.deepEqual(await backupNames(directory), []);
  const update = await store.mutate(command(1, project("迁移项目", oldProject.id)));
  assert.equal(update.ok, true);
  assert.equal(update.entityId, oldProject.id);
  const names = await backupNames(directory);
  assert.equal(names.length, 3);
  assert.ok(names.includes("schema2-migration.json"));
  for (const name of names.filter((name) => name.endsWith(".json"))) assert.deepEqual(await fs.readFile(path.join(directory, "backups", name)), bytes);
  assert.equal(await fs.readFile(path.join(directory, "backups", MIGRATION_CHECKSUM), "utf8"), rawChecksum(bytes) + "\n");
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, "data.json"), "utf8")).schemaVersion, 4);
  assert.equal((await store.mutate(originalInput)).replayed, true);
}));

test("strict schema 2 and continuous receipt lineage reject unknown fields, duplicates and floors without rewriting", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const receipt = { requestId: randomUUID(), fingerprint: "a".repeat(64), appliedRevision: 1 };
  const cases = [
    { ...emptyLegacyBoard(), schemaVersion: 2, revision: 1, appliedRequests: [{ ...receipt, entityId: randomUUID() }] },
    { ...emptyLegacyBoard(), schemaVersion: 2, revision: 2, appliedRequests: [receipt, { ...receipt, appliedRevision: 2 }] },
    { ...emptyLegacyBoard(), schemaVersion: 2, projects: [{ id: randomUUID(), name: "x", description: "", lastUpdatedAt: "2026-10-04T00:00:00.000Z", archivedAt: null }], appliedRequests: [] },
    { ...emptyBoard(), revision: 2, historyStartRevision: 1, appliedRequests: [{ ...receipt, appliedRevision: 1 }] },
    { ...emptyBoard(), revision: 0, historyStartRevision: 1, appliedRequests: [] },
    { ...emptyBoard(), revision: 1, historyStartRevision: 0, appliedRequests: [] },
  ];
  for (const disk of cases) {
    const bytes = Buffer.from(JSON.stringify(disk));
    await fs.writeFile(path.join(directory, "data.json"), bytes);
    assert.equal((await createFileStore(directory).read()).error.code, "INVALID_STORE");
    assert.equal((await createFileStore(directory).mutate(command(disk.revision, project()))).error.code, "INVALID_STORE");
    assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
    assert.deepEqual(await backupNames(directory), []);
  }
}));

test("schema 3 disk records missing archive, priority or due date fields are corruption and never defaulted", async () => fixture(async (directory) => {
  const { board } = await seed(directory);
  const originalDisk = JSON.parse(await fs.readFile(path.join(directory, "data.json"), "utf8"));
  originalDisk.schemaVersion = 3;
  delete originalDisk.sessions;
  const names = await backupNames(directory);
  for (const [collection, key] of [["projects", "archivedAt"], ["tasks", "archivedAt"], ["tasks", "priority"], ["tasks", "dueDate"]]) {
    const broken = structuredClone(originalDisk);
    delete broken[collection][0][key];
    const bytes = Buffer.from(JSON.stringify(broken));
    await fs.writeFile(path.join(directory, "data.json"), bytes);
    const store = createFileStore(directory);
    assert.equal((await store.read()).error.code, "INVALID_STORE");
    assert.equal((await store.mutate(command(board.revision, project("不得默认化")))).error.code, "INVALID_STORE");
    assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
    assert.deepEqual(await backupNames(directory), names);
  }
  const callerInput = structuredClone(board);
  delete callerInput.projects[0].archivedAt;
  delete callerInput.tasks[0].archivedAt;
  delete callerInput.tasks[0].priority;
  delete callerInput.tasks[0].dueDate;
  assert.deepEqual(boardSchema.parse(callerInput), board, "Public compatibility callers retain explicitly scoped defaults");
}));

test("priority, real dates and server-owned archive state persist when old editors omit fields", async () => fixture(async (directory) => {
  const { store, board, projectId, taskId } = await seed(directory);
  const changed = await store.mutate(command(board.revision, task(projectId, { id: taskId, priority: "urgent", dueDate: "2028-02-29" })));
  assert.equal(changed.ok, true);
  const archivedTask = await store.mutate(command(changed.board.revision, { type: "archive_task", taskId, archived: true }));
  assert.equal(typeof archivedTask.board.tasks[0].archivedAt, "string");
  const edited = await store.mutate(command(archivedTask.board.revision, task(projectId, { id: taskId, title: "旧编辑器更新" })));
  assert.deepEqual({ priority: edited.board.tasks[0].priority, dueDate: edited.board.tasks[0].dueDate, archivedAt: edited.board.tasks[0].archivedAt }, {
    priority: "urgent", dueDate: "2028-02-29", archivedAt: archivedTask.board.tasks[0].archivedAt,
  });
  const archivedProject = await store.mutate(command(edited.board.revision, { type: "archive_project", projectId, archived: true }));
  assert.equal(typeof archivedProject.board.projects[0].archivedAt, "string");
  assert.equal(archivedProject.board.tasks[0].archivedAt, archivedTask.board.tasks[0].archivedAt);
  const activeTask = await store.mutate(command(archivedProject.board.revision, { type: "archive_task", taskId, archived: false }));
  assert.equal(activeTask.board.tasks[0].archivedAt, null, "Project archive never cascades into task archive state");
  assert.equal(activeTask.board.projects[0].archivedAt, archivedProject.board.projects[0].archivedAt);
  const before = await fs.readFile(path.join(directory, "data.json"));
  const names = await backupNames(directory);
  for (const values of [{ dueDate: "2026-02-29" }, { dueDate: "2026-04-31" }, { priority: "critical" }, { archivedAt: null }]) {
    assert.equal((await store.mutate(command(activeTask.board.revision, task(projectId, { id: taskId, ...values })))).error.code, "INVALID_INPUT");
    assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), before);
    assert.deepEqual(await backupNames(directory), names);
  }
  assert.equal(boardSchema.safeParse({ ...emptyBoard(), projects: [{ ...activeTask.board.projects[0], lastUpdatedAt: "2026-02-30T00:00:00.000Z" }] }).success, false);
}));

test("retained receipts replay entity IDs before CAS while expired requests cannot run again", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const oldInput = command(0, project("旧请求"));
  const retainedInput = command(1, project("保留请求"));
  const entityId = randomUUID();
  const receipts = Array.from({ length: LIMITS.retainedRequests }, (_, index) => ({ requestId: randomUUID(), fingerprint: "a".repeat(64), appliedRevision: index + 1 }));
  receipts[0] = { requestId: oldInput.requestId, fingerprint: checksum(oldInput), appliedRevision: 1, entityId: randomUUID() };
  receipts[1] = { requestId: retainedInput.requestId, fingerprint: checksum(retainedInput), appliedRevision: 2, entityId };
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify({ ...emptyBoard(), revision: LIMITS.retainedRequests, historyStartRevision: 0, appliedRequests: receipts }));
  const store = createFileStore(directory);
  const input = command(LIMITS.retainedRequests, project("新请求"));
  const saved = await store.mutate(input);
  assert.equal(saved.ok, true);
  assert.equal(saved.board.revision, LIMITS.retainedRequests + 1);
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  const names = await backupNames(directory);
  const replay = await store.mutate(retainedInput);
  assert.equal(replay.replayed, true);
  assert.equal(replay.entityId, entityId);
  assert.equal(replay.appliedRevision, 2);
  assert.equal((await store.mutate(oldInput)).error.code, "REQUEST_EXPIRED");
  assert.equal((await store.mutate({ ...retainedInput, operation: project("复用内容") })).error.code, "REQUEST_ID_REUSE");
  const newReplay = await store.mutate(input);
  assert.equal(newReplay.entityId, saved.entityId);
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
  assert.deepEqual(await backupNames(directory), names);
}));

test("portable export and preview stay read-only; restore replaces records but extends current lineage", async () => fixture(async (directory) => {
  const { store, board } = await seed(directory);
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  const names = await backupNames(directory);
  const exported = await store.data({ action: "export" });
  assert.equal(exported.ok, true);
  assert.equal(exported.backup.checksum, checksum(board));
  assert.deepEqual(exported.backup.board, board);
  const preview = await store.data({ action: "preview_restore", backup: exported.backup });
  assert.deepEqual(preview, { ok: true, board, preview: { sourceRevision: board.revision, projectCount: 1, taskCount: 1, sessionCount: 0, archivedProjectCount: 0, archivedTaskCount: 0 } });
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
  assert.deepEqual(await backupNames(directory), names);
  const latestInput = command(board.revision, project("后续项目"));
  const latest = await store.mutate(latestInput);
  assert.equal(latest.board.projects.length, 2);
  const preRestore = await fs.readFile(path.join(directory, "data.json"));
  const restoring = command(latest.board.revision, { type: "restore_board", backup: exported.backup });
  const restored = await store.mutate(restoring);
  assert.equal(restored.ok, true);
  assert.equal(restored.entityId, undefined);
  assert.equal(restored.board.revision, latest.board.revision + 1);
  assert.deepEqual(restored.board.projects, board.projects);
  assert.deepEqual(restored.board.tasks, board.tasks);
  const disk = parseDiskBytes(await fs.readFile(path.join(directory, "data.json"))).disk;
  assert.equal(disk.appliedRequests.length, restored.board.revision);
  assert.equal((await store.mutate(latestInput)).entityId, latest.entityId);
  assert.equal((await store.mutate(restoring)).replayed, true);
  const backups = await backupNames(directory);
  assert.ok((await Promise.all(backups.map((name) => fs.readFile(path.join(directory, "backups", name))))).some((value) => value.equals(preRestore)), "Restore keeps the pre-restore disk as a backup");
}));

test("invalid backup metadata, bytes, references, checksum and missing fields never alter disk or backup count", async () => fixture(async (directory) => {
  const { store, board } = await seed(directory);
  const backup = (await store.data({ action: "export" })).backup;
  const cases = [
    { ...backup, formatVersion: 2 }, { ...backup, createdAt: "2026-02-30T00:00:00.000Z" }, { ...backup, checksum: "b".repeat(64) },
    { ...backup, board: { ...backup.board, schemaVersion: 2 } },
    { ...backup, board: { ...backup.board, projects: [] } },
    { ...backup, board: { ...backup.board, projects: [...backup.board.projects, backup.board.projects[0]] } },
    { ...backup, board: { ...backup.board, tasks: [{ ...backup.board.tasks[0], dueDate: "2026-02-29" }] } },
    { ...backup, extra: "x".repeat(LIMITS.bytes) },
  ];
  const incomplete = structuredClone(backup); delete incomplete.board.tasks[0].priority; incomplete.checksum = checksum(incomplete.board); cases.push(incomplete);
  const bytes = await fs.readFile(path.join(directory, "data.json"));
  const names = await backupNames(directory);
  for (const invalid of cases) {
    assert.equal((await store.data({ action: "preview_restore", backup: invalid })).error.code, "INVALID_INPUT");
    assert.equal((await store.mutate(command(board.revision, { type: "restore_board", backup: invalid }))).error.code, "INVALID_INPUT");
    assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), bytes);
    assert.deepEqual(await backupNames(directory), names);
  }
  assert.equal((await store.data({ action: "export", backup })).error.code, "INVALID_INPUT");
  await fs.writeFile(path.join(directory, "data.json"), "{broken");
  for (const result of [await store.data({ action: "export" }), await store.data({ action: "preview_restore", backup }), await store.mutate(command(board.revision, { type: "restore_board", backup }))]) assert.equal(result.error.code, "INVALID_STORE");
  assert.equal(await fs.readFile(path.join(directory, "data.json"), "utf8"), "{broken");
}));

test("backup failure, backup symlinks and destination changes abort without altering existing disk", async () => fixture(async (directory, temporary) => {
  const { board } = await seed(directory);
  const original = await fs.readFile(path.join(directory, "data.json"));
  const names = await backupNames(directory);
  for (const method of ["writeFile", "sync"]) {
    const io = { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      if (!String(args[0]).includes(`${path.sep}backups${path.sep}`) || args[1] !== "wx") return handle;
      return { writeFile: (...values) => method === "writeFile" ? Promise.reject(Error("backup write failure")) : handle.writeFile(...values), sync: () => method === "sync" ? Promise.reject(Error("backup sync failure")) : handle.sync(), close: () => handle.close() };
    } };
    const rejected = await createFileStore(directory, { io }).mutate(command(board.revision, project("不能提交")));
    assert.equal(rejected.error.code, "SAVE_FAILED");
    assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), original);
    assert.deepEqual(await backupNames(directory), names);
    await assert.rejects(fs.lstat(path.join(directory, ".save-lock")), { code: "ENOENT" });
  }
  await fs.rename(path.join(directory, "backups"), path.join(directory, "backups-kept"));
  const outside = path.join(temporary, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(directory, "backups"));
  assert.equal((await createFileStore(directory).mutate(command(board.revision, project("拒绝链接")))).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), original);
  await fs.unlink(path.join(directory, "backups"));
  await fs.rename(path.join(directory, "backups-kept"), path.join(directory, "backups"));
  const changed = Buffer.from("external update must remain");
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (String(args[0]).includes(".data-") && args[1] === "wx") await fs.writeFile(path.join(directory, "data.json"), changed);
    return handle;
  } };
  assert.equal((await createFileStore(directory, { io }).mutate(command(board.revision, project("拒绝竞争")))).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), changed);
  assert.deepEqual(await backupNames(directory), names);
}));

test("backup retention keeps twenty versions plus migration and private modes, and post-commit pruning failure stays successful", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const old = { ...emptyLegacyBoard(), schemaVersion: 2, appliedRequests: [] };
  const migrationBytes = Buffer.from(JSON.stringify(old));
  await fs.writeFile(path.join(directory, "data.json"), migrationBytes);
  let board = (await createFileStore(directory).mutate(command(0, project()))).board;
  for (let index = 0; index < 22; index++) board = (await createFileStore(directory).mutate(command(board.revision, project(`项目 ${index}`, board.projects[0].id)))).board;
  assert.equal(board.revision, 23);
  const names = await backupNames(directory);
  assert.equal(names.length, 22);
  assert.ok(names.includes("schema2-migration.json"));
  assert.ok(names.includes(MIGRATION_CHECKSUM));
  assert.deepEqual(await fs.readFile(path.join(directory, "backups", "schema2-migration.json")), migrationBytes);
  assert.equal(await fs.readFile(path.join(directory, "backups", MIGRATION_CHECKSUM), "utf8"), rawChecksum(migrationBytes) + "\n");
  assert.equal((await fs.stat(path.join(directory, "backups"))).mode & 0o777, 0o700);
  for (const name of names) assert.equal((await fs.stat(path.join(directory, "backups", name))).mode & 0o777, 0o600);
  const io = { ...fs, unlink: async (filename) => {
    if (String(filename).includes(`${path.sep}backups${path.sep}`)) throw Error("injected retention failure");
    return fs.unlink(filename);
  } };
  const saved = await createFileStore(directory, { io }).mutate(command(board.revision, project("保留失败仍提交", board.projects[0].id)));
  assert.equal(saved.ok, true);
  assert.equal(saved.board.revision, 24);
  assert.equal((await createFileStore(directory).read()).board.projects[0].name, "保留失败仍提交");
  assert.equal((await backupNames(directory)).length, 23);
}));

test("same-revision byte backups are validated before reuse and a failed commit removes no reused file", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  const saved = await store.mutate(command(0, project()));
  const original = await fs.readFile(path.join(directory, "data.json"));
  const name = `revision-0000000000000001-${rawChecksum(original)}.json`;
  await fs.mkdir(path.join(directory, "backups"), { mode: 0o700 });
  const filename = path.join(directory, "backups", name);
  await fs.writeFile(filename, original, { mode: 0o600 });
  const input = command(1, project("验证复用", saved.entityId));
  const io = { ...fs, rename: async () => { throw Error("injected commit failure"); } };
  assert.equal((await createFileStore(directory, { io }).mutate(input)).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readFile(filename), original);
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), original);
  const altered = JSON.parse(original); altered.projects[0].description = "合法字段被修改";
  const alteredBytes = Buffer.from(JSON.stringify(altered));
  assert.doesNotThrow(() => parseDiskBytes(alteredBytes));
  await fs.writeFile(filename, alteredBytes);
  assert.equal((await store.mutate(input)).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readFile(filename), alteredBytes, "A pre-existing damaged backup remains for diagnosis");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), original);
  await fs.writeFile(filename, original);
  assert.equal((await store.mutate(input)).ok, true);
  assert.deepEqual(await backupNames(directory), [name]);
}));

test("migration checksum creation failures roll back new files and corrupt migration pairs block writes", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const lastUpdatedAt = "2026-10-04T00:00:00.000Z";
  const legacy = { ...emptyLegacyBoard(), schemaVersion: 2, projects: [{ id: randomUUID(), name: "迁移项目", description: "", lastUpdatedAt }], appliedRequests: [] };
  const original = Buffer.from(JSON.stringify(legacy));
  await fs.writeFile(path.join(directory, "data.json"), original);
  const input = command(0, project("迁移后项目", legacy.projects[0].id));
  const io = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (!String(args[0]).endsWith(MIGRATION_CHECKSUM) || args[1] !== "wx") return handle;
    return { writeFile: async () => { throw Error("injected checksum sidecar failure"); }, sync: () => handle.sync(), close: () => handle.close() };
  } };
  assert.equal((await createFileStore(directory, { io }).mutate(input)).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), original);
  assert.deepEqual(await backupNames(directory), []);
  const migrated = await createFileStore(directory).mutate(input);
  assert.equal(migrated.ok, true);
  const current = await fs.readFile(path.join(directory, "data.json"));
  const migrationPath = path.join(directory, "backups", "schema2-migration.json");
  const sidecarPath = path.join(directory, "backups", MIGRATION_CHECKSUM);
  const altered = structuredClone(legacy); altered.projects[0].description = "合法迁移备份字段被改";
  const alteredBytes = Buffer.from(JSON.stringify(altered));
  assert.doesNotThrow(() => parseDiskBytes(alteredBytes));
  await fs.writeFile(migrationPath, alteredBytes);
  assert.equal((await createFileStore(directory).mutate(command(1, project("不得覆盖", legacy.projects[0].id)))).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), current);
  assert.deepEqual(await fs.readFile(migrationPath), alteredBytes);
  await fs.writeFile(migrationPath, original);
  await fs.writeFile(sidecarPath, "a".repeat(64) + "\n");
  assert.equal((await createFileStore(directory).mutate(command(1, project("不得忽略sidecar", legacy.projects[0].id)))).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), current);
  await fs.unlink(sidecarPath);
  assert.equal((await createFileStore(directory).mutate(command(1, project("不得补造缺失hash", legacy.projects[0].id)))).error.code, "SAVE_FAILED");
  assert.deepEqual(await fs.readFile(path.join(directory, "data.json")), current);
  await fs.writeFile(sidecarPath, rawChecksum(original) + "\n", { mode: 0o600 });
  assert.equal((await createFileStore(directory).mutate(command(1, project("校验恢复后保存", legacy.projects[0].id)))).ok, true);
}));

test("first writes and blank-store data exports create no backup, directory or expired receipt side effects", async () => fixture(async (directory) => {
  const store = createFileStore(directory);
  const exported = await store.data({ action: "export" });
  assert.equal(exported.ok, true);
  assert.deepEqual(exported.backup.board, emptyBoard());
  assert.equal((await store.data({ action: "preview_restore", backup: exported.backup })).ok, true);
  await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
  const created = await store.mutate(command(0, project()));
  assert.equal(created.ok, true);
  assert.deepEqual(await backupNames(directory), []);
  assert.match(created.entityId, /^[a-f0-9-]{36}$/);
}));

async function plantMarker(directory, pid, hostname = osHostname()) {
  await fs.mkdir(path.join(directory, ".save-lock"), { mode: 0o700 });
  const owner = { version: 1, token: randomUUID(), pid, hostname, createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(directory, ".save-lock", "owner.json"), JSON.stringify(owner) + "\n", { mode: 0o600 });
  return owner;
}
const deadProbe = () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); };

test("a lock marker left by a dead writer on this host is quarantined and the save proceeds", async () => fixture(async (directory) => {
  const { board } = await seed(directory);
  const owner = await plantMarker(directory, 999999);
  const store = createFileStore(directory, { pidProbe: deadProbe });
  const saved = await store.mutate(command(board.revision, project("崩溃后继续保存")));
  assert.equal(saved.ok, true);
  const quarantined = (await fs.readdir(directory)).filter((name) => name.startsWith(".save-lock-quarantine-"));
  assert.equal(quarantined.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, quarantined[0], "owner.json"), "utf8")).token, owner.token);
  await assert.rejects(fs.lstat(path.join(directory, ".save-lock")), { code: "ENOENT" });
}));

test("a marker owned by a live process or another host is never taken over", async () => fixture(async (directory) => {
  const { board } = await seed(directory);
  for (const [pidProbe, host] of [[() => true, undefined], [deadProbe, "another-host.example"]]) {
    await plantMarker(directory, 999999, host);
    const result = await createFileStore(directory, { pidProbe, lockWaitMs: 50 }).mutate(command(board.revision, project("不能抢锁")));
    assert.equal(result.error.code, "BUSY");
    await fs.rm(path.join(directory, ".save-lock"), { recursive: true });
  }
}));

test("concurrent writers in one process wait for the lock instead of failing BUSY", async () => fixture(async (directory) => {
  const { board } = await seed(directory);
  const store = createFileStore(directory);
  const results = await Promise.all([store.mutate(command(board.revision, project("甲"))), store.mutate(command(board.revision, project("乙")))]);
  assert.deepEqual(results.map((result) => result.ok ? "ok" : result.error.code).sort(), ["REVISION_CONFLICT", "ok"]);
}));

test("a file holding the old 10,000-receipt history is accepted and trimmed to the retained window on the next save", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  const receipts = Array.from({ length: LIMITS.requests }, (_, index) => ({ requestId: randomUUID(), fingerprint: "a".repeat(64), appliedRevision: index + 1 }));
  await fs.writeFile(path.join(directory, "data.json"), JSON.stringify({ ...emptyBoard(), revision: LIMITS.requests, historyStartRevision: 0, appliedRequests: receipts }));
  const store = createFileStore(directory);
  assert.equal((await store.read()).ok, true);
  const saved = await store.mutate(command(LIMITS.requests, project("裁剪历史")));
  assert.equal(saved.ok, true);
  const disk = JSON.parse(await fs.readFile(path.join(directory, "data.json"), "utf8"));
  assert.equal(disk.appliedRequests.length, LIMITS.retainedRequests);
  assert.equal(disk.historyStartRevision, disk.revision - LIMITS.retainedRequests);
  assert.equal((await store.mutate(command(0, project("过期"), receipts[0].requestId))).error.code, "REQUEST_EXPIRED");
}));
