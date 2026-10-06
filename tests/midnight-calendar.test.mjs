import { createI18n } from "../src/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { emptyBoard } from "../src/board.mjs";
import { mountBoard } from "../src/view.mjs";
import { loadAppTemplate } from "../scripts/app-template.mjs";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2000-01-01T00:00:00.000Z";

async function setup(t, { startAt, endAt, timeZone = "Asia/Shanghai", displayZone = timeZone, now = startAt, status = "scheduled" }) {
  const dom = new JSDOM(await loadAppTemplate(), { url: "https://midnight-calendar.invalid/" });
  t.after(() => dom.window.close());
  dom.window.localStorage.setItem("learning-board:view-preferences:v1", JSON.stringify({ viewMode: "week", timeZone: displayZone }));
  const board = {
    ...emptyBoard(), revision: 1,
    projects: [{ id: projectId, name: "跨日练习", description: "", archivedAt: null, lastUpdatedAt: timestamp }],
    tasks: [{ id: taskId, projectId, title: "同一学习时段", status: "planned", priority: "normal", dueDate: null, sourceTool: "手动", currentStep: "", blocker: "", conversationUrl: null, archivedAt: null, lastUpdatedAt: timestamp }],
    sessions: [{ id: sessionId, taskId, startAt, endAt, timeZone, status, objective: "阅读一章", completionCriteria: "完成练习", feedback: "", actualMinutes: null, lastUpdatedAt: timestamp }],
  };
  const original = structuredClone(board);
  const writes = [];
  const view = (createI18n(dom.window.document, { locale: "zh" }), mountBoard(dom.window.document, emptyBoard(), {
    now: () => now,
    mutate: async (request) => { writes.push(request); throw new Error("Calendar display must not write records"); },
    refresh: async () => ({ structuredContent: { ok: true, board } }),
  }));
  t.after(() => view.dispose());
  view.setHostState({ connected: true, message: "测试宿主" });
  assert.equal(view.acceptReadResult({ structuredContent: { ok: true, board } }), true);
  const document = dom.window.document;
  const byId = (id) => document.getElementById(id);
  const card = (date) => document.querySelector(`[data-session-id="${sessionId}"][data-session-date="${date}"]`);
  const label = (date) => card(date)?.querySelector(".session-time").textContent;
  const planned = (date) => document.querySelector(`[data-calendar-date="${date}"] .calendar-day-total`).textContent;
  const changeZone = (zone) => { byId("display-time-zone").value = zone; byId("display-time-zone").dispatchEvent(new dom.window.Event("change", { bubbles: true })); };
  return { board, original, writes, document, byId, card, label, planned, changeZone };
}

test("week cards show each local midnight segment and keep the complete interval in details", async (t) => {
  const ctx = await setup(t, { startAt: "2026-10-05T15:38:00.000Z", endAt: "2026-10-05T16:08:00.000Z" });
  assert.equal(ctx.label("2026-10-05"), "23:38–24:00（续至周二）");
  assert.equal(ctx.label("2026-10-06"), "00:00–00:08（接周一）");
  assert.equal(ctx.planned("2026-10-05"), "计划 22 分钟");
  assert.equal(ctx.planned("2026-10-06"), "计划 8 分钟");
  assert.match(ctx.byId("calendar-summary").textContent, /1 个学习时段 · 总计划 30 分钟/);
  for (const date of ["2026-10-05", "2026-10-06"]) {
    assert.match(ctx.card(date).querySelector(".session-details-body").textContent, /完整时段：2026-10-05 23:38 — 2026-10-06 00:08（Asia\/Shanghai）/);
    assert.equal(ctx.card(date).querySelector(".session-duration").textContent, "整段 30 分钟");
  }
  ctx.changeZone("UTC");
  assert.equal(ctx.label("2026-10-05"), "15:38–16:08");
  assert.equal(ctx.card("2026-10-06"), null);
  assert.equal(ctx.document.querySelector(".session-full-time"), null);
  assert.deepEqual(ctx.board, ctx.original);
  assert.equal(ctx.writes.length, 0);
});

test("an exact midnight end stays on its starting day without a continuation or empty next-day card", async (t) => {
  const ctx = await setup(t, { startAt: "2026-10-05T15:38:00.000Z", endAt: "2026-10-05T16:00:00.000Z" });
  assert.equal(ctx.label("2026-10-05"), "23:38–24:00");
  assert.equal(ctx.card("2026-10-06"), null);
  assert.equal(ctx.planned("2026-10-06"), "计划 0 分钟");
  assert.equal(ctx.document.querySelectorAll(`[data-session-id="${sessionId}"]`).length, 1);
});

test("today and folded history use the local continuation label", async (t) => {
  for (const status of ["scheduled", "completed", "cancelled"]) await t.test(status, async (t) => {
    const ctx = await setup(t, { startAt: "2026-10-05T15:38:00.000Z", endAt: "2026-10-05T16:08:00.000Z", now: "2026-10-05T16:04:00.000Z", status });
    ctx.byId("view-today").click();
    assert.equal(ctx.label("2026-10-06"), "00:00–00:08（接周一）");
    assert.match(ctx.card("2026-10-06").textContent, /完整时段：2026-10-05 23:38 — 2026-10-06 00:08/);
    if (status === "scheduled") assert.match(ctx.byId("calendar-remaining").textContent, /4 分钟/);
    else assert.equal(ctx.card("2026-10-06").closest("details.session-history").dataset.sessionHistory, status);
  });
});

