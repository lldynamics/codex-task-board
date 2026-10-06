import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { codexSnapshotSchema, CODEX_SNAPSHOT_STALE_MS, staleAfterMs } from "../src/codex-domain.mjs";
import { CODEX_SNAPSHOT_FILENAME, CODEX_SNAPSHOT_LOCK_FILENAME, CODEX_SNAPSHOT_MAX_BYTES, createCodexService, ingestCodexSnapshot } from "../src/codex-service.mjs";
import { runCodexSync } from "../src/codex-sync.mjs";

const origin = Date.parse("2026-10-05T00:00:00.000Z");
const iso = (milliseconds) => new Date(milliseconds).toISOString();
const emptyMetadata = () => ({ automations: [], threads: [], turns: [] });
const thread = (id = "local-thread", fields = {}) => ({ id, hostId: "local", kind: "codex", title: "任务标题", cwd: "/private/project", updatedAt: origin / 1000 - 5, status: "idle", ...fields });
const collection = (milliseconds = origin, fields = {}) => ({ capturedAt: iso(milliseconds), limit: 200, result: { pinnedThreads: [], threads: [thread()], unavailableHosts: [], unavailableSources: [] }, ...fields });
const cachePath = (directory) => path.join(directory, CODEX_SNAPSHOT_FILENAME);
async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "learning-board-codex-"));
  try { await run(path.join(temporary, "data"), temporary); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
function reader(directory, options = {}) { return createCodexService({ directory, now: () => origin, readMetadata: emptyMetadata, ...options }); }
function sink() {
  let value = "";
  return { stream: new Writable({ write(chunk, encoding, callback) { value += chunk.toString(); callback(); } }), value: () => value };
}
async function lockHolder(directory) {
  const code = "import {DatabaseSync} from 'node:sqlite'; const database = new DatabaseSync(process.argv[1]); database.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;'); process.send('held'); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, path.join(directory, CODEX_SNAPSHOT_LOCK_FILENAME)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  let timer;
  try {
    await Promise.race([once(child, "message"), exited.then(() => { throw Error("Lock holder exited before readiness"); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Lock holder readiness timeout")), 3000); })]);
  } catch (error) {
    child.kill("SIGKILL"); await exited; throw error;
  } finally { clearTimeout(timer); }
  return { child, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); return exited; } };
}

test("native snapshot filters identities, maps structured statuses and never persists summaries or private turn bodies", async () => fixture(async (directory) => {
  const input = collection(origin, { result: {
    pinnedThreads: [thread("same", { summary: "SECRET_SUMMARY", prompt: "SECRET_PROMPT", goalStatus: "complete", lastTurnStatus: "completed", updatedAt: null })],
    threads: [thread("same", { status: "active" }), thread("same", { hostId: "remote-control:host", status: { type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] } }), thread("input", { status: { type: "active", activeFlags: ["waitingOnUserInput"] } }), thread("error", { status: "systemError" }), thread("chat", { kind: "chatgpt" })],
    unavailableHosts: [], unavailableSources: [], schemaVersion: 4,
  } });
  const receipt = await ingestCodexSnapshot(directory, input, { now: origin });
  assert.equal(receipt.threadCount, 4);
  assert.equal(receipt.complete, true);
  const bytes = await fs.readFile(cachePath(directory), "utf8");
  for (const secret of ["SECRET_SUMMARY", "SECRET_PROMPT", "goalStatus\":\"complete", "lastTurnStatus\":\"completed", "schemaVersion"]) assert.equal(bytes.includes(secret), false);
  const snapshot = await reader(directory).read();
  assert.equal(codexSnapshotSchema.safeParse(snapshot).success, true);
  assert.deepEqual(snapshot.threads.map((value) => [value.id, value.hostId, value.runtimeStatus, value.attention]), [
    ["same", "local", "active", null], ["same", "remote-control:host", "active", "approval"], ["input", "local", "active", "input"], ["error", "local", "error", null],
  ]);
  assert.ok(snapshot.threads.every((value) => value.goalStatus === null && value.lastTurnStatus === null));
  assert.equal(snapshot.sources.threads.lastSuccessAt, iso(origin));
  assert.equal(snapshot.connection.scope, "桌面已缓存记录");
}));

test("a missing host identity makes the native collection partial without inventing a local host", async () => fixture(async (directory) => {
  const invalid = thread("missing-host"); delete invalid.hostId;
  const result = await ingestCodexSnapshot(directory, collection(origin, { result: { pinnedThreads: [], threads: [invalid, thread()], unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  assert.equal(result.complete, false);
  assert.equal(result.threadCount, 1);
  const snapshot = await reader(directory).read();
  assert.equal(snapshot.sources.threads.state, "partial");
  assert.equal(snapshot.sources.threads.error.code, "SOURCE_PARTIAL");
}));

test("malformed entries and unknown kinds cannot turn a partial capture into an empty complete snapshot", async () => fixture(async (directory) => {
  const invalidEntries = [null, false, 42, "invalid", [], {}, { id: "missing-kind" }, thread("unknown", { kind: "future-source" }), { kind: "chatgpt" }];
  let capturedAt = origin;
  await ingestCodexSnapshot(directory, collection(origin), { now: origin });
  for (const key of ["pinnedThreads", "threads"]) {
    for (const entry of invalidEntries) {
      capturedAt += 1000;
      const input = collection(capturedAt, { result: { pinnedThreads: [], threads: [], unavailableHosts: [], unavailableSources: [], [key]: [entry] } });
      const output = sink(); const errors = sink();
      assert.equal(await runCodexSync(["ingest"], { directory, input: Readable.from([JSON.stringify(input)]), output: output.stream, errorOutput: errors.stream, now: capturedAt }), 0);
      const receipt = JSON.parse(output.value());
      assert.equal(receipt.complete, false, `${key}: ${JSON.stringify(entry)}`);
      assert.equal(receipt.threadCount, 1);
      assert.equal(errors.value(), "");
      const snapshot = await reader(directory, { now: () => capturedAt }).read();
      assert.equal(snapshot.threads.length, 1);
      assert.equal(snapshot.threads[0].id, "local-thread");
      assert.equal(snapshot.threads[0].runtimeStatus, "unknown");
      assert.equal(snapshot.sources.threads.state, "partial");
      const saved = JSON.parse(await fs.readFile(cachePath(directory), "utf8"));
      assert.equal(saved.records[0].capturedAt, iso(origin));
    }
  }
}));

test("valid ChatGPT-only captures can still provide complete empty Codex coverage", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  const next = collection(origin + 1000, { result: { pinnedThreads: [], threads: [thread("chatgpt-thread", { kind: "chatgpt" })], unavailableHosts: [], unavailableSources: [] } });
  const receipt = await ingestCodexSnapshot(directory, next, { now: origin + 1000 });
  assert.equal(receipt.complete, true);
  assert.equal(receipt.threadCount, 0);
  const snapshot = await reader(directory, { now: () => origin + 1000 }).read();
  assert.equal(snapshot.sources.threads.complete, true);
  assert.deepEqual(snapshot.threads, []);
}));

test("partial and paginated captures retain old records while complete captures can remove them", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(origin, { result: { pinnedThreads: [], threads: [thread("old", { status: "active" }), thread("keep")], unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  const partial = collection(origin + 1000, { limit: 1, result: { pinnedThreads: [], threads: [thread("keep", { status: "active" })], unavailableHosts: [], unavailableSources: [] } });
  assert.equal((await ingestCodexSnapshot(directory, partial, { now: origin + 1000 })).truncated, true);
  const snapshot = await reader(directory, { now: () => origin + 1000 }).read();
  assert.equal(snapshot.threads.length, 2);
  assert.equal(snapshot.threads.find((value) => value.id === "old").runtimeStatus, "unknown");
  assert.equal(snapshot.threads.find((value) => value.id === "keep").runtimeStatus, "active");
  const cache = JSON.parse(await fs.readFile(cachePath(directory), "utf8"));
  assert.equal(cache.records.find((value) => value.thread.id === "old").capturedAt, iso(origin));
  const replay = await ingestCodexSnapshot(directory, partial, { now: origin + 1000 });
  assert.equal(replay.unchanged, true);
  await ingestCodexSnapshot(directory, collection(origin + 2000), { now: origin + 2000 });
  assert.equal((await reader(directory, { now: () => origin + 2000 }).read()).threads.length, 1);
}));

test("unavailable sources and hosts retain missing records and remain distinct from fresh live data", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(origin), { now: origin });
  await ingestCodexSnapshot(directory, collection(origin + 1000, { result: { pinnedThreads: [], threads: [], unavailableHosts: ["remote-control:host"], unavailableSources: ["chatgpt"] } }), { now: origin + 1000 });
  const snapshot = await reader(directory, { now: () => origin + 1000 }).read();
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].runtimeStatus, "unknown");
  assert.equal(snapshot.sources.threads.mode, "snapshot");
  assert.equal(snapshot.sources.threads.complete, false);
}));

