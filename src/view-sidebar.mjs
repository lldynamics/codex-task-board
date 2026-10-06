import { i18nFor, msg, fmt } from "./i18n.mjs";
import { element, displayProjectName } from "./view-common.mjs";

const SIDEBAR_PREFERENCE_KEY = "learning-board:sidebar-preferences:v1";

export function createSidebar({ document, state, options, refs, callbacks }) {
  const i18n = i18nFor(document);
  const { byId, projectFilter, archiveFilter } = refs;
  const narrow = () => document.defaultView.innerWidth <= 800;
  const blocked = () => !!state.editor.pendingAction || !!state.schedule.pendingAction || callbacks.compactSchedule() || callbacks.compactEditor();
  const sidebarDrawer = () => !!byId("project-sidebar") && narrow() && state.sidebar.open && !blocked();
  const projectMenus = () => [...document.querySelectorAll("[data-sidebar-project-menu]")];
  const manualProject = (id) => state.projectsById.get(id);
  const canEditProject = (id) => !!manualProject(id) && !blocked() && !byId("new-project").disabled;
  const canArchiveProject = (id) => !!manualProject(id) && !blocked() && !state.editor.kind && callbacks.canMove();

  function closeSidebarProjectMenus({ returnFocus = false, except = null } = {}) {
    for (const menu of projectMenus()) {
      if (menu === except || !menu.open) continue;
      menu.open = false;
      const summary = menu.querySelector("summary");
      summary.setAttribute("aria-expanded", "false");
      if (returnFocus && isVisibleControl(summary)) summary.focus({ preventScroll: true });
    }
  }

  function positionProjectMenu(menu) {
    if (!menu.open || !menu.isConnected) return;
    const summary = menu.querySelector("summary");
    const actions = menu.querySelector(".sidebar-project-menu-actions");
    const rect = summary.getBoundingClientRect();
    const viewportWidth = document.defaultView.innerWidth || 1024;
    const viewportHeight = document.defaultView.innerHeight || 768;
    const width = Math.min(200, Math.max(1, viewportWidth - 16));
    actions.style.width = `${width}px`;
    actions.style.maxHeight = `${Math.max(1, viewportHeight - 16)}px`;
    const height = Math.min(actions.scrollHeight || 90, viewportHeight - 16);
    actions.style.left = `${Math.min(Math.max(8, rect.right - width), Math.max(8, viewportWidth - width - 8))}px`;
    actions.style.top = `${rect.bottom + 5 + height <= viewportHeight - 8 ? rect.bottom + 5 : Math.max(8, rect.top - height - 5)}px`;
  }

  function prepareProjectMenu(menu) {
    closeSidebarProjectMenus({ except: menu });
    callbacks.closeFilters({ returnFocus: false });
    callbacks.closeCardMenus();
    callbacks.closeProjectMenu();
  }

  function actOnProject(id, action, summary) {
    // Resolve the record again instead of relying on a selected filter or a
    // stale rendered project. Automatic projects never enter this map.
    const project = manualProject(id);
    if (!project || (action === "edit" ? !canEditProject(id) : !canArchiveProject(id))) return;
    if (state.presentation.surface !== "tasks") {
      if (options.onOpenWorkbench?.() === false) return;
      state.presentation.surface = "tasks";
    }
    closeSidebarProjectMenus();
    if (action === "edit") {
      state.sidebar.editorOpener = summary;
      try { callbacks.openProject(project); } finally { state.sidebar.editorOpener = null; }
    } else {
      summary.focus({ preventScroll: true });
      callbacks.startAction({ type: "archive_project", projectId: project.id, archived: !project.archivedAt });
    }
  }

  function renderProjectMenu(project, previous) {
    if (previous) {
      i18n.bindFormatAttr(previous.querySelector("summary"), "aria-label", () => i18n.t("{p1}的项目操作", { p1: i18n.text(displayProjectName(project)) }));
      i18n.bindFormatAttr(previous.querySelector(".sidebar-project-menu-actions"), "aria-label", () => i18n.t("{p1}的项目操作", { p1: i18n.text(displayProjectName(project)) }));
      i18n.setText(previous.querySelector('[data-sidebar-project-action="archive"]'), fmt(() => project.archivedAt ? i18n.t("恢复项目") : i18n.t("归档项目")));
      return previous;
    }
    const menu = element(document, "details", "sidebar-project-menu");
    menu.dataset.sidebarProjectMenu = project.id;
    const summary = element(document, "summary", "", "⋯");
    summary.dataset.sidebarProjectControl = "menu";
    i18n.bindFormatAttr(summary, "aria-label", () => i18n.t("{p1}的项目操作", { p1: i18n.text(displayProjectName(project)) }));
    summary.setAttribute("aria-haspopup", "true");
    summary.setAttribute("aria-expanded", "false");
    const actions = element(document, "div", "sidebar-project-menu-actions");
    actions.setAttribute("role", "group");
    i18n.bindFormatAttr(actions, "aria-label", () => i18n.t("{p1}的项目操作", { p1: i18n.text(displayProjectName(project)) }));
    for (const [action, label] of [["edit", "编辑项目"], ["archive", project.archivedAt ? "恢复项目" : "归档项目"]]) {
      const button = element(document, "button", "", msg(label));
      button.type = "button"; button.dataset.sidebarProjectAction = action;
      button.addEventListener("click", () => { if (isVisibleControl(button)) actOnProject(project.id, action, summary); });
      actions.append(button);
    }
    menu.append(summary, actions);
    summary.addEventListener("click", (event) => {
      if (!canEditProject(project.id) && !canArchiveProject(project.id)) return event.preventDefault();
      if (!menu.open) prepareProjectMenu(menu);
    });
    summary.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" || !canEditProject(project.id) && !canArchiveProject(project.id)) return;
      event.preventDefault(); prepareProjectMenu(menu); menu.open = true;
      summary.setAttribute("aria-expanded", "true"); positionProjectMenu(menu);
      actions.querySelector("button:not(:disabled)")?.focus();
    });
    menu.addEventListener("toggle", () => {
      if (!menu.isConnected) return;
      if (menu.open && !canEditProject(project.id) && !canArchiveProject(project.id)) menu.open = false;
      summary.setAttribute("aria-expanded", String(menu.open));
      if (menu.open) { prepareProjectMenu(menu); positionProjectMenu(menu); }
    });
    return menu;
  }

  function isVisibleControl(node) {
    if (!node?.isConnected || node.disabled || node.closest("[hidden], [inert]")) return false;
    if (!node.matches('button, input, select, textarea, summary, a[href], [tabindex], [contenteditable]:not([contenteditable="false"])')) return false;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches("details:not([open])") && !(node.matches("summary") && node.parentElement === parent)) return false;
    }
    const style = document.defaultView.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function persistSidebar() {
    try { document.defaultView.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, JSON.stringify({ sidebarCollapsed: state.sidebar.collapsed })); }
    catch { /* Sidebar preferences never affect records or write requests. */ }
  }

  function syncSidebarVisibility() {
    const sidebar = byId("project-sidebar");
    if (!sidebar) return false;
    const wasFocused = sidebar.contains(document.activeElement);
    const focusedBackdrop = document.activeElement === byId("sidebar-backdrop");
    const mobile = narrow();
    if (state.sidebar.narrow !== null && state.sidebar.narrow !== mobile) state.sidebar.open = false;
    state.sidebar.narrow = mobile;
    if (blocked()) state.sidebar.open = false;
    sidebar.hidden = mobile ? !state.sidebar.open : state.sidebar.collapsed;
    document.querySelector(".app").classList.toggle("sidebar-collapsed", state.sidebar.collapsed);
    const drawer = sidebarDrawer();
    if (byId("sidebar-backdrop")) byId("sidebar-backdrop").hidden = !drawer;
    byId("sidebar-toggle")?.setAttribute("aria-expanded", String(!sidebar.hidden));
    if (byId("sidebar-toggle")) byId("sidebar-toggle").disabled = blocked();
    if (byId("sidebar-close")) byId("sidebar-close").hidden = !mobile;
    if (drawer) { sidebar.setAttribute("role", "dialog"); sidebar.setAttribute("aria-modal", "true"); }
    else { sidebar.removeAttribute("role"); sidebar.removeAttribute("aria-modal"); }
    return (wasFocused && !isVisibleControl(document.activeElement)) || (focusedBackdrop && byId("sidebar-backdrop")?.hidden);
  }

  function closeSidebar({ returnFocus = true } = {}) {
    closeSidebarProjectMenus();
    state.sidebar.open = false;
    if (!returnFocus) { syncSidebarVisibility(); return; }
    callbacks.refreshAccessibility();
    if (returnFocus && !blocked() && isVisibleControl(byId("sidebar-toggle"))) byId("sidebar-toggle").focus({ preventScroll: true });
  }

  function openSidebar() {
    if (!byId("project-sidebar") || !narrow() || blocked()) return false;
    callbacks.closeFilters({ returnFocus: false });
    callbacks.closeCardMenus();
    callbacks.closeProjectMenu();
    closeSidebarProjectMenus();
    state.sidebar.open = true;
    callbacks.refreshAccessibility();
    (isVisibleControl(byId("sidebar-close")) ? byId("sidebar-close") : byId("sidebar-project-search"))?.focus();
    return true;
  }

  function toggleSidebar() {
    if (!byId("project-sidebar") || blocked()) return;
    if (narrow()) return state.sidebar.open ? closeSidebar() : openSidebar();
    const wasFocused = byId("project-sidebar").contains(document.activeElement);
    state.sidebar.collapsed = !state.sidebar.collapsed;
    persistSidebar();
    callbacks.refreshAccessibility();
    if (state.sidebar.collapsed && wasFocused && isVisibleControl(byId("sidebar-toggle"))) byId("sidebar-toggle").focus({ preventScroll: true });
  }

  function navigateSidebar(kind, projectId, projectArchive) {
    if (blocked()) return false;
    closeSidebarProjectMenus();
    if (kind === "automations") {
      if (typeof options.onOpenAutomations !== "function") return false;
      // The drawer is modal. Remove its dialog and inert state before the
      // surface guard permits leaving the manual board.
      closeSidebar({ returnFocus: false });
      callbacks.refreshAccessibility();
      return options.onOpenAutomations() !== false;
    }
    if (state.presentation.surface !== "tasks") {
      if (options.onOpenWorkbench?.() === false) return false;
      state.presentation.surface = "tasks";
    }
    const learning = ["today", "week"].includes(state.presentation.mode);
    if (kind === "learning") {
      if (!learning) state.presentation.mode = "today";
      callbacks.filterChanged();
      if (sidebarDrawer()) closeSidebar();
      return true;
    }
    if (kind === "project") {
      const project = callbacks.displayProjectsById().get(projectId);
      if (!project) return false;
      projectFilter.value = projectId;
      // In the archive context an active project row represents its archived
      // tasks. Its data attribute captures that intent without changing drafts.
      archiveFilter.value = project.archivedAt || projectArchive === "archived" ? "archived" : "active";
      if (state.presentation.mode === "next" || learning) state.presentation.mode = "list";
    } else {
      projectFilter.value = "all";
      archiveFilter.value = kind === "archive" ? "archived" : "active";
      if (kind === "next") state.presentation.mode = "next";
      else if (kind === "archive" || state.presentation.mode === "next" || learning) state.presentation.mode = "list";
    }
    callbacks.filterChanged();
    if (sidebarDrawer()) closeSidebar();
    return true;
  }

  function setCount(button, count, description) {
    if (!button) return;
    let badge = button.querySelector("[data-sidebar-count]");
    if (!badge) { badge = element(document, "span", "sidebar-count"); badge.dataset.sidebarCount = ""; button.append(badge); }
    i18n.setText(badge, String(count));
    const notice = callbacks.codexCountNotice();
    badge.dataset.complete = String(!notice);
    i18n.bindFormatAttr(badge, "aria-label", () => i18n.t("{p1}总数：{p2}；不受其他筛选影响{p3}", { p1: i18n.text(description), p2: count, p3: notice ? `; ${i18n.t(notice)}` : "" }));
    i18n.bindFormatAttr(button, "title", () => i18n.t("{p1}：{p2} 项任务；总数不受搜索、状态或来源筛选影响。{p3}", { p1: i18n.text(description), p2: count, p3: notice ? `${i18n.t(notice)}.` : "" }));
  }

  function setAttentionCount(next, attention, today) {
    const button = byId("sidebar-next");
    if (!button) return;
    setCount(button, next, msg("全部项目的待处理活动任务"));
    i18n.bindFormatAttr(button, "title", () => i18n.t("全部项目：待处理 {p1} 项 · 接下来 {p2} 项；到期按 {p3} 的今日 {p4} 判断；总数不受搜索、状态或来源筛选影响。", { p1: attention, p2: next - attention, p3: state.schedule.timeZone, p4: today }));
    i18n.bindFormatAttr(button.querySelector("[data-sidebar-count]"), "aria-label", () => i18n.t("待处理与接下来总数：{p1}；待处理 {p2} 项，接下来 {p3} 项；不受其他筛选影响", { p1: next, p2: attention, p3: next - attention }));
  }

  function refreshAttentionCount(today = callbacks.attentionToday()) {
    let next = 0; let attention = 0;
    for (const task of callbacks.displayTasks()) {
      const decision = callbacks.taskAttention(task, today);
      if (decision) { next++; if (decision.group === "attention") attention++; }
    }
    setAttentionCount(next, attention, today);
  }

  function renderSidebar(today = callbacks.attentionToday()) {
    const sidebar = byId("project-sidebar");
    if (!sidebar) return;
    const list = byId("sidebar-projects");
    const focused = list?.contains(document.activeElement) ? document.activeElement : null;
    const focusedProject = focused?.closest("[data-sidebar-project-row]")?.dataset.sidebarProjectRow || focused?.dataset.sidebarProject;
    const focusedControl = focused?.dataset.sidebarProjectAction || focused?.dataset.sidebarProjectControl;
    const openMenuId = list?.querySelector("[data-sidebar-project-menu][open]")?.dataset.sidebarProjectMenu;
    const previousMenus = new Map(projectMenus().map((menu) => [menu.dataset.sidebarProjectMenu, menu]));
    const returnMenuId = state.editor.returnFocus?.closest?.("[data-sidebar-project-menu]")?.dataset.sidebarProjectMenu;
    const counts = new Map(callbacks.displayProjects().map((project) => [project.id, { active: 0, archived: 0 }]));
    let active = 0; let archived = 0; let next = 0; let attention = 0;
    for (const task of callbacks.displayTasks()) {
      const scope = callbacks.isArchived(task) ? "archived" : "active";
      const projectCount = counts.get(task.projectId);
      if (projectCount) projectCount[scope] += 1;
      if (scope === "archived") archived += 1;
      else {
        active += 1;
        const decision = callbacks.taskAttention(task, today);
        if (decision) { next += 1; if (decision.group === "attention") attention += 1; }
      }
    }
    setCount(byId("sidebar-all"), active, msg("全部项目的活动任务"));
    setAttentionCount(next, attention, today);
    setCount(byId("sidebar-archive"), archived, msg("全部项目的归档任务"));
    const selected = projectFilter.value;
    const archiveContext = archiveFilter.value === "archived";
    const learning = ["today", "week"].includes(state.presentation.mode);
    const projects = callbacks.displayProjects().filter((project) => {
      const relevant = archiveFilter.value === "all" || (archiveContext ? !!project.archivedAt || counts.get(project.id).archived > 0 : !project.archivedAt);
      return (relevant || project.id === selected) && (!state.sidebar.search || `${i18n.text(displayProjectName(project))} ${project.description}`.toLocaleLowerCase().includes(state.sidebar.search.trim().toLocaleLowerCase()));
    });
    const rows = projects.map((project) => {
      const row = element(document, "div", "sidebar-project-row");
      row.dataset.sidebarProjectRow = project.id;
      if (project.origin === "codex") row.dataset.origin = "codex";
      const scope = project.archivedAt || archiveContext ? "archived" : "active";
      const button = element(document, "button", "sidebar-project");
      button.type = "button"; button.dataset.sidebarProject = project.id; button.dataset.sidebarArchive = scope;
      const name = element(document, "span", "sidebar-project-name", fmt(() => `${i18n.text(displayProjectName(project))}${project.archivedAt ? i18n.t("（已归档）") : ""}`));
      if (project.origin === "codex") {
        button.dataset.origin = "codex";
        name.append(element(document, "small", "sidebar-project-source", fmt(() => i18n.t("主机：{p1}", { p1: project.hostId }))));
      }
      button.append(name);
      setCount(button, counts.get(project.id)[scope], fmt(() => i18n.t("{p1}的{p2}任务", { p1: i18n.text(displayProjectName(project)), p2: i18n.t(scope === "archived" ? "归档" : "活动") })));
      if (project.origin === "codex") i18n.bindFormatAttr(button, "title", () => i18n.text(displayProjectName(project)) + i18n.t(" 主机：{p1}；目录：{p2}；Codex 自动项目只读。", { p1: project.hostId, p2: project.cwd || i18n.t("未关联目录") }));
      button.disabled = blocked();
      if (state.presentation.surface === "tasks" && !learning && project.id === selected) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => navigateSidebar("project", project.id, scope));
      row.append(button);
      if (project.origin !== "codex" && state.projectsById.has(project.id)) row.append(renderProjectMenu(project, previousMenus.get(project.id)));
      return row;
    });
    if (list) {
      const manualRows = rows.filter((row) => row.dataset.origin !== "codex");
      const codexRows = rows.filter((row) => row.dataset.origin === "codex");
      list.replaceChildren(...(codexRows.length ? [...(manualRows.length ? [element(document, "p", "sidebar-group-heading", fmt(() => i18n.t("手工项目"))), ...manualRows] : []), element(document, "p", "sidebar-group-heading", fmt(() => i18n.t("Codex 自动项目 · 只读"))), ...codexRows] : manualRows));
    }
    if (list && !rows.length) list.append(element(document, "p", "sidebar-empty", fmt(() => state.sidebar.search.trim() ? i18n.t("没有匹配的项目") : i18n.t("暂无项目"))));
    for (const [id, current] of [
      ["sidebar-all", state.presentation.surface === "tasks" && !learning && selected === "all" && archiveFilter.value === "active" && state.presentation.mode !== "next"],
      ["sidebar-next", state.presentation.surface === "tasks" && selected === "all" && archiveFilter.value === "active" && state.presentation.mode === "next"],
      ["sidebar-archive", state.presentation.surface === "tasks" && !learning && selected === "all" && archiveContext],
      ["sidebar-learning", state.presentation.surface === "tasks" && learning],
      ["sidebar-automations", state.presentation.surface === "automations"],
      ["codex-tab", state.presentation.surface === "diagnostics"],
    ]) {
      const button = byId(id); if (!button) continue;
      button.disabled = blocked();
      if (current) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
    const project = callbacks.displayProjectsById().get(selected);
    const title = fmt(() => state.presentation.surface === "automations" ? i18n.t("定时计划") : state.presentation.surface === "diagnostics" ? i18n.t("同步诊断") : learning ? i18n.t("学习安排") : project ? `${i18n.text(displayProjectName(project))}${archiveContext ? i18n.t(" · 归档任务") : ""}` : archiveContext ? i18n.t("归档任务") : state.presentation.mode === "next" ? i18n.t("待处理") : i18n.t("全部项目"));
    if (byId("sidebar-current-project")) i18n.setText(byId("sidebar-current-project"), title);
    if (byId("sidebar-selected-project")) i18n.setText(byId("sidebar-selected-project"), fmt(() => project?.origin === "codex" ? i18n.t("Codex 只读：{p1} · {p2}", { p1: i18n.text(displayProjectName(project)), p2: project.hostId }) : project ? i18n.t("当前项目：{p1}", { p1: i18n.text(displayProjectName(project)) }) : i18n.t("选择手工项目后可编辑或归档")));
    refreshProjectMenuControls();
    const restoredMenu = projectMenus().find((menu) => menu.dataset.sidebarProjectMenu === openMenuId);
    if (restoredMenu && !restoredMenu.hasAttribute("inert")) {
      restoredMenu.open = true; restoredMenu.querySelector("summary").setAttribute("aria-expanded", "true"); positionProjectMenu(restoredMenu);
    }
    if (returnMenuId) state.editor.returnFocus = projectMenus().find((menu) => menu.dataset.sidebarProjectMenu === returnMenuId)?.querySelector("summary") || byId("sidebar-toggle");
    if (focusedProject) {
      const row = rows.find((item) => item.dataset.sidebarProjectRow === focusedProject);
      const target = focusedControl === "menu" ? row?.querySelector("summary") : focusedControl ? row?.querySelector(`[data-sidebar-project-action="${focusedControl}"]`) : row?.querySelector("[data-sidebar-project]");
      const fallback = row?.querySelector("summary") || row?.querySelector("[data-sidebar-project]") || byId("sidebar-project-search");
      (isVisibleControl(target) ? target : isVisibleControl(fallback) ? fallback : null)?.focus({ preventScroll: true });
    }
  }

  function refreshProjectMenuControls() {
    for (const menu of projectMenus()) {
      const id = menu.dataset.sidebarProjectMenu;
      const wasFocused = menu.contains(document.activeElement);
      const edit = canEditProject(id); const archive = canArchiveProject(id);
      menu.querySelector('[data-sidebar-project-action="edit"]').disabled = !edit;
      menu.querySelector('[data-sidebar-project-action="archive"]').disabled = !archive;
      menu.toggleAttribute("inert", !edit && !archive);
      menu.querySelector("summary").setAttribute("aria-disabled", String(!edit && !archive));
      if (!edit && !archive) {
        menu.open = false; menu.querySelector("summary").setAttribute("aria-expanded", "false");
        const row = menu.parentElement.querySelector("[data-sidebar-project]");
        if (wasFocused && isVisibleControl(row)) row.focus({ preventScroll: true });
      }
    }
  }

  function refreshSidebarControls() {
    if (byId("sidebar-new-project")) byId("sidebar-new-project").disabled = byId("new-project").disabled || blocked();
    if (byId("sidebar-project-search")) byId("sidebar-project-search").disabled = blocked();
    for (const button of document.querySelectorAll("#sidebar-all, #sidebar-next, #sidebar-archive, #sidebar-learning, [data-sidebar-project]")) button.disabled = blocked();
    if (byId("sidebar-automations")) byId("sidebar-automations").disabled = blocked() || typeof options.onOpenAutomations !== "function";
    refreshProjectMenuControls();
  }

  function bindSidebar() {
    try {
      const saved = JSON.parse(document.defaultView.localStorage.getItem(SIDEBAR_PREFERENCE_KEY));
      if (saved && !Array.isArray(saved) && typeof saved === "object" && Object.keys(saved).length === 1 && typeof saved.sidebarCollapsed === "boolean") state.sidebar.collapsed = saved.sidebarCollapsed;
    } catch { /* Ignore invalid or inaccessible sidebar preferences. */ }
    byId("sidebar-toggle")?.addEventListener("click", toggleSidebar);
    byId("sidebar-close")?.addEventListener("click", () => closeSidebar());
    byId("sidebar-backdrop")?.addEventListener("click", () => closeSidebar());
    for (const [id, kind] of [["sidebar-all", "all"], ["sidebar-next", "next"], ["sidebar-archive", "archive"], ["sidebar-learning", "learning"], ["sidebar-automations", "automations"]]) byId(id)?.addEventListener("click", () => navigateSidebar(kind));
    byId("sidebar-project-search")?.addEventListener("input", () => { if (blocked()) return; state.sidebar.search = byId("sidebar-project-search").value; renderSidebar(); });
    byId("sidebar-new-project")?.addEventListener("click", () => {
      if (blocked() || byId("new-project").disabled || byId("sidebar-new-project").disabled) return;
      state.sidebar.editorOpener = byId("sidebar-new-project");
      try { byId("new-project").click(); } finally { state.sidebar.editorOpener = null; }
    });
    document.addEventListener("click", (event) => {
      for (const menu of projectMenus()) if (menu.open && !event.composedPath().includes(menu)) {
        const focused = menu.contains(document.activeElement);
        menu.open = false; menu.querySelector("summary").setAttribute("aria-expanded", "false");
        if (focused && isVisibleControl(menu.querySelector("summary"))) menu.querySelector("summary").focus({ preventScroll: true });
      }
    });
    document.addEventListener("focusin", (event) => {
      for (const menu of projectMenus()) if (menu.open && !menu.contains(event.target)) {
        menu.open = false; menu.querySelector("summary").setAttribute("aria-expanded", "false");
      }
    });
    // Run before the existing drawer/editor Escape handlers so this menu is
    // the first layer to close, including inside the mobile focus trap.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !projectMenus().some((menu) => menu.open)) return;
      closeSidebarProjectMenus({ returnFocus: true });
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    const reposition = () => { for (const menu of projectMenus()) positionProjectMenu(menu); };
    document.addEventListener("scroll", reposition, true);
    document.defaultView.addEventListener("resize", reposition);
  }

  return { bindSidebar, sidebarDrawer, syncSidebarVisibility, openSidebar, closeSidebar, toggleSidebar, navigateSidebar, renderSidebar, refreshAttentionCount, refreshSidebarControls, isVisibleControl, navigationBlocked: blocked };
}
