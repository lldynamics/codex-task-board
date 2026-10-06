import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { createFileStore } from "../src/store.mjs";
import { emptyBoard } from "../src/board.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";
import { tick } from "./helpers.mjs";

// Independent examples deliberately span both civil-day boundaries and repeat
// one task across sessions. Every mutation uses an explicit temporary store.
const specs = [
  ["ongoing", "2099-01-02T15:45:00Z", "2099-01-02T16:45:00Z", "scheduled"],
  ["upcoming", "2099-01-02T17:00:00Z", "2099-01-02T18:00:00Z", "scheduled"],
  ["done", "2099-01-02T18:00:00Z", "2099-01-02T19:00:00Z", "completed"],
  ["unfinished", "2099-01-02T19:00:00Z", "2099-01-02T20:00:00Z", "not_completed"],
  ["cancelled", "2099-01-02T20:00:00Z", "2099-01-02T21:00:00Z", "cancelled"],
  ["next-midnight", "2099-01-03T15:30:00Z", "2099-01-03T16:30:00Z", "scheduled"],
];
const wrap = (result) => ({ content: [], ...(result.ok ? {} : { isError: true }), structuredContent: result });
async function settle(ctx) {
  const deadline = Date.now() + 5000;
  while (ctx.byId("session-form").getAttribute("aria-busy") === "true" && Date.now() < deadline) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(ctx.byId("session-form").getAttribute("aria-busy"), "false");
}
async function setup(t, { mutate } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "learning-polish-acceptance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  const read = async () => { const result = await store.read(); assert.equal(result.ok, true); return result.board; };
  const commit = async (operation) => {
    const result = await store.mutate({ requestId: randomUUID(), expectedRevision: (await read()).revision, operation });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const project = await commit({ type: "save_project", project: { name: "独立体验验收", description: "跨日、多时段与反馈" } });
  const task = await commit({ type: "save_task", task: { projectId: project.entityId, title: "同一任务的多次练习", status: "planned", sourceTool: "Synthetic acceptance", currentStep: "逐段复习", blocker: "", conversationUrl: null, priority: "normal", dueDate: "2099-01-12" } });
  const ids = {};
  for (const [key, startAt, endAt, status] of specs) {
    const result = await commit({ type: "save_session", session: { taskId: task.entityId, startAt, endAt, timeZone: "Asia/Shanghai", objective: `独立目标 ${key}`, completionCriteria: `独立标准 ${key}` } });
    ids[key] = result.entityId;
    if (status === "cancelled") await commit({ type: "cancel_session", sessionId: result.entityId });
    else if (status !== "scheduled") await commit({ type: "record_session_feedback", sessionId: result.entityId, status, feedback: `已有记录 ${key}`, actualMinutes: 12 });
  }
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://polish-acceptance.invalid/" });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, "innerWidth", { value: 1100, configurable: true });
  const calls = [];
  const perform = async (request) => wrap(await store.mutate(request));
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: () => "2099-01-02T16:15:00.000Z",
    mutate: async (request) => { calls.push(structuredClone(request)); return mutate ? mutate(request, perform, calls.length) : perform(request); },
    refresh: async () => wrap(await store.read()), data: async (request) => wrap(await store.data(request)),
  }));
  view.setHostState({ connected: true, message: "Synthetic host" });
  view.acceptReadResult(wrap(await store.read()));
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  const change = (id, value) => { const node = byId(id); node.value = value; node.dispatchEvent(new dom.window.Event(node.matches("select") || id === "display-time-zone" ? "change" : "input", { bubbles: true })); };
  const card = (key, date) => document.querySelector(`[data-session-id="${ids[key]}"]${date ? `[data-session-date="${date}"]` : ""}`);
  const submit = async () => { byId("session-submit").click(); await settle({ byId }); };
  const notify = async () => view.acceptReadResult(wrap(await store.read()));
  const keyboard = (node, key) => node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  return { store, read, commit, taskId: task.entityId, dom, document, byId, change, card, submit, notify, keyboard, view, calls, ids };
}
function openFeedback(ctx, key) {
  ctx.card(key).querySelector('[data-session-action="feedback"]').click();
  assert.equal(ctx.byId("schedule-panel").hidden, false);
}
function reasonButtons(ctx) { return [...ctx.byId("session-reasons").querySelectorAll("[data-feedback-reason]")]; }

