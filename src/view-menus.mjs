// Native details remain in the card tree. Only their floating control position
// is managed here, so rerenders can restore open menus and keyboard focus.
export function createMenus({ document, state, refs, callbacks }) {
  const { byId } = refs;
  const visible = (node) => node?.isConnected && !node.closest("[hidden], [inert]")
    && (!node.closest("details:not([open])") || node.matches("summary"));
  const cardMenus = () => [...document.querySelectorAll(".card-actions[open]")];

  function closeCardMenus({ returnFocus = false, except = null } = {}) {
    for (const menu of cardMenus()) {
      if (menu === except) continue;
      menu.open = false;
      const trigger = menu.querySelector("summary");
      trigger.setAttribute("aria-expanded", "false");
      if (returnFocus && visible(trigger)) trigger.focus({ preventScroll: true });
    }
  }

  function closeFilters({ returnFocus = true } = {}) {
    state.presentation.filterOpen = false;
    const panel = byId("filter-panel");
    const trigger = byId("filter-toggle");
    if (panel) panel.hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (returnFocus && visible(trigger) && !callbacks.compactEditor() && !state.editor.pendingAction) trigger.focus({ preventScroll: true });
  }

  function closeProjectMenu({ returnFocus = false } = {}) {
    const menu = byId("project-menu");
    if (!menu) return;
    menu.open = false;
    const summary = menu.querySelector("summary");
    summary.setAttribute("aria-expanded", "false");
    if (returnFocus && visible(summary)) summary.focus({ preventScroll: true });
  }

  function openFilters() {
    if (!byId("filter-panel") || callbacks.compactEditor() || state.editor.pendingAction || callbacks.sidebarDrawer()) return;
    closeProjectMenu();
    closeCardMenus();
    state.presentation.filterOpen = true;
    byId("filter-panel").hidden = false;
    byId("filter-toggle").setAttribute("aria-expanded", "true");
    byId("filter-panel").querySelector("select:not(:disabled)")?.focus();
  }

  function positionCardMenu(menu) {
    if (!menu.open || !menu.isConnected) return;
    const trigger = menu.querySelector("summary");
    const controls = menu.querySelector(".move-controls");
    trigger.setAttribute("aria-expanded", "true");
    const rect = trigger.getBoundingClientRect();
    const window = document.defaultView;
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;
    const width = Math.min(280, Math.max(1, viewportWidth - 16));
    controls.style.width = `${width}px`;
    controls.style.maxHeight = `${Math.max(1, viewportHeight - 16)}px`;
    const height = Math.min(controls.scrollHeight || 180, viewportHeight - 16);
    const left = Math.min(Math.max(8, rect.right - width), Math.max(8, viewportWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + height <= viewportHeight - 8 ? below : Math.max(8, rect.top - height - 6);
    controls.style.left = `${left}px`;
    controls.style.top = `${top}px`;
  }

  function repositionMenus() { for (const menu of cardMenus()) positionCardMenu(menu); }

  function prepareCardMenu(menu) {
    const summary = menu.querySelector("summary");
    summary.setAttribute("aria-expanded", String(menu.open));
    summary.setAttribute("aria-haspopup", "true");
    menu.addEventListener("toggle", () => {
      if (!menu.isConnected) return;
      summary.setAttribute("aria-expanded", String(menu.open));
      if (!menu.open) return;
      closeCardMenus({ except: menu });
      closeFilters({ returnFocus: false });
      closeProjectMenu();
      positionCardMenu(menu);
    });
    summary.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();
      menu.open = true;
      positionCardMenu(menu);
      menu.querySelector("button:not(:disabled), select:not(:disabled)")?.focus();
    });
  }

  function syncMenus() {
    if (callbacks.compactEditor() || state.editor.pendingAction) {
      closeFilters({ returnFocus: false });
      closeProjectMenu();
      closeCardMenus();
    } else if (callbacks.sidebarDrawer()) {
      closeFilters({ returnFocus: false });
      closeCardMenus();
    }
  }

  function bindMenus() {
    byId("filter-toggle")?.addEventListener("click", () => state.presentation.filterOpen ? closeFilters() : openFilters());
    byId("filter-close")?.addEventListener("click", () => closeFilters());
    byId("project-menu")?.addEventListener("toggle", () => {
      const menu = byId("project-menu");
      if (!menu?.isConnected) return;
      menu.querySelector("summary").setAttribute("aria-expanded", String(menu.open));
      if (menu.open) { closeFilters({ returnFocus: false }); closeCardMenus(); }
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      // Clearing a chip rebuilds its container before this bubbling listener.
      // The event path still identifies that click as part of the filters.
      const clickedChip = event.composedPath().includes(byId("filter-chips"));
      if (state.presentation.filterOpen && !byId("filter-panel").contains(target) && !byId("filter-toggle").contains(target) && !clickedChip) closeFilters({ returnFocus: byId("filter-panel").contains(document.activeElement) });
      const projectMenu = byId("project-menu");
      if (projectMenu?.open && !projectMenu.contains(target)) closeProjectMenu({ returnFocus: projectMenu.contains(document.activeElement) });
      for (const menu of cardMenus()) if (!menu.contains(target)) {
        const restore = menu.contains(document.activeElement);
        menu.open = false;
        menu.querySelector("summary").setAttribute("aria-expanded", "false");
        if (restore && visible(menu.querySelector("summary"))) menu.querySelector("summary").focus({ preventScroll: true });
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || state.editor.pendingAction) return;
      if (state.presentation.filterOpen) closeFilters();
      else if (byId("project-menu")?.open) closeProjectMenu({ returnFocus: true });
      else if (cardMenus().length) closeCardMenus({ returnFocus: true });
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    });
    document.addEventListener("scroll", repositionMenus, true);
    document.defaultView.addEventListener("resize", repositionMenus);
  }

  return { bindMenus, closeFilters, closeProjectMenu, closeCardMenus, prepareCardMenu, repositionMenus, syncMenus };
}
