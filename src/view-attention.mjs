import { PRIORITY_ORDER } from "./view-common.mjs";

/** A display-only decision; no record or source thread is changed. */
export function classifyTaskAttention(task, { archived = false, today, codexRuntimeReliable = false, isFocus = false } = {}) {
  if (archived || task.archivedAt || task.status === "completed") return null;
  const automatic = task.origin === "codex" || task.readOnly;
  if (automatic && !codexRuntimeReliable) return null;
  if (!["planned", "in_progress", "waiting_user", "failed", "paused"].includes(task.status)) return null;

  const reasons = [];
  if (isFocus) reasons.push("今日焦点，优先攻坚");
  if (task.status === "waiting_user") reasons.push(automatic ? task.statusLabel || "等待用户处理" : "等待用户处理");
  if (task.status === "failed") reasons.push(automatic ? task.statusLabel || "运行异常" : "任务失败");
  const due = !automatic && task.dueDate && today && task.dueDate <= today
    ? task.dueDate < today ? "overdue" : "today" : null;
  if (due) reasons.push(`${due === "overdue" ? "已逾期" : "今日到期"} · ${task.dueDate}`);
  if (isFocus) return { group: "focus", reasons, due };
  if (reasons.length) return { group: "attention", reasons, due };
  if (!["planned", "in_progress"].includes(task.status)) return null;
  return { group: "upcoming", reasons: [task.status === "planned" ? "计划中，接下来安排" : automatic ? "运行中，跟进进展" : "进行中，继续推进"], due: null };
}

/** Stable projection order, independent of the persisted task order. */
export function sortAttentionTasks(tasks, classify) {
  const priority = (task) => PRIORITY_ORDER[task.priority] ?? PRIORITY_ORDER.normal;
  const groupRank = (group) => group === "focus" ? 0 : group === "attention" ? 1 : 2;
  return tasks.map((task, index) => ({ task, index, attention: classify(task) }))
    .sort((a, b) => groupRank(a.attention?.group) - groupRank(b.attention?.group)
      || priority(a.task) - priority(b.task)
      || (a.task.dueDate || "9999-12-31").localeCompare(b.task.dueDate || "9999-12-31")
      || a.index - b.index)
    .map(({ task }) => task);
}
