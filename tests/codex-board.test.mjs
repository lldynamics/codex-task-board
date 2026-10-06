import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { codexSnapshotSchema, unavailableCodexSnapshot, CODEX_SNAPSHOT_STALE_MS } from "../src/codex-domain.mjs";
import { projectCodexSnapshot } from "../src/codex-board.mjs";
import { threadPresentation } from "../src/view-codex.mjs";

const observedAt = "2026-10-05T00:00:00.000Z";
const origin = Date.parse(observedAt);
const thread = (id = "thread", fields = {}) => ({ id, hostId: "local", title: `任务 ${id}`, cwd: "/work/project", updatedAt: observedAt, runtimeStatus: "idle", attention: null, lastTurnStatus: null, goalStatus: null, ...fields });
function snapshot(threads = [], sourceFields = {}) {
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: observedAt, complete: true, truncated: false, error: null, ...sourceFields };
  return codexSnapshotSchema.parse({ ...unavailableCodexSnapshot(observedAt), threads, sources: { threads: source, automations: { ...source } } });
}
const project = (value, options = {}) => projectCodexSnapshot(value, { now: origin, ...options });

test("same host and trailing-normalized cwd share one read-only project without persisting manual records", () => {
  const input = snapshot([thread("first", { cwd: "/work/project/" }), thread("second", { cwd: "/work/project///" }), thread("third")]);
  const value = project(input);
  assert.equal(value.projects.length, 1);
  assert.equal(value.projects[0].name, "project");
  assert.equal(value.projects[0].cwd, "/work/project");
  assert.equal(value.projects[0].description, "主机：local · 目录：/work/project");
  assert.ok(value.tasks.every((task) => task.projectId === value.projects[0].id));
  for (const item of [...value.projects, ...value.tasks]) {
    assert.equal(item.readOnly, true); assert.equal(item.source, "codex"); assert.equal(item.origin, "codex"); assert.equal(item.archivedAt, null);
    assert.ok(!/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(item.id));
  }
  assert.equal(value.tasks[0].sourceTool, "Codex 自动同步");
  assert.equal(value.tasks[0].priority, "normal");
  assert.equal(value.tasks[0].dueDate, null);
  assert.equal(value.tasks[0].blocker, "");
  assert.equal(value.tasks[0].conversationUrl, null);
  assert.equal(value.tasks[0].currentStep, value.tasks[0].statusLabel);
});

test("same basename, different directories and different hosts cannot merge or reuse task identities", () => {
  const value = project(snapshot([thread("same", { cwd: "/one/project" }), thread("other", { cwd: "/two/project" }), thread("same", { hostId: "remote-control:host", cwd: "/one/project" })]));
  assert.equal(value.projects.length, 3);
  assert.equal(new Set(value.projects.map((item) => item.id)).size, 3);
  assert.equal(new Set(value.tasks.map((item) => item.id)).size, 3);
  assert.deepEqual(value.projects.map((item) => [item.hostId, item.cwd]), [["local", "/one/project"], ["local", "/two/project"], ["remote-control:host", "/one/project"]]);
  assert.equal(new Set(value.projects.map((item) => item.description)).size, 3);
});

test("POSIX path case, internal separators, symlink spellings and worktrees remain separate", () => {
  const paths = ["/work/Project", "/work/project", "/work/project/../project", "/work//project", "/work/project-link", "/work/project.worktree", "/tmp/a\\", "/tmp/a", " /work/project "];
  const value = project(snapshot(paths.map((cwd, index) => thread(String(index), { cwd }))));
  assert.equal(value.projects.length, paths.length);
  assert.deepEqual([...value.projects.map((item) => item.cwd)].sort(), [...paths].sort());
  assert.equal(value.projects.find((item) => item.cwd === "/tmp/a\\").name, "a\\");
  assert.equal(value.projects.find((item) => item.cwd === " /work/project ").name, "project ");
});

