import { z } from "zod/v4";
import { sessionSchema, sessionInputSchema, feedbackOperationSchema, findScheduledOverlap } from "./schedule-domain.mjs";
import { PRODUCT_UI_URI } from "./product-identity.mjs";

export const VERSION = "0.11.0";
export const TOOL_NAME = "learning_board";
export const MUTATION_TOOL_NAME = "learning_board_mutate";
export const DATA_TOOL_NAME = "learning_board_data";
export const CONTEXT_TOOL_NAME = "learning_board_context";
export const PLAN_TOOL_NAME = "learning_board_plan";
export const FEEDBACK_TOOL_NAME = "learning_board_feedback";
export const TASK_TOOL_NAME = "learning_board_task";
export const UI_URI = PRODUCT_UI_URI;
export const MIME_TYPE = "text/html;profile=mcp-app";
export const STATUS_VALUES = ["planned", "in_progress", "waiting_user", "paused", "completed", "failed"];
export const PRIORITY_VALUES = ["low", "normal", "high", "urgent"];
// requests bounds what an existing file may contain; retainedRequests is what
// each save keeps. Retries happen within minutes, so 1,000 receipts is ample.
export const LIMITS = Object.freeze({ projects: 500, tasks: 5000, sessions: 20000, batchTasks: 50, batchSessions: 100, requests: 10000, retainedRequests: 1000, bytes: 16 * 1024 * 1024 });