test("independent polish: remaining minutes clip ongoing and next-midnight sessions to the displayed civil day", async (t) => {
  const ctx = await setup(t);
  ctx.byId("view-today").click();
  ctx.change("display-time-zone", "Asia/Shanghai");
  assert.match(ctx.byId("calendar-range").textContent, /2099-01-03/);
  // Local today contributes 30 minutes after now from ongoing, 60 upcoming,
  // and only 30 before midnight from the last session. Feedback/cancel add 0.
  assert.match(ctx.byId("calendar-remaining").textContent, /120\s*分钟/);
  ctx.change("display-time-zone", "UTC");
  assert.match(ctx.byId("calendar-range").textContent, /2099-01-02/);
  assert.match(ctx.byId("calendar-remaining").textContent, /90\s*分钟/);
  assert.equal(ctx.calls.length, 0, "Display-zone changes must not mutate schedule times");
});

test("independent polish: today prioritizes the current session, keeps unfinished visible and routes N by view", async (t) => {
  const ctx = await setup(t);
  ctx.byId("view-today").click();
  const cards = [...ctx.document.querySelectorAll("[data-session-id]")];
  assert.equal(cards[0].dataset.sessionId, ctx.ids.ongoing);
  assert.equal(ctx.document.querySelector(".session-card.is-next").dataset.sessionId, ctx.ids.ongoing);
  assert.match(ctx.card("ongoing").querySelector(".session-focus-label").textContent, /进行中/);
  assert.equal(ctx.card("unfinished").closest("details.session-history"), null);
  for (const [key, group] of [["done", "completed"], ["cancelled", "cancelled"]]) {
    const details = ctx.card(key).closest(`details[data-session-history="${group}"]`);
    assert.ok(details, `${key} should be in native collapsible history`);
    assert.equal(details.open, false);
    details.querySelector("summary").focus();
    assert.equal(ctx.document.activeElement, details.querySelector("summary"));
  }
  assert.equal(ctx.byId("new-task").hidden, true);
  ctx.document.body.focus();
  ctx.document.activeElement.blur();
  ctx.keyboard(ctx.document.body, "n");
  assert.equal(ctx.byId("schedule-panel").hidden, false);
  assert.equal(ctx.byId("editor-panel").hidden, true);
  const focused = ctx.document.activeElement;
  ctx.keyboard(focused, "n");
  assert.equal(ctx.document.activeElement, focused, "Typing in the form must not reopen an editor");
  ctx.byId("schedule-close").click();
  ctx.byId("view-board").click();
  assert.equal(ctx.byId("new-task").hidden, false);
  ctx.document.activeElement.blur();
  ctx.keyboard(ctx.document.body, "n");
  assert.equal(ctx.byId("editor-panel").hidden, false);
  assert.equal(ctx.byId("schedule-panel").hidden, true);
  assert.equal(ctx.calls.length, 0);
});

test("independent polish: week native disclosures retain per-day openness and focused action across refresh", async (t) => {
  const ctx = await setup(t);
  ctx.byId("view-week").click();
  const earlier = ctx.card("ongoing", "2099-01-02").querySelector("details.session-details");
  const current = ctx.card("ongoing", "2099-01-03").querySelector("details.session-details");
  assert.ok(earlier && current);
  assert.equal(earlier.open, false);
  assert.equal(current.open, false);
  const summary = current.querySelector("summary.session-details-toggle");
  summary.focus();
  assert.equal(ctx.document.activeElement, summary);
  current.open = true;
  current.dispatchEvent(new ctx.dom.window.Event("toggle"));
  const action = current.querySelector('[data-session-action="feedback"]');
  action.focus();
  assert.equal(ctx.document.activeElement, action);
  await ctx.notify();
  const refreshed = ctx.card("ongoing", "2099-01-03").querySelector("details.session-details");
  assert.equal(refreshed.open, true);
  assert.equal(ctx.card("ongoing", "2099-01-02").querySelector("details.session-details").open, false, "Cross-midnight copies must have independent disclosure state");
  assert.equal(ctx.document.activeElement, refreshed.querySelector('[data-session-action="feedback"]'));
  assert.equal(ctx.calls.length, 0);
});

