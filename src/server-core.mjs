import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { CODEX_TOOL_NAME, CODEX_SYNC_TOOL_NAME, codexCaptureSchema, codexSnapshotSchema, unavailableCodexSnapshot } from "./codex-domain.mjs";
import { PRODUCT_ID, PRODUCT_NAME, LEGACY_UI_URIS } from "./product-identity.mjs";
import { projectSchema, taskSchema } from "./board.mjs";
import { sessionSchema } from "./schedule-domain.mjs";
import { VERSION, TOOL_NAME, MUTATION_TOOL_NAME, DATA_TOOL_NAME, CONTEXT_TOOL_NAME, PLAN_TOOL_NAME, FEEDBACK_TOOL_NAME, TASK_TOOL_NAME, UI_URI, MIME_TYPE, boardSchema, mutationInputSchema, planInputSchema, feedbackInputSchema, taskInputSchema, dataInputSchema, portableBackupSchema, timestampSchema } from "./board.mjs";
export { createFileStore } from "./store.mjs";
export { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function toolResult(result) {
  return { ...(result.ok ? {} : { isError: true }), content: [{ type: "text", text: result.ok ? "已读取本机手工记录；Codex 自动任务会按项目汇入我的看板。" : result.error.message }], structuredContent: result };
}

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(["INVALID_INPUT", "INVALID_STORE", "SAVE_FAILED", "BUSY", "REVISION_CONFLICT", "REQUEST_ID_REUSE", "REQUEST_EXPIRED", "CAPACITY_EXCEEDED", "NOT_FOUND", "SCHEDULE_CONFLICT", "SESSION_LOCKED"]),
    message: z.string().min(1),
  }).strict(),
  board: boardSchema.optional(),
}).strict();
function resultSchema(successSchema) {
  // SDK 1.29 requires an object root and validates structured error responses in
  // Client.callTool too. JSON Schema describes both sets of fields; refinement
  // keeps successful server results strict. SDK 1.29 bypasses this refinement
  // for isError results, which are produced by the store and checked by the UI.
  const optionalFields = Object.fromEntries(Object.entries(successSchema.shape).map(([name, schema]) => [name, schema.optional()]));
  return z.object({ ...optionalFields, ok: z.boolean(), error: failureSchema.shape.error.optional() }).strict().superRefine((result, context) => {
    const parsed = (result.ok ? successSchema : failureSchema).safeParse(result);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue(issue);
  });
}

// Archived projects and tasks (and their sessions) are hidden from the model by
// default; the references of the remaining board stay complete.
function activeBoard(board) {
  const projects = board.projects.filter((project) => project.archivedAt === null);
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = board.tasks.filter((task) => task.archivedAt === null && projectIds.has(task.projectId));
  const taskIds = new Set(tasks.map((task) => task.id));
  const sessions = board.sessions.filter((session) => taskIds.has(session.taskId));
  const dailyFocus = board.dailyFocus && { ...board.dailyFocus, taskIds: board.dailyFocus.taskIds.filter((id) => taskIds.has(id)) };
  return { ...board, projects, tasks, sessions, ...(dailyFocus ? { dailyFocus } : {}) };
}

