import { constants } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { LIMITS, timestampSchema } from "./board.mjs";
import { canonical, parseDiskBytes } from "./store-data.mjs";

export const lockOwnerSchema = z.object({ version: z.literal(1), token: z.uuid(), pid: z.number().int().min(1), hostname: z.string().min(1).max(255), createdAt: timestampSchema }).strict();
export const BACKUP_PATTERN = /^revision-(\d{16})-([a-f0-9]{64})\.json$/;
export const LEGACY_BACKUP_PATTERN = /^revision-\d{16}-[a-f0-9-]{36}\.json$/;
export const MIGRATION_BACKUP = "schema2-migration.json";
export const MIGRATION_CHECKSUM = "schema2-migration.sha256";
export const rawChecksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function isBackupName(name) {
  return typeof name === "string" && (BACKUP_PATTERN.test(name) || LEGACY_BACKUP_PATTERN.test(name) || name === MIGRATION_BACKUP);
}
export async function checkDirectory(io, directory, { absent = false } = {}) {
  try {
    const stat = await io.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe directory");
    return stat;
  } catch (error) {
    if (absent && error.code === "ENOENT") return null;
    throw error;
  }
}
export async function readRegularFile(io, filename, maximum = LIMITS.bytes) {
  let handle;
  const leaf = await io.lstat(filename);
  if (!leaf.isFile() || leaf.isSymbolicLink()) throw new Error("Unsafe file");
  try {
    handle = await io.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || stat.dev !== leaf.dev || stat.ino !== leaf.ino) throw new Error("Changed or oversized file");
    const bytes = await handle.readFile();
    if (bytes.length > maximum) throw new Error("Oversized file");
    return { bytes, stat };
  } finally { await handle?.close().catch(() => {}); }
}
export async function readVerifiedBackup(io, directory, name) {
  if (!isBackupName(name)) throw new Error("Unknown backup name");
  await checkDirectory(io, directory);
  const match = name.match(BACKUP_PATTERN);
  if (!match && name !== MIGRATION_BACKUP) throw new Error("Backup lacks a raw byte checksum");
  const { bytes } = await readRegularFile(io, path.join(directory, name));
  const sha256 = rawChecksum(bytes);
  if (match && match[2] !== sha256) throw new Error("Backup raw byte checksum mismatch");
  if (name === MIGRATION_BACKUP) {
    const checksumFile = await readRegularFile(io, path.join(directory, MIGRATION_CHECKSUM), 65);
    if (!/^[a-f0-9]{64}\n$/.test(checksumFile.bytes.toString("utf8")) || checksumFile.bytes.toString("utf8") !== sha256 + "\n") throw new Error("Migration backup raw byte checksum mismatch");
  }
  const loaded = parseDiskBytes(bytes);
  if ((match && String(loaded.disk.revision).padStart(16, "0") !== match[1]) || (name === MIGRATION_BACKUP && loaded.sourceVersion !== 2)) throw new Error("Backup revision or migration schema mismatch");
  return { ...loaded, bytes, sha256 };
}
export async function syncDirectory(io, directory) {
  const handle = await io.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function writeExclusive(io, filename, bytes) {
  let handle;
  let created = false;
  try {
    handle = await io.open(filename, "wx", 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await io.unlink(filename).catch(() => {});
    throw error;
  }
}
const identity = (stat) => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
export async function inspectLockSnapshot(io, root) {
  await checkDirectory(io, root);
  const lockPath = path.join(root, ".save-lock");
  const directoryStat = await checkDirectory(io, lockPath);
  const entries = (await io.readdir(lockPath)).sort();
  if (entries.length > 1 || (entries.length === 1 && entries[0] !== "owner.json")) throw new Error("Unrecognized lock contents");
  let owner = null;
  let observedOwner = null;
  let ownerFile = null;
  let rawBytes = null;
  let type = "legacy-ownerless";
  let reason = "No owner metadata; explicit offline confirmation is required";
  if (entries.length === 1) {
    const { bytes, stat } = await readRegularFile(io, path.join(lockPath, "owner.json"), 4096);
    rawBytes = bytes.toString("hex");
    ownerFile = identity(stat);
    try { observedOwner = JSON.parse(bytes.toString("utf8")); } catch { /* Reported below as invalid owner metadata. */ }
    const parsed = lockOwnerSchema.safeParse(observedOwner);
    if (parsed.success) { owner = parsed.data; type = "known-owner"; reason = "Owner token and fingerprint are both required"; }
    else { type = "invalid-owner"; reason = "Incomplete owner metadata; explicit offline confirmation is required"; }
  }
  const candidate = observedOwner && typeof observedOwner === "object" && !Array.isArray(observedOwner) ? observedOwner : null;
  const processOwner = candidate && typeof candidate.hostname === "string" && Number.isSafeInteger(candidate.pid) && candidate.pid > 0
    ? { hostname: candidate.hostname, pid: candidate.pid } : null;
  const fingerprint = createHash("sha256").update(canonical({ directory: identity(directoryStat), ownerFile, bytes: rawBytes })).digest("hex");
  return { owner, processOwner, type, reason, fingerprint, directoryStat };
}

// A SQLite write transaction is the cross-process mutex: the operating system
// releases it when the owning process exits, so a crash can never leave it held.
// Waiting is asynchronous so other same-process work can finish and release it.
export async function acquireProcessLock(filename, { waitMs = 2000 } = {}) {
  const stat = await lstat(filename).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Object.assign(new Error("Unsafe process lock file"), { code: "UNSAFE" });
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(filename, { allowExtension: false });
  try {
    database.exec("PRAGMA busy_timeout=0;");
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE;"); break; }
      catch (error) {
        if (![5, 6].includes(error.errcode & 0xff)) throw error;
        if (Date.now() >= deadline) throw Object.assign(new Error("Another writer holds the lock"), { code: "LOCKED" });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  } catch (error) { database.close(); throw error; }
  let released = false;
  return { release() { if (released) return; released = true; try { database.exec("ROLLBACK;"); } finally { database.close(); } } };
}
