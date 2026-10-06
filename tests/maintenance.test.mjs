import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createFileStore } from "../src/store.mjs";
import { createMaintenance, runMaintenanceCLI } from "../src/maintenance.mjs";
import { validateBackup, parseDiskBytes } from "../src/store-data.mjs";
import { rawChecksum, MIGRATION_CHECKSUM } from "../src/store-files.mjs";

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "learning-board-maintenance-"));
  const root = path.join(temporary, "store");
  try { await run(root, temporary); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
async function makeLock(root, changes = {}) {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, ".save-lock"));
  const owner = { version: 1, token: randomUUID(), pid: 12345, hostname: hostname(), createdAt: "2026-10-05T00:00:00.000Z", ...changes };
  await fs.writeFile(path.join(root, ".save-lock", "owner.json"), JSON.stringify(owner), { mode: 0o600 });
  return owner;
}
const deadProbe = () => { throw Object.assign(Error("absent"), { code: "ESRCH" }); };
const recovery = (snapshot) => ({ ...(snapshot.token ? { expectedToken: snapshot.token } : {}), expectedFingerprint: snapshot.fingerprint, confirmAllClientsStopped: true });
const projectRequest = (expectedRevision, name = "测试项目") => ({ requestId: randomUUID(), expectedRevision, operation: { type: "save_project", project: { name, description: "" } } });

test("maintenance reads and help do not create absent store or locks", async () => fixture(async (root) => {
  const maintenance = createMaintenance(root);
  assert.deepEqual(await maintenance.inspectLock(), { ok: true, locked: false });
  assert.deepEqual(await maintenance.listBackups(), { ok: true, backups: [] });
  assert.match((await runMaintenanceCLI(["--help"], maintenance)).help, /Usage/);
  await assert.rejects(fs.stat(root), { code: "ENOENT" });
}));

test("offline recovery requires exact token, fingerprint and confirmation then quarantines without deleting data", async () => fixture(async (root) => {
  const owner = await makeLock(root);
  const data = Buffer.from("corrupt data must remain untouched");
  await fs.writeFile(path.join(root, "data.json"), data);
  const maintenance = createMaintenance(root, { pidProbe: deadProbe });
  const snapshot = await maintenance.inspectLock();
  assert.equal(snapshot.type, "known-owner");
  assert.equal(snapshot.token, owner.token);
  assert.deepEqual(snapshot.owner, owner);
  assert.match(snapshot.fingerprint, /^[a-f0-9]{64}$/);
  await assert.rejects(maintenance.recoverLock({ ...recovery(snapshot), confirmAllClientsStopped: false }));
  await assert.rejects(maintenance.recoverLock({ ...recovery(snapshot), expectedToken: randomUUID() }));
  await assert.rejects(maintenance.recoverLock({ ...recovery(snapshot), expectedFingerprint: "a".repeat(64) }));
  await assert.rejects(maintenance.recoverLock({ expectedFingerprint: snapshot.fingerprint, confirmAllClientsStopped: true }));
  const result = await maintenance.recoverLock(recovery(snapshot));
  assert.equal(result.recovered, true);
  assert.match(result.quarantine, /^\.save-lock-quarantine-[a-f0-9-]{36}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, result.quarantine, "owner.json"), "utf8")), owner);
  assert.deepEqual(await fs.readFile(path.join(root, "data.json")), data);
  await assert.rejects(fs.stat(path.join(root, ".save-lock")), { code: "ENOENT" });
  assert.deepEqual(await maintenance.inspectLock(), { ok: true, locked: false });
}));

test("live PID and EPERM owner probes refuse recovery with exact bytes retained", async () => fixture(async (root) => {
  const owner = await makeLock(root);
  for (const probe of [() => {}, () => { throw Object.assign(Error("no permission"), { code: "EPERM" }); }]) {
    const maintenance = createMaintenance(root, { pidProbe: probe });
    const snapshot = await maintenance.inspectLock();
    await assert.rejects(maintenance.recoverLock(recovery(snapshot)), /alive|safely ruled out/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, ".save-lock", "owner.json"), "utf8")), owner);
    assert.deepEqual((await fs.readdir(root)).sort(), [".save-lock"]);
  }
}));