export async function createServer(store, { codex = { read: async () => unavailableCodexSnapshot() }, collectCodex } = {}) {
  const html = await readFile(new URL("./app.html", import.meta.url), "utf8");
  const iconSvg = await readFile(new URL("../assets/icon.svg", import.meta.url), "utf8");
  const icon = { src: "data:image/svg+xml," + encodeURIComponent(iconSvg), mimeType: "image/svg+xml" };
  const server = new McpServer({ name: PRODUCT_ID, title: PRODUCT_NAME, version: VERSION, icons: [icon] });
  const readInputSchema = z.object({}).strict();
  const readOutputSchema = z.object({ ok: z.literal(true), board: boardSchema }).strict();
  const changedIdsSchema = z.object({ projects: z.array(z.uuid()), tasks: z.array(z.uuid()), sessions: z.array(z.uuid()) }).strict();
  const mutationOutputSchema = z.object({ ok: z.literal(true), board: boardSchema, replayed: z.boolean(), appliedRevision: z.number().int().min(1), entityId: z.uuid().optional(), changed: changedIdsSchema.optional() }).strict();
  // Model tools receive a compact receipt: the changed records, never the
  // whole board, which can be hundreds of thousands of characters.
  const receiptOutputSchema = z.object({
    ok: z.literal(true), replayed: z.boolean(), appliedRevision: z.number().int().min(1), revision: z.number().int().min(1), entityId: z.uuid().optional(),
    changed: z.object({ projects: z.array(projectSchema), tasks: z.array(taskSchema), sessions: z.array(sessionSchema) }).strict().optional(),
  }).strict();
  const contextInputSchema = z.object({ includeArchived: z.boolean().optional() }).strict();
  const modelReceipt = (result) => {
    if (!result.ok) { const { board, ...failure } = result; return failure; }
    const pick = (key) => result.board[key].filter((record) => result.changed?.[key]?.includes(record.id));
    return {
      ok: true, replayed: result.replayed, appliedRevision: result.appliedRevision, revision: result.board.revision,
      ...(result.entityId ? { entityId: result.entityId } : {}),
      ...(result.changed ? { changed: { projects: pick("projects"), tasks: pick("tasks"), sessions: pick("sessions") } } : {}),
    };
  };
  const receiptResult = (result) => {
    const response = toolResult(modelReceipt(result));
    if (result.ok) response.content = [{ type: "text", text: result.replayed ? "请求已在之前保存；未重复写入。完整记录请用 learning_board_context 读取。" : "已保存；返回本次变更的记录与最新 revision。" }];
    return response;
  };
  server.registerTool(TOOL_NAME, {
    title: PRODUCT_NAME, description: "打开本机项目、学习日历与 Codex 任务看板。我的看板统一展示手工任务与按项目分组的 Codex 自动任务。",
    inputSchema: readInputSchema, outputSchema: resultSchema(readOutputSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, icons: [icon],
    _meta: { ui: { resourceUri: UI_URI, visibility: ["model", "app"] }, "openai/ui": { entrypoints: [{ type: "global" }] }, "openai/iconStyle": "monochrome" },
  }, async () => toolResult(await store.read()));
  server.registerTool(CODEX_TOOL_NAME, {
    title: "读取 Codex 任务与定时计划",
    description: "只读获取可访问的 Codex 任务和本机定时计划元数据。返回来源范围、实时或历史模式与读取时间；空闲和一轮结束不代表目标完成。不会启动任务或改动调度。",
    inputSchema: readInputSchema,
    outputSchema: z.object({ ok: z.literal(true), snapshot: codexSnapshotSchema }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async () => {
    try {
      const snapshot = codexSnapshotSchema.parse(await codex.read());
      return { content: [{ type: "text", text: "已读取 Codex 状态快照；请结合来源范围及同步状态查看。" }], structuredContent: { ok: true, snapshot } };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Codex 状态来源暂时不可用，现有快照已保留，请稍后重试。" }] };
    }
  });
  server.registerTool(CODEX_SYNC_TOOL_NAME, {
    title: "同步用户授权的 Codex 任务快照",
    description: "仅用于用户授权的任务看板采集。先调用 Codex 桌面原生 list_threads(limit:50)，将返回的 pinnedThreads/threads 投影为 id、kind、hostId、status、title、cwd、updatedAt；不加入 summary 或正文。capturedAt 使用采集完成 UTC 时间；不确定当前时间时，在 list_threads 之后调用 learning_board_context，使用其 serverNow。原样保留不可用来源标识，仅写独立状态缓存，不操作原任务、不更新手工看板；不得根据对话内容猜测状态。",
    inputSchema: codexCaptureSchema,
    outputSchema: z.object({ ok: z.literal(true), capturedAt: timestampSchema, threadCount: z.number().int().min(0), complete: z.boolean(), truncated: z.boolean(), unchanged: z.boolean(), warningCode: z.enum(["CACHE_DURABILITY_UNCONFIRMED", "COLLECTOR_LOCK_RELEASE_FAILED"]).optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["model"] } },
  }, async (input) => {
    try {
      if (typeof collectCodex !== "function") throw new Error("Collector unavailable");
      const receipt = await collectCodex(input);
      return { content: [{ type: "text", text: "Codex 状态快照已同步；原任务与手工看板未修改。" }], structuredContent: receipt };
    } catch {
      return { isError: true, content: [{ type: "text", text: "Codex 状态快照未确认写入；请保留本次采集参数核对，勿推测或改写任务状态。" }] };
    }
  });
  server.registerTool(MUTATION_TOOL_NAME, {
    title: "更新看板与学习时段", description: "保存、移动或归档项目与任务，设置按日期和时区生效的今日焦点，维护学习时段与用户反馈，或用已校验备份恢复完整看板；恢复前保留本机旧版本备份，所有写入均检查当前版本。",
    inputSchema: mutationInputSchema,
    outputSchema: resultSchema(mutationOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async (input) => toolResult(await store.mutate(input)));
  const previewSchema = z.object({
    sourceRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    projectCount: z.number().int().min(0), taskCount: z.number().int().min(0), sessionCount: z.number().int().min(0),
    archivedProjectCount: z.number().int().min(0), archivedTaskCount: z.number().int().min(0),
  }).strict();
  const dataSuccessSchema = z.object({
    ok: z.literal(true), backup: portableBackupSchema.optional(), board: boardSchema.optional(), preview: previewSchema.optional(),
  }).strict().superRefine((result, context) => {
    const exported = result.backup !== undefined && result.board === undefined && result.preview === undefined;
    const previewed = result.backup === undefined && result.board !== undefined && result.preview !== undefined;
    if (!exported && !previewed) context.addIssue({ code: "custom", message: "Expected an export or a restore preview" });
  });
  server.registerTool(DATA_TOOL_NAME, {
    title: "导出或预览看板备份", description: "只读导出本机看板，或校验备份并预览恢复数量；恢复须另行提交版本校验操作。",
    inputSchema: dataInputSchema, outputSchema: resultSchema(dataSuccessSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  }, async (input) => toolResult(await store.data(input)));
  server.registerTool(CONTEXT_TOOL_NAME, {
    title: "读取任务与学习排程上下文", description: "只读获取本机看板、当前 revision 和 serverNow。默认省略已归档的项目、任务及其学习时段（omitted 给出数量），需要时传 includeArchived:true。写入工具只返回本次变更的记录与最新 revision。记录普通任务、更新任务或排程前先读取这里，并确认用户授权；学习排程还须确认学习目标、IANA 时区及可用时间。截止日期不是学习时段，不能据此臆造日历。",
    inputSchema: contextInputSchema,
    outputSchema: resultSchema(z.object({ ok: z.literal(true), board: boardSchema, serverNow: timestampSchema, omitted: z.object({ projects: z.number().int().min(0), tasks: z.number().int().min(0), sessions: z.number().int().min(0) }).strict() }).strict()),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["model"] } },
  }, async ({ includeArchived = false } = {}) => {
    const result = await store.read();
    if (!result.ok) return toolResult(result);
    const board = includeArchived ? result.board : activeBoard(result.board);
    const omitted = Object.fromEntries(["projects", "tasks", "sessions"].map((key) => [key, result.board[key].length - board[key].length]));
    return toolResult({ ok: true, board, serverNow: new Date().toISOString(), omitted });
  });
  server.registerTool(PLAN_TOOL_NAME, {
    title: "批量保存用户授权的学习排程", description: "仅在用户授权后，以 apply_schedule 原子创建项目、planned 任务和未来学习时段或更新尚未开始的 scheduled 时段。先调用 learning_board_context 读取 revision，确认时区、学习目标和可用时间；不能把 dueDate 当时段。全部时间为 UTC ISO Z，timeZone 为 IANA。反馈不会自动完成任务。写入结果未知时原样重试同一 requestId、expectedRevision 和 operation；冲突时先读取最新看板。",
    inputSchema: planInputSchema, outputSchema: resultSchema(receiptOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["model"] } },
  }, async (input) => receiptResult(await store.mutate(input)));
  server.registerTool(FEEDBACK_TOOL_NAME, {
    title: "记录用户报告的学习反馈", description: "仅根据用户明确报告，且经用户授权，记录 completed 或 not_completed、反馈及实际分钟数；不要推断用户完成了学习，也不会自动完成任务。先调用 learning_board_context 读取 revision。历史反馈可补充修正，已取消时段不可反馈。结果未知时原样重试同一 requestId、expectedRevision 和 operation；冲突时重新读取。",
    inputSchema: feedbackInputSchema, outputSchema: resultSchema(receiptOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["model"] } },
  }, async (input) => receiptResult(await store.mutate(input)));
  server.registerTool(TASK_TOOL_NAME, {
    title: "记录用户授权的普通任务",
    description: "仅在用户授权记录或更新任务后使用。先调用 learning_board_context 读取 revision 和现有项目；create_task 在现有未归档项目中新建普通任务，patch_task 只更新 currentStep、blocker、status 并保留其它字段，不可归档、恢复、删除或更改项目。不得由空闲、一轮结束或学习反馈臆测 completed。新建时仅在当前调用上下文明示真实 Codex 对话 UUID 时显式传 currentThreadId，服务端据此构造原对话链接；当前接口不自动识别调用线程，缺失时链接为空。不得从标题或任务列表猜 ID，也不得用插件启动进程的环境变量代替当前调用者。更新保留原链接。结果未知时原样重试同一 requestId、expectedRevision 和 operation；冲突时先读取最新看板。",
    inputSchema: taskInputSchema, outputSchema: resultSchema(receiptOutputSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ["model"] } },
  }, async (input) => {
    const result = await store.mutate(input);
    const response = receiptResult(result);
    if (result.ok && !result.replayed) response.content = [{ type: "text", text: input.operation.type === "patch_task"
      ? "已保存指定任务字段，保留其它任务内容与原对话链接。"
      : input.operation.currentThreadId
        ? "普通任务已保存；原对话链接由显式传入的 currentThreadId 构造，未由宿主自动确认调用线程身份。"
        : "普通任务已保存；当前调用没有提供已确认的对话 ID，原对话链接为空。" }];
    return response;
  });
  // Resource aliases keep panels opened by earlier plugin versions readable.
  // Only TOOL_NAME above publishes a global entrypoint.
  for (const [index, uri] of [UI_URI, ...LEGACY_UI_URIS].entries()) {
    server.registerResource(index === 0 ? PRODUCT_ID : `${PRODUCT_ID}-legacy-${index}`, uri, { title: PRODUCT_NAME, mimeType: MIME_TYPE }, async () => ({ contents: [{
      uri, mimeType: MIME_TYPE, text: html,
      _meta: { "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] }, ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
    }] }));
  }

  return server;
}
