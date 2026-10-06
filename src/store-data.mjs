import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { boardSchema, strictBoardSchema, schema3BoardSchema, legacyBoardSchema, portableBackupSchema, LIMITS } from "./board.mjs";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const legacyReceiptSchema = z.object({ requestId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), appliedRevision: revision.refine((value) => value >= 1) }).strict();
const receiptSchema = legacyReceiptSchema.extend({ entityId: z.uuid().optional() }).strict();
const legacyDiskSchema = legacyBoardSchema.safeExtend({ appliedRequests: z.array(legacyReceiptSchema).max(LIMITS.requests) });
const schema3DiskSchema = schema3BoardSchema.safeExtend({ historyStartRevision: revision, appliedRequests: z.array(receiptSchema).max(LIMITS.requests) });
export const diskSchema = strictBoardSchema.safeExtend({ historyStartRevision: revision, appliedRequests: z.array(receiptSchema).max(LIMITS.requests) });

export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
export const checksum = (value) => createHash("sha256").update(canonical(value)).digest("hex");
export function publicBoard(disk) {
  const { appliedRequests, historyStartRevision, ...board } = disk;
  return boardSchema.parse(board);
}
export function parseDisk(raw) {
  const sourceVersion = raw?.schemaVersion;
  const parsed = sourceVersion === 2 ? legacyDiskSchema.parse(raw) : sourceVersion === 3 ? schema3DiskSchema.parse(raw) : diskSchema.parse(raw);
  const floor = sourceVersion === 2 ? 0 : parsed.historyStartRevision;
  const ids = new Set(parsed.appliedRequests.map((receipt) => receipt.requestId));
  if (ids.size !== parsed.appliedRequests.length || parsed.revision - floor !== parsed.appliedRequests.length
    || parsed.appliedRequests.some((receipt, index) => receipt.appliedRevision !== floor + index + 1)) throw new Error("Invalid receipt lineage");
  const normalized = sourceVersion === 2 ? boardSchema.parse({
    ...publicLegacyBoard(parsed), schemaVersion: 4, sessions: [],
    projects: parsed.projects.map((project) => ({ ...project, archivedAt: null })),
    tasks: parsed.tasks.map((task) => ({ ...task, archivedAt: null, priority: "normal", dueDate: null })),
  }) : sourceVersion === 3 ? boardSchema.parse({ ...publicLegacyBoard(parsed), schemaVersion: 4, sessions: [] }) : publicBoard(parsed);
  return { sourceVersion, disk: { ...normalized, historyStartRevision: floor, appliedRequests: parsed.appliedRequests } };
}
function publicLegacyBoard(disk) { const { appliedRequests, historyStartRevision, ...board } = disk; return board; }
export function parseDiskBytes(bytes) {
  if (Buffer.byteLength(bytes) > LIMITS.bytes) throw new Error("Oversized disk");
  return parseDisk(JSON.parse(bytes.toString("utf8")));
}
export function makeBackup(board, now = new Date().toISOString()) {
  const normalized = boardSchema.parse(board);
  const backup = { format: "learning-board-backup", formatVersion: 1, createdAt: now, board: normalized, checksum: checksum(normalized) };
  return validateBackup(backup);
}
export function validateBackup(raw) {
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > LIMITS.bytes) throw new Error("Oversized backup");
  const backup = portableBackupSchema.parse(raw);
  if (backup.checksum !== checksum(backup.board)) throw new Error("Backup checksum mismatch");
  return backup;
}
// Upgrade the board only after verifying the original portable checksum. Keep
// its envelope and mutation input untouched so schema-3 retries retain their
// original fingerprint and no exported envelope has a mismatched checksum.
export function upgradeBackupBoard(backup) {
  return backup.board.schemaVersion === 3 ? boardSchema.parse({ ...backup.board, schemaVersion: 4, sessions: [] }) : backup.board;
}