test("a week-boundary continuation follows the selected display zone rather than the stored zone", async (t) => {
  const ctx = await setup(t, { startAt: "2026-10-05T03:40:00.000Z", endAt: "2026-10-05T04:20:00.000Z", displayZone: "America/New_York", now: "2026-10-05T16:00:00.000Z" });
  assert.equal(ctx.label("2026-10-05"), "00:00–00:20（接周日）");
  assert.match(ctx.card("2026-10-05").textContent, /完整时段：2026-10-04 23:40 — 2026-10-05 00:20（America\/New_York）/);
  assert.equal(ctx.planned("2026-10-05"), "计划 20 分钟");
  ctx.byId("week-previous").click();
  assert.equal(ctx.label("2026-10-04"), "23:40–24:00（续至周一）");
  assert.equal(ctx.planned("2026-10-04"), "计划 20 分钟");
  ctx.changeZone("Asia/Shanghai");
  ctx.byId("week-today").click();
  assert.equal(ctx.label("2026-10-05"), "11:40–12:20");
  assert.equal(ctx.writes.length, 0);
});

test("DST gap and fold continuations retain real elapsed minutes", async (t) => {
  for (const spec of [
    { name: "spring gap", startAt: "2026-03-08T04:30:00.000Z", endAt: "2026-03-08T07:30:00.000Z", first: "2026-03-07", next: "2026-03-08", endTime: "03:30", nextMinutes: 150, totalMinutes: 180 },
    { name: "autumn fold", startAt: "2026-11-01T03:30:00.000Z", endAt: "2026-11-01T07:30:00.000Z", first: "2026-10-31", next: "2026-11-01", endTime: "02:30", nextMinutes: 210, totalMinutes: 240 },
  ]) await t.test(spec.name, async (t) => {
    const ctx = await setup(t, { ...spec, timeZone: "America/New_York" });
    assert.equal(ctx.label(spec.first), "23:30–24:00（续至周日）");
    assert.equal(ctx.label(spec.next), `00:00–${spec.endTime}（接周六）`);
    assert.equal(ctx.planned(spec.first), "计划 30 分钟");
    assert.equal(ctx.planned(spec.next), `计划 ${spec.nextMinutes} 分钟`);
    assert.match(ctx.byId("calendar-summary").textContent, new RegExp(`总计划 ${spec.totalMinutes} 分钟`));
    assert.equal(ctx.card(spec.next).querySelector(".session-duration").textContent, `整段 ${spec.totalMinutes} 分钟`);
  });
});

test("a skipped midnight starts its continuation at the first real local time", async (t) => {
  const ctx = await setup(t, { startAt: "2018-11-04T02:30:00.000Z", endAt: "2018-11-04T03:30:00.000Z", timeZone: "America/Sao_Paulo" });
  assert.equal(ctx.label("2018-11-03"), "23:30–24:00（续至周日）");
  assert.equal(ctx.label("2018-11-04"), "01:00–01:30（接周六）");
  assert.equal(ctx.planned("2018-11-03"), "计划 30 分钟");
  assert.equal(ctx.planned("2018-11-04"), "计划 30 分钟");
});

test("a 24-hour session across a short DST day can show three civil-day segments", async (t) => {
  const ctx = await setup(t, { startAt: "2026-03-08T04:30:00.000Z", endAt: "2026-03-09T04:30:00.000Z", timeZone: "America/New_York" });
  assert.equal(ctx.label("2026-03-07"), "23:30–24:00（续至周一）");
  assert.equal(ctx.label("2026-03-08"), "00:00–24:00（接周六，续至周一）");
  assert.equal(ctx.planned("2026-03-07"), "计划 30 分钟");
  assert.equal(ctx.planned("2026-03-08"), "计划 1380 分钟");
  ctx.byId("week-next").click();
  assert.equal(ctx.label("2026-03-09"), "00:00–00:30（接周日）");
  assert.equal(ctx.planned("2026-03-09"), "计划 30 分钟");
  assert.equal(ctx.card("2026-03-09").querySelector(".session-duration").textContent, "整段 1440 分钟");
  assert.match(ctx.card("2026-03-09").textContent, /完整时段：2026-03-07 23:30 — 2026-03-09 00:30/);
});

test("a midnight end beyond a short DST day names the last occupied date", async (t) => {
  const ctx = await setup(t, { startAt: "2026-03-08T04:30:00.000Z", endAt: "2026-03-09T04:00:00.000Z", timeZone: "America/New_York" });
  assert.equal(ctx.label("2026-03-07"), "23:30–24:00（续至周日）");
  assert.equal(ctx.label("2026-03-08"), "00:00–24:00（接周六）");
  ctx.byId("week-next").click();
  assert.equal(ctx.card("2026-03-09"), null);
});