const id = z.uuid();
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
function realDate(value) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (!year || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export const timestampSchema = z.iso.datetime().refine(realDate, "A real calendar date is required");
export const dueDateSchema = z.union([z.null(), z.iso.date().refine(realDate, "A real calendar date is required")]);
const focusFields = {
  date: z.iso.date().refine(realDate, "A real calendar date is required"),
  timeZone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }, "A valid IANA time zone is required"),
};
export const dailyFocusSchema = z.object({
  ...focusFields, taskIds: z.array(id).max(LIMITS.tasks).refine((ids) => new Set(ids).size === ids.length, "Duplicate focus task id"),
}).strict();
const storedText = (max, min = 0) => z.string().min(min).max(max).refine((value) => value === value.trim(), "Text must be trimmed");
const inputText = (max, min = 0) => z.string().trim().min(min).max(max);
function safeHttpLink(value) {
  try {
    const url = new URL(value);
    // eslint-disable-next-line no-control-regex -- links must not contain control characters
    return ["https:", "http:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !/[\u0000-\u0020\u007f]/.test(value);
  } catch { return false; }
}
export function isSafeConversationUrl(value) {
  if (typeof value !== "string") return false;
  const thread = /^codex:\/\/threads\/([0-9a-f-]{36})$/.exec(value);
  return thread ? id.safeParse(thread[1]).success : safeHttpLink(value);
}
export const conversationUrlSchema = z.union([z.null(), z.string().max(2048).refine(isSafeConversationUrl, "A safe HTTP(S) link or codex://threads/<uuid> is required")]);
const inputConversationUrlSchema = z.union([z.null(), z.string().trim().max(2048).refine(isSafeConversationUrl, "A safe HTTP(S) link or codex://threads/<uuid> is required")]);
const legacyProjectSchema = z.object({ id, name: storedText(120, 1), description: storedText(4000), lastUpdatedAt: timestampSchema }).strict();
const legacyTaskSchema = z.object({
  id, projectId: id, title: storedText(200, 1), status: z.enum(STATUS_VALUES),
  sourceTool: storedText(120), currentStep: storedText(4000), blocker: storedText(4000),
  lastUpdatedAt: timestampSchema, conversationUrl: conversationUrlSchema,
}).strict();
const archive = timestampSchema.nullable();
export const projectSchema = legacyProjectSchema.extend({ archivedAt: archive.default(null) }).strict();
export const taskSchema = legacyTaskSchema.extend({
  archivedAt: archive.default(null), priority: z.enum(PRIORITY_VALUES).default("normal"), dueDate: dueDateSchema.default(null),
}).strict();
function references(board, context) {
  const projects = new Set(board.projects.map((project) => project.id));
  const tasks = new Set(board.tasks.map((task) => task.id));
  if (projects.size !== board.projects.length || tasks.size !== board.tasks.length) context.addIssue({ code: "custom", message: "Duplicate record id" });
  if (board.tasks.some((task) => !projects.has(task.projectId))) context.addIssue({ code: "custom", message: "Task references a missing project" });
  if (board.sessions) {
    if (new Set(board.sessions.map((session) => session.id)).size !== board.sessions.length) context.addIssue({ code: "custom", message: "Duplicate session id" });
    if (board.sessions.some((session) => !tasks.has(session.taskId))) context.addIssue({ code: "custom", message: "Session references a missing task" });
    if (findScheduledOverlap(board)) context.addIssue({ code: "custom", message: "Active scheduled sessions overlap" });
  }
}
const boardFields = { revision, syncState: z.literal("unsynced"), persistence: z.literal("local") };
export const legacyBoardSchema = z.object({
  schemaVersion: z.literal(2), ...boardFields,
  projects: z.array(legacyProjectSchema).max(LIMITS.projects), tasks: z.array(legacyTaskSchema).max(LIMITS.tasks),
}).strict().superRefine(references);
export const boardSchema = z.object({
  schemaVersion: z.literal(4), ...boardFields,
  projects: z.array(projectSchema).max(LIMITS.projects), tasks: z.array(taskSchema).max(LIMITS.tasks),
  sessions: z.array(sessionSchema).max(LIMITS.sessions),
  dailyFocus: dailyFocusSchema.optional(),
}).strict().superRefine(references);
// Backups must contain every field explicitly. Public record defaults are only
// a compatibility convenience, never a way to repair an incomplete backup.
export const schema3BoardSchema = z.object({
  schemaVersion: z.literal(3), ...boardFields,
  projects: z.array(legacyProjectSchema.extend({ archivedAt: archive }).strict()).max(LIMITS.projects),
  tasks: z.array(legacyTaskSchema.extend({ archivedAt: archive, priority: z.enum(PRIORITY_VALUES), dueDate: dueDateSchema }).strict()).max(LIMITS.tasks),
}).strict().superRefine(references);
export const strictBoardSchema = schema3BoardSchema.safeExtend({
  schemaVersion: z.literal(4), sessions: z.array(sessionSchema).max(LIMITS.sessions), dailyFocus: dailyFocusSchema.optional(),
});
export const portableBackupSchema = z.object({
  format: z.literal("learning-board-backup"), formatVersion: z.literal(1), createdAt: timestampSchema,
  board: z.union([schema3BoardSchema, strictBoardSchema]), checksum: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const projectInput = z.object({ id: id.optional(), name: inputText(120, 1), description: inputText(4000) }).strict();
const taskInput = z.object({
  id: id.optional(), projectId: id, title: inputText(200, 1), status: z.enum(STATUS_VALUES),
  sourceTool: inputText(120), currentStep: inputText(4000), blocker: inputText(4000), conversationUrl: inputConversationUrlSchema,
  // Do not default these inputs: historical request fingerprints must remain
  // byte-for-byte equivalent after normalization, and old editors retain values.
  priority: z.enum(PRIORITY_VALUES).optional(), dueDate: dueDateSchema.optional(),
}).strict();
export const applyScheduleOperationSchema = z.object({
  type: z.literal("apply_schedule"), newProject: projectInput.extend({ id }).strict().optional(),
  newTasks: z.array(taskInput.extend({ id, status: z.literal("planned") }).strict()).max(LIMITS.batchTasks),
  sessions: z.array(sessionInputSchema).max(LIMITS.batchSessions),
}).strict().superRefine((operation, context) => {
  if (!operation.newProject && operation.newTasks.length === 0 && operation.sessions.length === 0) {
    context.addIssue({ code: "custom", message: "A schedule batch must contain at least one change" });
  }
});
const mutationFields = { requestId: id, expectedRevision: revision };
const taskPatchFields = { status: z.enum(STATUS_VALUES).optional(), currentStep: inputText(4000).optional(), blocker: inputText(4000).optional() };
const nonemptyPatch = (fields) => z.object(fields).strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), "A task patch must contain at least one field")
  .transform((patch) => Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
const patchTaskOperation = (patch) => z.object({ type: z.literal("patch_task"), taskId: id, patch }).strict();
export const patchTaskOperationSchema = patchTaskOperation(nonemptyPatch({ ...taskPatchFields, priority: z.enum(PRIORITY_VALUES).optional() }));
export const createTaskOperationSchema = z.object({
  type: z.literal("create_task"),
  // This is explicit caller input, not host authentication or process identity.
  // Never fill it from a process-level CODEX_THREAD_ID or guessed metadata.
  currentThreadId: id.optional(),
  task: z.object({
    projectId: id, title: inputText(200, 1), status: z.enum(STATUS_VALUES).default("planned"),
    currentStep: inputText(4000).default(""), blocker: inputText(4000).default(""),
    priority: z.enum(PRIORITY_VALUES).optional(), dueDate: dueDateSchema.optional(),
  }).strict(),
}).strict();
export const taskInputSchema = z.object({
  ...mutationFields, operation: z.discriminatedUnion("type", [createTaskOperationSchema, patchTaskOperation(nonemptyPatch(taskPatchFields))]),
}).strict();
export const planInputSchema = z.object({ ...mutationFields, operation: applyScheduleOperationSchema }).strict();
export const feedbackInputSchema = z.object({ ...mutationFields, operation: feedbackOperationSchema }).strict();
export const mutationInputSchema = z.object({
  ...mutationFields,
  operation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("save_project"), project: projectInput }).strict(),
    z.object({ type: z.literal("save_task"), task: taskInput }).strict(),
    createTaskOperationSchema,
    patchTaskOperationSchema,
    z.object({ type: z.literal("move_task"), taskId: id, status: z.enum(STATUS_VALUES), beforeTaskId: id.nullable() }).strict(),
    z.object({ type: z.literal("archive_project"), projectId: id, archived: z.boolean() }).strict(),
    z.object({ type: z.literal("archive_task"), taskId: id, archived: z.boolean() }).strict(),
    z.object({ type: z.literal("set_focus_task"), taskId: id, focused: z.boolean(), ...focusFields }).strict(),
    z.object({ type: z.literal("restore_board"), backup: portableBackupSchema }).strict(),
    z.object({ type: z.literal("save_session"), session: sessionInputSchema }).strict(),
    feedbackOperationSchema,
    z.object({ type: z.literal("cancel_session"), sessionId: id }).strict(),
    applyScheduleOperationSchema,
  ]),
}).strict();
export const dataInputSchema = z.object({
  action: z.enum(["export", "preview_restore"]), backup: portableBackupSchema.optional(),
}).strict().superRefine((input, context) => {
  if ((input.action === "export" && input.backup !== undefined) || (input.action === "preview_restore" && input.backup === undefined)) {
    context.addIssue({ code: "custom", message: "Backup is required only for restore preview" });
  }
});

export function emptyBoard() {
  return { schemaVersion: 4, revision: 0, projects: [], tasks: [], sessions: [], syncState: "unsynced", persistence: "local" };
}
