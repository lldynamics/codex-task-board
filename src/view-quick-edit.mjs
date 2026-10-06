import { i18nFor, msg, fmt } from "./i18n.mjs";
import { STATUS_LABELS, PRIORITY_LABELS, COLUMN_ORDER, element } from "./view-common.mjs";
import { isBusy, slotUncertain, slotExpired, slotNeedsRefresh, canRetrySlot, hasExpiredWrites } from "./write-state.mjs";

const fields = ["status", "priority"];
const labelsFor = (field) => field === "status" ? STATUS_LABELS : PRIORITY_LABELS;
const fieldLabel = (field) => field === "status" ? "状态" : "优先级";

export function createQuickEdit({ document, state, options, refs, callbacks }) {
  const i18n = i18nFor(document);
  const { byId } = refs;
  let expandedBoardTaskId = null;
  const ownAction = () => !!state.fieldEdit && state.writes.action?.request.operation.type === "patch_task"
    && state.writes.action.request.operation.taskId === state.fieldEdit.taskId;
  const target = (taskId) => state.board.tasks.find((task) => task.id === taskId);
  const reviewAvailable = () => available(target(state.fieldEdit?.taskId)) && (!state.fieldEdit.undo || target(state.fieldEdit.taskId)[state.fieldEdit.field] === state.fieldEdit.before);
  const available = (task) => !!task && task.origin !== "codex" && !task.readOnly && state.projectsById.has(task.projectId) && !callbacks.isArchived(task);
  const permittedSurface = (taskId, surface) => surface === "reader" ? !!callbacks.canReadQuick?.(taskId) : !state.editor.kind;
  const idle = () => state.presentation.surface === "tasks" && state.host.connected && state.host.loaded && !!options.mutate && !isBusy(state) && !state.editor.pendingAction && !state.schedule.pendingAction
    && !state.schedule.draft && !state.writes.save && !state.writes.move && !hasExpiredWrites(state) && !state.backup.preview;

  function canStageQuick(taskId, surface = "board") {
    return idle() && !state.fieldEdit && !state.writes.action && permittedSurface(taskId, surface) && available(target(taskId));
  }

  function canSaveQuick() {
    if (!state.fieldEdit || !idle()) return false;
    // Receipt replay is permitted even when later records archive/delete the task.
    if (ownAction()) return canRetrySlot(state.writes.action);
    return !state.writes.action && state.fieldEdit.reviewed && !state.fieldEdit.conflict && reviewAvailable();
  }

  function stageQuick(taskId, field, value, surface = "board") {
    if (!fields.includes(field) || !Object.hasOwn(labelsFor(field), value) || !canStageQuick(taskId, surface)) return false;
    const task = target(taskId);
    if (task[field] === value) { refreshQuickControls(); return true; }
    state.fieldUndo = null;
    state.fieldEdit = { taskId, field, value, before: task[field], title: task.title, surface, revision: state.board.revision, reviewed: true, conflict: null, undo: false };
    return saveQuick();
  }

  function saveQuick() {
    if (!canSaveQuick()) return;
    if (ownAction()) return callbacks.retryAction();
    const edit = state.fieldEdit;
    return callbacks.startQuickAction({ type: "patch_task", taskId: edit.taskId, patch: { [edit.field]: edit.value } }, edit.revision);
  }

  function cancelQuick() {
    if (!state.fieldEdit || isBusy(state) || ownAction() && slotUncertain(state.writes.action) || state.editor.pendingAction) return;
    const edit = state.fieldEdit;
    const restoreFocus = document.querySelector(".field-save-notice")?.contains(document.activeElement);
    if (ownAction()) state.writes.action = null;
    state.fieldEdit = null;
    callbacks.clearFeedback();
    callbacks.render();
    if (restoreFocus) restoreQuickFocus(edit);
  }

  function mergeRefreshedQuick() {
    const edit = state.fieldEdit;
    if (!edit || ownAction() && slotUncertain(state.writes.action)) return false;
    const task = target(edit.taskId);
    edit.reviewed = true;
    edit.revision = state.board.revision;
    edit.conflict = available(task) && task[edit.field] !== edit.before && task[edit.field] !== edit.value
      ? { local: edit.value, remote: task[edit.field] } : null;
    if (available(task) && task[edit.field] === edit.value) state.fieldEdit = null;
    return true;
  }

  function resolveQuick(side) {
    const edit = state.fieldEdit;
    if (!edit || !idle() || state.writes.action || !edit.conflict || !available(target(edit.taskId))) return;
    if (side === "remote") return cancelQuick();
    if (side !== "local" || edit.undo) return;
    // Recheck the observed record when confirming; a later race is still CAS guarded.
    edit.before = target(edit.taskId)[edit.field];
    edit.conflict = null;
    return saveQuick();
  }

  function confirmQuick() {
    const edit = state.fieldEdit;
    if (!edit) return;
    state.fieldUndo = edit.undo ? null : { taskId: edit.taskId, field: edit.field, before: edit.before, value: edit.value, title: edit.title, surface: edit.surface };
    state.fieldEdit = null;
  }

  function canUndoQuick() {
    const undo = state.fieldUndo;
    return !!undo && idle() && !state.writes.action && !state.fieldEdit && available(target(undo.taskId))
      && target(undo.taskId)[undo.field] === undo.value && (!state.editor.kind || callbacks.canReadQuick?.(undo.taskId));
  }

  function undoQuick() {
    if (!canUndoQuick()) return;
    const undo = state.fieldUndo;
    state.fieldEdit = { ...undo, before: undo.value, value: undo.before, surface: state.editor.kind ? "reader" : "board", revision: state.board.revision, reviewed: true, conflict: null, undo: true };
    state.fieldUndo = null;
    return saveQuick();
  }

  function restoreQuickFocus(edit) {
    if (!edit || state.presentation.surface !== "tasks") return;
    const controls = [...document.querySelectorAll("[data-quick-task]")].find((node) => node.dataset.quickTask === edit.taskId && node.dataset.quickSurface === edit.surface);
    const control = controls?.querySelector(`[data-quick-field="${edit.field}"]`);
    if (control && !control.disabled && callbacks.isVisibleControl(control)) control.focus({ preventScroll: true });
    else if (state.editor.kind === "task" && state.editor.mode === "read") byId("task-read-title")?.focus({ preventScroll: true });
    else {
      const card = document.querySelector(`[data-task-id="${edit.taskId}"]`);
      const fallback = edit.surface === "menu" ? card?.querySelector('[data-move-control="status"]') : card?.querySelector("[data-edit-task]");
      if (callbacks.isVisibleControl(fallback)) fallback.focus({ preventScroll: true });
    }
  }

  function quickText(taskId) {
    if (state.fieldEdit?.taskId !== taskId) return "";
    const slot = ownAction() ? state.writes.action : null;
    if (slotExpired(slot)) return "请求已过期，请刷新并核对后结束重试。";
    if (isBusy(state)) return "正在保存…";
    if (slotUncertain(slot)) return "保存结果需确认，请重试原请求。";
    if (slotNeedsRefresh(slot)) return "记录已变更，请刷新并核对。";
    if (!available(target(taskId))) return "任务或项目已不可用，不能保存这次选择。";
    if (state.fieldEdit.undo && !reviewAvailable()) return "该字段已被再次修改，不能撤销；请结束这次选择。";
    if (slot) return "保存未完成，请重试原请求。";
    return state.fieldEdit.conflict ? "相同字段已变更，请确认保留的值。" : "已刷新最新记录，请确认这次选择。";
  }

  function renderQuickControls(task, { surface = "board" } = {}) {
    const controls = element(document, "div", "quick-task-controls");
    controls.dataset.quickTask = task.id; controls.dataset.quickSurface = surface;
    for (const field of fields) {
      const label = element(document, "label", "", msg(fieldLabel(field)));
      const select = element(document, "select"); select.dataset.quickField = field;
      if (surface === "reader") select.id = `task-read-quick-${field}`;
      i18n.bindFormatAttr(select, "aria-label", () => i18n.t("{p1}：{p2}（选择即保存）", { p1: task.title, p2: i18n.t(fieldLabel(field)) }));
      for (const value of field === "status" ? COLUMN_ORDER : Object.keys(PRIORITY_LABELS)) {
        const option = element(document, "option", "", msg(labelsFor(field)[value])); option.value = value; select.append(option);
      }
      select.value = task[field];
      select.addEventListener("change", () => { if (!stageQuick(task.id, field, select.value, surface)) refreshQuickControls(); });
      label.append(select); controls.append(label);
    }
    const status = element(document, "span", "quick-save-state"); status.setAttribute("role", "status"); controls.append(status);
    if (surface !== "board") return controls;
    const wrapper = element(document, "div", "list-quick-edit");
    const toggle = element(document, "button", "quiet list-quick-toggle", fmt(() => i18n.t("编辑"))); toggle.type = "button"; toggle.dataset.quickToggle = task.id;
    controls.dataset.quickPanel = task.id; controls.id = `list-quick-panel-${task.id}`;
    toggle.setAttribute("aria-controls", controls.id);
    toggle.addEventListener("click", () => {
      const opening = expandedBoardTaskId !== task.id;
      expandedBoardTaskId = opening ? task.id : null;
      refreshQuickControls();
      if (opening) controls.querySelector("select:not(:disabled)")?.focus({ preventScroll: true }); else toggle.focus({ preventScroll: true });
    });
    controls.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      expandedBoardTaskId = null; refreshQuickControls(); toggle.focus({ preventScroll: true }); event.preventDefault(); event.stopPropagation();
    });
    wrapper.append(toggle, controls); return wrapper;
  }

  function refreshFieldNotice() {
    let notice = document.querySelector(".field-save-notice");
    const edit = state.fieldEdit, undo = state.fieldUndo;
    if (!edit && !undo) { notice?.remove(); return; }
    if (!notice) { notice = element(document, "section", "field-save-notice"); notice.setAttribute("role", "status"); }
    const hadFocus = notice.contains(document.activeElement);
    const action = document.activeElement?.dataset.fieldAction;
    notice.replaceChildren(element(document, "span", "", fmt(() => edit ? i18n.t("pagination.action", { label: edit.title, action: i18n.t(quickText(edit.taskId)) }) : i18n.t("{p1}：{p2}已保存为{p3}。", { p1: undo.title, p2: i18n.t(fieldLabel(undo.field)), p3: i18n.t(labelsFor(undo.field)[undo.value]) }))));
    const add = (key, text, fn, disabled = false) => {
      const button = element(document, "button", "quiet", typeof text === "string" ? msg(text) : text); button.type = "button"; button.dataset.fieldAction = key; button.disabled = disabled; button.addEventListener("click", fn); notice.append(button);
    };
    if (edit) {
      if (!state.writes.action && edit.reviewed && reviewAvailable()) {
        add("confirm", fmt(() => edit.conflict ? i18n.t("保留选择：{p1}", { p1: i18n.t(labelsFor(edit.field)[edit.value]) }) : i18n.t("确认保存")), () => edit.conflict ? resolveQuick("local") : saveQuick(), !idle());
        if (edit.conflict) add("remote", fmt(() => i18n.t("采用最新：{p1}", { p1: i18n.t(labelsFor(edit.field)[edit.conflict.remote]) })), () => resolveQuick("remote"), !idle());
      }
      add("dismiss", "结束这次选择", cancelQuick, isBusy(state) || ownAction() && slotUncertain(state.writes.action));
    } else {
      add("undo", fmt(() => i18n.t("撤销{p1}", { p1: i18n.t(fieldLabel(undo.field)) })), undoQuick, !canUndoQuick());
      add("dismiss", "关闭提示", () => { const focused = notice.contains(document.activeElement); state.fieldUndo = null; refreshQuickControls(); if (focused) restoreQuickFocus(undo); });
      if (!available(target(undo.taskId)) || target(undo.taskId)[undo.field] !== undo.value) notice.querySelector("span").append(element(document, "span", "", msg("该字段或任务已变更，不能撤销。")));
    }
    const location = state.editor.kind && !byId("editor-panel").hidden
      ? state.editor.mode === "read" && byId("task-read-quick") ? byId("task-read-quick") : byId("merge-conflicts").parentElement : document.querySelector(".feedback");
    if (notice.parentElement !== location) location.append(notice);
    if (hadFocus) (notice.querySelector(`[data-field-action="${action}"]:not(:disabled)`) || notice.querySelector("button:not(:disabled)") || byId("task-read-title"))?.focus({ preventScroll: true });
  }

  function refreshQuickControls() {
    for (const controls of document.querySelectorAll("[data-quick-task]")) {
      const task = target(controls.dataset.quickTask), surface = controls.dataset.quickSurface || "board";
      if (surface === "board") {
        const toggle = controls.parentElement?.querySelector("[data-quick-toggle]");
        controls.hidden = expandedBoardTaskId !== controls.dataset.quickTask;
        if (toggle) { i18n.setText(toggle, fmt(() => controls.hidden ? i18n.t("编辑") : i18n.t("收起"))); toggle.setAttribute("aria-expanded", String(!controls.hidden)); i18n.bindFormatAttr(toggle, "aria-label", () => i18n.t("{p1}快捷修改：{p2}", { p1: controls.hidden ? i18n.t("展开") : i18n.t("收起"), p2: task?.title || controls.dataset.quickTask })); }
      }
      for (const select of controls.querySelectorAll("[data-quick-field]")) {
        select.disabled = !canStageQuick(controls.dataset.quickTask, surface);
        const edit = state.fieldEdit?.taskId === controls.dataset.quickTask && state.fieldEdit.field === select.dataset.quickField ? state.fieldEdit : null;
        if (task) select.value = edit ? edit.value : task[select.dataset.quickField];
      }
      i18n.setText(controls.querySelector(".quick-save-state"), fmt(() => i18n.t(quickText(controls.dataset.quickTask))));
    }
    refreshFieldNotice();
  }

  return { ownQuickAction: ownAction, canStageQuick, stageQuick, canSaveQuick, saveQuick, cancelQuick, mergeRefreshedQuick, confirmQuick, canUndoQuick, undoQuick, restoreQuickFocus, renderQuickControls, refreshQuickControls };
}