test("legacy empty locks and partial metadata require explicit fingerprint-only offline recovery", async () => fixture(async (root) => {
  await fs.mkdir(root); await fs.mkdir(path.join(root, ".save-lock"));
  const maintenance = createMaintenance(root, { pidProbe: deadProbe });
  const legacy = await maintenance.inspectLock();
  assert.equal(legacy.type, "legacy-ownerless");
  assert.equal(legacy.token, undefined);
  await assert.rejects(maintenance.recoverLock({ expectedFingerprint: legacy.fingerprint, confirmAllClientsStopped: false }));
  const result = await maintenance.recoverLock(recovery(legacy));
  assert.deepEqual(await fs.readdir(path.join(root, result.quarantine)), []);
  await fs.mkdir(path.join(root, ".save-lock"));
  const replaced = await maintenance.inspectLock();
  assert.notEqual(replaced.fingerprint, legacy.fingerprint, "A different empty directory has a different fingerprint");
  await assert.rejects(maintenance.recoverLock(recovery(legacy)), /changed/);
  await fs.writeFile(path.join(root, ".save-lock", "owner.json"), '{"version":');
  const partial = await maintenance.inspectLock();
  assert.equal(partial.type, "invalid-owner");
  const recovered = await maintenance.recoverLock(recovery(partial));
  assert.equal(await fs.readFile(path.join(root, recovered.quarantine, "owner.json"), "utf8"), '{"version":');
}));

test("incomplete owner metadata still protects any parseable live same-host PID", async () => fixture(async (root) => {
  await fs.mkdir(root); await fs.mkdir(path.join(root, ".save-lock"));
  const bytes = JSON.stringify({ pid: process.pid, hostname: hostname(), version: 1 });
  await fs.writeFile(path.join(root, ".save-lock", "owner.json"), bytes);
  const maintenance = createMaintenance(root);
  const snapshot = await maintenance.inspectLock();
  assert.equal(snapshot.type, "invalid-owner");
  await assert.rejects(maintenance.recoverLock(recovery(snapshot)), /alive/);
  assert.equal(await fs.readFile(path.join(root, ".save-lock", "owner.json"), "utf8"), bytes);
}));

test("changed ownership, unknown contents and symlinks are never recovered", async () => fixture(async (root, temporary) => {
  await makeLock(root);
  const maintenance = createMaintenance(root, { pidProbe: deadProbe });
  let snapshot = await maintenance.inspectLock();
  await fs.writeFile(path.join(root, ".save-lock", "owner.json"), JSON.stringify({ ...snapshot.owner, token: randomUUID() }));
  await assert.rejects(maintenance.recoverLock(recovery(snapshot)), /changed/);
  snapshot = await maintenance.inspectLock();
  await fs.writeFile(path.join(root, ".save-lock", "unknown"), "do not delete");
  await assert.rejects(maintenance.inspectLock(), /Unrecognized/);
  await assert.rejects(maintenance.recoverLock(recovery(snapshot)), /Unrecognized/);
  assert.equal(await fs.readFile(path.join(root, ".save-lock", "unknown"), "utf8"), "do not delete");
  await fs.unlink(path.join(root, ".save-lock", "unknown"));
  const external = path.join(temporary, "owner.json");
  const bytes = JSON.stringify(snapshot.owner); await fs.writeFile(external, bytes);
  await fs.unlink(path.join(root, ".save-lock", "owner.json"));
  await fs.symlink(external, path.join(root, ".save-lock", "owner.json"));
  await assert.rejects(maintenance.inspectLock(), /Unsafe/);
  await assert.rejects(maintenance.recoverLock(recovery(snapshot)), /Unsafe/);
  assert.equal(await fs.readFile(external, "utf8"), bytes);
  await fs.unlink(path.join(root, ".save-lock", "owner.json"));
  await fs.rmdir(path.join(root, ".save-lock"));
  const lockTarget = path.join(temporary, "external-lock"); await fs.mkdir(lockTarget);
  await fs.symlink(lockTarget, path.join(root, ".save-lock"));
  await assert.rejects(maintenance.inspectLock(), /Unsafe/);
  assert.deepEqual(await fs.readdir(lockTarget), []);
}));

