import { i18nFor, msg, fmt } from "./i18n.mjs";
import { element, ERROR_MESSAGES } from "./view-common.mjs";
import { isValidTimeZone, MAX_SESSION_DURATION_MS } from "./schedule-domain.mjs";
import { dateInZone, timeInZone, localToInstant, weekDates, addDays } from "./calendar-time.mjs";
import { isBusy, isMutating, slotUncertain, slotNeedsRefresh, canRetrySlot, hasExpiredWrites } from "./write-state.mjs";
import { timeZoneChoices } from "./time-zone-choices.mjs";

const LABELS = { scheduled: "已安排", completed: "本次已完成", not_completed: "本次未完成", cancelled: "已取消" };
const fieldIds = ["session-task", "session-date", "session-start", "session-end-date", "session-end", "session-zone", "session-objective", "session-criteria", "session-outcome", "session-minutes", "session-feedback"];
export const validTimeZone = isValidTimeZone;

export function createSchedule({ document, state, options, refs, callbacks }) {
  const i18n = i18nFor(document);
  const { byId } = refs;
  const now = () => new Date(options.now ? options.now() : Date.now()).toISOString();
  const today = () => dateInZone(now(), state.schedule.timeZone);
  const ownScheduleAction = () => !!state.schedule.draft && ["save_session", "record_session_feedback"].includes(state.writes.action?.request.operation.type)
    && (state.schedule.draft.id ? (state.writes.action.request.operation.session?.id || state.writes.action.request.operation.sessionId) === state.schedule.draft.id : state.writes.action.request.operation.type === "save_session");
  const frozen = () => ownScheduleAction() && slotUncertain(state.writes.action);
  const snapshot = () => JSON.stringify(fieldIds.map((id) => byId(id).value));
  const dirty = () => !!state.schedule.draft && snapshot() !== state.schedule.snapshot;
  const availableTask = (id) => state.board.tasks.find((task) => task.id === id);
  const editableSession = (session) => session?.status === "scheduled" && Date.parse(session.startAt) > Date.parse(now());
  const feedbackSession = (session) => !!session && session.status !== "cancelled";
  const canOpen = () => state.host.connected && state.host.loaded && !isBusy(state) && !state.writes.save && !state.writes.move && !state.writes.action && !state.fieldEdit && !state.backup.preview && !state.editor.pendingAction && !hasExpiredWrites(state);
  const compactSchedule = () => state.presentation.surface === "tasks" && !byId("manual-board")?.hidden && !!state.schedule.draft && document.defaultView.innerWidth <= 800;

  function refreshDisplayTimeZones() {
    const select = byId("display-time-zone");
    if (![...select.options].some((option) => option.value === state.schedule.timeZone)) {
      select.replaceChildren(...timeZoneChoices({ timeZone: state.schedule.timeZone, intl: document.defaultView.Intl, i18n }).map((group) => {
        const node = element(document, "optgroup");
        i18n.bindFormatAttr(node, "label", () => i18n.text(group.displayLabel));
        node.append(...group.options.map((entry) => {
          const option = element(document, "option", "", entry.displayLabel);
          option.value = entry.value;
          return option;
        }));
        return node;
      }));
    }
    select.value = state.schedule.timeZone;
  }

  function dayBounds(date) {
    // Locate the first instant of a civil date, including zones whose DST
    // transition skips midnight. Dates remain calendar values, never UTC slices.
    function boundary(value) {
      const utc = Date.parse(`${value}T00:00:00.000Z`);
      let low = utc - 36 * 3600000; let high = utc + 36 * 3600000;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (dateInZone(mid, state.schedule.timeZone) < value) low = mid; else high = mid;
      }
      return high;
    }
    return [boundary(date), boundary(addDays(date, 1))];
  }

  // Keep native disclosure state only in this mounted view. It contains no
  // learning text and never enters browser preferences or mutation requests.
  const disclosureStates = new Map();
  let pendingCalendarFocus = null;
  const disclosureKey = (kind, date, id) => `${kind}:${state.schedule.timeZone}:${date}:${id}`;

  function focusIdentity(node) {
    if (!node) return null;
    const disclosure = node.matches?.("summary") ? node.parentElement?.dataset.calendarDisclosureKey : null;
    if (disclosure) return { disclosure };
    const card = node.closest?.("[data-session-id][data-session-date]");
    if (!card) return null;
    return { sessionId: card.dataset.sessionId, date: card.dataset.sessionDate, action: node.dataset.sessionAction || null };
  }

  function captureCalendar() {
    const root = byId("cards");
    for (const details of root.querySelectorAll("details[data-calendar-disclosure-key]")) disclosureStates.set(details.dataset.calendarDisclosureKey, details.open);
    if (root.contains(document.activeElement)) pendingCalendarFocus = focusIdentity(document.activeElement);
    // Bound navigation-only memory when users browse many different weeks.
    while (disclosureStates.size > 2048) disclosureStates.delete(disclosureStates.keys().next().value);
  }

  function resolveCalendarFocus(identity) {
    if (!identity) return null;
    let target;
    if (identity.disclosure) target = [...byId("cards").querySelectorAll("details[data-calendar-disclosure-key]")].find((node) => node.dataset.calendarDisclosureKey === identity.disclosure)?.querySelector("summary");
    else {
      const card = [...byId("cards").querySelectorAll("[data-session-id][data-session-date]")].find((node) => node.dataset.sessionId === identity.sessionId && node.dataset.sessionDate === identity.date);
      target = identity.action ? card?.querySelector(`[data-session-action="${identity.action}"]`) || card?.querySelector("[data-session-task]") : card?.querySelector("[data-session-task]");
    }
    // A status change may move the focused card into newly folded history.
    // Return to its reachable summary rather than opening history implicitly.
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) if (parent.matches("details:not([open])")) target = parent.querySelector("summary");
    return target;
  }

  function restoreCalendarFocus() {
    if (!pendingCalendarFocus || isBusy(state) || state.schedule.draft || state.editor.kind || state.editor.pendingAction) return;
    const active = document.activeElement;
    if (active !== document.body && active?.isConnected && !byId("cards").contains(active)) { pendingCalendarFocus = null; return; }
    const target = resolveCalendarFocus(pendingCalendarFocus);
    if (callbacks.isVisibleControl(target)) target.focus({ preventScroll: true });
    pendingCalendarFocus = null;
  }

  function nativeDisclosure(className, key, label, body) {
    const details = element(document, "details", className);
    details.dataset.calendarDisclosureKey = key;
    details.open = disclosureStates.get(key) === true;
    details.append(element(document, "summary", `${className}-toggle`, typeof label === "string" ? msg(label) : label), body);
    details.addEventListener("toggle", () => {
      // Toggle is queued by the browser; discarded DOM must not overwrite the
      // state of a newer card rendered for the same session/date key.
      if (details.isConnected) disclosureStates.set(key, details.open);
    });
    return details;
  }

  function sessionDetails(session, task, compact, fullTime) {
    const body = element(document, "div", "session-details-body");
    if (compact) body.append(element(document, "p", "session-detail", fmt(() => i18n.t("任务：{p1}", { p1: task?.title || i18n.t("任务已不可用") }))));
    if (fullTime) body.append(element(document, "p", "session-detail session-full-time", fullTime));
    body.append(element(document, "p", "session-detail", fmt(() => i18n.t("本次目标：{p1}", { p1: session.objective || i18n.t("未填写") }))), element(document, "p", "session-detail", fmt(() => i18n.t("完成标准：{p1}", { p1: session.completionCriteria || i18n.t("未填写") }))));
    if (["completed", "not_completed"].includes(session.status)) body.append(element(document, "p", "session-feedback-text", fmt(() => i18n.t("实际学习：{p1}；反馈：{p2}", { p1: session.actualMinutes === null ? i18n.t("未填写") : i18n.t("{p1} 分钟", { p1: session.actualMinutes }), p2: session.feedback || i18n.t("未填写") }))));
    const actions = element(document, "div", "session-actions");
    for (const [kind, label] of [["edit", "编辑时段"], ["feedback", session.status === "scheduled" ? "记录本次结果" : "修改本次反馈"], ["cancel", "取消时段"]]) {
      if (kind === "edit" && !editableSession(session) || kind === "feedback" && !feedbackSession(session) || kind === "cancel" && session.status !== "scheduled") continue;
      const button = element(document, "button", "quiet", msg(label));
      button.type = "button"; button.dataset.sessionAction = kind;
      button.addEventListener("click", () => kind === "cancel" ? callbacks.startAction({ type: "cancel_session", sessionId: session.id }) : openSession(session.id, kind === "feedback" ? "feedback" : "session"));
      actions.append(button);
    }
    body.append(actions);
    return body;
  }

  function renderSession(session, date, { compact = false, focusId = null, instant, dayRange } = {}) {
    const task = availableTask(session.taskId);
    const highlighted = session.id === focusId;
    const card = element(document, "article", `session-card session-${session.status}${highlighted ? " is-next" : ""}`);
    card.dataset.sessionId = session.id; card.dataset.sessionDate = date;
    const zone = state.schedule.timeZone;
    const startAt = Date.parse(session.startAt); const endAt = Date.parse(session.endAt);
    const startDate = dateInZone(startAt, zone); const endDate = dateInZone(endAt, zone);
    const [dayStart, dayEnd] = dayRange;
    const weekday = (value) => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${value}T00:00:00.000Z`).getUTCDay()];
    const continuity = [];
    if (startAt < dayStart) continuity.push(fmt(() => i18n.t("接{p1}", { p1: i18n.t(weekday(dateInZone(dayStart - 1, zone))) })));
    // The end is exclusive, so an interval ending at midnight does not
    // continue on that next date. Use its last occupied date for the label.
    if (endAt > dayEnd) continuity.push(fmt(() => i18n.t("续至{p1}", { p1: i18n.t(weekday(dateInZone(endAt - 1, zone))) })));
    const label = fmt(() => `${timeInZone(Math.max(startAt, dayStart), zone)}–${endAt >= dayEnd ? "24:00" : timeInZone(endAt, zone)}${continuity.length ? i18n.t("session.continuity", { value: continuity.map((item) => i18n.text(item)).join(i18n.locale === "zh" ? "，" : ", ") }) : ""}`);
    const fullTime = startDate !== endDate ? fmt(() => i18n.t("完整时段：{p1} {p2} — {p3} {p4}（{p5}）", { p1: startDate, p2: timeInZone(startAt, zone), p3: endDate, p4: timeInZone(endAt, zone), p5: zone })) : null;
    if (highlighted) card.append(element(document, "p", "session-focus-label", fmt(() => Date.parse(session.startAt) <= instant ? i18n.t("正在学习 · 进行中") : i18n.t("接下来学习"))));
    else if (!compact && session.status === "scheduled" && Date.parse(session.endAt) <= instant) card.append(element(document, "p", "session-focus-label", fmt(() => i18n.t("时间已过 · 待记录本次反馈"))));
    card.append(element(document, "p", "session-time", label));
    const title = element(document, "button", "session-task-title", fmt(() => task?.title || i18n.t("任务已不可用")));
    title.type = "button"; title.dataset.sessionTask = session.taskId;
    title.addEventListener("click", () => callbacks.openTask(task));
    card.append(title, element(document, "span", `status session-status status-${session.status === "not_completed" ? "failed" : session.status}`, fmt(() => i18n.t(LABELS[session.status]))), element(document, "p", "session-duration", fmt(() => i18n.t("整段 {p1} 分钟", { p1: Math.round((Date.parse(session.endAt) - Date.parse(session.startAt)) / 60000) }))));
    const body = sessionDetails(session, task, compact, fullTime);
    card.append(compact ? nativeDisclosure("session-details", disclosureKey("session", date, session.id), "本次详情", body) : body);
    return card;
  }

  function renderHistory(status, sessions, date, instant, dayRange) {
    const list = element(document, "div", "session-history-list");
    list.append(...sessions.map((session) => renderSession(session, date, { instant, dayRange })));
    const details = nativeDisclosure("session-history", disclosureKey("history", date, status), fmt(() => i18n.t("{p1} · {p2} 个时段", { p1: i18n.t(status === "completed" ? "本次已完成" : "已取消"), p2: sessions.length })), list);
    details.dataset.sessionHistory = status;
    return details;
  }

  function renderSchedule(tasks) {
    captureCalendar();
    const calendar = ["today", "week"].includes(state.presentation.mode);
    byId("schedule-toolbar").hidden = !calendar;
    if (!calendar) { byId("calendar-remaining").hidden = true; i18n.setText(byId("calendar-remaining"), ""); return false; }
    const instant = Date.parse(now());
    const currentDate = dateInZone(instant, state.schedule.timeZone);
    const isToday = state.presentation.mode === "today";
    refreshDisplayTimeZones();
    const dates = isToday ? [currentDate] : weekDates(state.schedule.anchorDate || currentDate);
    i18n.setText(byId("calendar-range"), fmt(() => isToday ? i18n.t("今日 · {p1}", { p1: dates[0] }) : `${dates[0]} — ${dates[6]}`));
    for (const id of ["week-previous", "week-next", "week-today"]) byId(id).hidden = isToday;
    const taskIds = new Set(tasks.map((task) => task.id));
    const sessions = (state.board.sessions || []).filter((session) => taskIds.has(session.taskId));
    const bounds = new Map(dates.map((date) => [date, dayBounds(date)]));
    let count = 0; let minutes = 0; let completed = 0; let unfinished = 0; let remainingMinutes = 0;
    const byTime = (a, b) => (Date.parse(a.startAt) - Date.parse(b.startAt)) || a.id.localeCompare(b.id);
    const rank = (session) => session.status !== "scheduled" ? 3 : Date.parse(session.startAt) <= instant && Date.parse(session.endAt) > instant ? 0 : Date.parse(session.startAt) > instant ? 1 : 2;
    const columns = dates.map((date, index) => {
      const [start, end] = bounds.get(date);
      const items = sessions.filter((session) => Date.parse(session.startAt) < end && Date.parse(session.endAt) > start).sort(isToday ? (a, b) => rank(a) - rank(b) || byTime(a, b) : byTime);
      const focusId = isToday ? items.find((session) => session.status === "scheduled" && Date.parse(session.endAt) > instant)?.id : null;
      const column = element(document, "section", `calendar-day${date === currentDate ? " is-today" : ""}`);
      column.dataset.calendarDate = date;
      column.classList.toggle("has-sessions", items.length > 0);
      column.classList.toggle("is-empty-day", items.length === 0);
      i18n.bindFormatAttr(column, "aria-label", () => i18n.t("{p1}的学习安排", { p1: date }));
      const heading = element(document, "h2", "", fmt(() => isToday ? date : `${[i18n.t("周一"), i18n.t("周二"), i18n.t("周三"), i18n.t("周四"), i18n.t("周五"), i18n.t("周六"), i18n.t("周日")][index]} · ${items.length ? date : date.slice(5)}`));
      heading.title = date;
      column.append(heading);
      let dailyMinutes = 0;
      for (const session of items) {
        if (session.status !== "cancelled") dailyMinutes += (Math.min(end, Date.parse(session.endAt)) - Math.max(start, Date.parse(session.startAt))) / 60000;
        if (isToday && session.status === "scheduled") remainingMinutes += Math.max(0, Math.min(end, Date.parse(session.endAt)) - Math.max(start, instant, Date.parse(session.startAt))) / 60000;
        if (!isToday || !["completed", "cancelled"].includes(session.status)) column.append(renderSession(session, date, { compact: !isToday, focusId, instant, dayRange: bounds.get(date) }));
      }
      if (isToday) for (const status of ["completed", "cancelled"]) {
        const history = items.filter((session) => session.status === status);
        if (history.length) column.append(renderHistory(status, history, date, instant, bounds.get(date)));
      }
      minutes += dailyMinutes;
      column.insertBefore(element(document, "p", "calendar-day-total", fmt(() => i18n.t("计划 {p1} 分钟", { p1: Math.round(dailyMinutes) }))), column.children[1] || null);
      if (!items.length) column.append(element(document, "p", "calendar-day-empty", fmt(() => i18n.t("暂无学习安排"))));
      const add = element(document, "button", "add-session quiet", fmt(() => i18n.t("＋ 添加时段")));
      add.type = "button"; add.dataset.addSessionDate = date;
      add.addEventListener("click", () => openSession(null, "session", date));
      column.append(add);
      return column;
    });
    const first = bounds.get(dates[0])[0]; const last = bounds.get(dates.at(-1))[1];
    for (const session of sessions) if (Date.parse(session.startAt) < last && Date.parse(session.endAt) > first) {
      count += 1; if (session.status === "completed") completed += 1; if (session.status === "not_completed") unfinished += 1;
    }
    i18n.setText(byId("calendar-summary"), fmt(() => callbacks.selectedCodexProject() ? i18n.t("Codex 自动项目只读，不关联手工学习时段。请切回看板查看自动任务，或选择手工项目安排学习。") : i18n.t("{p1} 个学习时段 · 总计划 {p2} 分钟 · 本次已完成 {p3} · 本次未完成 {p4}", { p1: count, p2: Math.round(minutes), p3: completed, p4: unfinished })));
    byId("calendar-remaining").hidden = !isToday;
    i18n.setText(byId("calendar-remaining"), fmt(() => isToday ? i18n.t("今天剩余安排：{p1} 分钟（仅计未结束的已安排时段，按显示时区计算）", { p1: Math.ceil(remainingMinutes) }) : ""));
    byId("cards").className = `cards calendar-view ${state.presentation.mode}-view`;
    // Occupied days keep readable time labels; empty days reserve a smaller track.
    byId("cards").style.setProperty("--week-columns", columns.map((column) => column.classList.contains("has-sessions") ? "minmax(220px, 2.5fr)" : "minmax(88px, .7fr)").join(" "));
    byId("cards").replaceChildren(...columns);
    byId("empty").hidden = true;
    return true;
  }

  function changeSchedule(proceed) {
    if (!state.schedule.draft) return proceed();
    if (isBusy(state) || frozen() || hasExpiredWrites(state) || state.schedule.pendingAction) return;
    if (dirty()) {
      state.schedule.pendingAction = proceed;
      byId("schedule-discard-dialog").hidden = false;
      callbacks.refreshControls();
      byId("schedule-keep-editing").focus();
      return;
    }
    closeSchedule(); proceed();
  }

  function closeSchedule() {
    if (isBusy(state) || frozen()) return;
    const opener = state.schedule.returnFocus;
    if (ownScheduleAction()) state.writes.action = null;
    state.schedule.draft = null; state.schedule.pendingAction = null;
    byId("schedule-panel").hidden = true;
    byId("schedule-discard-dialog").hidden = true;
    byId("workspace").classList.remove("has-editor");
    callbacks.render();
    if (state.presentation.surface !== "tasks") return;
    const restoredOpener = resolveCalendarFocus(focusIdentity(opener));
    (callbacks.isVisibleControl(restoredOpener) ? restoredOpener : callbacks.isVisibleControl(opener) ? opener : byId("new-session"))?.focus({ preventScroll: true });
  }

  function openSession(sessionId, kind = "session", date = today()) {
    if (!canOpen() || !sessionId && callbacks.selectedCodexProject()) return;
    const opener = document.activeElement;
    const begin = () => {
      const session = sessionId ? (state.board.sessions || []).find((item) => item.id === sessionId) : null;
      if (sessionId && !(kind === "feedback" ? feedbackSession(session) : editableSession(session))) return callbacks.reportError(ERROR_MESSAGES.SESSION_LOCKED);
      const tasks = state.board.tasks.filter((task) => !callbacks.isArchived(task));
      if (!session && !tasks.length) return callbacks.reportError("请先添加一项活动任务，再安排学习时段。");
      if (state.editor.kind) callbacks.closeEditor();
      callbacks.closeSidebar({ returnFocus: false }); callbacks.closeFilters({ returnFocus: false }); callbacks.closeProjectMenu();
      state.schedule.returnFocus = opener;
      state.schedule.draft = { kind, id: session?.id, taskId: session?.taskId, revision: state.board.revision, baseline: session ? structuredClone(session) : null, context: session ? structuredClone(session) : null, needsReview: false };
      byId("session-task").replaceChildren(...tasks.map((task) => { const option = element(document, "option", "", task.title); option.value = task.id; return option; }));
      if (session && !tasks.some((task) => task.id === session.taskId)) { const option = element(document, "option", "", fmt(() => availableTask(session.taskId)?.title || i18n.t("任务已不可用"))); option.value = session.taskId; byId("session-task").append(option); }
      byId("session-task").value = session?.taskId || tasks.find((task) => task.projectId === refs.projectFilter.value)?.id || tasks[0]?.id;
      const zone = session?.timeZone || state.schedule.timeZone;
      const nextHour = new Date(Date.parse(now()) + 3600000).toISOString();
      const defaultStart = date === today() ? nextHour : null;
      const defaultEnd = defaultStart ? new Date(Date.parse(defaultStart) + 3600000).toISOString() : null;
      byId("session-date").value = session ? dateInZone(session.startAt, zone) : defaultStart ? dateInZone(defaultStart, zone) : date;
      byId("session-end-date").value = session ? dateInZone(session.endAt, zone) : defaultEnd ? dateInZone(defaultEnd, zone) : date;
      byId("session-start").value = session ? timeInZone(session.startAt, zone) : defaultStart ? timeInZone(defaultStart, zone) : "09:00";
      byId("session-end").value = session ? timeInZone(session.endAt, zone) : defaultEnd ? timeInZone(defaultEnd, zone) : "10:00";
      byId("session-zone").value = zone;
      byId("session-objective").value = session?.objective || "";
      byId("session-criteria").value = session?.completionCriteria || "";
      byId("session-outcome").value = session?.status === "not_completed" ? "not_completed" : "completed";
      byId("session-minutes").value = session?.actualMinutes ?? "";
      byId("session-feedback").value = session?.feedback || "";
      byId("session-timing-fields").hidden = kind === "feedback";
      byId("session-feedback-fields").hidden = kind !== "feedback";
      i18n.setText(byId("session-editor-title"), fmt(() => kind === "feedback" ? i18n.t("本次学习反馈") : session ? i18n.t("编辑学习时段") : i18n.t("新增学习时段")));
      byId("schedule-review").hidden = true; byId("schedule-reviewed").checked = false;
      state.schedule.snapshot = snapshot();
      byId("schedule-panel").hidden = false; byId("workspace").classList.add("has-editor");
      callbacks.clearFeedback(); callbacks.render();
      byId(kind === "feedback" ? "session-outcome" : session ? "session-date" : "session-task").focus();
    };
    const proceed = () => state.schedule.draft ? changeSchedule(begin) : begin();
    if (state.editor.kind) callbacks.changeEditor(proceed); else proceed();
  }

  function canSaveSchedule() {
    const draft = state.schedule.draft;
    if (state.presentation.surface !== "tasks") return false;
    if (!draft || !state.host.connected || !state.host.loaded || isBusy(state) || state.editor.kind || state.fieldEdit || state.editor.pendingAction || state.schedule.pendingAction || state.writes.save || state.writes.move || hasExpiredWrites(state)) return false;
    if (ownScheduleAction() && slotUncertain(state.writes.action)) return canRetrySlot(state.writes.action);
    if (state.writes.action && (!ownScheduleAction() || slotNeedsRefresh(state.writes.action))) return false;
    const session = draft.id ? (state.board.sessions || []).find((item) => item.id === draft.id) : null;
    const task = availableTask(draft.taskId || byId("session-task").value);
    return !!task && (draft.kind === "feedback" ? feedbackSession(session) : !callbacks.isArchived(task) && (!draft.id || editableSession(session))) && (!draft.needsReview || byId("schedule-reviewed").checked);
  }

  function sessionOperation() {
    const draft = state.schedule.draft;
    if (draft.kind === "feedback") {
      const status = byId("session-outcome").value;
      const text = byId("session-feedback").value.trim();
      const minutes = byId("session-minutes").value.trim();
      const actualMinutes = minutes === "" ? null : Number(minutes);
      if (!["completed", "not_completed"].includes(status)) throw new Error("请选择本次学习结果。");
      if (actualMinutes !== null && (!Number.isSafeInteger(actualMinutes) || actualMinutes < 0 || actualMinutes > 1440)) throw new Error("实际分钟请填写 0–1440 的整数，或留空。");
      if (text.length > 4000) throw new Error("学习反馈最多 4000 个字。");
      return { type: "record_session_feedback", sessionId: draft.id, status, feedback: text, actualMinutes };
    }
    const timeZone = byId("session-zone").value.trim();
    if (!validTimeZone(timeZone)) throw new Error("请填写有效的 IANA 时区，例如 Asia/Shanghai。");
    const startAt = localToInstant(byId("session-date").value, byId("session-start").value, timeZone);
    const endAt = localToInstant(byId("session-end-date").value, byId("session-end").value, timeZone);
    if (Date.parse(startAt) <= Date.parse(now())) throw new Error("新增和调整时段必须选择未来的开始时间。");
    if (Date.parse(endAt) <= Date.parse(startAt)) throw new Error("结束时间必须晚于开始时间。");
    if (Date.parse(endAt) - Date.parse(startAt) > MAX_SESSION_DURATION_MS) throw new Error("单次学习时段不能超过 24 小时。");
    const objective = byId("session-objective").value.trim(); const completionCriteria = byId("session-criteria").value.trim();
    if (objective.length > 4000 || completionCriteria.length > 4000) throw new Error("本次目标和完成标准最多各 4000 个字。");
    return { type: "save_session", session: { ...(draft.id ? { id: draft.id } : {}), taskId: draft.taskId || byId("session-task").value, startAt, endAt, timeZone, objective, completionCriteria } };
  }

  function saveSchedule(event) {
    event.preventDefault();
    if (!canSaveSchedule()) return;
    if (ownScheduleAction() && slotUncertain(state.writes.action)) return callbacks.retryAction();
    let operation;
    try { operation = sessionOperation(); } catch (error) { return callbacks.reportError(error.message); }
    if (ownScheduleAction() && JSON.stringify(operation) === JSON.stringify(state.writes.action.request.operation)) return callbacks.retryAction();
    if (ownScheduleAction()) state.writes.action = null;
    return callbacks.startScheduleAction(operation, state.schedule.draft.revision);
  }

  function mergeRefreshedSchedule() {
    const draft = state.schedule.draft;
    if (!draft || frozen()) return;
    if (ownScheduleAction()) state.writes.action = null;
    draft.revision = state.board.revision;
    const remote = (state.board.sessions || []).find((item) => item.id === draft.id);
    if (draft.id && JSON.stringify(remote) !== JSON.stringify(draft.baseline)) {
      draft.needsReview = true; byId("schedule-reviewed").checked = false;
      i18n.setText(byId("schedule-review-message"), fmt(() => remote ? i18n.t("本次记录已更新：{p1}，{p2} — {p3}，目标：{p4}，完成标准：{p5}，反馈：{p6}，实际分钟：{p7}。你的输入已保留，请核对后保存。", { p1: i18n.t(LABELS[remote.status]), p2: `${dateInZone(remote.startAt, state.schedule.timeZone)} ${timeInZone(remote.startAt, state.schedule.timeZone)}`, p3: `${dateInZone(remote.endAt, state.schedule.timeZone)} ${timeInZone(remote.endAt, state.schedule.timeZone)}`, p4: remote.objective || i18n.t("未填写"), p5: remote.completionCriteria || i18n.t("未填写"), p6: remote.feedback || i18n.t("未填写"), p7: remote.actualMinutes ?? i18n.t("未填写") }) : i18n.t("时段已不可用。你的输入已保留，请关闭后重新选择。")));
      draft.baseline = remote ? structuredClone(remote) : null;
    }
    byId("schedule-review").hidden = !draft.needsReview;
  }

  let calendarClockTimer = null;
  let calendarClockDisposed = false;
  let calendarPageSuspended = false;
  const visibleCalendar = () => !calendarClockDisposed && !calendarPageSuspended
    && document.visibilityState === "visible" && state.presentation.surface === "tasks" && ["today", "week"].includes(state.presentation.mode);

  function stopCalendarClock() {
    if (calendarClockTimer !== null) document.defaultView.clearTimeout(calendarClockTimer);
    calendarClockTimer = null;
  }

  function updateCalendarClock() {
    if (!visibleCalendar() || isBusy(state) || state.schedule.draft || state.editor.kind || state.fieldEdit
      || state.schedule.pendingAction || state.editor.pendingAction || Object.values(state.writes).some(Boolean)
      || state.backup.preview || callbacks.sidebarDrawer()) return;
    // Native inputs retain their own selection/composition state. Defer the
    // minute refresh while any input control is being used, including filters.
    const active = document.activeElement;
    if (active?.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    // This is an in-memory projection only: no read, mutation or status change.
    callbacks.render();
  }

  function armCalendarClock() {
    if (!visibleCalendar()) { stopCalendarClock(); return; }
    if (calendarClockTimer !== null) return;
    // Align one timer to the next minute; visibility/focus also checks the
    // current instant after background throttling or a system-clock change.
    const delay = 60000 - (Date.parse(now()) % 60000);
    calendarClockTimer = document.defaultView.setTimeout(() => {
      calendarClockTimer = null;
      try { updateCalendarClock(); } finally { armCalendarClock(); }
    }, delay);
  }

  function resumeCalendarClock() {
    if (calendarClockDisposed) return;
    if (document.visibilityState !== "visible") { stopCalendarClock(); return; }
    updateCalendarClock();
    armCalendarClock();
  }

  function suspendCalendarPage() {
    calendarPageSuspended = true;
    stopCalendarClock();
  }

  function resumeCalendarPage() {
    if (calendarClockDisposed) return;
    calendarPageSuspended = false;
    resumeCalendarClock();
  }

  function disposeSchedule() {
    calendarClockDisposed = true;
    stopCalendarClock();
    document.removeEventListener("visibilitychange", resumeCalendarClock);
    document.defaultView.removeEventListener("focus", resumeCalendarClock);
    document.defaultView.removeEventListener("pagehide", suspendCalendarPage);
    document.defaultView.removeEventListener("pageshow", resumeCalendarPage);
  }

  function refreshFeedbackContext() {
    const draft = state.schedule.draft;
    const context = draft?.kind === "feedback" ? draft.context : null;
    byId("session-context").hidden = !context;
    if (!context) {
      for (const id of ["session-context-time", "session-context-objective", "session-context-criteria"]) i18n.setText(byId(id), "");
      return;
    }
    // The saved record captured when the panel opened describes this draft.
    // Explicit refresh may advance the merge baseline but never this context.
    const zone = context.timeZone;
    i18n.setText(byId("session-context-time"), fmt(() => i18n.t("打开时的记录：{p1} {p2} — {p3} {p4}（{p5}）", { p1: dateInZone(context.startAt, zone), p2: timeInZone(context.startAt, zone), p3: dateInZone(context.endAt, zone), p4: timeInZone(context.endAt, zone), p5: zone })));
    i18n.setText(byId("session-context-objective"), fmt(() => context.objective || i18n.t("未填写")));
    i18n.setText(byId("session-context-criteria"), fmt(() => context.completionCriteria || i18n.t("未填写")));
  }

  function canAddFeedbackReason() {
    const draft = state.schedule.draft;
    const current = (state.board.sessions || []).find((session) => session.id === draft?.id);
    return !!draft && draft.kind === "feedback" && feedbackSession(current) && byId("session-outcome").value === "not_completed"
      && state.host.connected && state.host.loaded && !isBusy(state) && !frozen() && !hasExpiredWrites(state)
      && !state.schedule.pendingAction && !state.editor.pendingAction && !state.editor.kind && !state.fieldEdit && !state.writes.save && !state.writes.move
      && (!state.writes.action || ownScheduleAction() && !slotNeedsRefresh(state.writes.action))
      && (!draft.needsReview || byId("schedule-reviewed").checked);
  }

  function appendFeedbackReason(button) {
    if (button.disabled || !canAddFeedbackReason()) return;
    const reason = button.dataset.feedbackReason;
    if (!["时间不够", "内容太难", "临时有事"].includes(reason)) return;
    const input = byId("session-feedback");
    const localizedReason = i18n.t(reason);
    if (input.value.includes(localizedReason)) { input.focus(); return; }
    const next = `${input.value}${input.value && !input.value.endsWith("\n") ? "\n" : ""}${localizedReason}`;
    if (next.length > 4000) return callbacks.reportError("学习反馈最多 4000 个字。请先调整文字，再添加原因。");
    input.value = next;
    // Use the existing form edit path so known failures get a new request only
    // on the next explicit save. Shortcuts never submit or touch saved records.
    input.dispatchEvent(new document.defaultView.Event("input", { bubbles: true }));
    input.focus();
  }

  function refreshScheduleControls() {
    if (!byId("schedule-panel")) return;
    const blocked = !!state.schedule.draft || !!state.schedule.pendingAction;
    const open = canOpen();
    for (const button of document.querySelectorAll("[data-session-action], [data-add-session-date], #new-session")) button.disabled = !open || blocked || callbacks.selectedCodexProject() || (button.dataset.sessionAction === "cancel" && !callbacks.canMove());
    for (const button of document.querySelectorAll("[data-session-task]")) button.disabled = !state.host.connected || !state.host.loaded || isBusy(state) || !!state.fieldEdit || !!state.writes.action;
    const editable = !!state.schedule.draft && state.host.connected && state.host.loaded && !isBusy(state) && !frozen() && !state.schedule.pendingAction && !hasExpiredWrites(state);
    for (const id of fieldIds) byId(id).disabled = !editable || id === "session-task" && !!state.schedule.draft?.id;
    byId("session-submit").disabled = !canSaveSchedule();
    i18n.setText(byId("session-submit"), fmt(() => isMutating(state, "action") ? i18n.t("正在保存…") : frozen() ? i18n.t("重试确认本次保存") : state.schedule.draft?.kind === "feedback" ? i18n.t("保存本次反馈") : i18n.t("保存时段")));
    byId("schedule-refresh").disabled = byId("refresh").disabled;
    for (const id of ["schedule-close", "session-cancel", "schedule-discard-edits"]) byId(id).disabled = isBusy(state) || frozen() || hasExpiredWrites(state);
    byId("schedule-reviewed").disabled = !editable;
    byId("session-form").setAttribute("aria-busy", String(isMutating(state, "action")));
    const draft = state.schedule.draft;
    const current = draft?.id ? (state.board.sessions || []).find((item) => item.id === draft.id) : null;
    byId("session-lock-note").hidden = !draft?.id || (draft.kind === "feedback" ? feedbackSession(current) : editableSession(current));
    i18n.setText(byId("session-lock-note"), fmt(() => draft?.kind === "feedback" ? i18n.t("本次时段已取消或不可用，无法保存反馈。输入已保留。") : i18n.t("时段已开始、完成、取消或不可用，无法调整安排。输入已保留，关闭后可记录本次反馈。")));
    i18n.setText(byId("session-save-state"), fmt(() => frozen() ? i18n.t("保存结果需确认；原请求已保留") : slotNeedsRefresh(state.writes.action) && ownScheduleAction() ? i18n.t("请刷新并核对记录") : dirty() ? i18n.t("有未保存的修改") : ""));
    for (const id of ["display-time-zone", "week-previous", "week-next", "week-today", "view-today", "view-week"]) byId(id).disabled = !!state.schedule.pendingAction || isBusy(state);
    refreshFeedbackContext();
    byId("session-reasons").hidden = draft?.kind !== "feedback" || byId("session-outcome").value !== "not_completed";
    for (const button of document.querySelectorAll("#session-reasons [data-feedback-reason]")) button.disabled = !canAddFeedbackReason();
    restoreCalendarFocus();
    armCalendarClock();
  }

  function bindSchedule() {
    refreshDisplayTimeZones();
    document.addEventListener("visibilitychange", resumeCalendarClock);
    document.defaultView.addEventListener("focus", resumeCalendarClock);
    document.defaultView.addEventListener("pagehide", suspendCalendarPage);
    document.defaultView.addEventListener("pageshow", resumeCalendarPage);
    byId("view-today").addEventListener("click", () => { if (callbacks.navigationBlocked()) return; state.presentation.mode = "today"; callbacks.render(); });
    byId("view-week").addEventListener("click", () => { if (callbacks.navigationBlocked()) return; state.presentation.mode = "week"; callbacks.render(); });
    byId("new-session").addEventListener("click", () => openSession(null, "session", state.presentation.mode === "week" ? state.schedule.anchorDate || today() : today()));
    for (const [id, days] of [["week-previous", -7], ["week-next", 7], ["week-today", 0]]) byId(id).addEventListener("click", () => { state.schedule.anchorDate = days ? addDays(state.schedule.anchorDate || today(), days) : today(); callbacks.render(); });
    byId("display-time-zone").addEventListener("change", () => {
      const value = byId("display-time-zone").value.trim();
      if (!validTimeZone(value)) { refreshDisplayTimeZones(); return callbacks.reportError("显示时区无效，请选择有效的时区。"); }
      state.schedule.timeZone = value; callbacks.render();
    });
    byId("session-form").addEventListener("submit", saveSchedule);
    byId("schedule-reviewed").addEventListener("change", callbacks.refreshControls);
    for (const button of document.querySelectorAll("#session-reasons [data-feedback-reason]")) button.addEventListener("click", () => appendFeedbackReason(button));
    for (const type of ["input", "change"]) byId("session-form").addEventListener(type, () => {
      if (ownScheduleAction() && !frozen() && !slotNeedsRefresh(state.writes.action)) state.writes.action = null;
      callbacks.refreshControls();
    });
    byId("schedule-refresh").addEventListener("click", callbacks.refresh);
    for (const id of ["session-cancel", "schedule-close"]) byId(id).addEventListener("click", () => changeSchedule(() => {}));
    byId("schedule-keep-editing").addEventListener("click", () => { state.schedule.pendingAction = null; byId("schedule-discard-dialog").hidden = true; callbacks.refreshControls(); byId("session-submit").focus(); });
    byId("schedule-discard-edits").addEventListener("click", () => { if (!state.schedule.pendingAction || frozen() || isBusy(state)) return; const proceed = state.schedule.pendingAction; closeSchedule(); proceed(); });
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || !state.schedule.draft || state.presentation.surface !== "tasks") return;
      if (event.key === "Escape") { event.preventDefault(); if (state.schedule.pendingAction) byId("schedule-keep-editing").click(); else changeSchedule(() => {}); }
      else if (event.key === "Enter" && (event.metaKey !== event.ctrlKey) && !event.altKey && !event.shiftKey && !event.isComposing && !event.repeat) { event.preventDefault(); byId("session-submit").click(); }
    });
    document.defaultView.addEventListener("beforeunload", (event) => { if (dirty() || frozen()) { event.preventDefault(); event.returnValue = ""; } });
    byId("learning-prompt-copy").addEventListener("click", async () => {
      const text = i18n.t(byId("learning-prompt").getAttribute("data-learning-prompt-key"));
      byId("learning-prompt").value = text;
      try { await document.defaultView.navigator.clipboard.writeText(text); callbacks.showSuccess("已复制，可在 Codex 中填写后发送。"); }
      catch { byId("learning-prompt").hidden = false; byId("learning-prompt").focus(); byId("learning-prompt").select(); callbacks.showSuccess("请复制已选中的提示，填写后在 Codex 中发送。"); }
    });
  }
  return { renderSchedule, bindSchedule, openSession, closeSchedule, changeSchedule, ownScheduleAction, canSaveSchedule, compactSchedule, refreshScheduleControls, mergeRefreshedSchedule, disposeSchedule };
}
