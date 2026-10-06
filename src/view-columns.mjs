import { i18nFor, msg, fmt } from "./i18n.mjs";
import { STATUS_LABELS, PAGE_SIZE, element } from "./view-common.mjs";
import { icon } from "./icons.mjs";
import { DISPLAY_STATUS_LABELS } from "./view-codex-board.mjs";

export function createColumns(context) {
  const { document, state, refs, callbacks } = context;
  const i18n = i18nFor(document);
  const { byId, archiveFilter } = refs;
  const canMove = (...args) => callbacks.canMove(...args);
  const clearDrag = (...args) => callbacks.clearDrag(...args);
  const currentPage = (...args) => callbacks.currentPage(...args);
  const openTask = (...args) => callbacks.openTask(...args);
  const render = (...args) => callbacks.render(...args);
  const renderCard = (...args) => callbacks.renderCard(...args);
  const renderPagination = (...args) => callbacks.renderPagination(...args);
  const startMove = (...args) => callbacks.startMove(...args);

  function renderColumn(status, tasks) {
    const collapsed = callbacks.selectedCodexProject() ? state.codex.collapsed : state.presentation.collapsed;
    const column = element(document, "section", "kanban-column");
    column.dataset.status = status;
    const page = currentPage(status, tasks.length);
    column.dataset.page = String(page);
    column.dataset.pageSize = String(PAGE_SIZE);
    column.classList.toggle("is-collapsed", collapsed.has(status));
    const header = element(document, "div", "column-header");
    const label = DISPLAY_STATUS_LABELS[status];
    const heading = element(document, "h2", "", msg(label));
    const count = element(document, "span", "column-count", String(tasks.length));
    const toggle = element(document, "button");
    toggle.type = "button";
    toggle.dataset.toggleColumn = status;
    toggle.setAttribute("aria-expanded", String(!collapsed.has(status)));
    i18n.bindFormatAttr(toggle, "aria-label", () => i18n.t("{p1}{p2}列", { p1: collapsed.has(status) ? i18n.t("展开") : i18n.t("折叠"), p2: i18n.t(label) }));
    toggle.append(icon(document, collapsed.has(status) ? "right" : "down"));
    toggle.addEventListener("click", () => {
      if (collapsed.has(status)) collapsed.delete(status); else collapsed.add(status);
      render();
      byId("cards").querySelector(`[data-toggle-column="${status}"]`).focus();
    });
    header.append(heading, count, toggle);
    const cards = element(document, "div", "column-cards");
    cards.id = `column-${status}`;
    toggle.setAttribute("aria-controls", cards.id);
    cards.hidden = collapsed.has(status);
    if (!collapsed.has(status)) tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).forEach((task, index) => cards.append(renderCard(task, tasks, page * PAGE_SIZE + index)));
    if (!tasks.length && !collapsed.has(status)) cards.append(element(document, "p", "column-empty", fmt(() => i18n.t("暂无任务"))));
    const add = element(document, "button", "add-task", fmt(() => i18n.t("添加任务")));
    add.type = "button";
    add.prepend(icon(document, "plus"));
    add.hidden = collapsed.has(status);
    i18n.bindFormatAttr(add, "aria-label", () => i18n.t("添加{p1}任务", { p1: i18n.t(label) }));
    add.addEventListener("click", () => openTask(undefined, status));
    column.append(header, cards);
    const pagination = renderPagination(status, tasks.length, page);
    if (pagination) { pagination.hidden = collapsed.has(status); column.append(pagination); }
    if (Object.hasOwn(STATUS_LABELS, status) && !callbacks.selectedCodexProject() && archiveFilter.value !== "archived") column.append(add);
    column.addEventListener("dragover", (event) => {
      if (!Object.hasOwn(STATUS_LABELS, status) || !state.presentation.draggingId || !canMove()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      column.classList.add("is-drop-target");
    });
    column.addEventListener("dragleave", () => column.classList.remove("is-drop-target"));
    column.addEventListener("drop", (event) => {
      if (!Object.hasOwn(STATUS_LABELS, status) || !state.presentation.draggingId || !canMove()) return;
      event.preventDefault();
      const id = state.presentation.draggingId;
      clearDrag();
      startMove(id, status, null);
    });
    return column;
  }

  return { renderColumn };
}