test("partial native snapshots add uncovered history records as unknown without overriding observed statuses", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(origin, { limit: 1, result: { pinnedThreads: [], threads: [thread("observed", { status: "active" })], unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  const snapshot = await reader(directory, { readMetadata: () => ({ automations: [], turns: [], threads: [
    { host_id: "local", thread_id: "observed", display_title: "旧标题", source_updated_at: origin / 1000 - 100, cwd: null },
    { host_id: "remote-control:host", thread_id: "uncovered", display_title: "历史记录", source_updated_at: origin / 1000 - 200, cwd: null },
  ] }) }).read();
  assert.equal(snapshot.threads.length, 2);
  assert.equal(snapshot.threads[0].title, "任务标题");
  assert.equal(snapshot.threads[0].runtimeStatus, "active");
  assert.equal(snapshot.threads[1].runtimeStatus, "unknown");
  assert.equal(snapshot.threads[1].attention, null);
  assert.equal(snapshot.sources.threads.lastSuccessAt, iso(origin));
  assert.equal(snapshot.sources.threads.complete, false);
  assert.equal(snapshot.connection.scope.includes("本地历史"), true);
}));

test("future, earlier and conflicting same-time captures cannot overwrite accepted bytes", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(origin), { now: origin });
  const before = await fs.readFile(cachePath(directory));
  for (const [input, code] of [[collection(origin + 5 * 60 * 1000 + 1), "FUTURE_SNAPSHOT"], [collection(origin - 1), "SNAPSHOT_ORDER"], [collection(origin, { result: { pinnedThreads: [], threads: [thread("other")], unavailableHosts: [], unavailableSources: [] } }), "SNAPSHOT_ORDER"]]) {
    await assert.rejects(ingestCodexSnapshot(directory, input, { now: origin }), { code });
    assert.deepEqual(await fs.readFile(cachePath(directory)), before);
  }
  assert.equal((await ingestCodexSnapshot(directory, collection(origin), { now: origin })).unchanged, true);
}));

test("a capture slightly ahead of the server clock is recorded at server time instead of being lost", async () => fixture(async (directory) => {
  const receipt = await ingestCodexSnapshot(directory, collection(origin + 90 * 1000), { now: origin });
  assert.equal(receipt.capturedAt, new Date(origin).toISOString());
  const cache = JSON.parse(await fs.readFile(cachePath(directory), "utf8"));
  assert.equal(cache.capturedAt, new Date(origin).toISOString());
  assert.ok(cache.records.every((record) => record.capturedAt === cache.capturedAt));
}));