test("Windows drive and UNC paths remove trailing separators while preserving drive roots and internal spelling", () => {
  const paths = ["C:\\work\\project\\", "C:\\work\\project", "\\\\server\\share\\project\\\\", "\\\\server\\share\\project", "C:\\\\", "C:\\", "C:/", "C:", "c:\\work\\project"];
  const value = project(snapshot(paths.map((cwd, index) => thread(String(index), { cwd }))));
  assert.equal(value.projects.length, 6);
  assert.ok(value.projects.some((item) => item.cwd === "C:\\"));
  assert.ok(value.projects.some((item) => item.cwd === "C:/"));
  assert.ok(value.projects.some((item) => item.cwd === "C:"));
  assert.ok(value.projects.some((item) => item.cwd === "C:\\work\\project" && item.name === "project"));
  assert.ok(value.projects.some((item) => item.cwd === "\\\\server\\share\\project" && item.name === "project"));
});

test("null, empty and whitespace cwd share an unassociated project within each host; root stays a project", () => {
  const value = project(snapshot([thread("a", { cwd: null }), thread("b", { cwd: "" }), thread("c", { cwd: " \t\n " }), thread("d", { hostId: "remote-control:host", cwd: null }), thread("root", { cwd: "////" })]));
  assert.equal(value.projects.length, 3);
  const local = value.projects.find((item) => item.hostId === "local" && item.cwd === null);
  assert.equal(local.name, "未关联项目");
  assert.equal(value.tasks.filter((task) => task.projectId === local.id).length, 3);
  assert.ok(value.projects.some((item) => item.cwd === "/" && item.name === "/"));
  assert.ok(value.projects.some((item) => item.hostId === "remote-control:host" && item.cwd === null && item.id !== local.id));
});

test("project and task IDs are stable across input order, title changes and JSON identity ambiguities", () => {
  const inputs = [thread("c", { cwd: "/work/Z" }), thread("a", { cwd: "/work/A", updatedAt: null }), thread("b", { cwd: "/work/A", updatedAt: "2026-10-04T00:00:00.000Z" })];
  const a = project(snapshot(inputs));
  const b = project(snapshot([...inputs].reverse()));
  assert.deepEqual(a, b);
  assert.deepEqual(a.projects.map((item) => item.name), ["A", "Z"]);
  assert.deepEqual(a.tasks.map((item) => item.threadId), ["b", "a", "c"]);
  const changed = project(snapshot(inputs.map((item) => ({ ...item, title: "改标题" }))));
  assert.deepEqual(a.projects, changed.projects);
  assert.deepEqual(a.tasks.map((item) => item.id), changed.tasks.map((item) => item.id));
  const tuples = project(snapshot([thread("a:b", { hostId: "c", cwd: "/same" }), thread("b", { hostId: "c:a", cwd: "/same" })]));
  assert.equal(new Set(tuples.tasks.map((item) => item.id)).size, 2);
  assert.equal(new Set(tuples.projects.map((item) => item.id)).size, 2);
});

test("untrusted identity and path strings produce DOM-safe IDs without rewriting display text", () => {
  const evil = `恶意"'\\][data-owned=true]<img src=x onerror=alert(1)>`;
  const value = project(snapshot([thread(evil, { hostId: evil, cwd: `/工作/${evil}`, title: evil })]));
  const dom = new JSDOM("<!doctype html><body></body>");
  try {
    for (const item of [...value.projects, ...value.tasks]) {
      assert.match(item.id, /^codex-(project|task)-[0-9a-f]+$/);
      const node = dom.window.document.createElement("div"); node.id = item.id; node.dataset.identity = item.id; dom.window.document.body.append(node);
      assert.equal(dom.window.document.querySelector(`#${item.id}`), node);
      assert.equal(dom.window.document.querySelector(`[data-identity="${item.id}"]`), node);
    }
    assert.equal(value.tasks[0].title, evil);
    assert.equal(value.projects[0].cwd, `/工作/${evil}`);
  } finally { dom.window.close(); }
});

