import { i18nFor, fmt } from "./i18n.mjs";
import { STATUS_LABELS, ERROR_MESSAGES, MOVE_ERROR_MESSAGES, uuid } from "./view-common.mjs";
import { findScheduledOverlap } from "./schedule-domain.mjs";
import { dateInZone, timeInZone } from "./calendar-time.mjs";
import {
  WRITE_LANES, createWriteSlot, transitionWrite, canRetrySlot, slotUncertain,
  slotExpired, slotNeedsRefresh, saveFrozen, saveNeedsRefresh, hasExpiredWrites,
  isBusy, isMutating, expiredReviewed, beginActivity, endActivity,
} from "./write-state.mjs";

export function createWrites({ document, state, options, refs, callbacks }) {
  const i18n = i18nFor(document);
  const { byId, search, projectFilter, statusFilter, recordFilter, sourceFilter, archiveFilter, message } = refs;
  const makeRequest = (operation, revision) => ({ requestId: uuid(document.defaultView), expectedRevision: revision, operation });
  const pendingMessage = (lane, unknown) => lane === "save"
    ? unknown ? "正在确认上次保存结果…" : "正在保存到本机…"
    : lane === "move" ? unknown ? "正在确认上次移动结果…" : "正在保存移动…"
      : unknown ? "正在确认上次操作结果…" : "正在保存操作…";
  const unknownMessage = (lane, reason) => {
    if (lane === "save") return fmt(() => i18n.t("{p1}。输入与本次请求已保留，请重试确认保存结果。", { p1: i18n.text(reason) }));
    return fmt(() => i18n.t("{p1}。原{p2}请求已保留，请重试确认。", { p1: i18n.text(reason), p2: lane === "move" ? i18n.t("移动") + (i18n.locale === "en" ? " " : "") : "" }));
  };

  function failureMessage(lane, slot) {
    const messages = lane === "move" ? MOVE_ERROR_MESSAGES : ERROR_MESSAGES;
    if (slotExpired(slot)) return messages.REQUEST_EXPIRED;
    if (slotUncertain(slot)) return lane === "save" ? "无法确认上次保存结果。输入与本次请求已保留，请重试确认保存结果。" : unknownMessage(lane, fmt(() => i18n.t("无法确认上次{p1}结果", { p1: i18n.t(lane === "move" ? "移动" : "操作") })));
    if (lane === "action" && slotNeedsRefresh(slot) && slot.request.operation.type === "restore_board") return "当前记录已更新。本次没有恢复，请重新预览后确认替换。";
    if (lane === "action" && slot.errorCode === "SCHEDULE_CONFLICT") return unarchiveConflictMessage(slot.request.operation) ?? messages[slot.errorCode];
    return messages[slot.errorCode];
  }

  // Restoring a record re-activates its hidden scheduled sessions. Name the
  // pair that would overlap so the user knows which visible session to move.
  function unarchiveConflictMessage(operation) {
    if (!["archive_task", "archive_project"].includes(operation.type) || operation.archived) return null;
    const key = operation.type === "archive_task" ? "tasks" : "projects";
    const id = operation.taskId ?? operation.projectId;
    const candidate = { ...state.board, [key]: state.board[key].map((record) => record.id === id ? { ...record, archivedAt: null } : record) };
    const pair = findScheduledOverlap(candidate);
    if (!pair) return null;
    const zone = state.schedule.timeZone;
    const describe = (session) => ({
      title: state.board.tasks.find((task) => task.id === session.taskId)?.title ?? "",
      time: `${dateInZone(session.startAt, zone)} ${timeInZone(session.startAt, zone)}–${timeInZone(session.endAt, zone)}`,
    });
    const [first, second] = pair.map(describe);
    return fmt(() => i18n.t("恢复后，「{p1}」{p2} 与「{p3}」{p4} 的学习时段会重叠。请先调整或取消其中仍可见的时段，再恢复。", { p1: first.title, p2: first.time, p3: second.title, p4: second.time }));
  }

  async function runMutation(lane, onConfirmed) {
    const current = state.writes[lane];
    if (!canRetrySlot(current) || hasExpiredWrites(state) || !state.host.connected || !options.mutate || state.editor.pendingAction || state.schedule.pendingAction || !beginActivity(state, "mutating", lane)) return;
    callbacks.clearFeedback();
    i18n.setText(message, fmt(() => i18n.t(pendingMessage(lane, slotUncertain(current)))));
    callbacks.refreshControls();
    try {
      const result = await options.mutate(structuredClone(current.request));
      const payload = result?.structuredContent;
      if (result?.isError || payload?.ok === false) {
        if (payload?.board) callbacks.setBoard(payload.board);
        state.writes[lane] = transitionWrite(current, { type: "failure", payload });
        callbacks.reportError(failureMessage(lane, state.writes[lane]));
      } else if (payload?.ok === true && Number.isSafeInteger(payload.appliedRevision)
        && payload.appliedRevision > current.request.expectedRevision
        && payload.board?.revision >= payload.appliedRevision && typeof payload.replayed === "boolean"
        && callbacks.setBoard(payload.board)) {
        // The save's entity lookup still uses its retained known-id snapshot.
        const savedId = lane === "save" ? callbacks.savedEntityId(payload, current.request.operation) : null;
        state.writes[lane] = transitionWrite(current, { type: "confirmed" });
        endActivity(state);
        callbacks.clearFeedback();
        onConfirmed(current.request.operation, savedId);
      } else {
        state.writes[lane] = transitionWrite(current, { type: "unknown" });
        callbacks.reportError(unknownMessage(lane, fmt(() => i18n.t("未收到完整的{p1}确认", { p1: i18n.t(lane === "save" ? "保存" : lane === "move" ? "移动" : "操作") }))));
      }
    } catch {
      state.writes[lane] = transitionWrite(current, { type: "unknown" });
      callbacks.reportError(unknownMessage(lane, fmt(() => i18n.t("连接异常，无法确认{p1}", { p1: i18n.t(lane === "save" ? "本次是否保存" : lane === "move" ? "本次是否移动" : "操作是否保存") }))));
    } finally {
      endActivity(state);
      callbacks.refreshControls();
    }
  }

  function startMove(taskId, status, beforeTaskId = null) {
    const task = state.board.tasks.find((record) => record.id === taskId);
    const anchor = beforeTaskId === null ? null : state.board.tasks.find((record) => record.id === beforeTaskId);
    if (!callbacks.canMove() || !options.mutate || !Object.hasOwn(STATUS_LABELS, status)
      || !task || task.readOnly || callbacks.isArchived(task) || beforeTaskId !== null && (!anchor || anchor.readOnly || anchor.status !== status || anchor.id === taskId)) return;
    state.writes.move = createWriteSlot(makeRequest({ type: "move_task", taskId, status, beforeTaskId }, state.board.revision));
    return retryMove();
  }

  function retryMove() {
    return runMutation("move", (operation) => {
      callbacks.revealTask(operation.taskId);
      callbacks.render();
      callbacks.showSuccess("已移动并保存到本机。");
      if (!callbacks.compactEditor()) document.querySelector(`[data-edit-task="${operation.taskId}"]`)?.focus();
    });
  }

  async function save(event) {
    event.preventDefault();
    if (state.presentation.surface !== "tasks" || event.currentTarget?.closest("[hidden], [inert]")) return;
    if (state.editor.kind === "task" && state.editor.mode === "read") return;
    if (!state.editor.kind || isBusy(state) || state.writes.move || state.writes.action || hasExpiredWrites(state) || state.editor.pendingAction || state.fieldEdit || state.schedule.draft) return;
    if (!state.host.connected || !state.host.loaded || !options.mutate) return callbacks.reportError("当前未连接可保存的宿主，不能本机保存。");
    if (saveNeedsRefresh(state)) return callbacks.reportError(ERROR_MESSAGES.REVISION_CONFLICT);
    if (state.editor.conflicts.length) return callbacks.reportError("请先选择冲突字段要保存的值。");
    // Synthetic submits can bypass the disabled button. A retained uncertain
    // request must still be retried verbatim even if its result is now visible.
    if (state.editor.id && !saveFrozen(state) && callbacks.draftSnapshot() === state.editor.snapshot) {
      state.writes.save = null;
      callbacks.clearFeedback();
      callbacks.refreshControls();
      return;
    }
    let operation;
    try { operation = saveFrozen(state) ? state.writes.save.request.operation : callbacks.operationFromEditor(); }
    catch (error) { return callbacks.reportError(error.message); }
    if (!state.writes.save || JSON.stringify(state.writes.save.request.operation) !== JSON.stringify(operation)) {
      state.writes.save = createWriteSlot(makeRequest(operation, state.editor.revision), {
        knownIds: (operation.type === "save_task" ? state.board.tasks : state.board.projects).map((record) => record.id),
      });
    }
    return runMutation("save", (savedOperation, savedId) => {
      const savedTask = savedOperation.type === "save_task";
      if (savedTask && savedId) callbacks.revealTask(savedId);
      else if (savedId) { projectFilter.value = savedId; search.value = ""; statusFilter.value = "all"; recordFilter.value = "all"; sourceFilter.value = "all"; }
      callbacks.closeEditor();
      callbacks.showSuccess("已保存到本机。");
      if (savedTask && savedId && state.presentation.surface === "tasks") {
        const target = document.querySelector(`[data-edit-task="${savedId}"]`);
        if (callbacks.isVisibleControl(target)) {
          target.focus({ preventScroll: true });
          target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        }
      }
    });
  }

  async function refresh() {
    if (!state.host.connected || !options.refresh || !beginActivity(state, "reading")) return false;
    callbacks.refreshControls();
    try {
      if (!callbacks.acceptReadResult(await options.refresh())) return false;
      const frozenSave = saveFrozen(state);
      const frozenQuick = callbacks.ownQuickAction() && slotUncertain(state.writes.action);
      const frozenSchedule = callbacks.ownScheduleAction() && slotUncertain(state.writes.action);
      for (const lane of WRITE_LANES) {
        const slot = state.writes[lane];
        if (!slot) continue;
        if (slotExpired(slot)) state.writes[lane] = transitionWrite(slot, { type: "refreshed" });
        else if (lane === "action" && (callbacks.ownQuickAction() || callbacks.ownScheduleAction()) && !slotUncertain(slot)) state.writes.action = null;
        else if (lane === "save" && !slotUncertain(slot)) state.writes.save = null;
        else state.writes[lane] = transitionWrite(slot, {
          type: "refreshed", request: makeRequest(slot.request.operation, state.board.revision),
        });
      }
      if (!frozenSchedule) callbacks.mergeRefreshedSchedule();
      if (!frozenQuick && callbacks.mergeRefreshedQuick()) callbacks.render({ followFocusedTask: true });
      if (!frozenSave) {
        state.editor.revision = state.board.revision;
        callbacks.mergeRefreshedEditor();
        if (!state.editor.kind) state.editor.availability = "available";
      }
      if (saveNeedsRefresh(state) && state.editor.kind) return true;
      callbacks.clearFeedback();
      i18n.setText(message, fmt(() => hasExpiredWrites(state) ? i18n.t("已刷新最新记录。请核对后勾选确认，再结束本次重试。")
        : state.editor.conflicts.length ? i18n.t("已合并未冲突字段。请先选择有冲突的字段。")
          : saveFrozen(state) ? i18n.t("已刷新记录。请重试确认上次保存结果。")
            : state.writes.move ? slotUncertain(state.writes.move) ? i18n.t("已刷新记录。请重试确认上次移动结果。") : i18n.t("已刷新本机记录。请核对后重试移动。")
              : state.editor.kind === "task" && state.editor.mode === "read" ? i18n.t("已读取最新任务详情。")
                : state.editor.kind ? i18n.t("已刷新本机记录。编辑内容已保留，请核对后保存。") : i18n.t("已读取本机记录。")));
      return true;
    } catch {
      callbacks.reportError("读取本机记录时连接异常。现有记录与编辑内容已保留，请重试。");
      return false;
    } finally {
      endActivity(state);
      callbacks.refreshControls();
    }
  }

  function startAction(operation, expectedRevision = state.board.revision) {
    if (!callbacks.canMove() || state.editor.kind || !options.mutate) return;
    state.writes.action = createWriteSlot(makeRequest(operation, expectedRevision));
    return retryAction();
  }

  function startQuickAction(operation, expectedRevision) {
    if (!callbacks.canSaveQuick() || state.writes.action || !options.mutate) return;
    state.writes.action = createWriteSlot(makeRequest(operation, expectedRevision));
    return retryAction();
  }

  function startScheduleAction(operation, expectedRevision) {
    if (!callbacks.canSaveSchedule() || state.writes.action || !options.mutate) return;
    state.writes.action = createWriteSlot(makeRequest(operation, expectedRevision));
    return retryAction();
  }

  function retryAction() {
    const slot = state.writes.action;
    if (!slot || slotExpired(slot) || !state.host.connected || isBusy(state) || state.editor.pendingAction || state.schedule.pendingAction) return;
    if (callbacks.ownQuickAction() && !callbacks.canSaveQuick()) return;
    if (callbacks.ownScheduleAction() && !callbacks.canSaveSchedule()) return;
    if (slotNeedsRefresh(slot)) {
      if (slot.request.operation.type !== "restore_board" || state.editor.kind) return;
      const backup = slot.request.operation.backup;
      state.writes.action = null;
      return callbacks.previewBackup(backup);
    }
    return runMutation("action", (operation) => {
      const fieldEdit = operation.type === "patch_task" ? state.fieldEdit : null;
      if (fieldEdit) {
        callbacks.confirmQuick();
        callbacks.revealTask(operation.taskId);
      } else if (operation.type === "archive_task") callbacks.revealTask(operation.taskId);
      else if (operation.type === "archive_project") archiveFilter.value = "all";
      else if (operation.type === "restore_board") {
        archiveFilter.value = "active"; search.value = ""; projectFilter.value = "all"; statusFilter.value = "all"; recordFilter.value = "all"; sourceFilter.value = "all";
        state.backup.preview = null; byId("restore-preview").hidden = true;
      }
      if (["save_session", "record_session_feedback"].includes(operation.type)) callbacks.closeSchedule();
      callbacks.render();
      callbacks.restoreQuickFocus(fieldEdit);
      callbacks.showSuccess(operation.type === "set_focus_task" ? "今日焦点已保存到本机。" : operation.type === "save_session" ? "学习时段已保存到本机。" : operation.type === "record_session_feedback" ? "本次学习反馈已保存，任务整体状态由任务详情管理。" : operation.type === "cancel_session" ? "已取消本次学习时段。" : operation.type === "patch_task" ? fieldEdit?.undo ? "已撤销并保存到本机。" : "已保存到本机。" : operation.type === "restore_board" ? "已恢复并保存到本机。恢复前的记录已自动备份。" : operation.archived ? "已归档并保存到本机。" : "已恢复并保存到本机。");
    });
  }

  function bindWrites() {
    byId("action-retry").addEventListener("click", retryAction);
    byId("action-dismiss").addEventListener("click", () => { if (!state.writes.action || (isMutating(state, "move") || isMutating(state, "action")) || slotUncertain(state.writes.action)) return; if (callbacks.ownQuickAction()) return callbacks.cancelQuick(); state.writes.action = null; callbacks.clearFeedback(); callbacks.refreshControls(); });
    byId("expired-reviewed").addEventListener("change", () => {
      for (const lane of ["save", "move", "action"]) state.writes[lane] = transitionWrite(state.writes[lane], { type: "reviewed", checked: byId("expired-reviewed").checked });
      callbacks.refreshControls();
    });
    byId("expired-end").addEventListener("click", () => {
      if (!hasExpiredWrites(state) || !expiredReviewed(state) || isBusy(state)) return;
      const closeSave = slotExpired(state.writes.save);
      const clearPreview = slotExpired(state.writes.action);
      const closeSession = clearPreview && callbacks.ownScheduleAction();
      if (clearPreview && callbacks.ownQuickAction()) state.fieldEdit = null;
      for (const lane of ["save", "move", "action"]) state.writes[lane] = transitionWrite(state.writes[lane], { type: "end" });
      if (closeSave) callbacks.closeEditor();
      if (closeSession) callbacks.closeSchedule();
      if (clearPreview) { state.backup.preview = null; byId("restore-preview").hidden = true; }
      callbacks.clearFeedback();
      i18n.setText(message, fmt(() => i18n.t("已结束本次重试，没有发送新的保存请求。")));
      callbacks.refreshControls();
    });
    byId("move-retry").addEventListener("click", retryMove);
    byId("move-dismiss").addEventListener("click", () => {
      if (!state.writes.move || (isMutating(state, "move") || isMutating(state, "action")) || slotUncertain(state.writes.move) || state.editor.pendingAction) return;
      state.writes.move = null;
      callbacks.clearFeedback();
      callbacks.refreshControls();
    });
  }

  return { bindWrites, startMove, retryMove, save, refresh, startAction, startQuickAction, startScheduleAction, retryAction };
}
