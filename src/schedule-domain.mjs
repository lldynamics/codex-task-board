import { z } from "zod/v4";

export const SESSION_STATUS_VALUES = ["scheduled", "completed", "not_completed", "cancelled"];
export const SESSION_TEXT_LIMIT = 4000;
export const MAX_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export function isValidTimeZone(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || /^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}
// The machine's own zone is the default display zone; UTC is the safe fallback.
export function systemTimeZone(intl = Intl) {
  try {
    const value = new intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isValidTimeZone(value)) return value;
  } catch { /* Fall back to UTC when the host cannot report a zone. */ }
  return "UTC";
}
const utcTimestamp = z.iso.datetime().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value.slice(0, 10);
}, "A real UTC calendar date is required");
const timeZone = z.string().max(255).refine(isValidTimeZone, "An IANA time zone is required");
const storedText = z.string().max(SESSION_TEXT_LIMIT).refine((value) => value === value.trim(), "Text must be trimmed");
const inputText = z.string().trim().max(SESSION_TEXT_LIMIT);
const timing = { taskId: z.uuid(), startAt: utcTimestamp, endAt: utcTimestamp, timeZone };
function validDuration(session, context) {
  const duration = Date.parse(session.endAt) - Date.parse(session.startAt);
  if (!(duration > 0 && duration <= MAX_SESSION_DURATION_MS)) {
    context.addIssue({ code: "custom", path: ["endAt"], message: "A session must last more than zero and at most 24 hours" });
  }
}
export const sessionSchema = z.object({
  id: z.uuid(), ...timing, status: z.enum(SESSION_STATUS_VALUES),
  objective: storedText, completionCriteria: storedText, feedback: storedText,
  actualMinutes: z.number().int().min(0).max(1440).nullable(), lastUpdatedAt: utcTimestamp,
}).strict().superRefine(validDuration);
export const sessionInputSchema = z.object({
  id: z.uuid().optional(), ...timing,
  // Optional inputs intentionally have no defaults: request fingerprints must
  // distinguish supplied values without changing older normalized requests.
  objective: inputText.optional(), completionCriteria: inputText.optional(),
}).strict().superRefine(validDuration);
export const feedbackOperationSchema = z.object({
  type: z.literal("record_session_feedback"), sessionId: z.uuid(), status: z.enum(["completed", "not_completed"]),
  feedback: inputText, actualMinutes: z.number().int().min(0).max(1440).nullable(),
}).strict();

// Archiving hides scheduled sessions from the active calendar without deleting
// history. Restoring a task or project must recheck the resulting whole board.
export function isActiveScheduledSession(board, session) {
  if (session.status !== "scheduled") return false;
  const task = board.tasks.find((item) => item.id === session.taskId);
  const project = task && board.projects.find((item) => item.id === task.projectId);
  return !!task && !!project && task.archivedAt === null && project.archivedAt === null;
}
export function activeScheduledSessions(board) {
  const projects = new Set(board.projects.filter((item) => item.archivedAt === null).map((item) => item.id));
  const tasks = new Set(board.tasks.filter((item) => item.archivedAt === null && projects.has(item.projectId)).map((item) => item.id));
  return board.sessions.filter((session) => session.status === "scheduled" && tasks.has(session.taskId));
}
export function findScheduledOverlap(board) {
  const sorted = activeScheduledSessions(board).slice().sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  for (let index = 1; index < sorted.length; index++) {
    if (Date.parse(sorted[index].startAt) < Date.parse(sorted[index - 1].endAt)) return [sorted[index - 1], sorted[index]];
  }
  return null;
}
