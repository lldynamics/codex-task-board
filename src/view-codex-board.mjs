import { i18nFor, fmt } from "./i18n.mjs";
import { projectCodexSnapshot } from "./codex-board.mjs";
import { CODEX_SNAPSHOT_STALE_MS, codexSnapshotSchema } from "./codex-domain.mjs";
import { STATUS_LABELS, COLUMN_ORDER, element } from "./view-common.mjs";
import { isMutating } from "./write-state.mjs";

// Only the minute-level label changes during the five-second freshness check.
export function relativeCollectedTime(value, now, i18n) {
  const collected = Date.parse(value);
  if (!Number.isFinite(collected)) return i18n ? i18n.t("采集时间未知") : "采集时间未知";
  const minutes = Math.max(0, Math.floor((now - collected) / 60000));
  if (minutes < 1) return i18n ? i18n.t("刚刚采集") : "刚刚采集";
  if (i18n?.locale === "en") return i18n.relative(-Math.floor(minutes < 60 ? minutes : minutes < 1440 ? minutes / 60 : minutes / 1440), minutes < 60 ? "minute" : minutes < 1440 ? "hour" : "day");
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

export const DISPLAY_STATUS_LABELS = { ...STATUS_LABELS, idle: "空闲", not_loaded: "未加载", unknown: "状态未知", turn_ended: "本轮结束" };
const SECONDARY_COLUMN_ORDER = ["idle", "not_loaded", "unknown", "turn_ended"];
export const DISPLAY_COLUMN_ORDER = [...COLUMN_ORDER, ...SECONDARY_COLUMN_ORDER];

export function createCodexBoard({ document, state, options, refs, callbacks }) {
  const i18n = i18nFor(document);
  const window = document.defaultView;
  const now = () => new Date(options.now ? options.now() : Date.now()).getTime();
  const staleMs = options.staleMs ?? CODEX_SNAPSHOT_STALE_MS;
  const setTimer = options.setTimeout || window.setTimeout.bind(window);
  const clearTimer = options.clearTimeout || window.clearTimeout.bind(window);
  let timer = null; let disposed = false; let suspended = false; let layoutPending = false;
  let otherStatusesExpanded = false;
  let manualProjects; let automaticProjects; let mergedProjects = new Map();
  const displayProjects = () => [...state.board.projects, ...state.codex.projection.projects];
  const displayTasks = () => [...state.board.tasks, ...state.codex.projection.tasks];
  function displayProjectsById() {
    if (manualProjects !== state.board.projects || automaticProjects !== state.codex.projection.projects) {
      manualProjects = state.board.projects; automaticProjects = state.codex.projection.projects;
      mergedProjects = new Map(displayProjects().map((project) => [project.id, project]));
    }
    return mergedProjects;
  }
  const selectedCodexProject = () => refs.projectFilter.value !== "all" && displayProjectsById().get(refs.projectFilter.value)?.origin === "codex";
  const canCreateManualTask = () => refs.projectFilter.value === "all" || state.projectsById.has(refs.projectFilter.value);
  function displayColumns(tasks) {
    const occupied = new Set(tasks.map((task) => task.status));
    if (selectedCodexProject()) return DISPLAY_COLUMN_ORDER.filter((status) => occupied.has(status));
    if (!tasks.some((task) => task.origin === "codex" || task.readOnly)) return [...COLUMN_ORDER];
    return DISPLAY_COLUMN_ORDER.filter((status) => COLUMN_ORDER.includes(status) || occupied.has(status));
  }
  function renderBoardColumns(tasks) {
    const statuses = displayColumns(tasks).filter((status) => refs.statusFilter.value === "all" || refs.statusFilter.value === status);
    const tasksByStatus = new Map(statuses.map((status) => [status, []]));
    for (const task of tasks) tasksByStatus.get(task.status)?.push(task);
    const renderColumns = (values) => values.map((status) => callbacks.renderColumn(status, tasksByStatus.get(status)));
    const secondary = statuses.filter((status) => SECONDARY_COLUMN_ORDER.includes(status));
    if (state.presentation.mode !== "board" || !secondary.length) return renderColumns(statuses);

    const nodes = [];
    const primary = statuses.filter((status) => !SECONDARY_COLUMN_ORDER.includes(status));
    if (primary.length) {
      const main = element(document, "div", "board-main-columns");
      main.setAttribute("role", "group");
      i18n.bindFormatAttr(main, "aria-label", () => i18n.t("任务主流程"));
      main.append(...renderColumns(primary));
      nodes.push(main);
    }
    // Read the current DOM before replacing it, including native details toggles
    // whose asynchronous toggle event has not run yet.
    const previous = refs.byId("cards")?.querySelector("[data-other-statuses]");
    if (previous && previous.dataset.autoExpanded !== "true") otherStatusesExpanded = previous.open;
    const secondaryCount = secondary.reduce((count, status) => count + tasksByStatus.get(status).length, 0);
    const focusedId = document.activeElement?.closest?.("[data-task-id]")?.dataset.taskId;
    const focusedTask = tasks.find((task) => task.id === focusedId);
    const autoExpanded = Boolean(refs.search.value.trim() || refs.statusFilter.value !== "all"
      || refs.sourceFilter.value !== "all" || refs.recordFilter.value !== "all" || (secondaryCount && tasks.every((task) => SECONDARY_COLUMN_ORDER.includes(task.status)))
      || (focusedTask && SECONDARY_COLUMN_ORDER.includes(focusedTask.status)));
    const other = element(document, "details", "board-secondary-statuses");
    other.dataset.otherStatuses = "";
    other.dataset.autoExpanded = String(autoExpanded);
    other.open = otherStatusesExpanded || autoExpanded;
    const summary = element(document, "summary");
    summary.dataset.toggleOtherStatuses = "";
    summary.setAttribute("aria-expanded", String(other.open));
    summary.setAttribute("aria-controls", "board-secondary-columns");
    summary.addEventListener("click", () => { otherStatusesExpanded = !other.open; });
    summary.append(element(document, "span", "", fmt(() => i18n.t("其他来源状态"))), element(document, "span", "secondary-status-count", fmt(() => i18n.t("{p1} 项", { p1: secondaryCount }))),
      element(document, "span", "secondary-status-breakdown", fmt(() => secondary.map((status) => `${i18n.t(DISPLAY_STATUS_LABELS[status])} ${tasksByStatus.get(status).length}`).join(" · "))));
    const columns = element(document, "div", "board-secondary-columns");
    columns.id = "board-secondary-columns";
    columns.append(...renderColumns(secondary));
    other.append(summary, columns);
    other.addEventListener("toggle", () => {
      if (!other.isConnected) return;
      summary.setAttribute("aria-expanded", String(other.open));
      if (!autoExpanded || !other.open) otherStatusesExpanded = other.open;
    });
    nodes.push(other);
    return nodes;
  }
  function renderCodexSource() {
    const banner = refs.byId("codex-board-status");
    if (!banner) return;
    banner.hidden = state.presentation.surface !== "tasks" || ["today", "week"].includes(state.presentation.mode) || (!state.codex.read.managed && !state.codex.snapshot && !state.codex.error);
    if (!state.codex.snapshot) {
      i18n.setText(refs.byId("codex-board-source"), fmt(() => state.codex.error || state.codex.read.phase === "error"
        ? i18n.t("Codex 任务读取失败 · 当前仅显示已读取的本机任务，数量暂不完整。可在同步诊断中刷新重试。")
        : i18n.t("正在读取 Codex 任务… · 当前数量暂不完整，读取完成后自动更新。")));
      return;
    }
    const source = state.codex.projection.source;
    const labels = { live: "实时来源", snapshot: "桌面快照 · 按分钟采集", archive: "历史记录 · 当前运行情况未知", unavailable: "来源不可用" };
    const captured = () => source?.lastSuccessAt ? i18n.date(source.lastSuccessAt, { timeZone: state.schedule.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }) : i18n.t("未知");
    const node = refs.byId("codex-board-source");
    const warning = () => `${state.codex.projection.freshness?.expired ? i18n.t(" · 数据已过期，当前状态未知") : ""}${source && !source.complete ? i18n.t(" · 部分范围，数量不完整") : ""}${source?.truncated ? i18n.t(" · 已截断") : ""}${state.codex.error ? i18n.t(" · 读取失败，展示上次快照") : ""}`;
    i18n.setText(node, fmt(() => i18n.t("codex.read-summary", { result: i18n.t(state.codex.error ? "读取失败" : "读取完成"), time: relativeCollectedTime(source?.lastSuccessAt, now(), i18n), warning: warning() })));
    i18n.bindFormatAttr(node, "title", () => i18n.t("自动记录只读 · {p1} · 最新采集（{zone}）：{p2}{p3}", { zone: state.schedule.timeZone, p1: i18n.t(labels[source?.mode] || "尚未读取"), p2: captured(), p3: warning() }));
  }
  function setCodexReadState(value) {
    if (disposed || !["waiting", "loading", "ready", "error"].includes(value?.phase)) return;
    state.codex.read = { managed: true, phase: value.phase };
    renderCodexSource();
    callbacks.renderTaskCount();
    for (const badge of document.querySelectorAll("[data-sidebar-count]")) badge.dataset.complete = String(!callbacks.codexCountNotice());
  }
  function reproject() {
    if (!state.codex.snapshot) return false;
    const projection = projectCodexSnapshot(state.codex.snapshot, { now: now(), staleMs: options.staleMs ?? state.codex.snapshot?.sources?.threads?.staleAfterMs ?? staleMs });
    const signature = JSON.stringify({ projects: projection.projects, tasks: projection.tasks, runtimeReliable: projection.freshness.runtimeReliable });
    const changed = signature !== state.codex.signature;
    state.codex.projection = projection; state.codex.signature = signature;
    return changed;
  }
  function renderProjection() {
    if (state.presentation.draggingId || isMutating(state)) { layoutPending = true; renderCodexSource(); return; }
    layoutPending = false; callbacks.render({ followFocusedTask: true });
  }
  function stopClock() { if (timer !== null) clearTimer(timer); timer = null; }
  function armClock() {
    stopClock();
    if (disposed || suspended || !state.codex.snapshot || document.visibilityState === "hidden") return;
    timer = setTimer(() => { timer = null; if (reproject() || layoutPending) renderProjection(); else renderCodexSource(); armClock(); }, 5000);
  }
  function setCodexSnapshot(value) {
    if (disposed) return false;
    const parsed = codexSnapshotSchema.safeParse(value);
    if (!parsed.success) { safeCodexError("Codex 快照格式不完整，已保留上次自动任务。"); return false; }
    if (state.codex.snapshot && Date.parse(parsed.data.observedAt) < Date.parse(state.codex.snapshot.observedAt)) return true;
    state.codex.snapshot = parsed.data; state.codex.error = ""; state.codex.read.phase = "ready";
    if (reproject() || layoutPending) renderProjection(); else renderCodexSource();
    callbacks.renderTaskCount();
    armClock(); return true;
  }
  function safeCodexError(message) {
    if (disposed) return;
    state.codex.error = message;
    state.codex.read.phase = "error";
    if (reproject()) renderProjection(); else renderCodexSource();
    callbacks.renderTaskCount();
    armClock();
  }
  async function openCodexTask(task) {
    const id = task.threadId;
    refs.byId("codex-board-thread-id").value = id;
    const status = refs.byId("codex-board-interaction");
    try {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !options.openThread) throw new Error("Opening unavailable");
      const result = await options.openThread(id, task.hostId);
      if (result?.isError) throw new Error("Opening rejected");
      i18n.setText(status, fmt(() => i18n.t("已向宿主请求打开 Codex 原任务。")));
    } catch { refs.byId("codex-board-id-fallback").hidden = false; i18n.setText(status, fmt(() => i18n.t("无法打开原任务，请复制 ID 在 Codex 查找（主机：{p1}）。", { p1: task.hostId }))); }
  }
  async function copyCodexTaskId(task) {
    const input = refs.byId("codex-board-thread-id"); input.value = task.threadId;
    try { if (!window.navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await window.navigator.clipboard.writeText(task.threadId); i18n.setText(refs.byId("codex-board-interaction"), fmt(() => i18n.t("Codex 原任务 ID 已复制。"))); }
    catch { refs.byId("codex-board-id-fallback").hidden = false; input.focus(); input.select(); i18n.setText(refs.byId("codex-board-interaction"), fmt(() => i18n.t("请手动复制已选中的 Codex 原任务 ID。"))); }
  }
  const suspend = () => { suspended = true; stopClock(); };
  const resume = () => { if (disposed) return; suspended = false; if (document.visibilityState !== "hidden") { if (reproject() || layoutPending) renderProjection(); armClock(); } else stopClock(); };
  document.addEventListener("visibilitychange", resume); window.addEventListener("pagehide", suspend); window.addEventListener("pageshow", resume);
  function disposeCodexBoard() { disposed = true; stopClock(); document.removeEventListener("visibilitychange", resume); window.removeEventListener("pagehide", suspend); window.removeEventListener("pageshow", resume); }
  return { displayProjects, displayTasks, displayProjectsById, selectedCodexProject, canCreateManualTask, displayColumns, renderBoardColumns, renderCodexSource, setCodexReadState, setCodexSnapshot, safeCodexError, openCodexTask, copyCodexTaskId, disposeCodexBoard };
}