test("a lock changed during the PID probe fails the second fingerprint check", async () => fixture(async (root) => {
  await makeLock(root);
  const maintenance = createMaintenance(root, { pidProbe: async () => {
    await fs.writeFile(path.join(root, ".save-lock", "owner.json"), "{}");
    deadProbe();
  } });
  const snapshot = await maintenance.inspectLock();
  await assert.rejects(maintenance.recoverLock(recovery(snapshot)), /changed/);
  assert.equal(await fs.readFile(path.join(root, ".save-lock", "owner.json"), "utf8"), "{}");
  assert.deepEqual((await fs.readdir(root)).sort(), [".save-lock"]);
}));

test("store retains full owner diagnostics after cleanup failure", async () => fixture(async (root) => {
  const io = { ...fs, rmdir: async () => { throw Error("injected cleanup failure"); } };
  const saved = await createFileStore(root, { io }).mutate(projectRequest(0));
  assert.equal(saved.ok, true);
  const inspected = await createMaintenance(root).inspectLock();
  assert.equal(inspected.owner.pid, process.pid);
  assert.equal(inspected.owner.hostname, hostname());
  assert.equal((await fs.stat(path.join(root, ".save-lock", "owner.json"))).mode & 0o777, 0o600);
  await assert.rejects(createMaintenance(root).recoverLock(recovery(inspected)), /alive/);
  // Holding the process lock, the store recognizes its own leaked marker and heals it.
  assert.equal((await createFileStore(root).mutate(projectRequest(1))).ok, true);
}));

test("changed lock owner during a successful commit is protected from store cleanup", async () => fixture(async (root) => {
  let replacement;
  const io = { ...fs, rename: async (source, destination) => {
    const result = await fs.rename(source, destination);
    const previous = JSON.parse(await fs.readFile(path.join(root, ".save-lock", "owner.json"), "utf8"));
    replacement = { ...previous, token: randomUUID() };
    await fs.writeFile(path.join(root, ".save-lock", "owner.json"), JSON.stringify(replacement));
    return result;
  } };
  const result = await createFileStore(root, { io }).mutate(projectRequest(0));
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, ".save-lock", "owner.json"), "utf8")), replacement);
  assert.equal((await createFileStore(root).mutate(projectRequest(1))).ok, true);
}));

test("backup export validates saved disk without reading a corrupt current disk and never overwrites output", async () => fixture(async (root, temporary) => {
  const store = createFileStore(root);
  assert.equal((await store.mutate(projectRequest(0))).ok, true);
  assert.equal((await store.mutate(projectRequest(1, "第二项目"))).ok, true);
  const maintenance = createMaintenance(root);
  const listed = await maintenance.listBackups();
  assert.equal(listed.backups.length, 1);
  assert.equal(listed.backups[0].revision, 1);
  const current = "{corrupt current disk";
  await fs.writeFile(path.join(root, "data.json"), current);
  const output = path.join(temporary, "portable.json");
  const exported = await maintenance.exportBackup(listed.backups[0].name, output);
  assert.equal(exported.ok, true);
  assert.equal(exported.sourceRevision, 1);
  const bytes = await fs.readFile(output);
  const backup = validateBackup(JSON.parse(bytes));
  assert.equal(backup.board.projects.length, 1);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  await assert.rejects(maintenance.exportBackup(listed.backups[0].name, output), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(output), bytes);
  assert.equal(await fs.readFile(path.join(root, "data.json"), "utf8"), current);
  await assert.rejects(maintenance.exportBackup("../data.json", path.join(temporary, "no.json")));
  await fs.writeFile(path.join(root, "backups", listed.backups[0].name), "{damaged backup");
  await assert.rejects(maintenance.exportBackup(listed.backups[0].name, path.join(temporary, "rejected.json")));
  await assert.rejects(fs.stat(path.join(temporary, "rejected.json")), { code: "ENOENT" });
}));

