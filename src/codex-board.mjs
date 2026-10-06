import { codexSnapshotSchema, CODEX_SNAPSHOT_STALE_MS } from "./codex-domain.mjs";

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const encoder = new TextEncoder();
const encodedIdentity = (prefix, values) => prefix + Array.from(encoder.encode(JSON.stringify(values)), (byte) => byte.toString(16).padStart(2, "0")).join("");

function isWindowsPath(value) { return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value); }
function projectPath(value) {
  if (value === null || !value.trim()) return null;
  if (!isWindowsPath(value)) return /^\/+$/u.test(value) ? "/" : value.replace(/\/+$/u, "");
  if (/^[A-Za-z]:[\\/]+$/u.test(value)) return value.slice(0, 3);
  return value.replace(/[\\/]+$/u, "");
}
function projectName(cwd) {
  if (cwd === null) return "未关联项目";
  const parts = cwd.split(isWindowsPath(cwd) ? /[\\/]/u : /\//u);
  return parts.at(-1) || cwd;
}

// Keep the priority and labels of threadPresentation, with separate board values
// for a finished turn and a completed goal.
function threadStatus(thread, unknownLabel = "状态未知 · 来源未提供当前状态") {
  if (thread.attention) return { status: "waiting_user", statusLabel: thread.attention === "approval" ? "等待批准" : "等待输入" };
  if (thread.runtimeStatus === "error") return { status: "failed", statusLabel: "运行异常" };
  if (thread.runtimeStatus === "active" || thread.lastTurnStatus === "running") return { status: "in_progress", statusLabel: "运行中" };
  if (thread.goalStatus === "complete") return { status: "completed", statusLabel: "目标已完成" };
  if (thread.lastTurnStatus === "failed") return { status: "failed", statusLabel: "本轮失败" };
  if (thread.lastTurnStatus === "interrupted") return { status: "failed", statusLabel: "本轮中断" };
  if (thread.goalStatus === "blocked") return { status: "waiting_user", statusLabel: "目标受阻" };
  if (thread.goalStatus === "paused") return { status: "paused", statusLabel: "目标已暂停" };
  if (thread.lastTurnStatus === "completed") return { status: "turn_ended", statusLabel: thread.goalStatus === "active" ? "本轮结束 · 目标仍进行中" : "本轮结束 · 目标完成情况未知" };
  if (thread.runtimeStatus === "idle") return { status: "idle", statusLabel: "空闲 · 完成情况未知" };
  if (thread.runtimeStatus === "notLoaded") return { status: "not_loaded", statusLabel: "未加载 · 完成情况未知" };
  return { status: "unknown", statusLabel: unknownLabel };
}

function unavailableRuntimeLabel(source, ageMs, staleMs) {
  if (["disconnected", "unsupported"].includes(source.state) || source.mode === "unavailable") return "状态未知 · 来源不可用";
  if (ageMs === null) return "状态未知 · 缺少有效采集时间";
  if (ageMs < 0) return "状态未知 · 采集时间异常";
  if (ageMs > staleMs) return "状态未知 · 采集已过期";
  if (source.mode === "archive") return "状态未知 · 历史记录不提供当前状态";
  return "状态未知 · 来源未提供当前状态";
}

/** Derived, read-only records for display. These are never manual-board mutations. */
export function projectCodexSnapshot(snapshot, { now = Date.now(), staleMs = CODEX_SNAPSHOT_STALE_MS } = {}) {
  const parsed = codexSnapshotSchema.parse(snapshot);
  if (!Number.isFinite(now) || !Number.isFinite(staleMs) || staleMs < 0) throw new TypeError("Invalid projection clock or freshness limit");
  const source = parsed.sources.threads;
  const ageMs = source.lastSuccessAt === null ? null : now - Date.parse(source.lastSuccessAt);
  const expired = ["disconnected", "unsupported"].includes(source.state) || ageMs === null || ageMs < 0 || ageMs > staleMs;
  const runtimeReliable = !expired && ["live", "snapshot"].includes(source.mode);
  const unknownLabel = runtimeReliable ? "状态未知 · 来源未提供当前状态" : unavailableRuntimeLabel(source, ageMs, staleMs);
  const freshness = { expired, runtimeReliable, ageMs, lastSuccessAt: source.lastSuccessAt };
  const groups = new Map();
  const tasks = parsed.threads.map((raw) => {
    const cwd = projectPath(raw.cwd);
    const projectId = encodedIdentity("codex-project-", [raw.hostId, cwd]);
    if (!groups.has(projectId)) groups.set(projectId, {
      id: projectId, name: projectName(cwd), description: `主机：${raw.hostId} · 目录：${cwd ?? "未关联项目"}`,
      nameKey: cwd === null ? "未关联项目" : null, descriptionKey: "主机：{p1} · 目录：{p2}",
      hostId: raw.hostId, cwd, readOnly: true, source: "codex", origin: "codex", archivedAt: null,
    });
    const thread = runtimeReliable ? raw : { ...raw, runtimeStatus: "unknown", attention: null, lastTurnStatus: raw.lastTurnStatus === "running" ? null : raw.lastTurnStatus };
    const presentation = threadStatus(thread, unknownLabel);
    return {
      id: encodedIdentity("codex-task-", [raw.hostId, raw.id]), projectId, threadId: raw.id, hostId: raw.hostId,
      title: raw.title, sourceTool: "Codex 自动同步", ...presentation, readOnly: true, source: "codex", origin: "codex",
      statusLabelKey: presentation.statusLabel, sourceToolKey: "Codex 自动同步", currentStepKey: presentation.statusLabel,
      cwd, updatedAt: raw.updatedAt, lastUpdatedAt: raw.updatedAt, thread,
      priority: "normal", dueDate: null, archivedAt: null, currentStep: presentation.statusLabel, blocker: "", conversationUrl: null,
    };
  });
  const projects = [...groups.values()].sort((a, b) => compare(a.name, b.name) || compare(a.hostId, b.hostId) || compare(a.cwd ?? "", b.cwd ?? ""));
  const projectOrder = new Map(projects.map((project, index) => [project.id, index]));
  tasks.sort((a, b) => projectOrder.get(a.projectId) - projectOrder.get(b.projectId)
    || (b.updatedAt === null ? -Infinity : Date.parse(b.updatedAt)) - (a.updatedAt === null ? -Infinity : Date.parse(a.updatedAt))
    || compare(a.title, b.title) || compare(a.id, b.id));
  return { projects, tasks, source, freshness };
}
