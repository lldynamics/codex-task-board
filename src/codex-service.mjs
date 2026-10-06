import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { codexAutomationSchema, codexSnapshotSchema, codexThreadSchema, staleAfterMs } from "./codex-domain.mjs";
import { checkDirectory, readRegularFile, syncDirectory, writeExclusive } from "./store-files.mjs";

export const CODEX_SNAPSHOT_DIRECTORY = path.join(homedir(), "Library", "Application Support", "LearningBoard");
export const CODEX_SNAPSHOT_FILENAME = "codex-snapshot.json";
export const CODEX_SNAPSHOT_LOCK_FILENAME = ".codex-sync-lock.sqlite";
export const CODEX_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 1000;
const READ_THROTTLE_MS = 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SQLITE_TIMEOUT_MS = 2000;
const execFileAsync = promisify(execFile);
const isoTime = z.iso.datetime();
const collectionInput = z.object({
  capturedAt: isoTime, limit: z.number().int().min(1).max(MAX_RECORDS),
  result: z.object({
    pinnedThreads: z.array(z.unknown()).max(10000), threads: z.array(z.unknown()).max(10000),
    unavailableHosts: z.array(z.unknown()).max(1000).default([]),
    unavailableSources: z.array(z.unknown()).max(1000).default([]),
  }).passthrough(),
}).strict();
const cacheSchema = z.object({
  version: z.literal(1), capturedAt: isoTime, complete: z.boolean(), truncated: z.boolean(), captureTruncated: z.boolean().optional(),
  unavailableHostCount: z.number().int().min(0).max(1000), unavailableSourceCount: z.number().int().min(0).max(1000),
  cadenceMs: z.number().int().min(1).max(86400000).optional(),
  records: z.array(z.object({ capturedAt: isoTime, thread: codexThreadSchema }).strict()).max(MAX_RECORDS),
}).strict().superRefine((cache, context) => {
  if (new Set(cache.records.map(({ thread }) => identity(thread))).size !== cache.records.length) context.addIssue({ code: "custom", message: "Duplicate identity" });
  if (cache.complete && (cache.truncated || cache.unavailableHostCount || cache.unavailableSourceCount || cache.records.some((record) => record.capturedAt !== cache.capturedAt))) context.addIssue({ code: "custom", message: "Inconsistent complete capture" });
  if (cache.captureTruncated && !cache.truncated) context.addIssue({ code: "custom", message: "Inconsistent truncation provenance" });
  for (const record of cache.records) {
    if (Date.parse(record.capturedAt) > Date.parse(cache.capturedAt)) context.addIssue({ code: "custom", message: "Invalid capture order" });
    if (record.thread.goalStatus !== null || record.thread.lastTurnStatus !== null) context.addIssue({ code: "custom", message: "Unsupported native evidence" });
  }
});