test("read keeps captured time, marks three-minute expiry and checks expiry even inside the read throttle", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(origin, { result: { pinnedThreads: [], threads: [thread("active", { status: { type: "active", activeFlags: ["waitingOnApproval"] } })], unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  let clock = origin + CODEX_SNAPSHOT_STALE_MS;
  const service = reader(directory, { now: () => clock });
  assert.equal((await service.read()).sources.threads.state, "connected");
  clock += 1;
  const expired = await service.read();
  assert.equal(expired.sources.threads.lastSuccessAt, iso(origin));
  assert.equal(expired.observedAt, iso(clock));
  assert.equal(expired.sources.threads.error.code, "SNAPSHOT_STALE");
  assert.equal(expired.sources.threads.state, "disconnected");
  assert.equal(expired.threads[0].runtimeStatus, "unknown");
  assert.equal(expired.threads[0].attention, null);
  assert.equal(expired.sources.automations.lastSuccessAt, iso(origin + CODEX_SNAPSHOT_STALE_MS));
}));

test("corrupt, missing, older and future disk caches preserve the service's last accepted records and collection time", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(origin), { now: origin });
  const original = await fs.readFile(cachePath(directory), "utf8");
  let clock = origin;
  const service = reader(directory, { now: () => clock });
  await service.read();
  const mutations = [
    () => fs.writeFile(cachePath(directory), "{broken"),
    () => fs.unlink(cachePath(directory)),
    () => fs.writeFile(cachePath(directory), JSON.stringify({ ...JSON.parse(original), capturedAt: iso(origin + 999999) })),
    () => fs.writeFile(cachePath(directory), JSON.stringify({ ...JSON.parse(original), capturedAt: iso(origin - 1000), records: [] })),
  ];
  for (const mutate of mutations) {
    await mutate(); clock += 1000;
    const snapshot = await service.read();
    assert.equal(snapshot.threads.length, 1);
    assert.equal(snapshot.threads[0].runtimeStatus, "unknown");
    assert.equal(snapshot.sources.threads.lastSuccessAt, iso(origin));
    assert.equal(snapshot.sources.threads.state, "disconnected");
    assert.ok(snapshot.sources.threads.error);
  }
}));

test("invalid input and incompatible cache versions are rejected without rewriting or creating board data", async () => fixture(async (directory) => {
  await assert.rejects(ingestCodexSnapshot(directory, { ...collection(), secret: "input-private" }, { now: origin }), { code: "INVALID_INPUT" });
  await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
  await fs.mkdir(directory);
  const bytes = Buffer.from(JSON.stringify({ version: 99, secret: "cache-private" }));
  await fs.writeFile(cachePath(directory), bytes);
  await assert.rejects(ingestCodexSnapshot(directory, collection(), { now: origin }), { code: "CACHE_INVALID" });
  assert.deepEqual(await fs.readFile(cachePath(directory)), bytes);
  const snapshot = await reader(directory).read();
  assert.equal(snapshot.sources.threads.error.code, "CACHE_INVALID");
  assert.deepEqual((await fs.readdir(directory)).sort(), [CODEX_SNAPSHOT_FILENAME, CODEX_SNAPSHOT_LOCK_FILENAME].sort());
}));

test("strict cache validation rejects extra private fields, duplicate identities and inconsistent completeness", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  const valid = JSON.parse(await fs.readFile(cachePath(directory), "utf8"));
  const mutations = [
    { ...valid, summary: "PRIVATE_FIELD" },
    { ...valid, records: [...valid.records, valid.records[0]] },
    { ...valid, truncated: true },
    { ...valid, records: [{ ...valid.records[0], capturedAt: iso(origin - 1) }] },
    { ...valid, records: [{ ...valid.records[0], thread: { ...valid.records[0].thread, goalStatus: "complete" } }] },
  ];
  for (const value of mutations) {
    const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(cachePath(directory), bytes);
    const snapshot = await reader(directory).read();
    assert.equal(snapshot.sources.threads.error.code, "CACHE_INVALID");
    await assert.rejects(ingestCodexSnapshot(directory, collection(origin + 1000), { now: origin + 1000 }), { code: "CACHE_INVALID" });
    assert.deepEqual(await fs.readFile(cachePath(directory)), bytes);
  }
}));

test("cache symlinks and directory symlinks are refused without changing their targets", async () => fixture(async (directory, temporary) => {
  const outside = path.join(temporary, "outside");
  await fs.mkdir(outside);
  const target = path.join(outside, "important.json");
  await fs.writeFile(target, "KEEP");
  await fs.mkdir(directory);
  await fs.symlink(target, cachePath(directory));
  assert.equal((await reader(directory).read()).sources.threads.error.code, "CACHE_UNSAFE");
  await assert.rejects(ingestCodexSnapshot(directory, collection(), { now: origin }), { code: "CACHE_UNSAFE" });
  assert.equal(await fs.readFile(target, "utf8"), "KEEP");
  await fs.unlink(cachePath(directory));
  await fs.unlink(path.join(directory, CODEX_SNAPSHOT_LOCK_FILENAME));
  await fs.rmdir(directory);
  await fs.symlink(outside, directory);
  await assert.rejects(ingestCodexSnapshot(directory, collection(), { now: origin }));
  assert.deepEqual(await fs.readdir(outside), ["important.json"]);
}));

test("oversized and nonregular cache files are not opened as supported caches", async () => fixture(async (directory) => {
  await fs.mkdir(directory);
  await fs.mkdir(cachePath(directory));
  assert.equal((await reader(directory).read()).sources.threads.error.code, "CACHE_UNSAFE");
  await fs.rmdir(cachePath(directory));
  const handle = await fs.open(cachePath(directory), "w");
  await handle.truncate(CODEX_SNAPSHOT_MAX_BYTES + 1); await handle.close();
  assert.equal((await reader(directory).read()).sources.threads.error.code, "CACHE_UNSAFE");
  await assert.rejects(ingestCodexSnapshot(directory, collection(), { now: origin }), { code: "CACHE_UNSAFE" });
  assert.equal((await fs.stat(cachePath(directory))).size, CODEX_SNAPSHOT_MAX_BYTES + 1);
}));

