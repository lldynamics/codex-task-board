import { i18nFor, msg, fmt } from "./i18n.mjs";
import { CODEX_SNAPSHOT_STALE_MS, codexSnapshotSchema } from "./codex-domain.mjs";
import { isValidTimeZone, systemTimeZone } from "./schedule-domain.mjs";

const PAGE_SIZE = 50;
const SOURCE_NAMES = { desktop: "Codex 桌面", "desktop-snapshot": "Codex 桌面快照", "app-server": "Codex app-server", "local-history": "本机历史记录", unavailable: "来源不可用" };
const SOURCE_SCOPE_KEYS = new Set(["本机", "桌面已缓存记录", "桌面已缓存记录（最新原生采集与本地历史；历史运行状态未知）"]);
const SOURCE_ERROR_KEYS = {
  CACHE_INVALID: "Codex 缓存格式不受支持或已损坏。", CACHE_UNSAFE: "Codex 缓存路径不是安全的普通文件或目录。",
  CACHE_READ_FAILED: "无法读取 Codex 缓存；保留上一份有效采集。", FUTURE_SNAPSHOT: "采集时间晚于当前时间。",
  SNAPSHOT_STALE: "Codex 采集已超过预期的采集间隔，请等待原生采集更新。", SOURCE_PARTIAL: "原生采集未覆盖所有桌面记录。",
  SQLITE_TIMEOUT: "Codex 元数据读取超时。", SQLITE_UNAVAILABLE: "Codex 元数据来源不可读或版本不兼容。",
  SQLITE_OUTPUT_LIMIT: "Codex 元数据输出超过读取上限。", METADATA_INVALID: "Codex 元数据包含不兼容记录。",
  SNAPSHOT_MISSING: "尚未收到原生 Codex 采集，显示本地缓存目录。", SOURCE_UNAVAILABLE: "尚未连接 Codex 状态来源。",
};
const READ_ERROR_KEYS = new Set([
  "读取 Codex 状态失败或返回数据不完整。已保留上次数据，请稍后刷新。",
  "读取 Codex 状态超时。已保留上次数据，等待当前请求结束后重试。",
  "无法读取 Codex 状态。已保留上次数据，请稍后刷新。",
  "宿主连接发生错误。已保留上次 Codex 数据，请刷新后重试。",
  "读取已取消。已保留上次 Codex 数据，请刷新后重试。",
  "宿主连接未完成，无法读取 Codex 任务。请重新打开看板后重试。",
]);
const DAYS = { MO: "周一", TU: "周二", WE: "周三", TH: "周四", FR: "周五", SA: "周六", SU: "周日" };
const UNPARSED_SCHEDULE = "已配置计划（规则未解析，请在 Codex 核对）";

export function threadPresentation(thread) {
  if (thread.attention) return { group: "waiting", label: thread.attention === "approval" ? "等待批准" : "等待输入" };
  if (thread.runtimeStatus === "error") return { group: "error", label: "运行异常" };
  if (thread.runtimeStatus === "active" || thread.lastTurnStatus === "running") return { group: "running", label: "运行中" };
  if (thread.goalStatus === "complete") return { group: "ended", label: "目标已完成" };
  if (thread.lastTurnStatus === "failed") return { group: "error", label: "本轮失败" };
  if (thread.lastTurnStatus === "interrupted") return { group: "error", label: "本轮中断" };
  if (thread.goalStatus === "blocked" || thread.goalStatus === "paused") return { group: "waiting", label: thread.goalStatus === "blocked" ? "目标受阻" : "目标已暂停" };
  if (thread.lastTurnStatus === "completed") return { group: "ended", label: thread.goalStatus === "active" ? "本轮结束 · 目标仍进行中" : "本轮结束 · 目标完成情况未知" };
  return { group: "other", label: thread.runtimeStatus === "idle" ? "空闲 · 完成情况未知" : thread.runtimeStatus === "notLoaded" ? "未加载 · 完成情况未知" : "状态未知" };
}

function timeLabel(value, i18n, timeZone) {
  if (!value) return i18n.t("未知（来源未提供）");
  return new Intl.DateTimeFormat(i18n.intlLocale, { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value));
}