function identity(thread) { return JSON.stringify([thread.hostId, thread.id]); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function nowMs(now) {
  const value = typeof now === "function" ? now() : now ?? Date.now();
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : value;
  if (!Number.isFinite(milliseconds)) throw new TypeError("Invalid clock");
  return milliseconds;
}
function timestamp(value, unit = "seconds") {
  if (value === null || value === undefined) return null;
  const milliseconds = typeof value === "number" && Number.isFinite(value)
    ? value * (unit === "seconds" ? 1000 : 1) : typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) return null;
  try { return new Date(milliseconds).toISOString(); } catch { return null; }
}
function stringOrNull(value, maximum) { return typeof value === "string" && value.length <= maximum ? value : null; }
function problem(code, message) { return { code, message }; }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function publicError(error, fallback = "CACHE_READ_FAILED") {
  const code = typeof error?.code === "string" ? error.code : fallback;
  const known = {
    CACHE_INVALID: "Codex 缓存格式不受支持或已损坏。", CACHE_UNSAFE: "Codex 缓存路径不是安全的普通文件或目录。",
    CACHE_READ_FAILED: "无法读取 Codex 缓存；保留上一份有效采集。", FUTURE_SNAPSHOT: "采集时间晚于当前时间。",
    SNAPSHOT_STALE: "Codex 采集已超过预期的采集间隔，请等待原生采集更新。", SOURCE_PARTIAL: "原生采集未覆盖所有桌面记录。",
    SQLITE_TIMEOUT: "Codex 元数据读取超时。", SQLITE_UNAVAILABLE: "Codex 元数据来源不可读或版本不兼容。",
    SQLITE_OUTPUT_LIMIT: "Codex 元数据输出超过读取上限。", METADATA_INVALID: "Codex 元数据包含不兼容记录。",
    SNAPSHOT_MISSING: "尚未收到原生 Codex 采集，显示本地缓存目录。",
  };
  return problem(Object.hasOwn(known, code) ? code : fallback, known[code] ?? known[fallback] ?? "Codex 来源暂时不可读。");
}
function runtime(raw) {
  const type = typeof raw === "string" ? raw : isObject(raw) ? raw.type : null;
  if (type === "systemError") return "error";
  return ["active", "idle", "notLoaded", "error"].includes(type) ? type : "unknown";
}
function attention(raw) {
  if (!isObject(raw)) return null;
  const status = isObject(raw.status) ? raw.status : {};
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  if (raw.attention === "approval" || status.needsApproval === true || flags.includes("waitingOnApproval")) return "approval";
  if (raw.attention === "input" || status.needsInput === true || flags.includes("waitingOnUserInput")) return "input";
  return null;
}
function nativeThread(raw) {
  if (!isObject(raw) || raw.kind !== "codex") return null;
  const thread = {
    id: raw.id, hostId: raw.hostId, title: typeof raw.title === "string" && raw.title.length ? raw.title : "未命名任务",
    cwd: stringOrNull(raw.cwd, 4096), updatedAt: timestamp(raw.updatedAt), runtimeStatus: runtime(raw.status),
    attention: attention(raw), lastTurnStatus: null, goalStatus: null,
  };
  const parsed = codexThreadSchema.safeParse(thread);
  return parsed.success ? parsed.data : null;
}
function normalizeCollection(input) {
  const parsed = collectionInput.safeParse(input);
  if (!parsed.success) throw failure("INVALID_INPUT", "Expected {capturedAt,limit,result:{pinnedThreads,threads,unavailableHosts,unavailableSources}}");
  const value = parsed.data;
  const records = new Map();
  let invalid = false;
  let truncated = false;
  for (const raw of [...value.result.pinnedThreads, ...value.result.threads]) {
    if (!isObject(raw)) { invalid = true; continue; }
    if (raw.kind === "chatgpt" && typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 240) continue;
    if (raw.kind !== "codex") { invalid = true; continue; }
    const thread = nativeThread(raw);
    if (!thread) { invalid = true; continue; }
    const key = identity(thread);
    const previous = records.get(key);
    if (previous) {
      if (thread.updatedAt && (!previous.thread.updatedAt || Date.parse(thread.updatedAt) > Date.parse(previous.thread.updatedAt))) records.set(key, { capturedAt: value.capturedAt, thread });
      continue;
    }
    if (records.size === MAX_RECORDS) { truncated = true; continue; }
    records.set(key, { capturedAt: value.capturedAt, thread });
  }
  truncated ||= value.result.threads.length >= value.limit;
  return {
    version: 1, capturedAt: value.capturedAt, complete: !invalid && !truncated && !value.result.unavailableHosts.length && !value.result.unavailableSources.length,
    truncated, captureTruncated: truncated, unavailableHostCount: value.result.unavailableHosts.length, unavailableSourceCount: value.result.unavailableSources.length,
    records: [...records.values()],
  };
}
function fileIdentity(stat) { return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") : null; }
async function safeCache(directory, milliseconds) {
  try {
    if (!await checkDirectory(fs, directory, { absent: true })) return null;
    const { bytes, stat } = await readRegularFile(fs, path.join(directory, CODEX_SNAPSHOT_FILENAME), CODEX_SNAPSHOT_MAX_BYTES);
    let value;
    try { value = cacheSchema.parse(JSON.parse(bytes.toString("utf8"))); }
    catch { throw failure("CACHE_INVALID", "Invalid Codex cache"); }
    if (Date.parse(value.capturedAt) > milliseconds) throw failure("FUTURE_SNAPSHOT", "Future Codex cache");
    return { value, stat };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (["CACHE_INVALID", "FUTURE_SNAPSHOT"].includes(error.code)) throw error;
    if (!error.code || ["ELOOP", "ENOTDIR", "EISDIR"].includes(error.code)) throw failure("CACHE_UNSAFE", "Unsafe Codex cache");
    throw failure("CACHE_READ_FAILED", "Unreadable Codex cache");
  }
}
async function ensureDirectory(directory) {
  if (!await checkDirectory(fs, directory, { absent: true })) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  return checkDirectory(fs, directory);
}
async function acquireLock(directory) {
  const filename = path.join(directory, CODEX_SNAPSHOT_LOCK_FILENAME);
  const root = await checkDirectory(fs, directory);
  try {
    const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = await fs.lstat(filename);
  const safeLockFile = (value) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && (value.mode & 0o777) === 0o600 && value.size <= 1024 * 1024;
  if (!safeLockFile(stat)) throw failure("CACHE_UNSAFE", "Unsafe collector lock database");
  const verify = async () => {
    const currentRoot = await checkDirectory(fs, directory);
    const current = await fs.lstat(filename);
    if (currentRoot.dev !== root.dev || currentRoot.ino !== root.ino || !safeLockFile(current) || current.dev !== stat.dev || current.ino !== stat.ino) throw failure("CACHE_UNSAFE", "Collector lock path changed");
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { const sidecar = await fs.lstat(filename + suffix); if (!safeLockFile(sidecar)) throw failure("CACHE_UNSAFE", "Unsafe collector lock sidecar"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
  await verify();
  const deadline = Date.now() + 1000;
  let database;
  try {
    // Loaded lazily so older Node versions reach the entrypoint's version message.
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(filename, { allowExtension: false });
    // Waiting synchronously would prevent another same-process writer's async filesystem work.
    database.exec("PRAGMA busy_timeout=0;");
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE;"); break; }
      catch (error) {
        if (![5, 6].includes(error.errcode & 0xff)) throw error;
        if (Date.now() >= deadline) throw failure("COLLECTOR_LOCKED", "Another collector holds the transaction; no cache was changed");
        await new Promise((resolve) => setTimeout(resolve, 25));
        await verify();
      }
    }
    await verify();
    return { verify, release() { try { database.exec("ROLLBACK;"); } finally { database.close(); } } };
  } catch (error) {
    database?.close();
    if (["CACHE_UNSAFE", "COLLECTOR_LOCKED"].includes(error.code)) throw error;
    throw failure("CACHE_LOCK_FAILED", "Collector lock database is unavailable");
  }
}

/** Only the trusted native collector writes this metadata-only cache. */
export async function ingestCodexSnapshot(directory, input, { now } = {}) {
  const milliseconds = nowMs(now);
  const next = normalizeCollection(input);
  const ahead = Date.parse(next.capturedAt) - milliseconds;
  if (ahead > MAX_CLOCK_SKEW_MS) throw failure("FUTURE_SNAPSHOT", "Collection time is in the future");
  // A model-supplied time slightly ahead of this clock is skew, not a future
  // capture: record the server time so the collection is not lost.
  if (ahead > 0) {
    next.capturedAt = new Date(milliseconds).toISOString();
    for (const record of next.records) record.capturedAt = next.capturedAt;
  }
  const root = await ensureDirectory(directory);
  const lock = await acquireLock(directory);
  let temporary;
  let receipt;
  try {
    const old = await safeCache(directory, milliseconds);
    if (old && Date.parse(next.capturedAt) < Date.parse(old.value.capturedAt)) throw failure("SNAPSHOT_ORDER", "An older collection cannot replace the cache");
    if (old && next.capturedAt === old.value.capturedAt) {
      const existing = new Map(old.value.records.filter((record) => record.capturedAt === next.capturedAt).map((record) => [identity(record.thread), record]));
      if (next.complete !== old.value.complete || next.captureTruncated !== (old.value.captureTruncated ?? old.value.truncated) || next.unavailableHostCount !== old.value.unavailableHostCount || next.unavailableSourceCount !== old.value.unavailableSourceCount || next.records.length !== existing.size || next.records.some((record) => JSON.stringify(existing.get(identity(record.thread))) !== JSON.stringify(record))) throw failure("SNAPSHOT_ORDER", "Conflicting collections have the same capture time");
      receipt = { ok: true, capturedAt: old.value.capturedAt, threadCount: old.value.records.length, complete: old.value.complete, truncated: old.value.truncated, unchanged: true };
      return receipt;
    }
    // The interval between successive captures is the observed schedule.
    if (old) {
      const interval = Date.parse(next.capturedAt) - Date.parse(old.value.capturedAt);
      const cadence = interval > 0 && interval <= 86400000 ? interval : old.value.cadenceMs;
      if (cadence) next.cadenceMs = cadence;
    }
    if (old && !next.complete) {
      const observed = new Set(next.records.map((record) => identity(record.thread)));
      const retained = old.value.records.filter((record) => !observed.has(identity(record.thread))).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
      const capacity = MAX_RECORDS - next.records.length;
      next.truncated ||= old.value.truncated || retained.length > capacity;
      next.records = [...next.records, ...retained.slice(0, capacity)];
    }
    const bytes = Buffer.from(JSON.stringify(cacheSchema.parse(next)) + "\n");
    if (bytes.length > CODEX_SNAPSHOT_MAX_BYTES) throw failure("RECORD_LIMIT", "Codex cache exceeds its size limit");
    temporary = path.join(directory, `.codex-snapshot-${randomUUID()}.tmp`);
    await writeExclusive(fs, temporary, bytes);
    const currentRoot = await checkDirectory(fs, directory);
    if (currentRoot.dev !== root.dev || currentRoot.ino !== root.ino) throw failure("CACHE_UNSAFE", "Cache directory changed");
    await lock.verify();
    let current = null;
    try { current = await fs.lstat(path.join(directory, CODEX_SNAPSHOT_FILENAME)); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (current && (!current.isFile() || current.isSymbolicLink())) throw failure("CACHE_UNSAFE", "Unsafe cache destination");
    if (fileIdentity(current) !== fileIdentity(old?.stat)) throw failure("CACHE_CHANGED", "Cache changed outside the collector lock");
    await fs.rename(temporary, path.join(directory, CODEX_SNAPSHOT_FILENAME));
    temporary = undefined;
    receipt = { ok: true, capturedAt: next.capturedAt, threadCount: next.records.length, complete: next.complete, truncated: next.truncated, unchanged: false };
    try { await syncDirectory(fs, directory); } catch { receipt.warningCode = "CACHE_DURABILITY_UNCONFIRMED"; }
    return receipt;
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    // A release failure must not replace an ingest error already propagating;
    // after a committed ingest it is reported as a warning on the receipt.
    try { lock.release(); } catch { if (receipt) receipt.warningCode ??= "COLLECTOR_LOCK_RELEASE_FAILED"; }
  }
}

const AUTOMATIONS_QUERY = "SELECT id, name, status, next_run_at, last_run_at, rrule, kind, target_thread_id FROM automations ORDER BY id LIMIT 1001;";
const CATALOG_QUERY = "SELECT host_id, thread_id, display_title, source_updated_at, cwd FROM local_thread_catalog WHERE host_id IS NULL OR host_id NOT LIKE 'chatgpt:%' ORDER BY source_updated_at DESC, host_id, thread_id LIMIT 1001;";
const TURNS_QUERY = "SELECT thread_id, turn_id, status, started_at, completed_at, duration_ms FROM (SELECT thread_id, turn_id, status, started_at, completed_at, duration_ms, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY started_at DESC, turn_id DESC) AS position FROM thread_turns) WHERE position = 1 ORDER BY started_at DESC, thread_id LIMIT 1001;";
async function sqliteRows(codexHome, location, query) {
  try {
    await checkDirectory(fs, codexHome);
    if (location.includes(path.sep)) await checkDirectory(fs, path.join(codexHome, path.dirname(location)));
    const filename = path.join(codexHome, location);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw failure("SQLITE_UNAVAILABLE", "Unsafe metadata file");
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 250", "-cmd", "PRAGMA query_only=ON;", filename, query], { timeout: SQLITE_TIMEOUT_MS, maxBuffer: CODEX_SNAPSHOT_MAX_BYTES, encoding: "utf8", windowsHide: true });
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS + 1) throw failure("METADATA_INVALID", "Invalid metadata output");
    return rows;
  } catch (error) {
    if (error.killed || error.code === "ETIMEDOUT") throw failure("SQLITE_TIMEOUT", "Metadata query timed out");
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw failure("SQLITE_OUTPUT_LIMIT", "Metadata output too large");
    throw failure(error.code === "METADATA_INVALID" ? "METADATA_INVALID" : "SQLITE_UNAVAILABLE", "Metadata source unavailable");
  }
}
function metadataReader(codexHome) {
  return async () => {
    const queries = [["automations", path.join("sqlite", "codex-dev.db"), AUTOMATIONS_QUERY], ["threads", path.join("sqlite", "codex-dev.db"), CATALOG_QUERY], ["turns", "thread_history_1.sqlite", TURNS_QUERY]];
    const results = await Promise.allSettled(queries.map(([, location, query]) => sqliteRows(codexHome, location, query)));
    const result = { errors: {} };
    results.forEach((value, index) => { const key = queries[index][0]; if (value.status === "fulfilled") result[key] = value.value; else result.errors[key] = publicError(value.reason, "SQLITE_UNAVAILABLE"); });
    return result;
  };
}
function automationRow(raw) {
  if (!isObject(raw)) return null;
  const value = {
    id: raw.id, name: raw.name, status: ["ACTIVE", "PAUSED"].includes(raw.status) ? raw.status : "unknown",
    kind: ["heartbeat", "cron"].includes(raw.kind) ? raw.kind : "unknown", rrule: stringOrNull(raw.rrule, 2000), timeZone: null,
    targetThreadId: stringOrNull(raw.target_thread_id, 240), lastRunAt: timestamp(raw.last_run_at, "milliseconds"), nextRunAt: timestamp(raw.next_run_at, "milliseconds"),
  };
  const parsed = codexAutomationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function catalogRow(raw) {
  if (!isObject(raw)) return null;
  const value = { id: raw.thread_id, hostId: raw.host_id, title: raw.display_title, cwd: stringOrNull(raw.cwd, 4096), updatedAt: timestamp(raw.source_updated_at), runtimeStatus: "unknown", attention: null, lastTurnStatus: null, goalStatus: null };
  const parsed = codexThreadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function isChatGPTCatalogRow(raw) {
  return isObject(raw) && typeof raw.host_id === "string" && raw.host_id.toLowerCase().startsWith("chatgpt:");
}
function turnRow(raw) {
  if (!isObject(raw) || typeof raw.thread_id !== "string" || raw.thread_id.length > 240 || !["completed", "failed", "interrupted", "inProgress"].includes(raw.status)) return null;
  const startedAt = timestamp(raw.started_at);
  const completedAt = timestamp(raw.completed_at);
  return startedAt ? { threadId: raw.thread_id, status: raw.status, startedAt, completedAt } : null;
}
function metadataState() { return { rows: [], lastSuccessAt: null, error: null, complete: false, truncated: false, readSucceeded: false }; }
function refreshMetadata(previous, raw, mapper, key, milliseconds) {
  if (raw?.errors?.[key] || !Array.isArray(raw?.[key])) return { ...previous, error: publicError(raw?.errors?.[key], "SQLITE_UNAVAILABLE"), complete: false, readSucceeded: false };
  const rows = [];
  let invalid = false;
  const seen = new Set();
  const rejectedTurns = new Set();
  const candidates = key === "threads" ? raw[key].filter((value) => !isChatGPTCatalogRow(value)) : raw[key];
  for (const value of candidates.slice(0, MAX_RECORDS)) {
    const row = mapper(value);
    if (!row) {
      invalid = true;
      if (key === "turns" && typeof value?.thread_id === "string") rejectedTurns.add(value.thread_id);
      continue;
    }
    const id = key === "threads" ? identity(row) : key === "turns" ? row.threadId : row.id;
    if (seen.has(id)) { invalid = true; if (key === "turns") rejectedTurns.add(id); continue; }
    seen.add(id); rows.push(row);
  }
  const truncated = candidates.length > MAX_RECORDS;
  return { rows: key === "turns" ? rows.filter((row) => !rejectedTurns.has(row.threadId)) : rows, lastSuccessAt: new Date(milliseconds).toISOString(), error: invalid ? publicError({ code: "METADATA_INVALID" }) : null, complete: !invalid && !truncated, truncated, readSucceeded: true };
}
function sourceStatus(state, mode) {
  return { mode: state.lastSuccessAt ? mode : "unavailable", state: state.error ? "disconnected" : state.complete ? "connected" : "partial", lastSuccessAt: state.lastSuccessAt, complete: state.complete, truncated: state.truncated, error: state.error };
}
function attachTurn(thread, records, capturedAt) {
  if (thread.hostId !== "local" || !thread.updatedAt) return thread;
  const turn = records.get(thread.id);
  if (!turn || Date.parse(turn.startedAt) > Date.parse(capturedAt)) return thread;
  const updated = Date.parse(thread.updatedAt);
  if (turn.status === "inProgress") {
    if (thread.runtimeStatus === "active" && Math.abs(Date.parse(turn.startedAt) - updated) <= 2000) return { ...thread, lastTurnStatus: "running" };
    return thread;
  }
  const completed = Date.parse(turn.completedAt ?? "");
  if (!Number.isFinite(completed) || completed < Date.parse(turn.startedAt) || completed > Date.parse(capturedAt) || updated > completed + 2000) return thread;
  return { ...thread, lastTurnStatus: turn.status };
}
async function boundedMetadata(reader) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => reader()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure("SQLITE_TIMEOUT", "Metadata reader timed out")), SQLITE_TIMEOUT_MS + 250); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Reads cache and fixed, read-only private-index metadata; it never contacts desktop IPC. */
export function createCodexService({ directory = CODEX_SNAPSHOT_DIRECTORY, codexHome = path.join(homedir(), ".codex"), readMetadata = metadataReader(codexHome), now } = {}) {
  let inFlight;
  let refreshedAt = -Infinity;
  let lastGoodCache = null;
  let cacheError = null;
  let automations = metadataState();
  let history = metadataState();
  let turns = metadataState();
  async function refresh(milliseconds) {
    const results = await Promise.allSettled([safeCache(directory, milliseconds), boundedMetadata(readMetadata)]);
    if (results[0].status === "fulfilled") {
      if (results[0].value && (!lastGoodCache || Date.parse(results[0].value.value.capturedAt) >= Date.parse(lastGoodCache.capturedAt))) { lastGoodCache = results[0].value.value; cacheError = null; }
      else if (results[0].value) cacheError = publicError({ code: "CACHE_READ_FAILED" });
      else cacheError = lastGoodCache ? publicError({ code: "CACHE_READ_FAILED" }) : null;
    } else cacheError = publicError(results[0].reason);
    const raw = results[1].status === "fulfilled" ? results[1].value : { errors: { automations: results[1].reason, threads: results[1].reason, turns: results[1].reason } };
    automations = refreshMetadata(automations, raw, automationRow, "automations", milliseconds);
    history = refreshMetadata(history, raw, catalogRow, "threads", milliseconds);
    turns = refreshMetadata(turns, raw, turnRow, "turns", milliseconds);
    refreshedAt = milliseconds;
  }
  function snapshot(milliseconds) {
    const observedAt = new Date(milliseconds).toISOString();
    let threadSource;
    let threads;
    // An incomplete row affects only its thread. An actual failed read must not
    // resurrect the previous read's evidence, even if its error is METADATA_INVALID.
    const turnMap = new Map((turns.readSucceeded ? turns.rows : []).map((row) => [row.threadId, row]));
    if (lastGoodCache) {
      const limit = staleAfterMs(lastGoodCache.cadenceMs);
      const stale = milliseconds - Date.parse(lastGoodCache.capturedAt) > limit;
      const error = cacheError ?? (stale ? publicError({ code: "SNAPSHOT_STALE" }) : !lastGoodCache.complete ? publicError({ code: "SOURCE_PARTIAL" }) : null);
      threadSource = { mode: "snapshot", state: cacheError || stale ? "disconnected" : lastGoodCache.complete ? "connected" : "partial", lastSuccessAt: lastGoodCache.capturedAt, complete: !cacheError && !stale && lastGoodCache.complete, truncated: lastGoodCache.truncated, error, staleAfterMs: limit };
      threads = lastGoodCache.records.map((record) => {
        const current = !cacheError && !stale && record.capturedAt === lastGoodCache.capturedAt;
        const thread = current ? record.thread : { ...record.thread, runtimeStatus: "unknown", attention: null };
        return attachTurn(thread, turnMap, record.capturedAt);
      });
      if (!lastGoodCache.complete) {
        const seen = new Set(threads.map(identity));
        for (const thread of history.rows) {
          if (seen.has(identity(thread))) continue;
          if (threads.length === MAX_RECORDS) { threadSource.truncated = true; break; }
          seen.add(identity(thread));
          threads.push(attachTurn(thread, turnMap, observedAt));
        }
      }
    } else {
      threadSource = { ...sourceStatus(history, "archive"), complete: false, state: cacheError || history.error ? "disconnected" : "partial", error: cacheError ?? history.error ?? publicError({ code: "SNAPSHOT_MISSING" }) };
      threads = history.rows.map((thread) => attachTurn(thread, turnMap, observedAt));
    }
    const automationSource = sourceStatus(automations, "archive");
    const states = [threadSource.state, automationSource.state];
    const state = states.every((value) => value === "connected") ? "connected" : states.every((value) => value === "disconnected") ? "disconnected" : "partial";
    return codexSnapshotSchema.parse({
      version: 1, observedAt,
      connection: { state, lastSuccessAt: threadSource.lastSuccessAt, error: threadSource.error ?? automationSource.error, scope: lastGoodCache && !lastGoodCache.complete ? "桌面已缓存记录（最新原生采集与本地历史；历史运行状态未知）" : "桌面已缓存记录", source: lastGoodCache ? "desktop-snapshot" : history.lastSuccessAt ? "local-history" : "unavailable" },
      sources: { threads: threadSource, automations: automationSource }, threads, automations: automations.rows,
      completeness: { threads: threadSource.complete, automations: automationSource.complete, truncated: threadSource.truncated || automationSource.truncated },
    });
  }
  return {
    async read() {
      const milliseconds = nowMs(now);
      if (!inFlight && (milliseconds < refreshedAt || milliseconds - refreshedAt >= READ_THROTTLE_MS)) {
        inFlight = refresh(milliseconds).finally(() => { inFlight = undefined; });
      }
      if (inFlight) await inFlight;
      return snapshot(nowMs(now));
    },
  };
}