test("new cache directories and files are private, existing directory permissions and board artifacts stay unchanged", async () => fixture(async (directory, temporary) => {
  const nested = path.join(temporary, "new-parent", "new-cache");
  await ingestCodexSnapshot(nested, collection(), { now: origin });
  assert.equal((await fs.stat(nested)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.dirname(nested))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(cachePath(nested))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(nested, CODEX_SNAPSHOT_LOCK_FILENAME))).mode & 0o777, 0o600);
  await fs.mkdir(directory, { mode: 0o750 });
  await fs.chmod(directory, 0o750);
  await fs.writeFile(path.join(directory, "data.json"), "BOARD_REVISION_KEEP");
  await fs.mkdir(path.join(directory, "backups"));
  await fs.writeFile(path.join(directory, "backups", "revision-keep.json"), "BACKUP_KEEP");
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o750);
  assert.equal(await fs.readFile(path.join(directory, "data.json"), "utf8"), "BOARD_REVISION_KEEP");
  assert.equal(await fs.readFile(path.join(directory, "backups", "revision-keep.json"), "utf8"), "BACKUP_KEEP");
  assert.deepEqual((await fs.readdir(directory)).sort(), ["backups", CODEX_SNAPSHOT_FILENAME, CODEX_SNAPSHOT_LOCK_FILENAME, "data.json"].sort());
}));

test("simultaneous writers serialize and the newest capture wins regardless of lock order", async () => fixture(async (directory) => {
  const captures = [origin + 1000, origin, origin + 2000, origin + 1500];
  const results = await Promise.allSettled(captures.map((value) => ingestCodexSnapshot(directory, collection(value, { result: { pinnedThreads: [], threads: [thread(String(value))], unavailableHosts: [], unavailableSources: [] } }), { now: origin + 3000 })));
  assert.ok(results.some((value) => value.status === "fulfilled"));
  assert.ok(results.every((value) => value.status === "fulfilled" || value.reason.code === "SNAPSHOT_ORDER"));
  const cache = JSON.parse(await fs.readFile(cachePath(directory), "utf8"));
  assert.equal(cache.capturedAt, iso(origin + 2000));
  assert.deepEqual((await fs.readdir(directory)).sort(), [CODEX_SNAPSHOT_FILENAME, CODEX_SNAPSHOT_LOCK_FILENAME].sort());
}));

test("a live child collector transaction cannot be stolen and preserves the existing cache", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  const original = await fs.readFile(cachePath(directory));
  const holder = await lockHolder(directory);
  try {
    await assert.rejects(ingestCodexSnapshot(directory, collection(origin + 1000), { now: origin + 1000 }), { code: "COLLECTOR_LOCKED" });
    assert.equal(holder.child.exitCode, null);
    assert.equal(holder.child.signalCode, null);
    assert.deepEqual(await fs.readFile(cachePath(directory)), original);
  } finally { await holder.stop(); }
}));

test("SIGKILL releases the child collector transaction without deleting or ageing out its lock file", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  const lock = path.join(directory, CODEX_SNAPSHOT_LOCK_FILENAME);
  const before = await fs.stat(lock);
  const holder = await lockHolder(directory);
  const [, signal] = await holder.stop();
  assert.equal(signal, "SIGKILL");
  const receipt = await ingestCodexSnapshot(directory, collection(origin + 1000), { now: origin + 1000 });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.capturedAt, iso(origin + 1000));
  const after = await fs.stat(lock);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.equal(after.mode & 0o777, 0o600);
}));

test("separate child writers serialize snapshots and keep the newest observed capture", async () => fixture(async (directory) => {
  const moduleUrl = new URL("../src/codex-service.mjs", import.meta.url).href;
  const code = `import {ingestCodexSnapshot} from ${JSON.stringify(moduleUrl)}; try { const receipt = await ingestCodexSnapshot(process.argv[1], JSON.parse(process.argv[2]), {now:Number(process.argv[3])}); console.log(JSON.stringify(receipt)); } catch (error) { console.log(JSON.stringify({ok:false,errorCode:error.code})); }`;
  const captures = [origin + 1000, origin, origin + 2000, origin + 1500];
  const results = await Promise.all(captures.map(async (capturedAt) => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, directory, JSON.stringify(collection(capturedAt)), String(origin + 3000)], { timeout: 5000, maxBuffer: 4096 });
    return JSON.parse(stdout);
  }));
  assert.ok(results.some((value) => value.ok));
  assert.ok(results.every((value) => value.ok || value.errorCode === "SNAPSHOT_ORDER"));
  assert.equal(JSON.parse(await fs.readFile(cachePath(directory), "utf8")).capturedAt, iso(origin + 2000));
}));

test("symlink lock databases and sidecars are refused and their targets are not changed", async () => fixture(async (directory, temporary) => {
  await fs.mkdir(directory);
  const lock = path.join(directory, CODEX_SNAPSHOT_LOCK_FILENAME);
  const outside = path.join(temporary, "other-lock"); await fs.writeFile(outside, "KEEP");
  await fs.symlink(outside, lock);
  await assert.rejects(ingestCodexSnapshot(directory, collection(), { now: origin }), { code: "CACHE_UNSAFE" });
  assert.equal(await fs.readFile(outside, "utf8"), "KEEP");
  assert.equal((await fs.lstat(lock)).isSymbolicLink(), true);
  await fs.unlink(lock);
  await fs.writeFile(lock, "", { mode: 0o600 });
  await fs.symlink(outside, lock + "-journal");
  await assert.rejects(ingestCodexSnapshot(directory, collection(), { now: origin }), { code: "CACHE_UNSAFE" });
  assert.equal(await fs.readFile(outside, "utf8"), "KEEP");
  assert.equal((await fs.lstat(lock + "-journal")).isSymbolicLink(), true);
}));

