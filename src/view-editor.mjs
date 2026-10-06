import { i18nFor, msg, fmt } from "./i18n.mjs";
import { STATUS_LABELS, PRIORITY_LABELS, EDITOR_FIELDS, element } from "./view-common.mjs";
import { dueDateSchema, isSafeConversationUrl } from "./board.mjs";
import { mergeEditorFields } from "./editor-merge.mjs";
import { isMutating, isReading, isBusy, saveFrozen, slotUncertain } from "./write-state.mjs";

export function createEditor(context) {
  const { document, state, refs, callbacks } = context;
  const i18n = i18nFor(document);
  const { byId, projectFilter, projectForm, taskForm, taskProject } = refs;
  const clearFeedback = (...args) => callbacks.clearFeedback(...args);
  const conversationLink = (...args) => callbacks.conversationLink(...args);
  const projectOptions = (...args) => callbacks.projectOptions(...args);
  const refreshControls = (...args) => callbacks.refreshControls(...args);
  const render = (...args) => callbacks.render(...args);
  const reportError = (...args) => callbacks.reportError(...args);

  const readingTask = () => state.editor.kind === "task" && state.editor.mode === "read";
  const currentTask = () => state.board.tasks.find((task) => task.id === state.editor.id);
  const retainedDraft = () => !!state.editor.baseline && draftSnapshot() !== state.editor.snapshot;

  function canReadQuick(taskId) {
    return (!state.presentation.surface || state.presentation.surface === "tasks")
      && readingTask() && state.editor.id === taskId && !!state.editor.baseline
      && !retainedDraft() && !state.editor.conflicts.length && !state.writes.save;
  }

  function refreshReaderQuick(task, available, dirty) {
    let section = byId("task-read-quick");
    const record = available ? task : null;
    if (!record) { section?.remove(); return; }
    if (!section) {
      section = element(document, "section", "task-read-quick");
      section.id = "task-read-quick";
      section.setAttribute("aria-labelledby", "task-read-quick-title");
      const title = element(document, "h4", "", fmt(() => i18n.t("快捷修改"))); title.id = "task-read-quick-title";
      const notice = element(document, "p", "helper"); notice.id = "task-read-quick-notice";
      section.append(title, notice);
      byId("task-read-record").before(section);
    }
    // Keep selects stable through ordinary control refreshes and notifications.
    // Rebuild only when the task or explicit conflict choices change.
    const signature = record.id;
    if (section.dataset.signature !== signature) {
      const focused = section.contains(document.activeElement) ? document.activeElement : null;
      const field = focused?.dataset.quickField;
      const controls = callbacks.renderQuickControls(record, { surface: "reader" });
      section.querySelector("[data-quick-task]")?.remove();
      section.append(controls);
      section.dataset.signature = signature;
      if (focused) (field ? controls.querySelector(`[data-quick-field="${field}"]`) : controls.querySelector("select"))?.focus({ preventScroll: true });
    }
    const notice = byId("task-read-quick-notice");
    i18n.setText(notice, fmt(() => dirty || state.editor.conflicts.length || state.writes.save
      ? i18n.t("完整编辑中有未保存的修改。请继续编辑并保存，或放弃草稿后再快捷修改。")
      : i18n.t("选择状态或优先级即保存，可撤销最近一次修改。")));
  }

  function refreshReader() {
    const reader = byId("task-read-view");
    const returnToRead = byId("task-edit-read");
    returnToRead.hidden = state.editor.kind !== "task" || !state.editor.id || readingTask();
    returnToRead.disabled = isBusy(state) || saveFrozen(state) || !!state.editor.pendingAction;
    byId("merge-conflicts").hidden = readingTask() || state.editor.conflicts.length === 0;
    reader.hidden = !readingTask();
    if (!readingTask()) return;
    taskForm.hidden = true;
    // Hidden forms may still receive synthetic submits. Keep their controls
    // disabled as a second boundary in addition to the submit/mutation guards.
    for (const control of taskForm.querySelectorAll("input, textarea, select, [type=submit]")) control.disabled = true;
    const task = currentTask();
    const project = task && state.projectsById.get(task.projectId);
    const available = task && project && task.origin !== "codex" && !task.readOnly;
    state.editor.availability = available ? "available" : "missing";
    const title = byId("task-read-title");
    i18n.setText(title, fmt(() => available ? task.title : i18n.t("任务已不可用")));
    const notice = byId("task-read-unavailable");
    i18n.setText(notice, fmt(() => !task ? i18n.t("任务已删除或移出当前记录。请关闭详情后重新选择。")
      : !project ? i18n.t("所属项目已不可用。请关闭详情后重新选择。")
        : !available ? i18n.t("这项记录不能作为手工任务编辑。请从原任务入口打开。")
          : task.archivedAt ? i18n.t("任务已归档。这里显示已归档的最新记录。")
            : project.archivedAt ? i18n.t("所属项目已归档。这里显示已归档项目中的最新记录。") : ""));
    notice.hidden = !notice.textContent;
    byId("task-read-record").hidden = !available;
    const edit = byId("task-read-edit");
    edit.disabled = !available || !state.host.connected || !state.host.loaded || isBusy(state) || saveFrozen(state) || !!state.editor.pendingAction;
    byId("task-read-close").disabled = isBusy(state) || saveFrozen(state) || !!state.editor.pendingAction;
    const dirty = retainedDraft();
    byId("task-read-draft").hidden = !dirty;
    i18n.setText(edit, fmt(() => dirty ? i18n.t("继续编辑任务") : i18n.t("编辑任务")));
    if (available) {
      i18n.setText(byId("task-read-project"), fmt(() => `${project.name}${project.archivedAt ? i18n.t("（已归档）") : ""}`));
      const status = byId("task-read-status");
      i18n.setText(status, fmt(() => i18n.t(STATUS_LABELS[task.status])));
      status.className = `status status-${task.status}`;
      const priority = byId("task-read-priority");
      i18n.setText(priority, fmt(() => i18n.t(PRIORITY_LABELS[task.priority || "normal"])));
      priority.className = `priority-${task.priority || "normal"}`;
      i18n.setText(byId("task-read-date"), fmt(() => task.dueDate || i18n.t("未设置")));
      i18n.setText(byId("task-read-step"), fmt(() => task.currentStep || i18n.t("未填写当前步骤")));
      i18n.setText(byId("task-read-blocker"), fmt(() => task.blocker || i18n.t("暂无阻塞项")));
      byId("task-read-blocker").dataset.hasBlocker = String(Boolean(task.blocker));
      i18n.setText(byId("task-read-source"), fmt(() => i18n.t("手工记录 · 来源：{p1}", { p1: task.sourceTool || i18n.t("未填写") })));
      i18n.setText(byId("task-read-updated"), fmt(() => i18n.t("保存更新时间：{p1}", { p1: new Date(task.lastUpdatedAt).toLocaleString(i18n.intlLocale, { hour12: false }) })));
    } else {
      for (const id of ["task-read-project", "task-read-status", "task-read-priority", "task-read-date", "task-read-step", "task-read-blocker", "task-read-source", "task-read-updated"]) i18n.setText(byId(id), "");
    }
    const link = byId("task-read-link");
    const url = available ? task.conversationUrl || "" : "";
    if (link.dataset.conversationUrl !== url) {
      const focusedLink = link.contains(document.activeElement);
      link.replaceChildren(url ? conversationLink(task, "打开已保存的原对话") : element(document, "p", "helper", fmt(() => i18n.t("原对话：未填写"))));
      link.dataset.conversationUrl = url;
      if (focusedLink) (link.querySelector("a") || title).focus({ preventScroll: true });
    }
    // Confirmed reader writes and clean notifications adopt the current record
    // without changing reading mode. Full-editor drafts keep their baseline.
    if (available && !dirty && !state.fieldEdit && !state.writes.save && !state.editor.conflicts.length && !isBusy(state)) {
      mergeRefreshedEditor();
      state.editor.revision = state.board.revision;
    }
    refreshReaderQuick(task, available, dirty);
    // A refresh may remove the focused link or disable the edit control. The
    // reading heading remains a stable focus target within the narrow dialog.
    if (reader.closest("[inert]")) return;
    if (taskForm.contains(document.activeElement) || (document.activeElement === edit && edit.disabled)
      || callbacks.compactEditor() && !byId("editor-panel").contains(document.activeElement)) title.focus({ preventScroll: true });
  }

  function taskMetadata(task) {
    i18n.setText(byId("task-updated"), fmt(() => task ? i18n.t("最后更新：{p1}", { p1: new Date(task.lastUpdatedAt).toLocaleString(i18n.intlLocale, { hour12: false }) }) : i18n.t("保存后记录更新时间。")));
    byId("task-link").replaceChildren(task?.conversationUrl ? conversationLink(task, "打开已保存的原对话") : element(document, "p", "helper", fmt(() => i18n.t("原对话：未填写"))));
    refreshReader();
  }

  function beginEditor(type, id, opener = document.activeElement) {
    const frozenRestore = state.writes.action?.request.operation.type === "restore_board" && slotUncertain(state.writes.action);
    if (!state.host.connected || !state.host.loaded || isBusy(state) || saveFrozen(state) || frozenRestore || state.schedule.draft) return false;
    const sidebarOpener = byId("project-sidebar")?.contains(opener);
    state.editor.returnFocus = sidebarOpener && (callbacks.sidebarDrawer() || byId("project-sidebar").hidden || state.sidebar.collapsed)
      ? byId("sidebar-toggle") : opener?.closest("#project-menu") ? byId("project-menu").querySelector("summary") : opener;
    callbacks.closeSidebar({ returnFocus: false });
    callbacks.closeProjectMenu();
    callbacks.closeFilters({ returnFocus: false });
    callbacks.closeCardMenus();
    state.editor.kind = type;
    state.editor.mode = "edit";
    state.editor.id = id;
    state.editor.revision = state.board.revision;
    state.editor.availability = "available";

    state.writes.save = null;

    state.editor.baseline = null;
    state.editor.conflicts = [];
    renderConflicts();
    if (!state.writes.move) clearFeedback();
    projectForm.hidden = type !== "project";
    taskForm.hidden = type !== "task";
    byId("task-read-view").hidden = true;
    byId("editor-panel").hidden = false;
    i18n.bindFormatAttr(byId("editor-panel"), "aria-label", () => type === "task" ? i18n.t("任务详情") : i18n.t("项目详情"));
    i18n.setText(byId("editor-kind"), fmt(() => type === "task" ? i18n.t("任务详情") : i18n.t("项目详情")));
    byId("workspace").classList.add("has-editor");
    return true;
  }

  function editorValues(record) {
    return Object.fromEntries(EDITOR_FIELDS[state.editor.kind].map(({ key, id }) => [key, record ? record[key] ?? ""
      : state.editor.kind === "task" && state.editor.id && ["status", "priority"].includes(key) && state.editor.baseline ? state.editor.baseline[key] : byId(id).value]));
  }

  function draftSnapshot(values = editorValues()) {
    // Inputs are trimmed by the store. Compare the values that would persist
    // without replacing the user's draft text in the form.
    return JSON.stringify(EDITOR_FIELDS[state.editor.kind].map(({ key }) => typeof values[key] === "string" ? values[key].trim() : values[key]));
  }

  function rememberEditorBaseline() {
    state.editor.baseline = editorValues();
    state.editor.snapshot = draftSnapshot();
  }

  function formatConflictValue(key, value) {
    if (key === "priority") return i18n.t(PRIORITY_LABELS[value] || value);
    if (key === "status") return i18n.t(STATUS_LABELS[value] || value);
    if (key === "projectId") return state.projectsById.get(value)?.name || i18n.t("项目已不可用");
    return value || i18n.t("（未填写）");
  }

  function renderConflicts() {
    const panel = byId("merge-conflicts");
    panel.replaceChildren();
    panel.hidden = state.editor.conflicts.length === 0;
    if (!state.editor.conflicts.length) return;
    panel.append(element(document, "p", "", fmt(() => i18n.t("以下字段在两处都被修改，请选择要保存的值。"))));
    for (const item of state.editor.conflicts) {
      const field = EDITOR_FIELDS[state.editor.kind].find(({ key }) => key === item.key);
      const row = element(document, "section", "merge-conflict");
      row.dataset.conflictField = item.key;
      row.append(element(document, "strong", "", msg(field.label)));
      for (const [side, label, value] of [["local", "保留我的修改", item.local], ["remote", "采用最新记录", item.remote]]) {
        const choice = element(document, "div", "merge-choice");
        choice.append(element(document, "p", "merge-value", fmt(() => `${side === "local" ? i18n.t("我的修改") : i18n.t("最新记录")}：${formatConflictValue(item.key, value)}`)));
        const button = element(document, "button", "quiet", msg(label));
        button.type = "button";
        button.dataset.conflictChoice = side;
        i18n.bindFormatAttr(button, "aria-label", () => `${i18n.t(field.label)}: ${i18n.t(label)}`);
        button.addEventListener("click", () => {
          if (isMutating(state, "save") || isReading(state) || saveFrozen(state) || state.editor.pendingAction) return;
          if (field.key === "projectId") projectOptions(taskProject, false, value, true);
          byId(field.id).value = value;
          state.editor.conflicts = state.editor.conflicts.filter((conflict) => conflict.key !== item.key);
          renderConflicts();
          refreshControls();
          byId(field.id).focus();
        });
        choice.append(button);
        row.append(choice);
      }
      panel.append(row);
    }
  }

  function mergeRefreshedEditor() {
    if (!state.editor.kind || !state.editor.baseline || saveFrozen(state)) return;
    const record = state.editor.id ? (state.editor.kind === "task" ? state.board.tasks : state.board.projects).find((item) => item.id === state.editor.id) : null;
    if (state.editor.id && !record) {
      state.editor.availability = "missing";
      reportError("正在编辑的记录已不可用。输入已保留，请关闭详情后重新选择。");
      return;
    }
    if (record) {
      const remote = editorValues(record);
      const local = editorValues();
      const merged = mergeEditorFields(state.editor.baseline, local, remote);
      for (const prior of state.editor.conflicts) {
        if (!merged.conflicts.some(({ key }) => key === prior.key) && String(local[prior.key]).trim() !== String(remote[prior.key]).trim()) {
          merged.conflicts.push({ key: prior.key, local: local[prior.key], remote: remote[prior.key] });
        }
      }
      if (state.editor.kind === "task") projectOptions(taskProject, false, merged.values.projectId, true);
      for (const { key, id } of EDITOR_FIELDS[state.editor.kind]) byId(id).value = merged.values[key];
      state.editor.conflicts = merged.conflicts;
      state.editor.baseline = remote;
      state.editor.snapshot = draftSnapshot(remote);
    }
    state.editor.availability = "available";
    renderConflicts();
  }

  function changeEditor(proceed) {
    if (isMutating(state, "save") || saveFrozen(state) || (isMutating(state, "move") || isMutating(state, "action"))) return;
    if (state.editor.kind && draftSnapshot() !== state.editor.snapshot) {
      state.editor.pendingAction = proceed;
      byId("discard-dialog").hidden = false;
      refreshControls();
      byId("keep-editing").focus();
      return;
    }
    proceed();
  }

  function openProject(project) {
    if (state.schedule.draft) return callbacks.changeSchedule(() => openProject(project));
    const opener = state.sidebar.editorOpener || document.activeElement;
    changeEditor(() => {
      if (project) {
        project = state.board.projects.find((item) => item.id === project.id);
        if (!project) return reportError("项目已变更，请刷新记录后重新选择。");
      }
      if (!beginEditor("project", project?.id, opener)) return;
      i18n.setText(byId("project-editor-title"), fmt(() => project ? i18n.t("编辑项目") : i18n.t("新建项目")));
      byId("project-name").value = project?.name || "";
      byId("project-description-input").value = project?.description || "";
      rememberEditorBaseline();
      render();
      byId("project-name").focus();
    });
  }

  function openTask(task, initialStatus = "planned") {
    if (task?.origin === "codex" || task?.readOnly || !task && !callbacks.canCreateManualTask() || !Object.hasOwn(STATUS_LABELS, initialStatus)) return;
    if (state.schedule.draft) return callbacks.changeSchedule(() => openTask(task, initialStatus));
    changeEditor(() => {
      if (task) {
        task = state.board.tasks.find((item) => item.id === task.id);
        if (!task) return reportError("任务已变更，请刷新记录后重新选择。");
      }
      if (state.board.projects.length === 0 || !beginEditor("task", task?.id)) return;
      i18n.setText(byId("task-editor-title"), fmt(() => task ? i18n.t("编辑任务") : i18n.t("新建任务")));
      const targetProjectId = task?.projectId || (state.projectsById.has(projectFilter.value) && !state.projectsById.get(projectFilter.value).archivedAt ? projectFilter.value : state.board.projects.find((project) => !project.archivedAt)?.id || state.board.projects[0].id);
      // Include the record's actual project before assigning the select value;
      // archived projects are normally excluded from choices for a new task.
      projectOptions(taskProject, false, targetProjectId, true);
      taskProject.value = targetProjectId;
      byId("task-title").value = task?.title || "";
      byId("task-status").value = task?.status || initialStatus;
      byId("task-priority").value = task?.priority || "normal";
      for (const id of ["task-status", "task-priority"]) byId(id).closest("label").hidden = !!task;
      byId("task-due-date").value = task?.dueDate || "";
      byId("task-source").value = task?.sourceTool || "";
      byId("task-step").value = task?.currentStep || "";
      byId("task-blocker").value = task?.blocker || "";
      byId("task-conversation").value = task?.conversationUrl || "";
      rememberEditorBaseline();
      state.editor.mode = task ? "read" : "edit";
      render();
      byId(task ? "task-read-title" : "task-title").focus();
    });
  }

  function editTask() {
    if (!readingTask() || isBusy(state) || saveFrozen(state) || state.editor.pendingAction || !state.host.connected || !state.host.loaded) return;
    refreshReader();
    if (state.editor.availability !== "available") return;
    // A clean reader enters editing from the latest record. A retained draft
    // keeps its original revision and baseline so normal conflict protection
    // still applies when a notification arrived while the reader was open.
    if (!state.writes.save && !state.editor.conflicts.length && draftSnapshot() === state.editor.snapshot) {
      mergeRefreshedEditor();
      state.editor.revision = state.board.revision;
    }
    state.editor.mode = "edit";
    taskForm.hidden = false;
    i18n.setText(byId("task-editor-title"), fmt(() => i18n.t("编辑任务")));
    refreshControls();
    byId("task-title").focus();
  }

  function readTask() {
    if (state.editor.kind !== "task" || !state.editor.id || isBusy(state) || saveFrozen(state) || state.editor.pendingAction) return;
    state.editor.mode = "read";
    refreshControls();
    byId("task-read-title").focus();
  }

  function closeEditor() {
    if (isMutating(state, "save") || saveFrozen(state)) return;
    const previousId = state.editor.id;
    const returnFocus = state.editor.returnFocus;
    state.editor.kind = null;
    state.editor.mode = undefined;
    state.editor.id = undefined;
    state.writes.save = null;
    state.editor.availability = "available";
    state.editor.conflicts = [];
    state.editor.baseline = null;

    renderConflicts();
    projectForm.hidden = true;
    taskForm.hidden = true;
    byId("task-read-view").hidden = true;
    byId("editor-panel").hidden = true;
    byId("workspace").classList.remove("has-editor");
    byId("discard-dialog").hidden = true;
    state.editor.pendingAction = null;
    render();
    if (state.presentation.surface !== "tasks") return;
    const candidates = [document.querySelector(`[data-edit-task="${previousId}"]`), returnFocus, byId("sidebar-toggle"), byId("new-task"), byId("search")];
    candidates.find(callbacks.isVisibleControl)?.focus({ preventScroll: true });
  }

  function operationFromEditor() {
    if (readingTask()) throw new Error("请先点击编辑任务，再保存修改。");
    if (state.editor.kind === "project") {
      const name = byId("project-name").value.trim();
      if (!name || name.length > 120) throw new Error("项目名称必填，最多 120 个字。");
      const description = byId("project-description-input").value;
      if (description.length > 4000) throw new Error("项目说明最多 4000 个字。");
      return { type: "save_project", project: { ...(state.editor.id ? { id: state.editor.id } : {}), name, description } };
    }
    const title = byId("task-title").value.trim();
    const sourceTool = byId("task-source").value.trim();
    const currentStep = byId("task-step").value;
    const blocker = byId("task-blocker").value;
    const status = state.editor.id ? state.editor.baseline.status : byId("task-status").value;
    const priority = state.editor.id ? state.editor.baseline.priority : byId("task-priority").value;
    const dueDate = byId("task-due-date").value || null;
    if (!Object.hasOwn(PRIORITY_LABELS, priority)) throw new Error("请选择有效的优先级。");
    if (!dueDateSchema.safeParse(dueDate).success) throw new Error("请选择有效的截止日期。");
    if (!title || title.length > 200) throw new Error("任务名称必填，最多 200 个字。");
    if (!state.board.projects.some((project) => project.id === taskProject.value)) throw new Error("请选择已保存的项目。");
    if (!Object.hasOwn(STATUS_LABELS, status)) throw new Error("请选择任务状态。");
    if (sourceTool.length > 120 || currentStep.length > 4000 || blocker.length > 4000) throw new Error("来源工具最多 120 个字，当前步骤与阻塞项最多 4000 个字。");
    const conversationUrl = byId("task-conversation").value.trim() || null;
    if (conversationUrl && !isSafeConversationUrl(conversationUrl)) throw new Error("原对话链接请使用安全的 http、https 地址或有效的 Codex 原任务链接，最多 2048 个字符。");
    return { type: "save_task", task: { ...(state.editor.id ? { id: state.editor.id } : {}), projectId: taskProject.value, title, status, priority, dueDate, sourceTool, currentStep, blocker, conversationUrl } };
  }

  function savedEntityId(payload, operation) {
    const taskOperation = operation.type === "save_task";
    const input = taskOperation ? operation.task : operation.project;
    const records = taskOperation ? state.board.tasks : state.board.projects;
    const confirmed = payload.entityId || input.id;
    if (confirmed && records.some((record) => record.id === confirmed)) return confirmed;
    // Old hosts may not return the entity id. Never guess among simultaneous creations.
    const added = records.filter((record) => !state.writes.save?.knownIds?.has(record.id));
    if (added.length !== 1) return null;
    const candidate = added[0];
    return Object.entries(input).every(([key, value]) => candidate[key] === (typeof value === "string" ? value.trim() : value)) ? candidate.id : null;
  }

  function bindEditor() {
    for (const form of [projectForm, taskForm]) {
      form.addEventListener("submit", (event) => {
        if (readingTask()) { event.preventDefault(); return; }
        return callbacks.save(event);
      });
      form.addEventListener("input", refreshControls);
      form.addEventListener("change", refreshControls);
    }
    byId("task-read-edit").addEventListener("click", editTask);
    byId("task-edit-read").addEventListener("click", readTask);
    for (const button of document.querySelectorAll("[data-cancel]")) button.addEventListener("click", () => changeEditor(closeEditor));
    byId("editor-close").addEventListener("click", () => changeEditor(closeEditor));
    byId("keep-editing").addEventListener("click", () => {
      state.editor.pendingAction = null;
      byId("discard-dialog").hidden = true;
      if (readingTask()) {
        if (state.editor.availability === "available") editTask();
        else { refreshControls(); byId("task-read-title").focus(); }
        return;
      }
      refreshControls();
      byId(state.editor.kind === "project" ? "project-name" : "task-title").focus();
    });
    byId("discard-edits").addEventListener("click", () => {
      if (!state.editor.pendingAction || isMutating(state, "save") || saveFrozen(state)) return;
      const proceed = state.editor.pendingAction;
      state.editor.pendingAction = null;
      byId("discard-dialog").hidden = true;
      proceed();
    });
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented) return;
      if (event.key === "Tab") {
        const scope = state.editor.pendingAction ? byId("discard-dialog") : state.schedule.pendingAction ? byId("schedule-discard-dialog") : callbacks.compactEditor() ? byId("editor-panel") : callbacks.compactSchedule() ? byId("schedule-panel") : callbacks.sidebarDrawer() ? byId("project-sidebar") : null;
        if (scope) {
          const focusable = [...scope.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter(callbacks.isVisibleControl);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (first && (!focusable.includes(document.activeElement) || (!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first))) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          }
        }
        return;
      }
      if (event.key !== "Escape") return;
      if (callbacks.sidebarDrawer()) { event.preventDefault(); callbacks.closeSidebar(); return; }
      if (state.presentation.surface && state.presentation.surface !== "tasks") return;
      if (!state.editor.kind) return;
      event.preventDefault();
      if (state.editor.pendingAction) byId("keep-editing").click(); else changeEditor(closeEditor);
    });
    document.defaultView.addEventListener("resize", callbacks.refreshAccessibility);
  }

  return { bindEditor, taskMetadata, refreshReader, canReadQuick, editTask, readTask, beginEditor, editorValues, draftSnapshot, rememberEditorBaseline, formatConflictValue, renderConflicts, mergeRefreshedEditor, changeEditor, openProject, openTask, closeEditor, operationFromEditor, savedEntityId };
}
