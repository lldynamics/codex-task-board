import { i18nFor, msg, fmt } from "./i18n.mjs";
import { isMutating, isReading, isDataBusy, isBusy, saveFrozen, saveNeedsRefresh, slotUncertain, slotNeedsRefresh, hasExpiredWrites, expiredNeedsRefresh, expiredReviewed, canRetrySlot } from "./write-state.mjs";

export function createFeedback(context) {
  const { document, state, options, refs, callbacks } = context;
  const i18n = i18nFor(document);
  const { byId, projectFilter, projectForm, taskForm, message } = refs;

  function reportError(text) {
    callbacks.cancelSuccess();
    state.feedback.error = typeof text === "string" && text ? msg(text) : text;
    presentError();
    i18n.setText(message, "");
    callbacks.updateEditorSaveStatus();
  }

  function presentError() {
    const inside = state.schedule.draft ? "schedule-error" : state.editor.kind && !byId("editor-panel").hidden ? "editor-error" : "data-error";
    for (const id of ["data-error", "editor-error", "schedule-error"]) {
      const active = id === inside;
      i18n.setText(byId(id), active ? state.feedback.error : "");
      byId(id).hidden = !active || !state.feedback.error;
    }
  }

  function clearFeedback() {
    callbacks.cancelSuccess();
    state.feedback.error = "";
    presentError();
    i18n.setText(message, "");
  }

  function compactEditor() {
    return state.presentation.surface === "tasks" && !byId("manual-board")?.hidden && !!state.editor.kind && !byId("editor-panel").hidden && document.defaultView.innerWidth <= 800;
  }

  function refreshAccessibility() {
    const sessionModal = callbacks.compactSchedule();
    const modal = compactEditor() || sessionModal;
    const deciding = !!state.editor.pendingAction || !!state.schedule.pendingAction;
    const manualVisible = state.presentation.surface === "tasks" && !byId("manual-board")?.hidden;
    callbacks.refreshSidebarControls();
    callbacks.refreshScheduleControls();
    const hiddenSidebarFocus = callbacks.syncSidebarVisibility();
    const drawer = callbacks.sidebarDrawer();
    const surfaceBlocked = drawer || manualVisible && (modal || deciding);
    document.querySelector(".surface-tabs")?.toggleAttribute("inert", surfaceBlocked);
    byId("manual-tab").disabled = surfaceBlocked;
    byId("codex-tab").disabled = modal || deciding;
    callbacks.syncMenus();
    for (const node of document.querySelectorAll(".app-header, .toolbar, .workbench-status, .filter-summary, .feedback, .data-panel, .board-area, .app-footer, .codex-panel")) node.toggleAttribute("inert", modal || deciding || drawer);
    document.querySelector(".app-main")?.toggleAttribute("inert", drawer);
    byId("project-sidebar")?.toggleAttribute("inert", modal || deciding);
    for (const form of [projectForm, taskForm]) form.toggleAttribute("inert", deciding);
    byId("task-read-view")?.toggleAttribute("inert", deciding);
    byId("session-form").toggleAttribute("inert", deciding);
    byId("schedule-close").closest(".editor-panel-header").toggleAttribute("inert", deciding);
    byId("schedule-review").toggleAttribute("inert", deciding);
    byId("editor-close").closest(".editor-panel-header").toggleAttribute("inert", deciding);
    byId("move-feedback").toggleAttribute("inert", deciding);
    byId("action-feedback").toggleAttribute("inert", deciding);
    byId("expired-feedback").toggleAttribute("inert", deciding);
    byId("merge-conflicts").toggleAttribute("inert", deciding);
    byId("discard-dialog").toggleAttribute("aria-modal", manualVisible && deciding);
    if (manualVisible && deciding) byId("discard-dialog").setAttribute("aria-modal", "true");
    byId("schedule-discard-dialog").toggleAttribute("aria-modal", manualVisible && !!state.schedule.pendingAction);
    if (manualVisible && state.schedule.pendingAction) byId("schedule-discard-dialog").setAttribute("aria-modal", "true");
    if (sessionModal && !deciding) { byId("schedule-panel").setAttribute("role", "dialog"); byId("schedule-panel").setAttribute("aria-modal", "true"); }
    else { byId("schedule-panel").removeAttribute("role"); byId("schedule-panel").removeAttribute("aria-modal"); }
    if (compactEditor() && !deciding) {
      byId("editor-panel").setAttribute("role", "dialog");
      byId("editor-panel").setAttribute("aria-modal", "true");
    } else {
      byId("editor-panel").removeAttribute("role");
      byId("editor-panel").removeAttribute("aria-modal");
    }
    const scope = state.schedule.pendingAction ? byId("schedule-discard-dialog") : deciding ? byId("discard-dialog") : sessionModal ? byId("schedule-panel") : modal ? byId("editor-panel") : drawer ? byId("project-sidebar") : null;
    if (byId("manual-board")?.hidden) return;
    if (scope && !scope.contains(document.activeElement) && sessionModal && !deciding) {
      const target = byId(state.schedule.draft.kind === "feedback" ? "session-outcome" : state.schedule.draft.id ? "session-date" : "session-task");
      (callbacks.isVisibleControl(target) ? target : [...scope.querySelectorAll("button, input, select, textarea")].find(callbacks.isVisibleControl))?.focus();
    }
    else if (scope && !scope.contains(document.activeElement)) byId(state.schedule.pendingAction ? "schedule-keep-editing" : deciding ? "keep-editing" : sessionModal ? state.schedule.draft.kind === "feedback" ? "session-outcome" : "session-task" : modal ? state.editor.kind === "project" ? "project-name" : state.editor.mode === "read" ? "task-read-title" : "task-title" : "sidebar-close")?.focus();
    else if (!scope && hiddenSidebarFocus && callbacks.isVisibleControl(byId("sidebar-toggle"))) byId("sidebar-toggle").focus({ preventScroll: true });
  }

  function refreshControls() {
    const frozenRestore = state.writes.action?.request.operation.type === "restore_board" && slotUncertain(state.writes.action);
    const editable = state.host.connected && state.host.loaded && !isBusy(state) && !frozenRestore;
    byId("new-project").disabled = !editable || saveFrozen(state) || !!state.schedule.draft;
    byId("edit-project").disabled = !editable || saveFrozen(state) || !!state.schedule.draft || !state.projectsById.has(projectFilter.value);
    byId("new-task").disabled = !editable || !callbacks.canCreateManualTask() || saveFrozen(state) || !!state.schedule.draft || !state.board.projects.some((project) => !project.archivedAt);
    const selectedProject = state.projectsById.get(projectFilter.value);
    byId("archive-project").disabled = !canMove() || !selectedProject || !!state.editor.kind;
    i18n.setText(byId("archive-project"), fmt(() => selectedProject?.archivedAt ? i18n.t("恢复") : i18n.t("归档")));
    i18n.bindFormatAttr(byId("archive-project"), "aria-label", () => selectedProject?.archivedAt ? i18n.t("恢复项目") : i18n.t("归档项目"));
    i18n.bindFormatAttr(byId("archive-project"), "title", () => selectedProject?.archivedAt ? i18n.t("恢复项目") : i18n.t("归档项目"));
    for (const id of ["refresh", "editor-refresh"]) {
      const button = byId(id);
      button.disabled = !state.host.connected || isMutating(state, "save") || isReading(state) || (isMutating(state, "move") || isMutating(state, "action")) || isDataBusy(state) || !!state.editor.pendingAction || !!state.schedule.pendingAction;
      const label = isReading(state) ? "正在刷新…" : id === "editor-refresh" ? "刷新当前记录" : "刷新记录";
      const text = button.querySelector(".refresh-label") || button.querySelector("span:not(.icon)");
      if (text) i18n.setText(text, fmt(() => isReading(state) ? i18n.t("正在刷新…") : id === "editor-refresh" ? i18n.t("刷新") : i18n.t("刷新记录")));
      i18n.bindAttr(button, "aria-label", label);
      i18n.bindAttr(button, "title", label);
    }
    for (const form of [projectForm, taskForm]) {
      for (const input of form.querySelectorAll("input, textarea, select")) input.disabled = !editable || saveFrozen(state);
      form.querySelector('[type="submit"]').disabled = !editable || saveNeedsRefresh(state) || state.editor.conflicts.length > 0 || !!state.writes.move || !!state.writes.action || hasExpiredWrites(state) || !!state.editor.pendingAction || !!state.schedule.pendingAction
        || !!state.editor.id && !saveFrozen(state) && callbacks.draftSnapshot() === state.editor.snapshot;
      i18n.setText(form.querySelector('[type="submit"]'), fmt(() => isMutating(state, "save") ? i18n.t("正在保存…") : saveFrozen(state) ? i18n.t("重试确认保存") : i18n.t("保存到本机")));
      form.querySelector('[data-cancel]').disabled = isMutating(state, "save") || saveFrozen(state);
      form.setAttribute("aria-busy", String(isMutating(state, "save")));
    }
    for (const button of document.querySelectorAll("[data-edit-task]")) button.disabled = !editable || saveFrozen(state) || !!state.schedule.draft;
    byId("editor-close").disabled = isMutating(state, "save") || saveFrozen(state);
    byId("discard-edits").disabled = isMutating(state, "save") || saveFrozen(state);
    const moveFeedback = byId("move-feedback");
    const editorNotices = state.schedule.draft ? byId("schedule-notices") : byId("merge-conflicts").parentElement;
    const insertNotice = (node) => editorNotices === byId("schedule-notices") ? editorNotices.prepend(node) : editorNotices.insertBefore(node, byId("merge-conflicts"));
    // Keep a single retry control and request state, reachable inside the modal
    // drawer as well as on the board. Moving a node preserves its listeners.
    if (state.schedule.draft || state.editor.kind && !byId("editor-panel").hidden) {
      if (moveFeedback.parentElement !== editorNotices) insertNotice(moveFeedback);
    } else if (moveFeedback.parentElement !== document.querySelector(".feedback")) document.querySelector(".feedback").append(moveFeedback);
    moveFeedback.hidden = !state.writes.move;
    byId("move-retry").disabled = !state.host.connected || isBusy(state) || !canRetrySlot(state.writes.move) || hasExpiredWrites(state) || !!state.editor.pendingAction || !!state.schedule.pendingAction;
    i18n.setText(byId("move-retry"), fmt(() => (isMutating(state, "move") || isMutating(state, "action")) ? i18n.t("正在移动…") : slotUncertain(state.writes.move) ? i18n.t("重试确认移动") : i18n.t("重试移动")));
    byId("move-dismiss").disabled = (isMutating(state, "move") || isMutating(state, "action")) || !!slotUncertain(state.writes.move) || !!state.editor.pendingAction || !!state.schedule.pendingAction;
    for (const control of document.querySelectorAll("[data-move-control]")) control.disabled = !canMove() || control.dataset.boundary === "true" || control.dataset.moveControl === "status" && !!state.editor.kind;
    for (const card of document.querySelectorAll(".task-card")) card.draggable = card.dataset.origin !== "codex" && canMove() && card.dataset.archived !== "true";
    for (const button of document.querySelectorAll(".add-task")) button.disabled = !editable || !callbacks.canCreateManualTask() || saveFrozen(state) || !!state.schedule.draft || !state.board.projects.some((project) => !project.archivedAt);
    for (const button of document.querySelectorAll("[data-page-control]")) button.disabled = !canPage() || button.dataset.boundary === "true";
    for (const button of document.querySelectorAll("[data-archive-task]")) button.disabled = !canMove() || !!state.editor.kind;
    for (const button of document.querySelectorAll("[data-focus-task]")) button.disabled = !canMove() || !!state.editor.kind || !callbacks.isFocusEligible(button.dataset.focusTask);
    i18n.setText(byId("notice"), fmt(() => state.host.connected
      ? i18n.t("手工任务点击保存后写入本机；Codex 自动项目与任务单独采集、只读展示，不进入手工备份。其他 AI 工具尚未同步。")
      : i18n.t("组件预览或连接尚未完成，当前不能本机保存。Codex 自动任务只读展示；其他 AI 工具尚未同步。")));
    for (const id of ["action-feedback", "expired-feedback"]) {
      const node = byId(id);
      const parent = (state.schedule.draft || state.editor.kind && !byId("editor-panel").hidden) ? editorNotices : document.querySelector(".feedback");
      if (node.parentElement !== parent) parent === editorNotices ? insertNotice(node) : parent.append(node);
    }
    byId("action-feedback").hidden = !state.writes.action;
    byId("action-retry").disabled = !state.host.connected || isBusy(state) || !canRetrySlot(state.writes.action) || hasExpiredWrites(state) || !!state.editor.pendingAction || !!state.schedule.pendingAction;
    i18n.setText(byId("action-retry"), fmt(() => (isMutating(state, "move") || isMutating(state, "action")) ? i18n.t("正在保存…") : slotUncertain(state.writes.action) ? i18n.t("重试确认操作") : slotNeedsRefresh(state.writes.action) ? i18n.t("重新预览恢复") : i18n.t("重试操作")));
    // Restore conflicts require a fresh preview, which supplies a fresh CAS revision.
    if (slotNeedsRefresh(state.writes.action) && state.writes.action.request.operation.type === "restore_board") byId("action-retry").disabled = !state.host.connected || isBusy(state) || !!state.editor.kind || !!state.editor.pendingAction || hasExpiredWrites(state);
    if (callbacks.ownQuickAction()) byId("action-retry").disabled = !callbacks.canSaveQuick();
    if (callbacks.ownScheduleAction()) byId("action-retry").disabled = !callbacks.canSaveSchedule();
    byId("action-dismiss").disabled = (isMutating(state, "move") || isMutating(state, "action")) || !!slotUncertain(state.writes.action) || !!state.editor.pendingAction || !!state.schedule.pendingAction;
    const hasExpired = hasExpiredWrites(state);
    byId("expired-feedback").hidden = !hasExpired;
    byId("expired-reviewed").checked = hasExpired && expiredReviewed(state);
    byId("expired-reviewed").disabled = !!hasExpired && expiredNeedsRefresh(state);
    byId("expired-end").disabled = !hasExpired || !expiredReviewed(state) || isBusy(state);
    byId("data-export").disabled = !options.data || !state.host.connected || !state.host.loaded || isDataBusy(state) || isMutating(state, "save") || (isMutating(state, "move") || isMutating(state, "action")) || isReading(state);
    byId("data-file").disabled = !options.data || !editable || saveFrozen(state) || !!state.writes.move || !!state.writes.action || hasExpiredWrites(state) || !!state.editor.kind || !!state.schedule.draft || !!state.fieldEdit;
    byId("restore-confirm").disabled = !options.data || !state.backup.preview || !editable || saveFrozen(state) || !!state.writes.move || !!state.writes.action || hasExpiredWrites(state) || !!state.editor.kind || !!state.schedule.draft || !!state.fieldEdit;
    byId("restore-cancel").disabled = (isMutating(state, "move") || isMutating(state, "action")) || !!slotUncertain(state.writes.action);
    for (const button of byId("merge-conflicts").querySelectorAll("button")) button.disabled = !editable || saveFrozen(state) || !!state.editor.pendingAction || !!state.schedule.pendingAction;
    presentError();
    refreshAccessibility();
    callbacks.updateEditorSaveStatus();
    callbacks.refreshQuickControls();
  }

  function canPage() {
    return !isBusy(state) && !saveFrozen(state) && !state.writes.move && !state.writes.action && !state.editor.pendingAction;
  }

  function canMove() {
    return state.host.connected && state.host.loaded && !isBusy(state) && !saveFrozen(state) && !hasExpiredWrites(state) && !state.writes.move && !state.writes.action && !state.editor.pendingAction && !state.schedule.pendingAction && !state.schedule.draft && !state.fieldEdit;
  }

  return { reportError, presentError, clearFeedback, compactEditor, refreshAccessibility, refreshControls, canPage, canMove };
}