test("rolling partial captures keep current observations, evict the oldest unobserved records and remain idempotent", async () => fixture(async (directory) => {
  const old = Array.from({ length: 1000 }, (_, index) => thread(`old-${index}`));
  await ingestCodexSnapshot(directory, collection(origin, { limit: 1000, result: { pinnedThreads: old, threads: [], unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  for (let batch = 1; batch <= 3; batch++) {
    const capturedAt = origin + batch * 1000;
    const observed = Array.from({ length: 50 }, (_, index) => thread(`batch-${batch}-${index}`, { status: "active" }));
    // Native pagination is not truncated; unavailable hosts make this input partial.
    const input = collection(capturedAt, { result: { pinnedThreads: [], threads: observed, unavailableHosts: ["remote-control:host"], unavailableSources: [] } });
    const receipt = await ingestCodexSnapshot(directory, input, { now: capturedAt });
    assert.equal(receipt.threadCount, 1000);
    assert.equal(receipt.complete, false);
    assert.equal(receipt.truncated, true);
    const bytes = await fs.readFile(cachePath(directory));
    assert.equal((await ingestCodexSnapshot(directory, input, { now: capturedAt })).unchanged, true);
    assert.deepEqual(await fs.readFile(cachePath(directory)), bytes);
    const saved = JSON.parse(bytes);
    assert.equal(saved.captureTruncated, false);
    assert.equal(saved.records.filter((record) => record.thread.id.startsWith("old-")).length, 1000 - batch * 50);
    for (let previous = 1; previous <= batch; previous++) assert.equal(saved.records.filter((record) => record.thread.id.startsWith(`batch-${previous}-`)).length, 50);
    const snapshot = await reader(directory, { now: () => capturedAt }).read();
    assert.equal(snapshot.sources.threads.state, "partial");
    assert.equal(snapshot.sources.threads.truncated, true);
    assert.equal(snapshot.threads.filter((value) => value.runtimeStatus === "active").length, 50);
    assert.ok(snapshot.threads.filter((value) => !value.id.startsWith(`batch-${batch}-`)).every((value) => value.runtimeStatus === "unknown"));
  }
}));

test("existing cache version one without truncation provenance remains readable and replayable", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  const legacy = JSON.parse(await fs.readFile(cachePath(directory), "utf8"));
  delete legacy.captureTruncated;
  await fs.writeFile(cachePath(directory), JSON.stringify(legacy));
  const original = await fs.readFile(cachePath(directory));
  assert.equal((await reader(directory).read()).sources.threads.state, "connected");
  assert.equal((await ingestCodexSnapshot(directory, collection(), { now: origin })).unchanged, true);
  assert.deepEqual(await fs.readFile(cachePath(directory)), original);
}));

test("read single-flight throttles index work while returning independent immutable snapshots", async () => fixture(async (directory) => {
  let clock = origin;
  let calls = 0;
  let release;
  const service = reader(directory, { now: () => clock, readMetadata: async () => { calls++; await new Promise((resolve) => { release = resolve; }); return emptyMetadata(); } });
  const first = service.read(); const second = service.read();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1); release();
  const [a, b] = await Promise.all([first, second]);
  a.sources.automations.state = "unsupported";
  assert.equal(b.sources.automations.state, "connected");
  clock += 500; await service.read(); assert.equal(calls, 1);
  clock += 501; const third = service.read();
  await new Promise((resolve) => setTimeout(resolve, 5)); assert.equal(calls, 2); release(); await third;
  await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
}));

test("metadata failures preserve last good automations and their source freshness independently from native thread updates", async () => fixture(async (directory) => {
  let clock = origin;
  let fail = false;
  const automation = { id: "timer", name: "计划", status: "ACTIVE", kind: "heartbeat", rrule: "RRULE:FREQ=MINUTELY;INTERVAL=2", target_thread_id: "local-thread", last_run_at: origin - 10000, next_run_at: origin + 10000, prompt: "SECRET_PROMPT", error_json: "SECRET_ERROR" };
  const service = reader(directory, { now: () => clock, readMetadata: async () => fail ? { errors: { automations: { code: "SQLITE_TIMEOUT" }, threads: { code: "SQLITE_UNAVAILABLE" }, turns: { code: "SQLITE_UNAVAILABLE" } } } : { automations: [automation], threads: [], turns: [] } });
  await ingestCodexSnapshot(directory, collection(), { now: clock });
  const first = await service.read();
  assert.equal(first.automations[0].lastRunAt, iso(origin - 10000));
  assert.equal(first.automations[0].nextRunAt, iso(origin + 10000));
  assert.equal(first.automations[0].timeZone, null);
  assert.equal(JSON.stringify(first).includes("SECRET_"), false);
  clock += 2000; fail = true;
  await ingestCodexSnapshot(directory, collection(clock), { now: clock });
  const second = await service.read();
  assert.equal(second.automations.length, 1);
  assert.equal(second.sources.automations.lastSuccessAt, iso(origin));
  assert.equal(second.sources.automations.state, "disconnected");
  assert.equal(second.sources.automations.error.code, "SQLITE_TIMEOUT");
  assert.equal(second.sources.threads.lastSuccessAt, iso(clock));
  assert.equal(second.sources.threads.state, "connected");
}));

test("a hanging metadata reader returns a bounded timeout without preventing cached thread reads", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  const start = Date.now();
  const snapshot = await reader(directory, { readMetadata: () => new Promise(() => {}) }).read();
  assert.ok(Date.now() - start < 3500);
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.sources.threads.state, "connected");
  assert.equal(snapshot.sources.automations.error.code, "SQLITE_TIMEOUT");
}));

test("local-history fallback provides only cached catalog identities and never invents active runtime or goals", async () => fixture(async (directory) => {
  const snapshot = await reader(directory, { readMetadata: () => ({ automations: [], turns: [], threads: [{ host_id: "remote-control:host", thread_id: "archived", display_title: "缓存任务", source_updated_at: origin / 1000 - 600, cwd: "/private/project", summary: "SECRET_HISTORY", status: "active" }] }) }).read();
  assert.equal(snapshot.connection.source, "local-history");
  assert.equal(snapshot.sources.threads.mode, "archive");
  assert.equal(snapshot.sources.threads.complete, false);
  assert.equal(snapshot.threads[0].runtimeStatus, "unknown");
  assert.equal(snapshot.threads[0].goalStatus, null);
  assert.equal(snapshot.threads[0].updatedAt, iso(origin - 600000));
  assert.equal(JSON.stringify(snapshot).includes("SECRET_HISTORY"), false);
  await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
}));

