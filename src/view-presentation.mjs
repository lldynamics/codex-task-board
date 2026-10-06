import { i18nFor, msg, fmt } from "./i18n.mjs";
import { PAGE_SIZE, COLUMN_ORDER, PREFERENCE_KEY, displayProjectName, displayProjectDescription, MAX_FOCUS_TASKS, element } from "./view-common.mjs";
import { icon } from "./icons.mjs";
import { DISPLAY_STATUS_LABELS } from "./view-codex-board.mjs";
import { dateInZone } from "./calendar-time.mjs";
import { classifyTaskAttention, sortAttentionTasks } from "./view-attention.mjs";
import { isBusy } from "./write-state.mjs";

export function createPresentation(context) {
  const { document, state, options, refs, callbacks } = context;
  const i18n = i18nFor(document);
  const { byId, search, projectFilter, statusFilter, recordFilter, sourceFilter, archiveFilter, taskProject } = refs;
  const canPage = (...args) => callbacks.canPage(...args);
  const compactEditor = (...args) => callbacks.compactEditor(...args);
  const refreshControls = (...args) => callbacks.refreshControls(...args);
  const renderCard = (...args) => callbacks.renderCard(...args);
  const renderColumn = (...args) => callbacks.renderColumn(...args);
  const taskMetadata = (...args) => callbacks.taskMetadata(...args);

  function persistPreferences() {
    if (!state.host.loaded) return;
    const value = {
      viewMode: state.presentation.mode, timeZone: state.schedule.timeZone, collapsed: [...state.presentation.collapsed],
      project: projectFilter.value, status: statusFilter.value, record: recordFilter.value, source: sourceFilter.value, archive: archiveFilter.value,

    };
    try { document.defaultView.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(value)); }
    catch { /* Private mode and quota failures only disable preference persistence. */ }
  }

  const attentionToday = () => dateInZone(options.now ? options.now() : Date.now(), state.schedule.timeZone);
  let focusBoard = null; let focusDay = null; let focusZone = null; let focusTasks = new Map(); let focusIds = new Set();
  function syncFocus() {
    const day = attentionToday();
    if (focusBoard === state.board && focusDay === day && focusZone === state.schedule.timeZone) return;
    focusBoard = state.board; focusDay = day; focusZone = state.schedule.timeZone;
    focusTasks = new Map(state.board.tasks.map((task) => [task.id, task]));
    const saved = state.board.dailyFocus;
    const ids = saved?.date === day && saved.timeZone === focusZone ? saved.taskIds : [];
    focusIds = new Set(ids.filter((id) => {
      const task = focusTasks.get(id);
      return task && !isArchived(task) && task.status !== "completed";
    }));
  }
  function isFocusEligible(taskId) {
    syncFocus();
    const task = focusTasks.get(taskId);
    return !!task && !isArchived(task) && task.status !== "completed";
  }

  function currentFocusIds() {
    syncFocus();
    return focusIds;
  }

  function isFocusTask(taskId) {
    return currentFocusIds().has(taskId);
  }

  function toggleFocusTask(taskId) {
    if (!isFocusEligible(taskId)) return;
    return callbacks.startAction({ type: "set_focus_task", taskId, focused: !isFocusTask(taskId), date: attentionToday(), timeZone: state.schedule.timeZone });
  }

  function renderFocusManagement() {
    const container = byId("daily-focus");
    const ids = new Set(currentFocusIds());
    container.hidden = ids.size === 0 || archiveFilter.value === "archived";
    container.replaceChildren();
    if (container.hidden) return;
    container.append(element(document, "p", "helper", fmt(() => i18n.t("今日焦点 {p1} 项 · {p2} · {p3}。建议最多选择 {p4} 项。", { p1: ids.size, p2: attentionToday(), p3: state.schedule.timeZone, p4: MAX_FOCUS_TASKS }))));
    const controls = element(document, "div", "daily-focus-controls");
    for (const task of state.board.tasks.filter((task) => ids.has(task.id))) {
      const button = element(document, "button", "quiet", fmt(() => i18n.t("移出：{p1}", { p1: task.title })));
      button.type = "button";
      button.dataset.focusTask = task.id;
      i18n.bindFormatAttr(button, "aria-label", () => i18n.t("移出今日焦点：{p1}", { p1: task.title }));
      button.addEventListener("click", () => toggleFocusTask(task.id));
      controls.append(button);
    }
    container.append(controls);
  }

  function taskAttention(task, today = attentionToday()) {
    return classifyTaskAttention(task, {
      archived: isArchived(task), today,
      codexRuntimeReliable: state.codex.projection.freshness?.runtimeReliable === true,
      isFocus: isFocusTask(task.id),
    });
  }

  function sortedNextTasks(tasks, today = attentionToday()) {
    return sortAttentionTasks(tasks, (task) => taskAttention(task, today));
  }

  const window = document.defaultView;
  const setTimer = options.setTimeout || window.setTimeout.bind(window);
  const clearTimer = options.clearTimeout || window.clearTimeout.bind(window);
  let attentionTimer = null; let attentionDisposed = false; let attentionSuspended = false; let attentionRefreshQueued = false; let sharedFocusPending = false;
  let renderedAttentionDay = null; let renderedAttentionZone = null;
  const visibleAttention = () => !attentionDisposed && !attentionSuspended && document.visibilityState === "visible"
    && state.presentation.surface === "tasks" && !["today", "week"].includes(state.presentation.mode) && !byId("manual-board")?.hidden;

  function stopAttentionClock() {
    if (attentionTimer !== null) clearTimer(attentionTimer);
    attentionTimer = null;
  }

  function attentionLayoutProtected() {
    if (isBusy(state) || state.presentation.draggingId || state.editor.kind || state.schedule.draft || state.fieldEdit
      || state.editor.pendingAction || state.schedule.pendingAction || Object.values(state.writes).some(Boolean)
      || state.backup.preview || state.presentation.filterOpen || callbacks.sidebarDrawer() || byId("project-menu")?.open
      || document.querySelector(".card-actions[open], .sidebar-project-menu[open]")) return true;
    const active = document.activeElement;
    return !!active?.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], summary')
      || !!active?.closest('[inert], .card-actions, [data-card-source-details], [data-other-statuses]');
  }

  function updateAttentionClock() {
    if (!visibleAttention()) return;
    const today = attentionToday();
    if (today === renderedAttentionDay && state.schedule.timeZone === renderedAttentionZone) return;
    // Badges can update without replacing project rows, native inputs or cards.
    // Keep the next header and its card reasons on the same rendered day until
    // a draft, drag, write or focused native control is safe to replace.
    callbacks.refreshAttentionCount(today);
    if (attentionLayoutProtected()) return;
    render({ followFocusedTask: true });
  }

  function armAttentionClock() {
    if (!visibleAttention()) { stopAttentionClock(); return; }
    if (attentionTimer !== null) return;
    const instant = new Date(options.now ? options.now() : Date.now()).getTime();
    const delay = 60000 - ((instant % 60000 + 60000) % 60000);
    attentionTimer = setTimer(() => {
      attentionTimer = null;
      try { updateAttentionClock(); readPendingSharedFocus(); } finally { armAttentionClock(); }
    }, delay);
  }

  function resumeAttentionClock() {
    if (attentionDisposed) return;
    if (!visibleAttention()) { stopAttentionClock(); return; }
    updateAttentionClock();
    readPendingSharedFocus();
    armAttentionClock();
  }
  function suspendAttentionPage() { attentionSuspended = true; stopAttentionClock(); }
  function resumeAttentionPage() { if (!attentionDisposed) { attentionSuspended = false; resumeAttentionClock(); } }
  function queueAttentionRefresh() {
    if (attentionDisposed || attentionRefreshQueued) return;
    attentionRefreshQueued = true;
    window.queueMicrotask(() => {
      attentionRefreshQueued = false;
      resumeAttentionClock();
    });
  }
  function refreshSharedFocus() {
    if (visibleAttention() && options.refresh && state.host.loaded) sharedFocusPending = true;
    resumeAttentionClock();
  }
  function readPendingSharedFocus() {
    if (!sharedFocusPending || !visibleAttention() || !callbacks.canMove() || attentionLayoutProtected()) return;
    sharedFocusPending = false;
    callbacks.refresh();
  }
  // Writes made by Codex through the model tools do not notify this panel.
  // While the board is visible and idle, check for a newer revision and apply
  // it only when no draft, menu, focused control or request could be disturbed.
  const boardPollMs = options.boardPollMs ?? 0;
  let boardPollTimer = null; let boardPolling = false;
  function armBoardPoll() {
    if (attentionDisposed || boardPollTimer !== null || !options.refresh || !(boardPollMs > 0)) return;
    boardPollTimer = setTimer(() => { boardPollTimer = null; void pollBoard().finally(armBoardPoll); }, boardPollMs);
  }
  async function pollBoard() {
    if (boardPolling || !visibleAttention() || !state.host.connected || !state.host.loaded || attentionLayoutProtected()) return;
    boardPolling = true;
    try {
      const result = await options.refresh();
      const revision = result?.structuredContent?.board?.revision;
      if (result?.isError || !Number.isSafeInteger(revision) || revision <= state.board.revision) return;
      if (!visibleAttention() || attentionLayoutProtected()) { sharedFocusPending = true; return; }
      callbacks.acceptReadResult(result);
    } catch { /* A background check stays silent; the next tick retries. */ }
    finally { boardPolling = false; }
  }
  armBoardPoll();
  const attentionInteractionEvents = ["focusout", "dragend", "toggle", "click", "keydown"];
  document.addEventListener("visibilitychange", resumeAttentionClock);
  window.addEventListener("focus", refreshSharedFocus);
  window.addEventListener("pagehide", suspendAttentionPage);
  window.addEventListener("pageshow", resumeAttentionPage);
  for (const type of attentionInteractionEvents) document.addEventListener(type, queueAttentionRefresh, true);

  function disposePresentation() {
    attentionDisposed = true;
    stopAttentionClock();
    if (boardPollTimer !== null) clearTimer(boardPollTimer);
    boardPollTimer = null;
    document.removeEventListener("visibilitychange", resumeAttentionClock);
    window.removeEventListener("focus", refreshSharedFocus);
    window.removeEventListener("pagehide", suspendAttentionPage);
    window.removeEventListener("pageshow", resumeAttentionPage);
    for (const type of attentionInteractionEvents) document.removeEventListener(type, queueAttentionRefresh, true);
  }

  function currentPage(status, total) {
    const page = Math.max(0, Math.min(state.presentation.pages.get(status) || 0, Math.ceil(total / PAGE_SIZE) - 1));
    state.presentation.pages.set(status, page);
    return page;
  }

  function renderPagination(status, total, page) {
    if (total <= PAGE_SIZE) return null;
    const label = DISPLAY_STATUS_LABELS[status] || "待处理";
    const pagination = element(document, "div", "column-pagination");
    pagination.setAttribute("role", "group");
    i18n.bindFormatAttr(pagination, "aria-label", () => i18n.t("{p1}任务分页", { p1: i18n.t(label) }));
    const previous = element(document, "button", "quiet", fmt(() => i18n.t("上一页")));
    const next = element(document, "button", "quiet", fmt(() => i18n.t("下一页")));
    const range = element(document, "span", "page-count", `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)}/${total}`);
    range.setAttribute("aria-live", "polite");
    for (const [button, direction, boundary] of [[previous, "previous", page === 0], [next, "next", (page + 1) * PAGE_SIZE >= total]]) {
      button.type = "button";
      button.dataset.pageControl = direction;
      button.dataset.pageStatus = status;
      button.dataset.boundary = String(boundary);
      i18n.bindFormatAttr(button, "aria-label", () => i18n.t("pagination.action", { label: i18n.t(label), action: direction === "previous" ? i18n.t("上一页") : i18n.t("下一页") }));
      button.addEventListener("click", () => {
        if (!canPage() || boundary) return;
        state.presentation.pages.set(status, page + (direction === "previous" ? -1 : 1));
        render();
        const column = document.querySelector(`[data-status="${status}"]`);
        const same = column?.querySelector(`[data-page-control="${direction}"]`);
        const target = same && !same.disabled ? same : column?.querySelector("[data-page-control]:not(:disabled)") || column?.querySelector("[data-toggle-column]");
        target?.focus({ preventScroll: true });
        const cards = byId(`column-${status}`);
        if (cards) cards.scrollTop = 0;
      });
    }
    pagination.append(previous, range, next);
    return pagination;
  }

  function projectOptions(select, includeAll, previous, preserveMissing = false) {
    select.replaceChildren();
    if (includeAll) {
      const all = element(document, "option", "", fmt(() => i18n.t("全部项目")));
      all.value = "all";
      select.append(all);
    }
    for (const project of includeAll ? callbacks.displayProjects() : state.board.projects) {
      const option = element(document, "option", "", fmt(() => `${i18n.text(displayProjectName(project))}${project.origin === "codex" ? `（Codex · ${project.hostId} · ${project.cwd || i18n.t("未关联目录")}）` : project.archivedAt ? i18n.t("（已归档）") : ""}`));
      option.value = project.id;
      if (!includeAll && project.archivedAt && project.id !== previous) continue;
      select.append(option);
    }
    if (preserveMissing && previous && ![...select.options].some((option) => option.value === previous)) {
      const missing = element(document, "option", "", fmt(() => i18n.t("项目已不可用，请重新选择")));
      missing.value = previous;
      missing.disabled = true;
      select.append(missing);
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  const sourceTool = (task) => task.origin === "codex" ? "Codex" : task.sourceTool;
  function sourceOptions() {
    const previous = sourceFilter.value;
    const all = element(document, "option", "", fmt(() => i18n.t("全部来源")));
    all.value = "all";
    sourceFilter.replaceChildren(all);
    for (const source of [...new Set(callbacks.displayTasks().map(sourceTool))].sort((a, b) => a.localeCompare(b, "zh-CN"))) {
      const option = element(document, "option", "", fmt(() => source || i18n.t("未填写来源")));
      // JSON strings cannot collide with the unquoted all-sources sentinel.
      option.value = JSON.stringify(source);
      sourceFilter.append(option);
    }
    if ([...sourceFilter.options].some((option) => option.value === previous)) sourceFilter.value = previous;
  }

  function isArchived(task) {
    return !!task.archivedAt || !!callbacks.displayProjectsById().get(task.projectId)?.archivedAt;
  }

  function matchesFilters(task, today) {
    // Array.filter supplies an index as its second argument; only an explicit
    // civil-date string is a shared clock for this membership pass.
    if (typeof today !== "string") today = attentionToday();
    const project = callbacks.displayProjectsById().get(task.projectId);
    const text = [project?.name, project?.description, task.title, task.sourceTool, task.currentStep, task.blocker, task.statusLabel || DISPLAY_STATUS_LABELS[task.status], task.hostId, task.cwd, task.threadId].join(" ").toLocaleLowerCase();
    const query = search.value.trim().toLocaleLowerCase();
    return (archiveFilter.value === "all" || isArchived(task) === (archiveFilter.value === "archived"))
      && (state.presentation.mode !== "next" || !!taskAttention(task, today))
      && (projectFilter.value === "all" || task.projectId === projectFilter.value)
      && (statusFilter.value === "all" || task.status === statusFilter.value)
      && (recordFilter.value === "all" || (task.origin === "codex" ? "codex" : "manual") === recordFilter.value)
      && (sourceFilter.value === "all" || JSON.stringify(sourceTool(task)) === sourceFilter.value)
      && (!query || text.includes(query));
  }

  function clearDrag() {
    state.presentation.draggingId = null;
    for (const node of document.querySelectorAll(".is-dragging, .drop-before, .is-drop-target")) node.classList.remove("is-dragging", "drop-before", "is-drop-target");
  }

  function captureLayout() {
    const root = byId("cards");
    const active = document.activeElement;
    let focus = null;
    if (root.contains(active)) {
      const card = active.closest("[data-task-id]");
      const column = active.closest("[data-status]");
      if (card) {
        const control = active.dataset.quickToggle ? "[data-quick-toggle]" : active.dataset.quickField ? `[data-quick-field="${active.dataset.quickField}"]`
          : active.dataset.archiveTask ? "[data-archive-task]" : active.dataset.moveControl ? `[data-move-control="${active.dataset.moveControl}"]`
          : active.dataset.codexTaskOpen ? "[data-codex-task-open]" : active.dataset.codexTaskCopy ? "[data-codex-task-copy]" : active.matches("[data-card-source-details] > summary") ? "[data-card-source-details] > summary" : active.matches("summary") ? ".card-actions > summary" : active.matches("a") ? "a" : "[data-edit-task]";
        focus = { taskId: card.dataset.taskId, control };
      } else if (active.hasAttribute("data-toggle-other-statuses") || active.matches("[data-other-statuses] > summary")) focus = { otherStatuses: true };
      else if (active.dataset.pageControl) focus = { column: column.dataset.status, control: `[data-page-control="${active.dataset.pageControl}"]` };
      else if (active.dataset.toggleColumn) focus = { column: column.dataset.status };
    }
    const scroll = [...document.querySelectorAll(".board-area, #cards, .column-cards")].map((node) => ({
      id: node.id, boardArea: node.classList.contains("board-area"), left: node.scrollLeft, top: node.scrollTop,
    }));
    return {
      focus, scroll,
      open: new Set([...root.querySelectorAll(".card-actions[open]")].map((node) => node.closest("[data-task-id]").dataset.taskId)),
      sourceOpen: new Set([...root.querySelectorAll("[data-card-source-details][open]")].map((node) => node.closest("[data-task-id]").dataset.taskId)),
      // A search may expand this region temporarily. Preserve user expansion
      // without turning a filter-driven expansion into a lasting preference.
      otherOpen: !!root.querySelector('[data-other-statuses][open]:not([data-auto-expanded="true"])'),
    };
  }

  function restoreLayout(layout) {
    for (const card of byId("cards").querySelectorAll("[data-task-id]")) {
      if (layout.open.has(card.dataset.taskId) && card.querySelector(".card-actions")) card.querySelector(".card-actions").open = true;
      if (layout.sourceOpen.has(card.dataset.taskId) && card.querySelector("[data-card-source-details]")) card.querySelector("[data-card-source-details]").open = true;
    }
    if (layout.otherOpen && byId("cards").querySelector("[data-other-statuses]")) byId("cards").querySelector("[data-other-statuses]").open = true;
    if (layout.focus && !compactEditor() && !state.editor.pendingAction) {
      const target = layout.focus.otherStatuses ? byId("cards").querySelector("[data-other-statuses]") : layout.focus.taskId
        ? document.querySelector(`[data-task-id="${layout.focus.taskId}"]`)
        : document.querySelector(`[data-status="${layout.focus.column}"]`);
      if (layout.focus.taskId && target?.closest("[data-other-statuses]")) target.closest("[data-other-statuses]").open = true;
      const control = layout.focus.otherStatuses ? target?.querySelector("[data-toggle-other-statuses], :scope > summary") : target?.querySelector(layout.focus.control || "[data-toggle-column]");
      if (control?.closest("[data-card-source-details]") && !control.matches("summary")) control.closest("[data-card-source-details]").open = true;
      if (control && !control.disabled) control.focus({ preventScroll: true });
      else target?.querySelector(".card-actions > summary, [data-page-control]:not(:disabled), [data-toggle-column]")?.focus({ preventScroll: true });
      if (!target) byId("search").focus({ preventScroll: true });
    }
    for (const saved of layout.scroll) {
      const node = saved.boardArea ? document.querySelector(".board-area") : byId(saved.id);
      if (node) { node.scrollLeft = saved.left; node.scrollTop = saved.top; }
    }
    callbacks.repositionMenus();
  }

  function normalizeView() {
    if (state.presentation.mode === "next" && archiveFilter.value !== "active") state.presentation.mode = "list";
    const next = byId("view-next");
    next.disabled = archiveFilter.value !== "active";
    i18n.bindFormatAttr(next, "title", () => next.disabled ? i18n.t("待处理仅显示活动任务，请先将归档状态切换为活动任务。") : i18n.t("查看等待处理、失败或到期任务，以及接下来的计划中与进行中任务"));
  }

  function renderFilterChips() {
    const container = byId("filter-chips");
    if (!container) return;
    const activeKey = container.contains(document.activeElement) ? document.activeElement.dataset.clearFilter : null;
    const chips = [
      ["project", projectFilter.value !== "all" ? displayProjectName(callbacks.displayProjectsById().get(projectFilter.value)) : ""],
      ["search", search.value.trim() ? msg("搜索：{p1}", { p1: search.value.trim() }) : ""],
      ["status", statusFilter.value !== "all" ? msg(DISPLAY_STATUS_LABELS[statusFilter.value]) : ""],
      ["record", recordFilter.value !== "all" ? fmt(() => recordFilter.selectedOptions[0]?.textContent || "") : ""],
      ["source", sourceFilter.value !== "all" ? fmt(() => sourceFilter.selectedOptions[0]?.textContent || "") : ""],
      ["archive", archiveFilter.value !== "active" ? fmt(() => archiveFilter.selectedOptions[0]?.textContent || "") : ""],
    ];
    const controls = { project: projectFilter, search, status: statusFilter, record: recordFilter, source: sourceFilter, archive: archiveFilter };
    container.replaceChildren();
    byId("clear").hidden = !chips.some(([, label]) => !!label);
    for (const [key, label] of chips) {
      if (!label) continue;
      const chip = element(document, "button", "filter-chip");
      chip.type = "button";
      chip.dataset.clearFilter = key;
      i18n.bindFormatAttr(chip, "aria-label", () => i18n.t("移除筛选：{p1}", { p1: i18n.text(label) }));
      chip.append(element(document, "span", "", label), icon(document, "close"));
      chip.addEventListener("click", () => {
        controls[key].value = key === "search" ? "" : key === "archive" ? "active" : "all";
        filterChanged();
      });
      container.append(chip);
    }
    if (activeKey && !compactEditor() && !state.editor.pendingAction) (container.querySelector(`[data-clear-filter="${activeKey}"]`) || container.querySelector("button") || search).focus({ preventScroll: true });
  }

  function renderWorkbenchSurface() {
    const tasksVisible = state.presentation.surface === "tasks";
    const calendar = tasksVisible && ["today", "week"].includes(state.presentation.mode);
    byId("task-surface").hidden = !tasksVisible;
    for (const id of ["task-search-field", "task-view-switch", "filter-toggle", "task-filter-summary"]) byId(id).hidden = !tasksVisible || calendar;
    for (const id of ["refresh", "data-toggle"]) byId(id).hidden = !tasksVisible;
    byId("new-task").hidden = !tasksVisible || calendar || archiveFilter.value === "archived";
    byId("codex-board-status").hidden = !tasksVisible || calendar || (!state.codex.read.managed && !state.codex.snapshot && !state.codex.error);
    i18n.setText(byId("manual-tab"), fmt(() => tasksVisible ? i18n.t("任务工作台") : state.presentation.surface === "automations" ? i18n.t("定时计划") : i18n.t("同步诊断")));
    if (calendar || !tasksVisible) callbacks.closeFilters({ returnFocus: false });
    armAttentionClock();
  }

  function codexCountNotice() {
    if (!state.codex.read.managed) return "";
    if (!state.codex.snapshot) return state.codex.read.phase === "error" ? "Codex 任务未读取，数量暂不完整" : "正在读取 Codex 任务，数量暂不完整";
    if (state.codex.error || state.codex.read.phase === "error") return "上次 Codex 快照数量";
    if (!state.codex.projection.source?.complete) return "Codex 来源范围不完整";
    return "";
  }

  function renderTaskCount(tasks = callbacks.displayTasks().filter(matchesFilters), allTasks = callbacks.displayTasks()) {
    const notice = codexCountNotice();
    i18n.setText(byId("count"), fmt(() => i18n.t("{p1} / {p2} 项任务{p3}", { p1: tasks.length, p2: allTasks.length, p3: notice ? ` · ${i18n.t(notice)}` : "" })));
    byId("count").dataset.complete = String(!notice);
  }

  function render({ followFocusedTask = false } = {}) {
    const layout = captureLayout();
    // A notification or filter change invalidates the card layout captured by a
    // drag. Do not submit an old drag intent using a newer board revision.
    clearDrag();
    const selected = projectFilter.value;
    const draftProject = taskProject.value;
    projectOptions(projectFilter, true, selected);
    projectOptions(taskProject, false, draftProject, state.editor.kind === "task");
    sourceOptions();
    if (state.host.loaded && state.presentation.preferences) {
      if ([...projectFilter.options].some((option) => option.value === state.presentation.preferences.project)) projectFilter.value = state.presentation.preferences.project;
      if ([...statusFilter.options].some((option) => option.value === state.presentation.preferences.status)) statusFilter.value = state.presentation.preferences.status;
      if (["manual", "codex", "all"].includes(state.presentation.preferences.record)) recordFilter.value = state.presentation.preferences.record;
      if (["active", "archived", "all"].includes(state.presentation.preferences.archive)) archiveFilter.value = state.presentation.preferences.archive;
      if (state.presentation.preferences.source === JSON.stringify("Codex 自动同步") && !Object.hasOwn(state.presentation.preferences, "record")) { recordFilter.value = "codex"; sourceFilter.value = "all"; }
      else if ([...sourceFilter.options].some((option) => option.value === state.presentation.preferences.source)) sourceFilter.value = state.presentation.preferences.source;
      if (typeof state.presentation.preferences.project !== "string" || !state.presentation.preferences.project.startsWith("codex-project-") || state.codex.snapshot) state.presentation.preferences = null;
    }
    normalizeView();
    renderWorkbenchSurface();
    const activeProject = callbacks.displayProjectsById().get(projectFilter.value);
    i18n.setText(byId("main-title"), fmt(() => i18n.text(displayProjectName(activeProject)) || i18n.t("我的任务")));
    i18n.setText(byId("project-description"), fmt(() => i18n.text(displayProjectDescription(activeProject)) || (activeProject ? i18n.t("这个项目还没有填写说明。") : i18n.t("项目与任务的进展，尽在此处。"))));
    const allTasks = callbacks.displayTasks();
    const today = attentionToday();
    const tasks = allTasks.filter((task) => matchesFilters(task, today));
    // Keep a keyboard-focused task reachable if a read inserts/removes records
    // before it or changes its projected priority order.
    if (followFocusedTask && layout.focus?.taskId) {
      const task = tasks.find((item) => item.id === layout.focus.taskId);
      if (task) {
        const collapsed = callbacks.selectedCodexProject() ? state.codex.collapsed : state.presentation.collapsed;
        collapsed.delete(task.status);
        const columnTasks = state.presentation.mode === "next" ? sortedNextTasks(tasks, today) : tasks.filter((item) => item.status === task.status);
        state.presentation.pages.set(state.presentation.mode === "next" ? "next" : task.status, Math.floor(columnTasks.findIndex((item) => item.id === task.id) / PAGE_SIZE));
      }
    }
    renderTaskCount(tasks, allTasks);
    i18n.setText(byId("project-count"), fmt(() => i18n.t("{p1} 个项目", { p1: callbacks.displayProjects().length })));
    i18n.setText(byId("filter-summary"), fmt(() => [search.value.trim() ? i18n.t("搜索：{p1}", { p1: search.value.trim() }) : "", statusFilter.value !== "all" ? i18n.t(DISPLAY_STATUS_LABELS[statusFilter.value]) : "", sourceFilter.value !== "all" ? sourceFilter.selectedOptions[0]?.textContent || "" : ""].filter(Boolean).join(" · ")));
    callbacks.renderCodexSource();
    renderFilterChips();
    callbacks.renderSidebar(today);
    renderFocusManagement();
    byId("empty").hidden = tasks.length !== 0;
    i18n.setText(byId("empty"), fmt(() => archiveFilter.value === "archived"
      ? allTasks.some(isArchived) ? i18n.t("没有符合筛选条件的归档任务。可以清除筛选继续查看。") : i18n.t("暂无归档任务。归档后的任务会显示在这里。")
      : callbacks.displayProjects().length === 0
      ? i18n.t("看板还是空白。连接后先新建项目，再添加任务。")
      : allTasks.length === 0 ? i18n.t("项目已准备好，可以添加第一项任务。") : i18n.t("没有符合筛选条件的任务。可以清除筛选继续查看。")));
    byId("cards").className = state.presentation.mode === "next" ? "cards list-view next-view" : `cards ${state.presentation.mode}-view`;
    byId("view-board").setAttribute("aria-pressed", String(state.presentation.mode === "board"));
    byId("view-list").setAttribute("aria-pressed", String(state.presentation.mode === "list"));
    byId("view-next").setAttribute("aria-pressed", String(state.presentation.mode === "next"));
    byId("view-today").setAttribute("aria-pressed", String(state.presentation.mode === "today"));
    byId("view-week").setAttribute("aria-pressed", String(state.presentation.mode === "week"));
    // Calendar navigation exposes project/archive scope; its hidden task-only
    // filters must not silently suppress learning sessions.
    const scheduleTasks = allTasks.filter((task) => task.origin !== "codex"
      && (projectFilter.value === "all" || task.projectId === projectFilter.value)
      && (archiveFilter.value === "all" || isArchived(task) === (archiveFilter.value === "archived")));
    if (callbacks.renderSchedule(scheduleTasks)) { /* Learning sessions remain bound to manual tasks. */ }
    else if (archiveFilter.value === "archived" && tasks.length === 0) byId("cards").replaceChildren();
    else if (state.presentation.mode === "next") {
      const columnTasks = new Map(COLUMN_ORDER.map((status) => [status, tasks.filter((task) => task.status === status)]));
      const indices = new Map([...columnTasks.values()].flatMap((items) => items.map((task, index) => [task.id, index])));
      const sorted = sortedNextTasks(tasks, today);
      const page = currentPage("next", sorted.length);
      const container = element(document, "section", "next-actions");
      container.dataset.status = "next";
      container.dataset.page = String(page);
      container.dataset.pageSize = String(PAGE_SIZE);
      i18n.bindFormatAttr(container, "aria-label", () => i18n.t("待处理与接下来任务"));
      const attention = new Map(sorted.map((task) => [task.id, taskAttention(task, today)]));
      const focusCount = sorted.filter((task) => attention.get(task.id).group === "focus").length;
      const neededCount = sorted.filter((task) => attention.get(task.id).group === "attention").length;
      const upcomingCount = sorted.length - focusCount - neededCount;
      const header = element(document, "header", "next-actions-header");
      const summaryText = fmt(() => focusCount > 0
        ? i18n.t("今日焦点 {p1} 项 · 待处理 {p2} 项 · 接下来 {p3} 项", { p1: focusCount, p2: neededCount, p3: upcomingCount })
        : i18n.t("待处理 {p1} 项 · 接下来 {p2} 项", { p1: neededCount, p2: upcomingCount }));
      const summary = element(document, "p", "next-actions-summary", summaryText);
      summary.dataset.attentionCount = String(neededCount);
      summary.dataset.upcomingCount = String(upcomingCount);
      if (focusCount > 0) summary.dataset.focusCount = String(focusCount);
      header.append(element(document, "h2", "", fmt(() => i18n.t("待处理与接下来"))), summary, element(document, "p", "next-actions-date", fmt(() => i18n.t("到期提醒按显示时区 {p1} 的今日 {p2} 判断", { p1: state.schedule.timeZone, p2: today }))));
      container.append(header);
      const cards = element(document, "div", "column-cards");
      cards.id = "column-next";
      let previousGroup = null;
      for (const task of sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
        const decision = attention.get(task.id);
        if (decision.group !== previousGroup) {
          const groupTitle = fmt(() => decision.group === "focus"
            ? i18n.t("今日焦点 · {p1} 项", { p1: focusCount })
            : decision.group === "attention"
              ? i18n.t("待处理 · {p1} 项", { p1: neededCount })
              : i18n.t("接下来 · {p1} 项", { p1: upcomingCount }));
          const heading = element(document, "h3", "next-group-heading", groupTitle);
          heading.dataset.attentionGroup = decision.group;
          cards.append(heading);
          previousGroup = decision.group;
        }
        const card = renderCard(task, columnTasks.get(task.status), indices.get(task.id));
        card.dataset.attentionGroup = decision.group;
        const reasonClass = decision.group === "focus"
          ? "attention-focus"
          : decision.group === "attention"
            ? "attention-needed"
            : "attention-upcoming";
        const reason = element(document, "p", `task-attention-reason ${reasonClass}`, fmt(() => decision.reasons.map((key) => i18n.t(key)).join(" · ")));
        reason.dataset.attentionReason = "";
        card.append(reason);
        cards.append(card);
      }
      container.append(cards);
      const pagination = renderPagination("next", sorted.length, page);
      if (pagination) container.append(pagination);
      byId("cards").replaceChildren(container);
    } else byId("cards").replaceChildren(...(callbacks.renderBoardColumns ? callbacks.renderBoardColumns(tasks) : callbacks.displayColumns(tasks).filter((status) => statusFilter.value === "all" || statusFilter.value === status).map((status) => renderColumn(status, tasks.filter((task) => task.status === status)))));
    if (state.editor.kind === "task") taskMetadata(state.board.tasks.find((task) => task.id === state.editor.id));
    refreshControls();
    restoreLayout(layout);
    persistPreferences();
    renderedAttentionDay = today;
    renderedAttentionZone = state.schedule.timeZone;
    armAttentionClock();
  }

  function revealTask(taskId) {
    const task = state.board.tasks.find((item) => item.id === taskId);
    if (!task) return;
    const today = attentionToday();
    state.presentation.collapsed.delete(task.status);
    if (archiveFilter.value !== "all" && isArchived(task) !== (archiveFilter.value === "archived")) archiveFilter.value = "all";
    if (state.presentation.mode === "next" && !taskAttention(task, today)) state.presentation.mode = "board";
    if (statusFilter.value !== "all" && statusFilter.value !== task.status) statusFilter.value = "all";
    if (projectFilter.value !== "all" && projectFilter.value !== task.projectId) projectFilter.value = "all";
    if (sourceFilter.value !== "all" && sourceFilter.value !== JSON.stringify(task.sourceTool)) sourceFilter.value = "all";
    if (recordFilter.value === "codex") recordFilter.value = "all";
    if (!matchesFilters(task, today)) search.value = "";
    const visible = callbacks.displayTasks().filter((item) => matchesFilters(item, today));
    const columnTasks = state.presentation.mode === "next" ? sortedNextTasks(visible, today) : visible.filter((item) => item.status === task.status);
    state.presentation.pages.set(state.presentation.mode === "next" ? "next" : task.status, Math.floor(columnTasks.findIndex((item) => item.id === taskId) / PAGE_SIZE));
  }

  function filterChanged() {
    state.presentation.preferences = null;
    state.presentation.pages.clear();
    normalizeView();
    if (statusFilter.value !== "all") { state.presentation.collapsed.delete(statusFilter.value); state.codex.collapsed.delete(statusFilter.value); }
    if (search.value.trim() || sourceFilter.value !== "all" || recordFilter.value !== "all") {
      for (const task of callbacks.displayTasks().filter(matchesFilters)) {
        state.presentation.collapsed.delete(task.status);
        state.codex.collapsed.delete(task.status);
      }
    }
    render();
  }

  return { persistPreferences, isFocusEligible, isFocusTask, toggleFocusTask, attentionToday, taskAttention, sortedNextTasks, currentPage, renderPagination, projectOptions, sourceOptions, isArchived, matchesFilters, clearDrag, captureLayout, restoreLayout, render, renderWorkbenchSurface, renderTaskCount, codexCountNotice, revealTask, filterChanged, disposePresentation };
}