function scheduleLabel(automation, i18n) {
  if (!automation.rrule) return i18n.t("运行安排未知");
  const parts = automation.rrule.replace(/^RRULE:/, "").split(";").map((part) => part.split("="));
  if (parts.some((part) => part.length !== 2 || !/^[A-Z]+$/.test(part[0]) || !part[1]) || new Set(parts.map(([key]) => key)).size !== parts.length) return i18n.t(UNPARSED_SCHEDULE);
  const values = Object.fromEntries(parts);
  const shapes = {
    MINUTELY: ["FREQ", "INTERVAL"], HOURLY: ["FREQ", "INTERVAL"],
    DAILY: ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE"], WEEKLY: ["FREQ", "INTERVAL", "BYHOUR", "BYMINUTE", "BYDAY"],
  };
  const supported = Object.hasOwn(shapes, values.FREQ) ? shapes[values.FREQ] : null;
  if (!supported || parts.some(([key]) => !supported.includes(key))) return i18n.t(UNPARSED_SCHEDULE);
  const interval = values.INTERVAL === undefined ? 1 : /^\d+$/.test(values.INTERVAL) ? Number(values.INTERVAL) : NaN;
  if (!Number.isSafeInteger(interval) || interval < 1) return i18n.t(UNPARSED_SCHEDULE);
  if (values.FREQ === "MINUTELY") return interval === 1 ? i18n.t("每分钟") : i18n.t("每 {p1} 分钟", { p1: interval });
  if (values.FREQ === "HOURLY") return interval === 1 ? i18n.t("每小时") : i18n.t("每 {p1} 小时", { p1: interval });
  if (interval !== 1 || !/^\d{1,2}$/.test(values.BYHOUR || "") || Number(values.BYHOUR) > 23 || !/^\d{1,2}$/.test(values.BYMINUTE || "") || Number(values.BYMINUTE) > 59) return i18n.t(UNPARSED_SCHEDULE);
  const time = ` ${values.BYHOUR.padStart(2, "0")}:${values.BYMINUTE.padStart(2, "0")}`;
  if (values.FREQ === "DAILY") return i18n.t("每天{p1}", { p1: time });
  if (values.BYDAY?.split(",").every((day) => Object.hasOwn(DAYS, day))) return i18n.t("每周 {p1}{p2}", { p1: values.BYDAY.split(",").map((day) => i18n.t(DAYS[day])).join(i18n.locale === "en" ? ", " : "、"), p2: time });
  return i18n.t(UNPARSED_SCHEDULE);
}