test("board statuses keep the existing presentation priorities and distinguish goal completion from turn end", () => {
  const cases = [
    [{ attention: "approval", runtimeStatus: "active", goalStatus: "complete" }, "waiting_user"],
    [{ attention: "input" }, "waiting_user"], [{ runtimeStatus: "error" }, "failed"],
    [{ runtimeStatus: "active", goalStatus: "complete" }, "in_progress"], [{ lastTurnStatus: "running" }, "in_progress"],
    [{ goalStatus: "complete", lastTurnStatus: "failed" }, "completed"],
    [{ lastTurnStatus: "failed" }, "failed"], [{ lastTurnStatus: "interrupted" }, "failed"],
    [{ goalStatus: "blocked" }, "waiting_user"], [{ goalStatus: "paused" }, "paused"],
    [{ lastTurnStatus: "completed" }, "turn_ended"], [{ lastTurnStatus: "completed", goalStatus: "active" }, "turn_ended"],
    [{ runtimeStatus: "idle" }, "idle"], [{ runtimeStatus: "notLoaded" }, "not_loaded"], [{ runtimeStatus: "unknown" }, "unknown"],
  ];
  for (const [fields, status] of cases) {
    const input = thread("status", fields);
    const task = project(snapshot([input])).tasks[0];
    assert.equal(task.status, status);
    assert.equal(task.statusLabel, status === "unknown" ? "状态未知 · 来源未提供当前状态" : threadPresentation(input).label);
    if (status === "completed") assert.equal(input.goalStatus, "complete");
  }
});

test("fresh idle and not-loaded runtime have their own read-only states without implying a completed goal", () => {
  for (const [runtimeStatus, status, label] of [["idle", "idle", "空闲"], ["notLoaded", "not_loaded", "未加载"]]) {
    const task = project(snapshot([thread("state", { runtimeStatus, goalStatus: "active" })], { state: "partial", complete: false, truncated: true })).tasks[0];
    assert.equal(task.status, status); assert.equal(task.readOnly, true); assert.match(task.statusLabel, new RegExp(`^${label} · 完成情况未知$`));
    for (const [fields, higherPriority] of [[{ attention: "input" }, "waiting_user"], [{ lastTurnStatus: "running" }, "in_progress"], [{ goalStatus: "complete" }, "completed"], [{ lastTurnStatus: "completed" }, "turn_ended"]]) {
      assert.equal(project(snapshot([thread("priority", { runtimeStatus, ...fields })])).tasks[0].status, higherPriority);
    }
  }
});

test("expired or unavailable runtime downgrades idle and not-loaded states with the actual missing-status reason", () => {
  const cases = [
    [{}, { now: origin + CODEX_SNAPSHOT_STALE_MS + 1 }, "状态未知 · 采集已过期"],
    [{ state: "disconnected" }, {}, "状态未知 · 来源不可用"],
    [{ state: "unsupported" }, {}, "状态未知 · 来源不可用"],
    [{ mode: "unavailable" }, {}, "状态未知 · 来源不可用"],
    [{ mode: "archive" }, {}, "状态未知 · 历史记录不提供当前状态"],
    [{ lastSuccessAt: null }, {}, "状态未知 · 缺少有效采集时间"],
    [{ lastSuccessAt: "2026-10-05T00:00:00.001Z" }, {}, "状态未知 · 采集时间异常"],
  ];
  for (const [source, options, label] of cases) {
    const input = snapshot([thread("idle", { runtimeStatus: "idle" }), thread("not-loaded", { runtimeStatus: "notLoaded" }), thread("unknown", { runtimeStatus: "unknown" })], source);
    const original = structuredClone(input);
    const value = project(input, options);
    assert.equal(value.freshness.runtimeReliable, false);
    for (const task of value.tasks) { assert.equal(task.status, "unknown"); assert.equal(task.statusLabel, label); assert.equal(task.currentStep, label); assert.equal(task.thread.runtimeStatus, "unknown"); }
    assert.deepEqual(input, original);
  }
  for (const source of [{}, { state: "partial", complete: false, truncated: true }, { mode: "live" }]) {
    assert.equal(project(snapshot([thread("unknown", { runtimeStatus: "unknown" })], source)).tasks[0].statusLabel, "状态未知 · 来源未提供当前状态");
  }
});

