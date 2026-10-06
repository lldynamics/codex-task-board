import { i18nFor, msg, fmt } from "./i18n.mjs";
import { isSafeConversationUrl } from "./board.mjs";
import { STATUS_LABELS, PRIORITY_LABELS, COLUMN_ORDER, element, displayProjectName, displayTaskField } from "./view-common.mjs";
import { icon } from "./icons.mjs";

export function createCards(context) {
  const { document, state, options, callbacks } = context;
  const i18n = i18nFor(document);
  const canMove = (...args) => callbacks.canMove(...args);
  const clearDrag = (...args) => callbacks.clearDrag(...args);
  const isArchived = (...args) => callbacks.isArchived(...args);
  const openTask = (...args) => callbacks.openTask(...args);
  const reportError = (...args) => callbacks.reportError(...args);
  const startAction = (...args) => callbacks.startAction(...args);
  const startMove = (...args) => callbacks.startMove(...args);
  // Each render supplies a new column array. Share its manual neighbours across
  // paginated cards instead of searching the entire board for each neighbour.
  const manualColumns = new WeakMap();
  const expandedSources = new Set();

  function renderStepAndBlocker(card, task) {
    if (task.currentStep) {
      const step = element(document, "p", "card-step", displayTaskField(task, "currentStep"));
      i18n.bindFormatAttr(step, "aria-label", () => i18n.t("当前步骤：{p1}", { p1: i18n.text(displayTaskField(task, "currentStep")) }));
      i18n.bindFormatAttr(step, "title", () => i18n.text(displayTaskField(task, "currentStep")));
      card.append(step);
    }
    if (task.blocker) {
      const blocker = element(document, "div", "card-blocker");
      i18n.bindFormatAttr(blocker, "aria-label", () => i18n.t("阻塞项：{p1}", { p1: task.blocker }));
      blocker.title = task.blocker;
      blocker.append(icon(document, "warning"), element(document, "span", "", task.blocker));
      card.append(blocker);
    }
  }

  function renderUpdatedDate(task) {
    const value = task.updatedAt ?? task.lastUpdatedAt;
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return element(document, "span", "card-date", fmt(() => i18n.t("更新时间未知")));
    const format = (fields) => new Intl.DateTimeFormat(i18n.intlLocale, { timeZone: state.schedule.timeZone, ...fields, hourCycle: "h23" }).format(date);
    const time = element(document, "time", "card-date", fmt(() => i18n.t("更新 {p1}", { p1: format({ month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) })));
    time.dateTime = value;
    i18n.bindFormatAttr(time, "title", () => i18n.t("来源更新时间（{zone}）：{p1}", { zone: state.schedule.timeZone, p1: format({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) }));
    i18n.bindFormatAttr(time, "aria-label", () => time.title);
    return time;
  }

  function renderSourceDetails(task) {
    const details = element(document, "details", "card-source-details");
    details.id = `card-source-details-${task.id}`;
    details.dataset.cardSourceDetails = task.id;
    const previous = document.getElementById(details.id);
    if (previous) {
      if (previous.open) expandedSources.add(task.id); else expandedSources.delete(task.id);
    }
    const focusedContent = previous?.contains(document.activeElement) && !document.activeElement.matches("summary");
    details.open = expandedSources.has(task.id) || Boolean(focusedContent);
    const summary = element(document, "summary", "", fmt(() => i18n.t("来源详情")));
    summary.setAttribute("aria-expanded", String(details.open));
    summary.setAttribute("aria-controls", `card-source-content-${task.id}`);
    summary.addEventListener("click", () => {
      if (details.open) expandedSources.delete(task.id); else expandedSources.add(task.id);
    });
    const content = element(document, "div", "card-source-content");
    content.id = `card-source-content-${task.id}`;
    const fields = element(document, "dl");
    for (const [label, value] of [["来源", fmt(() => i18n.t("{p1} · 只读", { p1: i18n.text(displayTaskField(task, "sourceTool")) || i18n.t("Codex 自动同步") }))], ["主机", task.hostId], ["目录", task.cwd || msg("未关联目录")], ["原任务 ID", task.threadId]]) {
      fields.append(element(document, "dt", "", msg(label)), element(document, "dd", "", value));
    }
    const copy = element(document, "button", "quiet", fmt(() => i18n.t("复制原任务 ID")));
    copy.type = "button";
    copy.dataset.codexTaskCopy = task.id;
    copy.addEventListener("click", () => void callbacks.copyCodexTaskId(task));
    content.append(fields, copy);
    details.append(summary, content);
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      if (details.open) expandedSources.add(task.id); else expandedSources.delete(task.id);
      summary.setAttribute("aria-expanded", String(details.open));
    });
    return details;
  }

  function manualColumn(tasks) {
    if (!manualColumns.has(tasks)) {
      const records = tasks.filter((task) => task.origin !== "codex" && !task.readOnly);
      manualColumns.set(tasks, { records, indices: new Map(records.map((task, index) => [task.id, index])) });
    }
    return manualColumns.get(tasks);
  }

  function conversationLink(task, label = "原对话") {
    if (!isSafeConversationUrl(task.conversationUrl)) return element(document, "span", "helper", fmt(() => i18n.t("原对话链接不可用")));
    const link = element(document, "a", "", msg(label));
    link.prepend(icon(document, "link"));
    link.href = task.conversationUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (options.openConversation) link.addEventListener("click", async (event) => {
      event.preventDefault();
      if (!state.host.connected) return reportError("当前未连接宿主，无法打开原对话。");
      try {
        const result = await options.openConversation(task.conversationUrl);
        if (result?.isError || result?.status === "error") reportError("无法打开原对话。请稍后重试。");
      } catch { reportError("无法打开原对话。请稍后重试。"); }
    });
    return link;
  }

  function renderCard(task, columnTasks, index) {
    if (task.origin === "codex" || task.readOnly) return renderCodexCard(task);
    const manual = manualColumn(columnTasks);
    columnTasks = manual.records;
    index = manual.indices.get(task.id);
    const card = element(document, "article", "task-card");
    card.classList.toggle("task-list-row", state.presentation.mode === "list");
    card.dataset.taskId = task.id;
    card.dataset.origin = "manual";
    card.dataset.archived = String(isArchived(task));
    card.classList.toggle("is-archived", isArchived(task));
    const isFocus = callbacks.isFocusTask?.(task.id) === true;
    card.classList.toggle("is-focus", isFocus);
    card.classList.toggle("is-selected", state.editor.kind === "task" && state.editor.id === task.id);
    const top = element(document, "div", "card-top");
    top.append(element(document, "span", "project", displayProjectName(callbacks.displayProjectsById().get(task.projectId))), element(document, "span", `status status-${task.status}`, fmt(() => i18n.t(STATUS_LABELS[task.status]))));
    const heading = element(document, "h3");
    const title = element(document, "button", "task-title", task.title);
    title.type = "button";
    title.dataset.editTask = task.id;
    title.addEventListener("click", () => openTask(task));
    heading.append(title);
    card.append(top, heading);
    const labels = element(document, "div", "task-labels");
    if (isFocus) labels.append(element(document, "span", "task-focus-tag", fmt(() => i18n.t("⭐ 今日焦点"))));
    if (task.priority && (task.priority !== "normal" || state.presentation.mode === "list")) labels.append(element(document, "span", `priority-${task.priority}`, fmt(() => i18n.t("{p1}优先级", { p1: i18n.t(PRIORITY_LABELS[task.priority]) }))));
    if (task.dueDate) {
      const date = callbacks.attentionToday();
      const year = date.slice(0, 4);
      const overdue = task.dueDate < date && !isArchived(task) && task.status !== "completed";
      const due = element(document, "time", `card-date${overdue ? " due-overdue" : ""}`, fmt(() => i18n.t("截止 {p1}", { p1: task.dueDate.startsWith(`${year}-`) ? task.dueDate.slice(5) : task.dueDate })));
      due.dateTime = task.dueDate;
      i18n.bindFormatAttr(due, "title", () => i18n.t("截止日期：{p1}{p2}", { p1: task.dueDate, p2: overdue ? i18n.t("（已逾期）") : "" }));
      i18n.bindFormatAttr(due, "aria-label", () => due.title);
      labels.append(due);
    }
    if (isArchived(task)) labels.append(element(document, "span", "", fmt(() => state.projectsById.get(task.projectId)?.archivedAt ? i18n.t("项目已归档") : i18n.t("已归档"))));
    renderStepAndBlocker(card, task);
    if (labels.childElementCount) card.append(labels);
    const footer = element(document, "div", "card-footer");
    footer.append(element(document, "span", "origin-badge origin-badge-manual", fmt(() => i18n.t("手工记录"))));
    footer.append(element(document, "span", "source-tag", fmt(() => i18n.t("来源：{p1}", { p1: task.sourceTool || i18n.t("未填写") }))));
    if (task.conversationUrl) footer.append(conversationLink(task));
    const actions = element(document, "details", "card-actions");
    const summary = element(document, "summary");
    summary.append(icon(document, "dots"), element(document, "span", "sr-only", fmt(() => i18n.t("更多操作"))));
    i18n.bindFormatAttr(summary, "aria-label", () => i18n.t("更多操作：{p1}", { p1: task.title }));
    const controls = element(document, "div", "move-controls");
    const up = element(document, "button", "", fmt(() => i18n.t("上移")));
    up.type = "button";
    up.prepend(icon(document, "up"));
    up.dataset.moveControl = "up";
    up.dataset.boundary = String(index === 0);
    up.addEventListener("click", () => startMove(task.id, task.status, columnTasks[index - 1]?.id));
    const down = element(document, "button", "", fmt(() => i18n.t("下移")));
    down.type = "button";
    down.prepend(icon(document, "arrow-down"));
    down.dataset.moveControl = "down";
    down.dataset.boundary = String(index === columnTasks.length - 1);
    down.addEventListener("click", () => startMove(task.id, task.status, columnTasks[index + 2]?.id ?? null));
    const status = element(document, "select");
    status.dataset.moveControl = "status";
    i18n.bindFormatAttr(status, "aria-label", () => i18n.t("移动“{p1}”到状态", { p1: task.title }));
    for (const value of COLUMN_ORDER) {
      const option = element(document, "option", "", fmt(() => i18n.t(STATUS_LABELS[value])));
      option.value = value;
      status.append(option);
    }
    status.value = task.status;
    status.addEventListener("change", () => {
      const target = status.value;
      status.value = task.status;
      if (target !== task.status) callbacks.stageQuick(task.id, "status", target, "menu");
    });
    if (isArchived(task)) {
      for (const control of [up, down, status]) control.dataset.boundary = "true";
    }
    const focusBtn = element(document, "button", "quiet", fmt(() => isFocus ? i18n.t("移出今日焦点") : i18n.t("设为今日焦点")));
    focusBtn.type = "button";
    focusBtn.dataset.focusTask = task.id;
    focusBtn.addEventListener("click", () => callbacks.toggleFocusTask?.(task.id));
    const archive = element(document, "button", "quiet", fmt(() => task.archivedAt ? i18n.t("恢复任务") : i18n.t("归档任务")));
    archive.type = "button";
    archive.dataset.archiveTask = task.id;
    archive.addEventListener("click", () => startAction({ type: "archive_task", taskId: task.id, archived: !task.archivedAt }));
    controls.append(up, down, status, focusBtn, archive);
    actions.append(summary, controls);
    callbacks.prepareCardMenu(actions);
    card.append(footer, actions);
    if (state.presentation.mode === "list") card.append(callbacks.renderQuickControls(task));
    card.addEventListener("dragstart", (event) => {
      if (!canMove() || isArchived(task)) return event.preventDefault();
      state.presentation.draggingId = task.id;
      event.dataTransfer?.setData("text/plain", task.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", clearDrag);
    card.addEventListener("dragover", (event) => {
      if (!state.presentation.draggingId || state.presentation.draggingId === task.id || !canMove()) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      card.classList.add("drop-before");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-before"));
    card.addEventListener("drop", (event) => {
      if (!state.presentation.draggingId || !canMove()) return;
      event.preventDefault();
      event.stopPropagation();
      const id = state.presentation.draggingId;
      clearDrag();
      if (id === task.id) return;
      startMove(id, task.status, task.id);
    });
    return card;
  }

  function renderCodexCard(task) {
    const card = element(document, "article", "task-card codex-task-card");
    card.classList.toggle("task-list-row", state.presentation.mode === "list");
    card.dataset.taskId = task.id; card.dataset.origin = "codex"; card.dataset.readOnly = "true"; card.dataset.archived = "false"; card.draggable = false;
    const top = element(document, "div", "card-top");
    top.append(element(document, "span", "project", displayProjectName(callbacks.displayProjectsById().get(task.projectId))), element(document, "span", `status status-${task.status}`, displayTaskField(task, "statusLabel")));
    const title = element(document, "button", "task-title", task.title); title.type = "button"; title.dataset.codexTaskOpen = task.id;
    i18n.bindFormatAttr(title, "aria-label", () => i18n.t("打开 Codex 原任务：{p1}", { p1: task.title }));
    title.addEventListener("click", () => void callbacks.openCodexTask(task));
    const heading = element(document, "h3"); heading.append(title);
    card.append(top, heading);
    renderStepAndBlocker(card, task);
    const labels = element(document, "div", "task-labels");
    if (state.presentation.mode === "list") labels.append(element(document, "span", "list-origin origin-badge origin-badge-codex", fmt(() => i18n.t("Codex · 只读"))));
    labels.append(renderUpdatedDate(task));
    card.append(labels);
    const footer = element(document, "div", "card-footer");
    const host = Array.from(task.hostId || "未知主机");
    footer.append(element(document, "span", "source-tag origin-badge origin-badge-codex", fmt(() => i18n.t("{p1} · 只读", { p1: i18n.text(displayTaskField(task, "sourceTool")) || i18n.t("Codex 自动同步") }))),
      element(document, "span", "source-host", fmt(() => i18n.t("主机：{p1}", { p1: host.length > 20 ? `${host.slice(0, 19).join("")}…` : host.join("") }))));
    card.append(footer, renderSourceDetails(task));
    card.addEventListener("dragstart", (event) => event.preventDefault());
    card.addEventListener("drop", (event) => { event.preventDefault(); event.stopPropagation(); });
    return card;
  }

  return { conversationLink, renderCard };
}
