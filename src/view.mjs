import { i18nFor, msg, fmt } from "./i18n.mjs";
import { STATUS_LABELS, COLUMN_ORDER, PREFERENCE_KEY, ERROR_MESSAGES, element } from "./view-common.mjs";
import { boardSchema } from "./board.mjs";
import { mountIcons } from "./icons.mjs";
import { createViewState } from "./view-state.mjs";
import { createFeedback } from "./view-feedback.mjs";
import { createPresentation } from "./view-presentation.mjs";
import { createCards } from "./view-cards.mjs";
import { createColumns } from "./view-columns.mjs";
import { createEditor } from "./view-editor.mjs";
import { createBackup } from "./view-backup.mjs";
import { createWrites } from "./view-writes.mjs";
import { createMenus } from "./view-menus.mjs";
import { createInteractions } from "./view-interactions.mjs";
import { createQuickEdit } from "./view-quick-edit.mjs";
import { createSidebar } from "./view-sidebar.mjs";
import { createSchedule, validTimeZone } from "./view-schedule.mjs";
import { createCodexBoard, DISPLAY_STATUS_LABELS } from "./view-codex-board.mjs";
export { STATUS_LABELS, PRIORITY_LABELS, PAGE_SIZE } from "./view-common.mjs";

export function mountBoard(document, initialBoard, options = {}) {
  const i18n = i18nFor(document, { locale: options.locale });
  i18n.bindDocument();
  const state = createViewState(initialBoard);
  const byId = (id) => document.getElementById(id);
  const refs = { byId };
  for (const [name, id] of Object.entries({search: "search", projectFilter: "project-filter", statusFilter: "status-filter", recordFilter: "record-filter", sourceFilter: "source-filter", archiveFilter: "archive-filter", projectForm: "project-form", taskForm: "task-form", taskProject: "task-project", message: "save-status"})) refs[name] = byId(id);
  const { search, projectFilter, statusFilter, recordFilter, sourceFilter, archiveFilter } = refs;
  const callbacks = {};
  const context = { document, state, options, refs, callbacks, i18n };
  try {
    const saved = JSON.parse(document.defaultView.localStorage.getItem(PREFERENCE_KEY));
    if (saved && typeof saved === "object" && !Array.isArray(saved)) state.presentation.preferences = saved;
  } catch { /* Record handling never depends on browser storage. */ }
  const preferences = state.presentation.preferences;
  if (["board", "list", "next", "today", "week"].includes(preferences?.viewMode)) state.presentation.mode = preferences.viewMode;
  if (validTimeZone(preferences?.timeZone)) state.schedule.timeZone = preferences.timeZone;
  if (Array.isArray(preferences?.collapsed)) {
    state.presentation.collapsed.clear();
    for (const status of preferences.collapsed) if (COLUMN_ORDER.includes(status)) state.presentation.collapsed.add(status);
  }
  mountIcons(document);
  Object.assign(callbacks, createCodexBoard(context));
  Object.assign(callbacks, createFeedback(context));
  Object.assign(callbacks, createPresentation(context));
  Object.assign(callbacks, createCards(context));
  Object.assign(callbacks, createColumns(context));
  Object.assign(callbacks, createEditor(context));
  Object.assign(callbacks, createBackup(context));
  Object.assign(callbacks, createWrites(context));
  Object.assign(callbacks, createMenus(context));
  Object.assign(callbacks, createInteractions(context));
  Object.assign(callbacks, createQuickEdit(context));
  Object.assign(callbacks, createSidebar(context));
  Object.assign(callbacks, createSchedule(context));

  function setBoard(value) {
    const parsed = boardSchema.safeParse(value);
    if (!parsed.success) {
      callbacks.reportError("返回的本机记录不完整，无法更新看板。当前记录和编辑内容已保留。");
      return false;
    }
    state.host.loaded = true;
    // A slower read must not roll back a more recent confirmed save.
    if (parsed.data.revision >= state.board.revision) {
      state.board = parsed.data;
      state.projectsById = new Map(state.board.projects.map((project) => [project.id, project]));
    }
    callbacks.render({ followFocusedTask: true });
    return true;
  }

  function acceptReadResult(result) {
    const payload = result?.structuredContent;
    if (result?.isError || payload?.ok !== true) {
      callbacks.reportError(ERROR_MESSAGES[payload?.error?.code] || "读取本机记录失败。现有记录和编辑内容已保留，请刷新后重试。");
      return false;
    }
    return setBoard(payload.board);
  }
  Object.assign(callbacks, { setBoard, acceptReadResult });

  callbacks.bindMenus();
  callbacks.bindBackup();
  callbacks.bindWrites();
  callbacks.bindEditor();
  callbacks.bindInteractions();
  callbacks.bindSidebar();
  callbacks.bindSchedule();

  byId("archive-project").addEventListener("click", () => {
    const project = state.projectsById.get(projectFilter.value);
    if (project) callbacks.startAction({ type: "archive_project", projectId: project.id, archived: !project.archivedAt });
  });
  const progressGroup = element(document, "optgroup"); i18n.bindFormatAttr(progressGroup, "label", () => i18n.t("任务进度"));
  const runtimeGroup = element(document, "optgroup"); i18n.bindFormatAttr(runtimeGroup, "label", () => i18n.t("Codex 运行状态 · 自动记录"));
  statusFilter.append(progressGroup, runtimeGroup);
  for (const [value, label] of Object.entries(STATUS_LABELS)) {
    for (const select of [progressGroup, byId("task-status")]) {
      const option = element(document, "option", "", msg(label));
      option.value = value;
      select.append(option);
    }
  }
  for (const value of ["idle", "not_loaded", "unknown", "turn_ended"]) { const option = element(document, "option", "", fmt(() => i18n.t(DISPLAY_STATUS_LABELS[value]))); option.value = value; runtimeGroup.append(option); }
  search.addEventListener("input", callbacks.filterChanged);
  projectFilter.addEventListener("change", callbacks.filterChanged);
  statusFilter.addEventListener("change", callbacks.filterChanged);
  sourceFilter.addEventListener("change", callbacks.filterChanged);
  recordFilter.addEventListener("change", callbacks.filterChanged);
  archiveFilter.addEventListener("change", callbacks.filterChanged);
  byId("clear").addEventListener("click", () => { search.value = ""; projectFilter.value = "all"; statusFilter.value = "all"; recordFilter.value = "all"; sourceFilter.value = "all"; archiveFilter.value = "active"; callbacks.filterChanged(); });
  byId("view-next").addEventListener("click", () => { state.presentation.pages.clear(); archiveFilter.value = "active"; state.presentation.mode = "next"; callbacks.render(); });
  byId("view-board").addEventListener("click", () => { state.presentation.pages.clear(); state.presentation.mode = "board"; callbacks.render(); });
  byId("view-list").addEventListener("click", () => { state.presentation.pages.clear(); state.presentation.mode = "list"; callbacks.render(); });
  byId("new-project").addEventListener("click", () => { if (state.presentation.surface !== "tasks" && options.onOpenWorkbench?.() === false) return; callbacks.openProject(); });
  byId("edit-project").addEventListener("click", () => { if (state.presentation.surface !== "tasks" && options.onOpenWorkbench?.() === false) return; const project = state.projectsById.get(projectFilter.value); if (project) callbacks.openProject(project); });
  byId("new-task").addEventListener("click", () => callbacks.openTask());
  byId("refresh").addEventListener("click", callbacks.refresh);
  byId("editor-refresh").addEventListener("click", callbacks.refresh);
  callbacks.render();

  function prepareSurfaceChange(toCodex, { fromSidebar = false } = {}) {
    if (!toCodex || state.presentation.surface !== "tasks") return true;
    if (callbacks.navigationBlocked()) return false;
    if (callbacks.sidebarDrawer()) {
      if (!fromSidebar) return false;
      callbacks.closeSidebar({ returnFocus: false });
    }
    callbacks.closeFilters({ returnFocus: false });
    callbacks.closeCardMenus();
    callbacks.closeProjectMenu();
    callbacks.refreshAccessibility();
    return true;
  }

  return {
    setLocale: i18n.setLocale, get locale() { return i18n.locale; }, get displayTimeZone() { return state.schedule.timeZone; }, setBoard, acceptReadResult, setCodexSnapshot: callbacks.setCodexSnapshot, setCodexReadState: callbacks.setCodexReadState, safeCodexError: callbacks.safeCodexError, refresh: callbacks.refresh, reportError: callbacks.reportError,
    setWorkbenchSurface(visible, surface = "diagnostics") { state.presentation.surface = visible ? surface : "tasks"; callbacks.renderWorkbenchSurface(); callbacks.renderSidebar(); callbacks.refreshControls(); },
    prepareSurfaceChange, refreshAccessibility: callbacks.refreshAccessibility,
    previewBackup: callbacks.previewBackup, exportBackup: callbacks.exportBackup,
    dispose() { callbacks.disposePresentation(); callbacks.disposeSchedule(); callbacks.disposeCodexBoard(); },
    setHostState(host) {
      state.host.connected = host.connected;
      i18n.setText(byId("connection"), typeof host.message === "string" ? msg(host.message) : host.message);
      i18n.setText(byId("mode-tag"), fmt(() => host.connected ? i18n.t("本机记录") : i18n.t("只读预览 / 等待连接")));
      callbacks.refreshControls();
    },
  };
}