export function mountCodex(document, options = {}) {
  const i18n = i18nFor(document, { locale: options.locale });
  i18n.bindDocument();
  const window = document.defaultView;
  const byId = (id) => document.getElementById(id);
  const root = byId("codex-panel");
  const manual = byId("manual-board");
  const now = () => new Date(options.now ? options.now() : Date.now()).getTime();
  const displayZone = () => { const zone = options.displayTimeZone?.(); return isValidTimeZone(zone) ? zone : systemTimeZone(); };
  const setTimer = options.setTimeout || window.setTimeout.bind(window);
  const clearTimer = options.clearTimeout || window.clearTimeout.bind(window);
  const pollMs = options.pollMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 10000;
  // The server publishes a window derived from the observed collection cadence.
  const staleLimit = () => options.staleMs ?? snapshot?.sources?.threads?.staleAfterMs ?? CODEX_SNAPSHOT_STALE_MS;
  const listeners = [];
  let snapshot = null; let error = ""; let visible = false; let suspended = false; let disposed = false;
  let returnFocus = null;
  let host = { connected: false };
  let pollTimer = null; let freshnessTimer = null; let flight = null; let failures = 0;
  let automationLimit = PAGE_SIZE;

  function listen(target, type, handler, settings) { target.addEventListener(type, handler, settings); listeners.push(() => target.removeEventListener(type, handler, settings)); }
  function node(tag, className, text) { const result = document.createElement(tag); if (className) result.className = className; if (text !== undefined) i18n.setText(result, text); return result; }
  function button(text, handler, identity) { const result = node("button", "quiet"); result.append(node("span", "", typeof text === "string" ? msg(text) : text)); result.type = "button"; if (identity) result.dataset.codexControl = identity; result.addEventListener("click", handler); return result; }
  function enabled() { return (visible || options.pollInManual === true) && !suspended && !disposed && document.visibilityState !== "hidden"; }
  function threadSourceExpired() {
    const source = snapshot?.sources.threads;
    return source?.state === "disconnected" || (!!source?.lastSuccessAt && now() - Date.parse(source.lastSuccessAt) > staleLimit());
  }
  function displayThread(thread) {
    if (!threadSourceExpired()) return thread;
    return { ...thread, runtimeStatus: "unknown", attention: null, lastTurnStatus: thread.lastTurnStatus === "running" ? null : thread.lastTurnStatus };
  }
  function stopTimer() { if (pollTimer !== null) clearTimer(pollTimer); pollTimer = null; }
  function stopFreshnessClock() { if (freshnessTimer !== null) clearTimer(freshnessTimer); freshnessTimer = null; }
  function armFreshnessClock() {
    stopFreshnessClock();
    if (!enabled() || !snapshot) return;
    freshnessTimer = setTimer(() => { freshnessTimer = null; renderStatus(); if (threadSourceExpired()) renderLists(); armFreshnessClock(); }, pollMs);
  }
  function backoff() { return Math.min(60000, pollMs * 2 ** Math.min(failures, 4)); }
  function queuePoll(delay = backoff()) {
    stopTimer();
    if (!enabled() || flight) return;
    pollTimer = setTimer(() => { pollTimer = null; renderStatus(); if (threadSourceExpired()) renderLists(); if (host.connected) void refresh(); else queuePoll(); }, delay);
  }
  function cancelRead() {
    stopTimer(); stopFreshnessClock();
    if (flight) { flight.cancelled = true; flight.controller.abort(); clearTimer(flight.timer); flight.finishTimeout(false); }
  }
  function sourceErrorText(sourceError) {
    if (!sourceError) return "";
    const key = Object.hasOwn(SOURCE_ERROR_KEYS, sourceError.code) ? SOURCE_ERROR_KEYS[sourceError.code] : null;
    // Only identified system messages are translated. Unrecognized source
    // details and error codes remain literal, even if they resemble UI keys.
    const message = key === sourceError.message ? i18n.t(key) : sourceError.message;
    return i18n.t("source.systemError", { message, code: sourceError.code });
  }
  function sourceText(name, source) {
    if (!source) return i18n.t("{p1}：尚未读取。", { p1: name });
    const mode = source.mode === "live" ? "实时来源" : source.mode === "snapshot" ? "source.snapshotMode" : source.mode === "archive" ? "历史记录，不能反映当前运行状态" : "来源不可用";
    const stale = !!error || source.state === "disconnected" || (!!source.lastSuccessAt && now() - Date.parse(source.lastSuccessAt) > staleLimit());
    const state = source.state === "connected" ? "已连接" : source.state === "partial" ? "部分范围" : source.state === "unsupported" ? "不支持读取" : "已断线";
    return i18n.t("source.summary", { name, mode: i18n.t(mode), status: i18n.t(state), stale: stale ? i18n.t(" · 数据已过期") : "", partial: !source.complete ? i18n.t(" · 数据可能不完整") : "", truncated: source.truncated ? i18n.t(" · 已截断") : "", timeKind: i18n.t(source.mode === "snapshot" ? "最新采集" : "最新成功"), time: timeLabel(source.lastSuccessAt, i18n, displayZone()), error: source.error ? ` · ${sourceErrorText(source.error)}` : "" });
  }
  function renderStatus() {
    byId("codex-refresh").disabled = !host.connected || !!flight || disposed;
    i18n.setText(byId("codex-poll-status"), fmt(() => !enabled() ? i18n.t("自动读取已暂停") : flight ? i18n.t("正在读取…") : !host.connected ? i18n.t("等待宿主连接") : failures ? i18n.t("读取受限 · {p1} 秒后重试", { p1: i18n.number(backoff() / 1000) }) : i18n.t("source.pollStatus", { seconds: i18n.number(pollMs / 1000) })));
    byId("codex-read-error").hidden = !error;
    i18n.setText(byId("codex-read-error"), error && READ_ERROR_KEYS.has(error) ? msg(error) : error);
    if (snapshot) {
      const labels = { connected: "来源已连接", partial: "仅有部分来源可用", disconnected: "来源已断线", unsupported: "当前来源不支持完整读取" };
      i18n.setText(byId("codex-connection"), fmt(() => `${i18n.t(labels[snapshot.connection.state])} · ${i18n.t(SOURCE_NAMES[snapshot.connection.source])}${snapshot.connection.error ? ` · ${sourceErrorText(snapshot.connection.error)}` : ""}${error ? i18n.t(" · 已保留上次数据") : ""}`));
      i18n.setText(byId("codex-observed"), fmt(() => i18n.t("面板最新读取：{p1}；来源最新成功：{p2}", { p1: timeLabel(snapshot.observedAt, i18n, displayZone()), p2: timeLabel(snapshot.connection.lastSuccessAt, i18n, displayZone()) })));
      i18n.setText(byId("codex-scope"), fmt(() => i18n.t("读取范围：{p1}{p2}", { p1: snapshot.connection.scope ? SOURCE_SCOPE_KEYS.has(snapshot.connection.scope) ? i18n.t(snapshot.connection.scope) : snapshot.connection.scope : i18n.t("来源未说明"), p2: snapshot.completeness.truncated ? i18n.t(" · 返回数据已截断") : "" })));
    } else {
      i18n.setText(byId("codex-connection"), fmt(() => host.connected ? i18n.t("尚未读取 Codex 状态") : i18n.t("宿主尚未连接 · 不能读取 Codex 状态")));
      i18n.setText(byId("codex-observed"), fmt(() => i18n.t("最新成功同步：未知")));
      i18n.setText(byId("codex-scope"), fmt(() => i18n.t("读取范围：尚未确认")));
    }
    i18n.setText(byId("codex-thread-source"), fmt(() => sourceText(i18n.t("任务来源"), snapshot?.sources.threads)));
    i18n.setText(byId("codex-automation-source"), fmt(() => sourceText(i18n.t("自动化来源"), snapshot?.sources.automations)));
    i18n.setText(byId("codex-diagnostic-automation-source"), fmt(() => sourceText(i18n.t("自动化来源"), snapshot?.sources.automations)));
    options.onReadState?.({ phase: error ? "error" : snapshot ? "ready" : flight ? "loading" : "waiting" });
  }
  function preserveListFocus(container, render) {
    const active = document.activeElement;
    const identity = container.contains(active) ? active.dataset.codexControl : null;
    render();
    if (identity && !active.isConnected && enabled() && document.activeElement === document.body) {
      [...container.querySelectorAll("[data-codex-control]")].find((item) => item.dataset.codexControl === identity)?.focus({ preventScroll: true });
    }
  }
  async function copyPlanRequest(automation) {
    const next = automation.status === "ACTIVE" ? "automation.pauseVerb" : "automation.resumeVerb";
    const text = i18n.t("请使用 Codex 自动化功能{p1}现有计划。\n计划 ID：{p2}\n仅修改该 ID 的启用状态，保留其任务内容与运行安排。请回复操作结果；若当前宿主不支持，请明确说明未修改。", { p1: i18n.t(next), p2: automation.id });
    const field = byId("codex-request-text");
    const status = byId("codex-copy-status");
    field.value = text;
    try {
      if (!window.navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await window.navigator.clipboard.writeText(text);
      if (disposed) return;
      byId("codex-request-fallback").hidden = true;
      i18n.setText(status, fmt(() => i18n.t("请求已复制，可在 Codex 对话中发送。")));
    } catch {
      if (disposed) return;
      byId("codex-request-fallback").hidden = false;
      field.focus(); field.select();
      i18n.setText(status, fmt(() => i18n.t("请手动复制已选中的请求，在 Codex 对话中发送。")));
    }
  }
  function automationCard(automation) {
    const card = node("article", "codex-card codex-automation-card"); card.dataset.codexAutomation = automation.id;
    const status = msg(automation.status === "ACTIVE" ? "计划启用" : automation.status === "PAUSED" ? "计划暂停" : "计划状态未知");
    const schedule = () => scheduleLabel(automation, i18n);
    card.append(node("span", `codex-badge ${automation.status === "ACTIVE" ? "codex-running" : "codex-other"}`, status), node("h3", "", automation.name),
      node("p", "codex-meta", fmt(() => i18n.t("{p1} · {p2} · 时区：{p3}", { p1: automation.kind === "heartbeat" ? i18n.t("对话定时跟进") : automation.kind === "cron" ? i18n.t("独立计划") : i18n.t("计划类型未知"), p2: schedule(), p3: automation.timeZone || i18n.t("未知") }))),
      node("p", "codex-meta", fmt(() => i18n.t("下次运行：{p1}", { p1: timeLabel(automation.nextRunAt, i18n, displayZone()) }))), node("p", "codex-meta", fmt(() => i18n.t("上次运行：{p1}", { p1: timeLabel(automation.lastRunAt, i18n, displayZone()) }))), node("p", "codex-id", fmt(() => `ID: ${automation.id}`)));
    if (automation.rrule && scheduleLabel(automation, { t: (key) => key }) === UNPARSED_SCHEDULE) card.append(node("p", "codex-meta codex-rule", fmt(() => i18n.t("原始规则：{p1}", { p1: automation.rrule }))));
    if (automation.targetThreadId) card.append(node("p", "codex-id", fmt(() => i18n.t("关联任务：{p1}", { p1: automation.targetThreadId }))));
    if (automation.status !== "unknown") card.append(button(automation.status === "ACTIVE" ? "复制暂停请求" : "复制恢复请求", () => void copyPlanRequest(automation), `plan:${automation.id}`));
    return card;
  }
  function renderLists() {
    const labels = new Map();
    for (const thread of snapshot?.threads || []) {
      const label = threadPresentation(displayThread(thread)).label;
      labels.set(label, (labels.get(label) || 0) + 1);
    }
    i18n.setText(byId("codex-diagnostic-count"), fmt(() => snapshot
      ? i18n.t("已读取 {p1} 项任务{p2}。任务请在工作台查看。{p3}", { p1: i18n.number(snapshot.threads.length), p2: labels.size ? `${i18n.locale === "en" ? ": " : "："}${[...labels].map(([label, count]) => `${i18n.t(label)} ${i18n.number(count)}`).join(" · ")}` : "", p3: snapshot.sources.threads.complete ? "" : i18n.t("来源范围不完整，不能据此判断没有其他任务。") })
      : i18n.t("尚未读取任务数量；是否存在 Codex 任务尚未确认。")));
    const automations = snapshot?.automations || [];
    preserveListFocus(byId("codex-automation-list"), () => byId("codex-automation-list").replaceChildren(...automations.slice(0, automationLimit).map(automationCard)));
    i18n.setText(byId("codex-automation-count"), fmt(() => i18n.t("显示 {p1} / {p2} 项计划", { p1: i18n.number(Math.min(automationLimit, automations.length)), p2: i18n.number(automations.length) })));
    byId("codex-automation-more").hidden = automationLimit >= automations.length;
    byId("codex-automation-empty").hidden = automations.length > 0;
    i18n.setText(byId("codex-automation-empty"), fmt(() => snapshot?.sources.automations.complete ? i18n.t("当前读取范围内没有自动化计划。") : i18n.t("尚无可展示计划；是否存在其他计划尚未确认。")));
  }
  function reportError(message) { if (disposed) return; error = message; renderStatus(); if (threadSourceExpired()) renderLists(); options.onReadError?.(message); }
  function acceptReadResult(result) {
    if (disposed) return false;
    const payload = result?.structuredContent;
    const parsed = payload?.ok === true && !result?.isError ? codexSnapshotSchema.safeParse(payload.snapshot) : { success: false };
    if (!parsed.success) { reportError("读取 Codex 状态失败或返回数据不完整。已保留上次数据，请稍后刷新。"); return false; }
    if (snapshot && Date.parse(parsed.data.observedAt) < Date.parse(snapshot.observedAt)) return true;
    snapshot = parsed.data; error = ""; renderStatus(); renderLists(); options.onSnapshot?.(snapshot); armFreshnessClock(); return true;
  }
  function refresh() {
    if (flight) return flight.result;
    if (!host.connected || disposed || !enabled() || !options.refresh) return Promise.resolve(false);
    stopTimer();
    const operation = { controller: new window.AbortController(), cancelled: false, timedOut: false, timer: null, finishTimeout: null, result: null };
    flight = operation;
    const timeout = new Promise((resolve) => {
      operation.finishTimeout = resolve;
      operation.timer = setTimer(() => {
        operation.timedOut = true; failures += 1; operation.controller.abort();
        reportError("读取 Codex 状态超时。已保留上次数据，等待当前请求结束后重试。"); resolve(false);
      }, timeoutMs);
    });
    const work = Promise.resolve().then(() => options.refresh({ signal: operation.controller.signal })).then((result) => {
      if (operation.cancelled || operation.timedOut || disposed) return false;
      const accepted = acceptReadResult(result);
      if (!accepted || ["disconnected", "unsupported"].includes(snapshot?.connection.state) || Object.values(snapshot?.sources || {}).some((source) => source.mode === "unavailable" || ["disconnected", "unsupported"].includes(source.state))) failures += 1;
      else failures = 0;
      return accepted;
    }).catch(() => {
      if (!operation.cancelled && !operation.timedOut && !disposed) { failures += 1; reportError("无法读取 Codex 状态。已保留上次数据，请稍后刷新。"); }
      return false;
    }).finally(() => {
      clearTimer(operation.timer);
      if (flight === operation) { flight = null; if (!disposed) { renderStatus(); queuePoll(); } }
    });
    operation.result = Promise.race([work, timeout]); renderStatus(); return operation.result;
  }

  function visibleControl(target) {
    if (!target?.isConnected || target.disabled || target.closest("[hidden], [inert]")) return false;
    const style = window.getComputedStyle(target);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function manualModal() {
    return [...manual.querySelectorAll('[aria-modal="true"]')].find((node) => !node.closest("[hidden]"));
  }
  function restoreManualFocus() {
    const modal = manualModal();
    if (modal) {
      if (!modal.contains(document.activeElement)) [...modal.querySelectorAll("button, input, select, textarea, [tabindex]")].find(visibleControl)?.focus({ preventScroll: true });
      return;
    }
    const target = [returnFocus, byId("sidebar-toggle"), byId("manual-tab")].find(visibleControl);
    target?.focus({ preventScroll: true });
  }
  function setVisible(value, surface = "diagnostics", fromSidebar = false) {
    if (disposed || options.beforeSurfaceChange?.(!!value, { fromSidebar }) === false) return false;
    if (value && !visible) returnFocus = manual.contains(document.activeElement) && !root.contains(document.activeElement) ? document.activeElement : null;
    visible = !!value; root.hidden = !visible;
    manual.hidden = false;
    byId("task-surface").hidden = visible;
    if (visible) {
      surface = surface === "automations" ? "automations" : "diagnostics";
      root.dataset.surface = surface;
      byId("codex-diagnostics").hidden = surface !== "diagnostics";
      for (const section of root.querySelectorAll(".codex-automations")) section.hidden = surface !== "automations";
      i18n.setText(byId("codex-surface-title"), fmt(() => surface === "automations" ? i18n.t("定时计划") : i18n.t("同步诊断")));
      i18n.setText(byId("codex-surface-description"), fmt(() => surface === "automations" ? i18n.t("查看已有定时计划；创建或调整计划请直接在 Codex 对话中提出。") : i18n.t("核对数据来源、读取范围与错误；Codex 任务统一显示在工作台。")));
    }
    options.onSurfaceChange?.(visible, surface);
    if (!visible) restoreManualFocus();
    if (!enabled()) cancelRead();
    else if (host.connected) void refresh(); else queuePoll();
    renderStatus(); if (visible && threadSourceExpired()) renderLists(); armFreshnessClock();
    return true;
  }
  function openAutomations() {
    if (!setVisible(true, "automations")) return false;
    root.scrollTop = 0;
    byId("codex-automations-heading")?.focus();
    return true;
  }
  listen(byId("manual-tab"), "click", () => setVisible(false));
  listen(byId("codex-tab"), "click", () => { if (setVisible(true, "diagnostics", true)) byId("codex-surface-title").focus(); });
  if (byId("codex-back-to-board")) listen(byId("codex-back-to-board"), "click", () => setVisible(false));
  // Plan controls own their keyboard input, while the shared sidebar stays active.
  listen(root, "keydown", (event) => event.stopPropagation());
  listen(byId("codex-refresh"), "click", () => void refresh());
  listen(byId("codex-automation-more"), "click", () => { automationLimit += PAGE_SIZE; renderLists(); });
  const suspend = () => { suspended = true; cancelRead(); renderStatus(); };
  const resume = () => { if (disposed) return; suspended = false; if (enabled()) { if (host.connected) void refresh(); else queuePoll(); } renderStatus(); if (threadSourceExpired()) renderLists(); armFreshnessClock(); };
  listen(window, "pagehide", suspend); listen(window, "pageshow", resume);
  listen(document, "visibilitychange", () => document.visibilityState === "hidden" ? (cancelRead(), renderStatus()) : resume());
  const collectionNotice = byId("codex-collection-notice") || node("p", "helper");
  collectionNotice.id = "codex-collection-notice";
  i18n.setText(collectionNotice, msg("source.collectionNotice"));
  if (!collectionNotice.isConnected) byId("codex-poll-status").after(collectionNotice);
  renderStatus(); renderLists();
  return {
    acceptReadResult, refresh, reportError, setVisible, openAutomations,
    setHostState(value) { if (disposed) return; host = { ...host, ...value }; if (!host.connected) cancelRead(); else if (enabled()) void refresh(); renderStatus(); if (enabled() && !flight) queuePoll(); armFreshnessClock(); },
    dispose() { if (disposed) return; disposed = true; cancelRead(); listeners.splice(0).forEach((remove) => remove()); },
  };
}
