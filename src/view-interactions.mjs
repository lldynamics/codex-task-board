import { i18nFor, msg } from "./i18n.mjs";
import { isBusy, isMutating, saveFrozen, saveNeedsRefresh, slotExpired, slotUncertain, slotNeedsRefresh } from "./write-state.mjs";

export function createInteractions({ document, state, refs, callbacks }) {
  const i18n = i18nFor(document);
  const { byId, projectForm, taskForm, message } = refs;

  function updateEditorSaveStatus() {
    callbacks.refreshReader?.();
    let value = state.editor.kind && !state.editor.id ? "dirty" : "clean";
    let text = state.editor.id ? "已保存" : "未保存";
    if (state.editor.kind) {
      const retained = Object.values(state.writes).filter(Boolean);
      if (retained.some(slotExpired)) { value = "expired"; text = "请求已过期，请刷新并核对"; }
      else if (isMutating(state)) { value = "saving"; text = state.activity.lane === "save" ? "保存中…" : "正在保存操作…"; }
      else if (saveFrozen(state) || retained.some(slotUncertain)) { value = "confirm"; text = "保存结果需确认"; }
      else if (saveNeedsRefresh(state) || state.editor.conflicts.length || retained.some(slotNeedsRefresh)) { value = "conflict"; text = "请刷新并核对冲突"; }
      else if (state.feedback.error || retained.some((slot) => slot.errorCode)) { value = "error"; text = "保存未完成，输入已保留"; }
      else if (callbacks.draftSnapshot() !== state.editor.snapshot) { value = "dirty"; text = "有未保存的修改"; }
    }
    for (const node of document.querySelectorAll("[data-editor-save-status]")) {
      node.dataset.state = value;
      i18n.setText(node, msg(text));
    }
  }

  function cancelSuccess() {
    if (state.feedback.successTimer !== null) document.defaultView.clearTimeout(state.feedback.successTimer);
    state.feedback.successTimer = null;
  }

  function showSuccess(text) {
    cancelSuccess();
    const translated = typeof text === "string" ? msg(text) : text;
    i18n.setText(message, translated);
    state.feedback.successTimer = document.defaultView.setTimeout(() => {
      // Only this success text expires. A later error, read or pending write stays.
      if (message.textContent === i18n.text(translated) && !state.feedback.error) i18n.setText(message, "");
      state.feedback.successTimer = null;
    }, 3000);
  }

  function bindInteractions() {
    for (const form of [projectForm, taskForm]) {
      form.addEventListener("input", updateEditorSaveStatus);
      form.addEventListener("change", updateEditorSaveStatus);
    }
    document.addEventListener("keydown", (event) => {
      if (state.presentation.surface !== "tasks" || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || state.editor.pendingAction || callbacks.sidebarDrawer()) return;
      const target = event.target;
      if (target?.closest?.("[inert], [hidden]")) return;
      const saveKey = event.key === "Enter" && (event.metaKey !== event.ctrlKey) && !event.altKey && !event.shiftKey;
      if (saveKey) {
        if (!state.editor.kind || isBusy(state)) return;
        if (state.editor.kind === "task" && state.editor.mode === "read") { event.preventDefault(); return; }
        const form = state.editor.kind === "project" ? projectForm : taskForm;
        const submit = form.querySelector('[type="submit"]');
        if (form.closest("[inert], [hidden]") || submit.disabled) return;
        event.preventDefault();
        submit.click();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || callbacks.compactEditor() || isBusy(state)) return;
      if (target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
      if (event.key.toLowerCase() === "n") {
        const button = byId(["today", "week"].includes(state.presentation.mode) ? "new-session" : "new-task");
        if (button.disabled || button.closest("[inert], [hidden]")) return;
        event.preventDefault();
        button.click();
      } else if (event.key === "/") {
        const search = byId("search");
        if (search.disabled || search.closest("[inert], [hidden]")) return;
        event.preventDefault();
        search.focus();
      }
    });
  }

  return { updateEditorSaveStatus, cancelSuccess, showSuccess, bindInteractions };
}
