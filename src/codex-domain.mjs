import { z } from "zod/v4";

export const CODEX_TOOL_NAME = "learning_board_codex";
export const CODEX_SYNC_TOOL_NAME = "learning_board_codex_sync";
export const CODEX_SNAPSHOT_STALE_MS = 180000;
export const CODEX_SNAPSHOT_MAX_STALE_MS = 35 * 60 * 1000;
// A snapshot stays current for two observed collection intervals plus a
// minute of slack, so a 15-minute schedule is not "stale" most of the time.
export function staleAfterMs(cadenceMs) {
  if (!Number.isFinite(cadenceMs) || cadenceMs <= 0) return CODEX_SNAPSHOT_STALE_MS;
  return Math.min(CODEX_SNAPSHOT_MAX_STALE_MS, Math.max(CODEX_SNAPSHOT_STALE_MS, 2 * cadenceMs + 60000));
}
const timestamp = z.iso.datetime();
const nullableTime = timestamp.nullable();
const identifier = z.string().min(1).max(240);
const captureThread = z.object({
  id: identifier, kind: z.string().max(40), hostId: identifier.optional(),
  title: z.string().max(500).nullable().optional(), cwd: z.string().max(4096).nullable().optional(),
  updatedAt: z.number().finite().nullable().optional(),
  status: z.union([z.string().max(80), z.object({
    type: z.string().max(80), activeFlags: z.array(z.string().max(80)).max(20).optional(),
    needsApproval: z.boolean().optional(), needsInput: z.boolean().optional(),
  }).strict()]),
}).strict();
export const codexCaptureSchema = z.object({
  capturedAt: timestamp, limit: z.number().int().min(1).max(1000),
  result: z.object({
    pinnedThreads: z.array(captureThread).max(1000), threads: z.array(captureThread).max(1000),
    unavailableHosts: z.array(z.string().max(500)).max(1000),
    unavailableSources: z.array(z.string().max(500)).max(1000),
  }).strict(),
}).strict();
const sourceStatus = z.object({
  mode: z.enum(["live", "snapshot", "archive", "unavailable"]),
  state: z.enum(["connected", "partial", "disconnected", "unsupported"]),
  lastSuccessAt: nullableTime,
  complete: z.boolean(),
  truncated: z.boolean(),
  error: z.object({ code: z.string().max(80), message: z.string().max(1000) }).strict().nullable(),
  staleAfterMs: z.number().int().min(0).optional(),
}).strict();

export const codexThreadSchema = z.object({
  id: identifier, hostId: identifier, title: z.string().min(1).max(500),
  cwd: z.string().max(4096).nullable(), updatedAt: nullableTime,
  runtimeStatus: z.enum(["active", "idle", "notLoaded", "error", "unknown"]),
  attention: z.enum(["approval", "input"]).nullable(),
  lastTurnStatus: z.enum(["running", "completed", "failed", "interrupted"]).nullable(),
  goalStatus: z.enum(["active", "complete", "paused", "blocked"]).nullable(),
}).strict();

export const codexAutomationSchema = z.object({
  id: identifier, name: z.string().min(1).max(500),
  status: z.enum(["ACTIVE", "PAUSED", "unknown"]),
  kind: z.enum(["heartbeat", "cron", "unknown"]),
  rrule: z.string().max(2000).nullable(), timeZone: z.string().max(100).nullable(),
  targetThreadId: identifier.nullable(), lastRunAt: nullableTime, nextRunAt: nullableTime,
}).strict();

export const codexSnapshotSchema = z.object({
  version: z.literal(1), observedAt: timestamp,
  connection: z.object({
    state: z.enum(["connected", "partial", "disconnected", "unsupported"]),
    lastSuccessAt: nullableTime,
    error: z.object({ code: z.string().max(80), message: z.string().max(1000) }).strict().nullable(),
    scope: z.string().max(500),
    source: z.enum(["desktop", "desktop-snapshot", "app-server", "local-history", "unavailable"]),
  }).strict(),
  sources: z.object({ threads: sourceStatus, automations: sourceStatus }).strict(),
  threads: z.array(codexThreadSchema).max(10000),
  automations: z.array(codexAutomationSchema).max(1000),
  completeness: z.object({ threads: z.boolean(), automations: z.boolean(), truncated: z.boolean() }).strict(),
}).strict().superRefine((snapshot, context) => {
  if (new Set(snapshot.threads.map((thread) => JSON.stringify([thread.hostId, thread.id]))).size !== snapshot.threads.length) {
    context.addIssue({ code: "custom", message: "Duplicate thread identity" });
  }
  if (new Set(snapshot.automations.map((automation) => automation.id)).size !== snapshot.automations.length) {
    context.addIssue({ code: "custom", message: "Duplicate automation identity" });
  }
});

export function unavailableCodexSnapshot(now = new Date().toISOString()) {
  const error = { code: "SOURCE_UNAVAILABLE", message: "尚未连接 Codex 状态来源。" };
  const source = { mode: "unavailable", state: "unsupported", lastSuccessAt: null, complete: false, truncated: false, error };
  return {
    version: 1, observedAt: now,
    connection: { state: "unsupported", lastSuccessAt: null, error, scope: "本机", source: "unavailable" },
    sources: { threads: { ...source }, automations: { ...source } },
    threads: [], automations: [],
    completeness: { threads: false, automations: false, truncated: false },
  };
}