test("source TTL uses collection time instead of snapshot observedAt and expires running and attention flags", () => {
  const input = snapshot([thread("active", { runtimeStatus: "active" }), thread("approval", { attention: "approval" }), thread("running", { lastTurnStatus: "running" })]);
  input.observedAt = "2026-10-05T00:03:00.001Z";
  assert.equal(project(input, { now: origin + CODEX_SNAPSHOT_STALE_MS }).freshness.expired, false);
  const stale = project(input, { now: origin + CODEX_SNAPSHOT_STALE_MS + 1 });
  assert.equal(stale.freshness.expired, true);
  assert.equal(stale.freshness.runtimeReliable, false);
  assert.equal(stale.freshness.lastSuccessAt, observedAt);
  assert.ok(stale.tasks.every((item) => item.status === "unknown" && item.thread.runtimeStatus === "unknown" && item.thread.attention === null && item.thread.lastTurnStatus === null));
});

test("disconnected, unsupported, missing time, future time and archive sources cannot claim reliable active runtime", () => {
  for (const source of [{ state: "disconnected" }, { state: "unsupported" }, { lastSuccessAt: null }, { lastSuccessAt: "2026-10-05T00:00:00.001Z" }, { mode: "archive" }, { mode: "unavailable" }]) {
    const value = project(snapshot([thread("active", { runtimeStatus: "active", attention: "input", lastTurnStatus: "running" })], source));
    assert.equal(value.freshness.runtimeReliable, false);
    assert.equal(value.tasks[0].status, "unknown");
  }
  assert.equal(project(snapshot([thread("partial", { runtimeStatus: "active" })], { state: "partial", complete: false, truncated: true })).tasks[0].status, "in_progress");
});

test("explicit terminal goal and turn metadata keep their labels after runtime expiry", () => {
  const input = snapshot([thread("goal", { runtimeStatus: "active", attention: "input", goalStatus: "complete" }), thread("turn", { lastTurnStatus: "completed" }), thread("failed", { lastTurnStatus: "failed" }), thread("interrupted", { lastTurnStatus: "interrupted" })], { state: "disconnected" });
  const value = project(input);
  assert.deepEqual(value.tasks.map((item) => [item.threadId, item.status]).sort(), [["failed", "failed"], ["goal", "completed"], ["interrupted", "failed"], ["turn", "turn_ended"]]);
});

test("unknown timestamps remain null; projection does not fabricate last updates from the read clock", () => {
  const value = project(snapshot([thread("unknown", { updatedAt: null })]));
  assert.equal(value.tasks[0].updatedAt, null);
  assert.equal(value.tasks[0].lastUpdatedAt, null);
  assert.equal(value.tasks[0].thread.updatedAt, null);
  const empty = project(unavailableCodexSnapshot(observedAt));
  assert.deepEqual(empty.projects, []); assert.deepEqual(empty.tasks, []);
  assert.equal(empty.freshness.runtimeReliable, false);
  assert.equal(empty.freshness.ageMs, null);
});

test("strict validation rejects private fields, duplicate identities and malformed or missing snapshots", () => {
  const valid = snapshot([thread()]);
  for (const input of [null, undefined, {}, { ...valid, prompt: "PRIVATE" }, { ...valid, threads: [{ ...valid.threads[0], summary: "PRIVATE" }] }, { ...valid, threads: [valid.threads[0], valid.threads[0]] }]) assert.throws(() => project(input));
  const differentHosts = project(snapshot([thread("same"), thread("same", { hostId: "remote-control:host" })]));
  assert.equal(differentHosts.tasks.length, 2);
});

test("projection does not mutate input or retain writable references to source and thread metadata", () => {
  const input = snapshot([thread("active", { cwd: "/work/project/", runtimeStatus: "active", attention: "approval" })]);
  const original = structuredClone(input);
  const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(input);
  const value = project(input, { now: origin + CODEX_SNAPSHOT_STALE_MS + 1 });
  value.tasks[0].thread.title = "Changed";
  value.source.state = "connected";
  value.projects[0].name = "Changed";
  assert.deepEqual(input, original);
});

test("custom freshness thresholds are bounded and use the same expiry edge", () => {
  const input = snapshot([thread("active", { runtimeStatus: "active" })]);
  assert.equal(project(input, { now: origin + 1000, staleMs: 1000 }).tasks[0].status, "in_progress");
  assert.equal(project(input, { now: origin + 1001, staleMs: 1000 }).tasks[0].status, "unknown");
  for (const options of [{ now: NaN }, { now: Infinity }, { staleMs: -1 }, { staleMs: Infinity }]) assert.throws(() => project(input, options), TypeError);
});
