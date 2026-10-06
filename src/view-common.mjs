import { i18nFor, msg } from "./i18n.mjs";
export const STATUS_LABELS = Object.freeze({
  planned: "计划中", in_progress: "进行中", waiting_user: "等待用户",
  paused: "暂停", completed: "已完成", failed: "失败",
});


export const displayProjectName = (project) => project?.nameKey ? msg(project.nameKey) : project?.name;
export const displayProjectDescription = (project) => project?.descriptionKey ? msg(project.descriptionKey, { p1: project.hostId, p2: project.cwd ?? msg("未关联项目") }) : project?.description;
export const displayTaskField = (task, field) => task?.origin === "codex" && task[`${field}Key`] ? msg(task[`${field}Key`]) : task?.[field];

export function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) {
    const leaf = document.createTextNode("");
    node.append(leaf);
    i18nFor(document).setText(leaf, text);
  }
  return node;
}

export const PAGE_SIZE = 50;
export const PRIORITY_LABELS = Object.freeze({ low: "低", normal: "普通", high: "高", urgent: "紧急" });
export const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
export const PREFERENCE_KEY = "learning-board:view-preferences:v1";
export const FOCUS_PREFERENCE_KEY = "learning-board:focus-preferences:v1";
export const MAX_FOCUS_TASKS = 5;
export const EDITOR_FIELDS = {
  project: [
    { key: "name", id: "project-name", label: "项目名称" },
    { key: "description", id: "project-description-input", label: "项目说明" },
  ],
  task: [
    { key: "projectId", id: "task-project", label: "所属项目" },
    { key: "title", id: "task-title", label: "任务名称" },
    { key: "status", id: "task-status", label: "任务状态" },
    { key: "priority", id: "task-priority", label: "优先级" },
    { key: "dueDate", id: "task-due-date", label: "截止日期" },
    { key: "sourceTool", id: "task-source", label: "来源工具" },
    { key: "currentStep", id: "task-step", label: "当前步骤" },
    { key: "blocker", id: "task-blocker", label: "阻塞项" },
    { key: "conversationUrl", id: "task-conversation", label: "原对话链接" },
  ],
};
export const COLUMN_ORDER = ["planned", "in_progress", "waiting_user", "completed", "paused", "failed"];

export function uuid(window) {
  if (window.crypto.randomUUID) return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const ERROR_MESSAGES = {
  REVISION_CONFLICT: "记录已被另一处修改。请刷新记录，核对保留的输入后重新保存。",
  REQUEST_ID_REUSE: "这次保存无法确认。请刷新记录，核对输入后重新保存。",
  BUSY: "另一处正在保存本机记录。输入已保留，请稍后重试。",
  INVALID_STORE: "本机记录文件无法读取。输入已保留；关闭所有任务看板后，可用维护工具 restore-backup 从本机备份恢复。",
  SAVE_FAILED: "保存到本机失败。输入已保留，请重试。",
  CAPACITY_EXCEEDED: "本机记录已达到容量限制。输入已保留，本次没有保存。",
  REQUEST_EXPIRED: "本次请求已超出可确认的历史窗口，请刷新并核对最新记录后结束重试。",
  NOT_FOUND: "关联项目或任务已变更。请刷新记录，核对输入后重新保存。",
  SCHEDULE_CONFLICT: "这个时间与另一学习时段重叠。输入已保留，请调整时间后重新保存。",
  SESSION_LOCKED: "时段已开始、结束或取消，无法调整安排。输入已保留，可关闭后记录本次反馈。",
  INVALID_INPUT: "部分填写内容不符合要求。请检查输入后重新保存。",
};
export const MOVE_ERROR_MESSAGES = {
  REVISION_CONFLICT: "任务已被更新。请刷新记录，核对最新位置后重试移动。",
  REQUEST_ID_REUSE: "移动请求无法确认。请刷新记录，核对后重试移动。",
  BUSY: "另一处正在保存本机记录。移动请求已保留，请稍后重试。",
  INVALID_STORE: "本机记录文件无法读取。移动请求已保留；关闭所有任务看板后，可用维护工具 restore-backup 从本机备份恢复。",
  SAVE_FAILED: "移动未保存到本机。请求已保留，请重试。",
  CAPACITY_EXCEEDED: "本机记录已达到容量限制，本次没有移动。",
  REQUEST_EXPIRED: "移动请求已超出可确认的历史窗口，请刷新并核对最新记录后结束重试。",
  NOT_FOUND: "任务或目标位置已变更。请刷新记录，核对后重试移动。",
  INVALID_INPUT: "目标位置已变更或无效。请取消重试后重新选择位置。",
};