test("injected catalog metadata excludes ChatGPT hosts before the history bound in fallback and partial snapshots", async () => fixture(async (directory) => {
  const ignored = Array.from({ length: 1001 }, (_, index) => ({ host_id: `${index % 2 ? "chatgpt:" : "CHATGPT:"}source`, thread_id: `chat-${index}`, display_title: "PRIVATE_CHATGPT_TITLE", source_updated_at: origin / 1000 - 1, cwd: null }));
  const threads = [...ignored,
    { host_id: "local", thread_id: "local-history", display_title: "本地Codex历史", source_updated_at: origin / 1000 - 200, cwd: null },
    { host_id: "remote-control:host", thread_id: "remote-history", display_title: "远程Codex历史", source_updated_at: origin / 1000 - 300, cwd: null },
  ];
  const service = reader(directory, { readMetadata: () => ({ automations: [], turns: [], threads }) });
  const fallback = await service.read();
  assert.deepEqual(fallback.threads.map((value) => value.id), ["local-history", "remote-history"]);
  assert.equal(fallback.sources.threads.truncated, false);
  assert.notEqual(fallback.sources.threads.error?.code, "METADATA_INVALID");
  assert.equal(JSON.stringify(fallback).includes("PRIVATE_CHATGPT_TITLE"), false);
  await ingestCodexSnapshot(directory, collection(origin, { limit: 1 }), { now: origin });
  const partial = await reader(directory, { readMetadata: () => ({ automations: [], turns: [], threads }) }).read();
  assert.deepEqual(partial.threads.map((value) => value.id), ["local-thread", "local-history", "remote-history"]);
  assert.equal(partial.sources.threads.error.code, "SOURCE_PARTIAL");
  assert.equal(JSON.stringify(partial).includes("PRIVATE_CHATGPT_TITLE"), false);
}));