test("independent polish: feedback context identifies this repeated-task session and preserves its opening baseline", async (t) => {
  const ctx = await setup(t);
  ctx.byId("view-today").click();
  openFeedback(ctx, "upcoming");
  const originalTime = ctx.byId("session-context-time").textContent;
  assert.match(originalTime, /01:00.*02:00/s);
  assert.match(ctx.byId("session-context-objective").textContent, /独立目标 upcoming/);
  assert.match(ctx.byId("session-context-criteria").textContent, /独立标准 upcoming/);
  ctx.change("session-feedback", "本地反馈草稿");
  await ctx.commit({ type: "save_session", session: { id: ctx.ids.upcoming, taskId: ctx.taskId, startAt: "2099-01-02T17:00:00Z", endAt: "2099-01-02T18:00:00Z", timeZone: "Asia/Shanghai", objective: "其他窗口的新目标", completionCriteria: "其他窗口的新标准" } });
  await ctx.notify();
  await ctx.view.refresh();
  assert.equal(ctx.byId("session-context-time").textContent, originalTime);
  assert.match(ctx.byId("session-context-objective").textContent, /独立目标 upcoming/);
  assert.match(ctx.byId("session-context-criteria").textContent, /独立标准 upcoming/);
  assert.equal(ctx.byId("session-feedback").value, "本地反馈草稿");
  assert.equal(ctx.byId("schedule-review").hidden, false);
  ctx.byId("schedule-reviewed").checked = true;
  ctx.byId("schedule-reviewed").dispatchEvent(new ctx.dom.window.Event("change", { bubbles: true }));
  await ctx.submit();
  const board = await ctx.read();
  assert.equal(ctx.calls[0].operation.sessionId, ctx.ids.upcoming);
  assert.equal(board.sessions.find((session) => session.id === ctx.ids.upcoming).feedback, "本地反馈草稿");
  assert.equal(board.sessions.find((session) => session.id === ctx.ids.ongoing).status, "scheduled");
  assert.equal(board.tasks[0].status, "planned");
});

test("independent polish: reason shortcuts append once without overwriting drafts and remain editable after known failure", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => count === 1 ? wrap({ ok: false, error: { code: "SAVE_FAILED", message: "Synthetic save failure" } }) : perform(request) });
  ctx.byId("view-today").click();
  openFeedback(ctx, "upcoming");
  ctx.change("session-outcome", "not_completed");
  const reasons = reasonButtons(ctx);
  assert.equal(reasons.length, 3);
  ctx.change("session-feedback", "自己的说明，保留原文");
  const reason = reasons[0].dataset.feedbackReason || reasons[0].textContent.trim();
  reasons[0].click();
  const once = ctx.byId("session-feedback").value;
  assert.ok(once.startsWith("自己的说明，保留原文"));
  assert.ok(once.includes(reason));
  reasons[0].click();
  assert.equal(ctx.byId("session-feedback").value, once);
  ctx.change("session-outcome", "completed");
  assert.equal(ctx.byId("session-reasons").hidden, true);
  assert.equal(ctx.byId("session-feedback").value, once);
  ctx.change("session-outcome", "not_completed");
  await ctx.submit();
  assert.equal(ctx.byId("session-feedback").value, once);
  assert.equal(ctx.byId("session-feedback").disabled, false);
  assert.ok(reasonButtons(ctx).every((button) => !button.disabled));
  ctx.change("session-feedback", `${once}\n保存失败后补充`);
  reasonButtons(ctx)[1].click();
  const corrected = ctx.byId("session-feedback").value;
  await ctx.submit();
  assert.notEqual(ctx.calls[1].requestId, ctx.calls[0].requestId);
  assert.equal((await ctx.read()).sessions.find((session) => session.id === ctx.ids.upcoming).feedback, corrected);
});

test("independent polish: unknown feedback freezes reason edits and retries exactly the original request after notification", async (t) => {
  const ctx = await setup(t, { mutate: async (request, perform, count) => { const result = await perform(request); if (count === 1) throw Error("Synthetic lost response"); return result; } });
  ctx.byId("view-today").click();
  openFeedback(ctx, "upcoming");
  ctx.change("session-outcome", "not_completed");
  ctx.change("session-feedback", "已经写下的用户说明");
  reasonButtons(ctx)[2].click();
  const draft = ctx.byId("session-feedback").value;
  await ctx.submit();
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.byId("session-feedback").disabled, true);
  assert.ok(reasonButtons(ctx).every((button) => button.disabled));
  for (const button of reasonButtons(ctx)) button.click();
  assert.equal(ctx.byId("session-feedback").value, draft);
  await ctx.notify();
  await ctx.view.refresh();
  assert.equal(ctx.byId("session-feedback").value, draft);
  assert.match(ctx.byId("session-context-objective").textContent, /独立目标 upcoming/);
  ctx.byId("action-retry").click();
  await settle(ctx);
  assert.deepEqual(ctx.calls[1], ctx.calls[0]);
  const board = await ctx.read();
  assert.equal(board.sessions.find((session) => session.id === ctx.ids.upcoming).feedback, draft);
  assert.equal(board.tasks[0].status, "planned");
  assert.equal(ctx.byId("schedule-panel").hidden, true);
});
