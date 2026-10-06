import { i18nFor, fmt } from "./i18n.mjs";
import { ERROR_MESSAGES, element } from "./view-common.mjs";
import { boardSchema, portableBackupSchema } from "./board.mjs";
import { isMutating, isReading, isDataBusy, beginActivity, endActivity, saveFrozen, slotUncertain } from "./write-state.mjs";

export function createBackup(context) {
  const { document, state, options, refs, callbacks } = context;
  const i18n = i18nFor(document);
  const { byId, message } = refs;
  const clearFeedback = (...args) => callbacks.clearFeedback(...args);
  const refreshControls = (...args) => callbacks.refreshControls(...args);
  const reportError = (...args) => callbacks.reportError(...args);
  const setBoard = (...args) => callbacks.setBoard(...args);

  async function previewBackup(backup) {
    if (!state.host.connected || !state.host.loaded || isMutating(state, "save") || isReading(state) || (isMutating(state, "move") || isMutating(state, "action")) || isDataBusy(state) || saveFrozen(state) || state.writes.move || state.writes.action || state.editor.kind || state.fieldEdit || state.schedule.draft || !options.data) return false;
    state.backup.preview = null;
    byId("restore-preview").hidden = true;
    refreshControls();
    const parsed = portableBackupSchema.safeParse(backup);
    if (!parsed.success) { reportError("备份格式或记录不完整，无法恢复。当前记录没有变化。"); return false; }
    const frozenBackup = structuredClone(parsed.data);
    beginActivity(state, "previewing");
    clearFeedback();
    refreshControls();
    try {
      const result = await options.data({ action: "preview_restore", backup: frozenBackup });
      const payload = result?.structuredContent;
      const preview = payload?.preview;
      if (result?.isError || payload?.ok !== true || !preview || !["sourceRevision", "projectCount", "taskCount", "sessionCount", "archivedProjectCount", "archivedTaskCount"].every((key) => Number.isSafeInteger(preview[key]) && preview[key] >= 0) || !boardSchema.safeParse(payload.board).success || preview.sourceRevision !== frozenBackup.board.revision || preview.projectCount !== frozenBackup.board.projects.length || preview.taskCount !== frozenBackup.board.tasks.length || preview.sessionCount !== (frozenBackup.board.sessions?.length || 0)) {
        reportError(payload?.error?.code ? ERROR_MESSAGES[payload.error.code] || "备份校验失败，无法预览恢复。当前记录没有变化。" : "未收到完整的恢复预览。当前记录没有变化，请重试。");
        return false;
      }
      const expectedRevision = payload.board.revision;
      setBoard(payload.board);
      state.backup.preview = { backup: frozenBackup, expectedRevision };
      byId("data-panel").hidden = false;
      byId("data-toggle").setAttribute("aria-expanded", "true");
      i18n.setText(byId("restore-summary"), fmt(() => i18n.t("备份日期：{p1}；{p2} 个项目、{p3} 项任务、{p4} 个学习时段（归档项目 {p5}、归档任务 {p6}）。", { p1: new Date(frozenBackup.createdAt).toLocaleString(i18n.intlLocale, { hour12: false }), p2: preview.projectCount, p3: preview.taskCount, p4: preview.sessionCount, p5: preview.archivedProjectCount, p6: preview.archivedTaskCount })));
      byId("restore-session-warning").hidden = preview.sessionCount !== 0;
      byId("restore-preview").hidden = false;
      return true;
    } catch {
      reportError("读取恢复预览失败。当前记录没有变化，请重试。");
      return false;
    } finally {
      endActivity(state);
      refreshControls();
    }
  }

  async function exportBackup() {
    if (!state.host.connected || !state.host.loaded || isMutating(state, "save") || isReading(state) || (isMutating(state, "move") || isMutating(state, "action")) || isDataBusy(state) || !options.data) return false;
    beginActivity(state, "exporting");
    clearFeedback();
    refreshControls();
    try {
      const result = await options.data({ action: "export" });
      const payload = result?.structuredContent;
      const parsed = portableBackupSchema.safeParse(payload?.backup);
      if (result?.isError || payload?.ok !== true || !parsed.success) { reportError(ERROR_MESSAGES[payload?.error?.code] || "没有收到完整的备份，无法导出。请重试。"); return false; }
      state.backup.exportText = JSON.stringify(parsed.data, null, 2);
      let downloaded = false;
      try {
        const window = document.defaultView;
        const url = window.URL.createObjectURL(new window.Blob([state.backup.exportText], { type: "application/json" }));
        const link = element(document, "a");
        link.href = url;
        link.download = `任务看板备份-${parsed.data.createdAt.slice(0, 10)}.json`;
        document.body.append(link);
        try { link.click(); downloaded = true; } finally { link.remove(); window.setTimeout(() => window.URL.revokeObjectURL(url), 0); }
      } catch { /* A host may disallow downloads; retain a copyable export. */ }
      byId("export-json").value = state.backup.exportText;
      byId("export-fallback").hidden = false;
      i18n.setText(byId("export-fallback").querySelector("p"), fmt(() => downloaded ? i18n.t("已发起下载。如果宿主没有收到文件，可复制下面的备份内容。") : i18n.t("浏览器未提供下载支持，可复制下面的备份内容保存为 JSON 文件。")));
      i18n.setText(message, fmt(() => downloaded ? i18n.t("已准备备份下载。") : i18n.t("备份已准备好，请复制并保存为 JSON 文件。")));
      return true;
    } catch {
      reportError("导出备份时连接异常，请重试。");
      return false;
    } finally {
      endActivity(state);
      refreshControls();
    }
  }

  function bindBackup() {
    byId("data-toggle").addEventListener("click", () => { byId("data-panel").hidden = !byId("data-panel").hidden; byId("data-toggle").setAttribute("aria-expanded", String(!byId("data-panel").hidden)); });
    byId("data-export").addEventListener("click", exportBackup);
    byId("export-copy").addEventListener("click", async () => {
      try { await document.defaultView.navigator.clipboard.writeText(state.backup.exportText); i18n.setText(message, fmt(() => i18n.t("备份已复制，请保存为 JSON 文件。"))); }
      catch { byId("export-json").focus(); byId("export-json").select(); i18n.setText(message, fmt(() => i18n.t("请复制已选中的备份内容并保存为 JSON 文件。"))); }
    });
    byId("data-file").addEventListener("change", async () => {
      const file = byId("data-file").files?.[0];
      byId("data-file").value = "";
      state.backup.preview = null;
      byId("restore-preview").hidden = true;
      if (!file) return;
      if (file.size > 24 * 1024 * 1024) return reportError("备份文件过大，无法读取。当前记录没有变化。");
      try {
        const text = await new Promise((resolve, reject) => { const reader = new document.defaultView.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(file); });
        await previewBackup(JSON.parse(text));
      } catch { reportError("无法读取备份 JSON。当前记录没有变化。"); }
    });
    byId("restore-confirm").addEventListener("click", () => {
      if (!state.backup.preview) return;
      callbacks.startAction({ type: "restore_board", backup: state.backup.preview.backup }, state.backup.preview.expectedRevision);
    });
    byId("restore-cancel").addEventListener("click", () => { if ((isMutating(state, "move") || isMutating(state, "action")) || slotUncertain(state.writes.action)) return; state.backup.preview = null; byId("restore-preview").hidden = true; refreshControls(); });
  }

  return { bindBackup, previewBackup, exportBackup };
}