test("turn metadata requires local identity and matching second-based timestamps, and inProgress alone is never active", async () => fixture(async (directory) => {
  const records = [thread("done"), thread("failed"), thread("interrupted"), thread("old"), thread("future"), thread("unknown-time", { updatedAt: null }), thread("running", { status: "active", updatedAt: origin / 1000 - 20 }), thread("residual", { status: "idle", updatedAt: origin / 1000 - 20 }), thread("done", { hostId: "remote-control:host" })];
  const turns = [
    ...["done", "failed", "interrupted"].map((id) => ({ thread_id: id, status: id === "done" ? "completed" : id, started_at: origin / 1000 - 20, completed_at: origin / 1000 - 4 })),
    { thread_id: "old", status: "completed", started_at: origin / 1000 - 100, completed_at: origin / 1000 - 50 },
    { thread_id: "future", status: "completed", started_at: origin / 1000 - 20, completed_at: origin / 1000 + 1 },
    { thread_id: "unknown-time", status: "completed", started_at: origin / 1000 - 20, completed_at: origin / 1000 - 4 },
    { thread_id: "running", status: "inProgress", started_at: origin / 1000 - 20, completed_at: null },
    { thread_id: "residual", status: "inProgress", started_at: origin / 1000 - 20, completed_at: null },
  ];
  await ingestCodexSnapshot(directory, collection(origin, { result: { pinnedThreads: [], threads: records, unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  const snapshot = await reader(directory, { readMetadata: () => ({ automations: [], threads: [], turns }) }).read();
  assert.deepEqual(snapshot.threads.map((value) => [value.id, value.lastTurnStatus]), [["done", "completed"], ["failed", "failed"], ["interrupted", "interrupted"], ["old", null], ["future", null], ["unknown-time", null], ["running", "running"], ["residual", null], ["done", null]]);
  assert.equal(snapshot.threads.find((value) => value.id === "residual").runtimeStatus, "idle");
  assert.ok(snapshot.threads.every((value) => value.goalStatus === null));
}));

test("metadata collections are bounded and malformed or duplicated rows are reported", async () => fixture(async (directory) => {
  const automations = Array.from({ length: 1001 }, (_, index) => ({ id: `timer-${index}`, name: "计划", status: "PAUSED", kind: "cron" }));
  const snapshot = await reader(directory, { readMetadata: () => ({ automations, turns: [], threads: [{ host_id: "local", thread_id: "valid", display_title: "有效" }, { host_id: "local", thread_id: "valid", display_title: "重复" }, { thread_id: "invalid", display_title: "缺host" }] }) }).read();
  assert.equal(snapshot.automations.length, 1000);
  assert.equal(snapshot.sources.automations.truncated, true);
  assert.equal(snapshot.sources.automations.complete, false);
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.sources.threads.error.code, "METADATA_INVALID");
}));

test("incomplete turn rows do not suppress valid unrelated terminal evidence", async () => fixture(async (directory) => {
  const records = [thread("done"), thread("failed"), thread("missing-start")];
  await ingestCodexSnapshot(directory, collection(origin, { result: { pinnedThreads: [], threads: records, unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  const turns = [
    { thread_id: "done", status: "completed", started_at: origin / 1000 - 20, completed_at: origin / 1000 - 4 },
    { thread_id: "missing-start", status: "completed", started_at: null, completed_at: origin / 1000 - 4 },
    { thread_id: "failed", status: "failed", started_at: origin / 1000 - 20, completed_at: origin / 1000 - 4 },
  ];
  const snapshot = await reader(directory, { readMetadata: () => ({ ...emptyMetadata(), turns }) }).read();
  assert.deepEqual(snapshot.threads.map((value) => [value.id, value.lastTurnStatus]), [["done", "completed"], ["failed", "failed"], ["missing-start", null]]);
  assert.ok(snapshot.threads.every((value) => value.goalStatus === null));
}));

test("a failed turn read never reuses previous completion evidence even for a metadata-invalid error", async () => fixture(async (directory) => {
  await ingestCodexSnapshot(directory, collection(), { now: origin });
  let clock = origin; let fail = false;
  const service = reader(directory, { now: () => clock, readMetadata: () => fail
    ? { ...emptyMetadata(), errors: { turns: { code: "METADATA_INVALID" } } }
    : { ...emptyMetadata(), turns: [{ thread_id: "local-thread", status: "completed", started_at: origin / 1000 - 20, completed_at: origin / 1000 - 4 }] } });
  assert.equal((await service.read()).threads[0].lastTurnStatus, "completed");
  clock += 1001; fail = true;
  assert.equal((await service.read()).threads[0].lastTurnStatus, null);
}));

test("ambiguous turn identities are excluded without discarding unrelated valid rows", async () => fixture(async (directory) => {
  const records = [thread("done"), thread("duplicate"), thread("incomplete")];
  await ingestCodexSnapshot(directory, collection(origin, { result: { pinnedThreads: [], threads: records, unavailableHosts: [], unavailableSources: [] } }), { now: origin });
  const completed = (id) => ({ thread_id: id, status: "completed", started_at: origin / 1000 - 20, completed_at: origin / 1000 - 4 });
  for (const reverse of [false, true]) {
    const turns = [completed("done"), completed("duplicate"), { ...completed("duplicate"), status: "failed" }, completed("incomplete"), { ...completed("incomplete"), started_at: null }];
    if (reverse) turns.reverse();
    const snapshot = await reader(directory, { readMetadata: () => ({ ...emptyMetadata(), turns }) }).read();
    assert.deepEqual(snapshot.threads.map((value) => [value.id, value.lastTurnStatus]), [["done", "completed"], ["duplicate", null], ["incomplete", null]]);
  }
}));

test("production SQLite adapter reads only fixed metadata columns from isolated databases and refuses symlink databases", async () => fixture(async (directory, temporary) => {
  const codexHome = path.join(temporary, "codex-home");
  await fs.mkdir(path.join(codexHome, "sqlite"), { recursive: true });
  const database = path.join(codexHome, "sqlite", "codex-dev.db");
  const execute = promisify(execFile);
  await execute("/usr/bin/sqlite3", [database, `CREATE TABLE automations (id TEXT, name TEXT, status TEXT, next_run_at INTEGER, last_run_at INTEGER, rrule TEXT, kind TEXT, target_thread_id TEXT, prompt TEXT, error_json TEXT);
    INSERT INTO automations VALUES ('auto','元数据计划','ACTIVE',${origin + 1000},${origin - 1000},'RRULE:FREQ=MINUTELY;INTERVAL=2','heartbeat','local-thread','SECRET_PROMPT','SECRET_ERROR');
    CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT, source_updated_at INTEGER, cwd TEXT, summary TEXT);
    INSERT INTO local_thread_catalog VALUES ('local','local-thread','历史元数据',${origin / 1000 - 5},'/private/project','SECRET_SUMMARY');`]);
  await execute("/usr/bin/sqlite3", [path.join(codexHome, "thread_history_1.sqlite"), `CREATE TABLE thread_turns (thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,duration_ms INTEGER,items TEXT,error_json TEXT);
    INSERT INTO thread_turns VALUES ('local-thread','new','completed',${origin / 1000 - 20},${origin / 1000 - 4},16000,'SECRET_BODY','SECRET_ERROR');
    INSERT INTO thread_turns VALUES ('local-thread','old','failed',${origin / 1000 - 100},${origin / 1000 - 90},10000,'SECRET_OLD','SECRET_ERROR');`]);
  const before = await fs.readFile(database);
  const snapshot = await createCodexService({ directory, codexHome, now: () => origin }).read();
  assert.equal(snapshot.automations[0].nextRunAt, iso(origin + 1000));
  assert.equal(snapshot.threads[0].lastTurnStatus, "completed");
  assert.equal(snapshot.threads[0].runtimeStatus, "unknown");
  assert.equal(JSON.stringify(snapshot).includes("SECRET_"), false);
  assert.deepEqual(await fs.readFile(database), before);
  await fs.rename(database, database + ".kept"); await fs.symlink(database + ".kept", database);
  const unavailable = await createCodexService({ directory, codexHome, now: () => origin }).read();
  assert.equal(unavailable.sources.automations.error.code, "SQLITE_UNAVAILABLE");
  assert.equal(unavailable.automations.length, 0);
  assert.deepEqual(await fs.readFile(database + ".kept"), before);
}));

test("production catalog SQL excludes ChatGPT hosts before LIMIT so older Codex history remains visible", async () => fixture(async (directory, temporary) => {
  const codexHome = path.join(temporary, "codex-home");
  await fs.mkdir(path.join(codexHome, "sqlite"), { recursive: true });
  const database = path.join(codexHome, "sqlite", "codex-dev.db");
  await promisify(execFile)("/usr/bin/sqlite3", [database, `CREATE TABLE automations (id TEXT,name TEXT,status TEXT,next_run_at INTEGER,last_run_at INTEGER,rrule TEXT,kind TEXT,target_thread_id TEXT);
    CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, display_title TEXT, source_updated_at INTEGER, cwd TEXT);
    WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 1005)
    INSERT INTO local_thread_catalog SELECT CASE WHEN n % 2 = 0 THEN 'chatgpt:source' ELSE 'CHATGPT:source' END, 'chat-' || n, 'PRIVATE_CHATGPT_TITLE', ${origin / 1000 - 1}, NULL FROM sequence;
    INSERT INTO local_thread_catalog VALUES ('local','local-history','本地Codex历史',${origin / 1000 - 200},NULL),('remote-control:host','remote-history','远程Codex历史',${origin / 1000 - 300},NULL);`]);
  const before = await fs.readFile(database);
  const snapshot = await createCodexService({ directory, codexHome, now: () => origin }).read();
  assert.deepEqual(snapshot.threads.map((value) => value.id), ["local-history", "remote-history"]);
  assert.equal(snapshot.sources.threads.truncated, false);
  assert.notEqual(snapshot.sources.threads.error?.code, "METADATA_INVALID");
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_CHATGPT_TITLE"), false);
  assert.deepEqual(await fs.readFile(database), before);
}));

test("missing SQLite tables degrade independently without reading fallback automation TOML files", async () => fixture(async (directory, temporary) => {
  const codexHome = path.join(temporary, "codex-home");
  await fs.mkdir(path.join(codexHome, "sqlite"), { recursive: true });
  await promisify(execFile)("/usr/bin/sqlite3", [path.join(codexHome, "sqlite", "codex-dev.db"), "CREATE TABLE automations (id TEXT,name TEXT,status TEXT,next_run_at INTEGER,last_run_at INTEGER,rrule TEXT,kind TEXT,target_thread_id TEXT); INSERT INTO automations (id,name,status,kind) VALUES ('timer','有界计划','PAUSED','cron');"]);
  const snapshot = await createCodexService({ directory, codexHome, now: () => origin }).read();
  assert.equal(snapshot.automations.length, 1);
  assert.equal(snapshot.sources.automations.state, "connected");
  assert.equal(snapshot.sources.threads.error.code, "SQLITE_UNAVAILABLE");
  assert.equal(snapshot.threads.length, 0);
}));

test("production SQLite output limit rejects unusually large private-index metadata without exposing it", async () => fixture(async (directory, temporary) => {
  const codexHome = path.join(temporary, "codex-home");
  await fs.mkdir(path.join(codexHome, "sqlite"), { recursive: true });
  await promisify(execFile)("/usr/bin/sqlite3", [path.join(codexHome, "sqlite", "codex-dev.db"), "CREATE TABLE automations (id TEXT,name TEXT,status TEXT,next_run_at INTEGER,last_run_at INTEGER,rrule TEXT,kind TEXT,target_thread_id TEXT); INSERT INTO automations (id,name,status,kind) VALUES ('oversize',hex(zeroblob(4200000)),'ACTIVE','cron');"]);
  const snapshot = await createCodexService({ directory, codexHome, now: () => origin }).read();
  assert.equal(snapshot.sources.automations.error.code, "SQLITE_OUTPUT_LIMIT");
  assert.equal(snapshot.automations.length, 0);
  assert.ok(JSON.stringify(snapshot).length < 5000);
}));

test("CLI ingest and inspect use isolated dependencies and print no title, cwd or private metadata", async () => fixture(async (directory) => {
  const output = sink(); const errors = sink();
  assert.equal(await runCodexSync(["ingest"], { directory, input: Readable.from([JSON.stringify(collection())]), output: output.stream, errorOutput: errors.stream, now: origin }), 0);
  assert.equal(JSON.parse(output.value()).threadCount, 1);
  assert.equal(output.value().includes("任务标题"), false);
  const inspected = sink();
  assert.equal(await runCodexSync(["inspect"], { service: reader(directory), output: inspected.stream, errorOutput: errors.stream }), 0);
  assert.equal(JSON.parse(inspected.value()).counts.threads, 1);
  for (const secret of ["任务标题", "/private/project", "local-thread", "SECRET_"]) assert.equal(inspected.value().includes(secret), false);
  assert.equal(errors.value(), "");
}));

test("CLI rejects oversized and invalid JSON, extra arguments and exposes only concise sanitized errors", async () => fixture(async (directory) => {
  for (const [argv, input, code] of [
    [["ingest"], Readable.from(["{SECRET_INPUT"]), "INVALID_INPUT"],
    [["ingest"], Readable.from([Buffer.alloc(CODEX_SNAPSHOT_MAX_BYTES + 1)]), "INPUT_TOO_LARGE"],
    [["ingest", "/private/custom-path"], Readable.from([]), "INVALID_COMMAND"],
  ]) {
    const output = sink(); const error = sink();
    assert.equal(await runCodexSync(argv, { directory, input, output: output.stream, errorOutput: error.stream, now: origin }), 1);
    assert.equal(output.value(), "");
    assert.equal(JSON.parse(error.value()).error.code, code);
    assert.equal(error.value().includes("SECRET_INPUT"), false);
    assert.equal(error.value().includes("/private/"), false);
  }
  await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
}));

test("the freshness window follows the observed collection cadence within its bounds", async () => fixture(async (directory) => {
  const minute = 60 * 1000;
  const active = { result: { pinnedThreads: [], threads: [thread("active", { status: { type: "active", activeFlags: ["waitingOnApproval"] } })], unavailableHosts: [], unavailableSources: [] } };
  await ingestCodexSnapshot(directory, collection(origin, active), { now: origin });
  const second = origin + 15 * minute;
  await ingestCodexSnapshot(directory, collection(second, active), { now: second });
  assert.equal(JSON.parse(await fs.readFile(cachePath(directory), "utf8")).cadenceMs, 15 * minute);
  const at = (offset) => reader(directory, { now: () => second + offset }).read();
  const fresh = await at(20 * minute);
  assert.equal(fresh.sources.threads.staleAfterMs, 31 * minute);
  assert.equal(fresh.sources.threads.state, "connected");
  assert.equal(fresh.threads[0].attention, "approval");
  const stale = await at(32 * minute);
  assert.equal(stale.sources.threads.error.code, "SNAPSHOT_STALE");
  assert.equal(stale.threads[0].attention, null);
  for (const [cadence, limit] of [[undefined, CODEX_SNAPSHOT_STALE_MS], [30 * 1000, CODEX_SNAPSHOT_STALE_MS], [60 * minute, 35 * minute]]) assert.equal(staleAfterMs(cadence), limit);
}));