test("maintenance rejects backup and output symlinks while retaining targets", async () => fixture(async (root, temporary) => {
  const store = createFileStore(root);
  await store.mutate(projectRequest(0)); await store.mutate(projectRequest(1));
  const maintenance = createMaintenance(root);
  const name = (await maintenance.listBackups()).backups[0].name;
  const outputTarget = path.join(temporary, "output-target"); await fs.writeFile(outputTarget, "intact");
  const linkedOutput = path.join(temporary, "output-link"); await fs.symlink(outputTarget, linkedOutput);
  await assert.rejects(maintenance.exportBackup(name, linkedOutput), { code: "EEXIST" });
  assert.equal(await fs.readFile(outputTarget, "utf8"), "intact");
  const backupTarget = path.join(temporary, "backup-target");
  await fs.rename(path.join(root, "backups", name), backupTarget);
  await fs.symlink(backupTarget, path.join(root, "backups", name));
  const bytes = await fs.readFile(backupTarget);
  const invalidList = await maintenance.listBackups();
  assert.equal(invalidList.backups[0].valid, false);
  assert.equal(invalidList.backups[0].error.code, "INVALID_BACKUP");
  await assert.rejects(maintenance.exportBackup(name, path.join(temporary, "rejected.json")), /Unsafe/);
  assert.deepEqual(await fs.readFile(backupTarget), bytes);
}));

test("backup listing distinguishes valid copies from legal JSON tampering, missing hashes and damaged migration pairs", async () => fixture(async (root, temporary) => {
  const store = createFileStore(root);
  await store.mutate(projectRequest(0, "第一项目"));
  await store.mutate(projectRequest(1, "第二项目"));
  await store.mutate(projectRequest(2, "第三项目"));
  const maintenance = createMaintenance(root);
  const initial = (await maintenance.listBackups()).backups;
  assert.equal(initial.length, 2);
  assert.ok(initial.every((backup) => backup.valid));
  const tamperedName = initial[0].name;
  const tamperedPath = path.join(root, "backups", tamperedName);
  const disk = JSON.parse(await fs.readFile(tamperedPath, "utf8"));
  disk.projects[0].description = "合法字段已经被篡改";
  const tampered = Buffer.from(JSON.stringify(disk));
  assert.doesNotThrow(() => parseDiskBytes(tampered));
  await fs.writeFile(tamperedPath, tampered);
  const legacyName = `revision-0000000000000001-${randomUUID()}.json`;
  await fs.writeFile(path.join(root, "backups", legacyName), await fs.readFile(path.join(root, "backups", initial[1].name)));
  const migration = { schemaVersion: 2, revision: 0, projects: [], tasks: [], syncState: "unsynced", persistence: "local", appliedRequests: [] };
  const migrationBytes = Buffer.from(JSON.stringify(migration));
  await fs.writeFile(path.join(root, "backups", "schema2-migration.json"), migrationBytes);
  let listed = await maintenance.listBackups();
  assert.equal(listed.backups.length, 4);
  assert.equal(listed.backups.filter((backup) => backup.valid).length, 1);
  assert.ok(listed.backups.filter((backup) => !backup.valid).every((backup) => backup.error.code === "INVALID_BACKUP"));
  const output = path.join(temporary, "preserve-output.json"); await fs.writeFile(output, "existing output must remain");
  for (const name of [tamperedName, legacyName, "schema2-migration.json"]) {
    await assert.rejects(maintenance.exportBackup(name, output));
    assert.equal(await fs.readFile(output, "utf8"), "existing output must remain");
  }
  const validOutput = path.join(temporary, "still-exportable.json");
  assert.equal((await maintenance.exportBackup(initial[1].name, validOutput)).ok, true);
  validateBackup(JSON.parse(await fs.readFile(validOutput, "utf8")));
  await fs.writeFile(path.join(root, "backups", MIGRATION_CHECKSUM), rawChecksum(migrationBytes) + "\n");
  listed = await maintenance.listBackups();
  assert.equal(listed.backups.find((backup) => backup.name === "schema2-migration.json").valid, true);
  migration.syncState = "unsynced"; migration.revision = 0;
  const migrationChanged = Buffer.from(JSON.stringify(migration, null, 2));
  assert.doesNotThrow(() => parseDiskBytes(migrationChanged));
  await fs.writeFile(path.join(root, "backups", "schema2-migration.json"), migrationChanged);
  assert.equal((await maintenance.listBackups()).backups.find((backup) => backup.name === "schema2-migration.json").valid, false);
  await assert.rejects(maintenance.exportBackup("schema2-migration.json", path.join(temporary, "tampered-migration.json")));
  await assert.rejects(fs.stat(path.join(temporary, "tampered-migration.json")), { code: "ENOENT" });
}));

test("CLI accepts explicit recovery flags and positional backup names; no root override exists", async () => fixture(async (root, temporary) => {
  const calls = [];
  const stub = {
    inspectLock: () => { calls.push(["inspect"]); return { ok: true }; }, listBackups: () => { calls.push(["list"]); return { ok: true }; },
    recoverLock: (options) => { calls.push(["recover", options]); return { ok: true }; }, exportBackup: (...args) => { calls.push(["export", ...args]); return { ok: true }; },
  };
  await runMaintenanceCLI(["inspect-lock"], stub);
  await runMaintenanceCLI(["list-backups"], stub);
  await runMaintenanceCLI(["export-backup", "schema2-migration.json", "--output", path.join(temporary, "new.json")], stub);
  const token = randomUUID(); const fingerprint = "a".repeat(64);
  await runMaintenanceCLI(["recover-lock", "--expected-token", token, "--expected-fingerprint", fingerprint, "--confirm-all-clients-stopped"], stub);
  assert.deepEqual(calls[3], ["recover", { expectedToken: token, expectedFingerprint: fingerprint, confirmAllClientsStopped: true }]);
  for (const args of [["inspect-lock", "--directory", root], ["recover-lock", "--force"], ["recover-lock", "--expected-token", token, "--expected-token", token], ["export-backup", "--name", "x", "--output", "x"], ["delete-lock"]]) await assert.rejects(runMaintenanceCLI(args, stub), /Usage/);
  const source = await fs.readFile(new URL("../src/maintenance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env|--directory|--root/);
}));

test("restore-backup replaces only an unreadable data file, keeping the damaged copy", async () => fixture(async (root) => {
  const store = createFileStore(root);
  const first = await store.mutate(projectRequest(0, "第一版"));
  const second = await store.mutate(projectRequest(first.board.revision, "第二版"));
  assert.equal(second.ok, true);
  const maintenance = createMaintenance(root);
  const [backup] = (await maintenance.listBackups()).backups;
  await assert.rejects(maintenance.restoreBackup(backup.name, { confirmAllClientsStopped: true }), /readable/);
  await assert.rejects(maintenance.restoreBackup(backup.name), /confirm-all-clients-stopped/);
  await fs.writeFile(path.join(root, "data.json"), "{ damaged");
  assert.equal((await store.read()).error.code, "INVALID_STORE");
  const restored = await runMaintenanceCLI(["restore-backup", backup.name, "--confirm-all-clients-stopped"], maintenance);
  assert.equal(restored.revision, backup.revision);
  assert.equal(await fs.readFile(path.join(root, restored.damagedFile), "utf8"), "{ damaged");
  const read = await store.read();
  assert.equal(read.ok, true);
  assert.equal(read.board.revision, backup.revision);
  assert.equal((await store.mutate(projectRequest(read.board.revision, "恢复后继续"))).ok, true);
}));

test("restore-backup refuses while a save lock marker is present", async () => fixture(async (root) => {
  const store = createFileStore(root);
  await store.mutate(projectRequest(0));
  await store.mutate(projectRequest(1));
  const maintenance = createMaintenance(root);
  const [backup] = (await maintenance.listBackups()).backups;
  await fs.writeFile(path.join(root, "data.json"), "{ damaged");
  await makeLock(root);
  await assert.rejects(maintenance.restoreBackup(backup.name, { confirmAllClientsStopped: true }), /lock/);
  assert.equal(await fs.readFile(path.join(root, "data.json"), "utf8"), "{ damaged");
}));
