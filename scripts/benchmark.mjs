import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { boardSchema, emptyBoard, LIMITS, STATUS_VALUES, taskSchema, VERSION } from "../src/board.mjs";
import { mountBoard } from "../src/view.mjs";
import { PREFERENCE_KEY } from "../src/view-common.mjs";
import { ROOT, sha256, sourceSnapshot } from "./check-release.mjs";
import { loadAppTemplate } from "./app-template.mjs";

const TIMESTAMP = "2026-10-05T00:00:00.000Z";
const uuid = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;

export function syntheticBoard(taskCount) {
  if (!Number.isInteger(taskCount) || taskCount < 1 || taskCount > LIMITS.tasks) throw new Error(`Task count must be from 1 to ${LIMITS.tasks}`);
  const projectCount = Math.min(10, taskCount);
  return boardSchema.parse({
    ...emptyBoard(),
    projects: Array.from({ length: projectCount }, (_, index) => ({ id: uuid(index + 1), name: `合成项目 ${index + 1}`, description: "固定合成数据，不读取本机记录", lastUpdatedAt: TIMESTAMP })),
    tasks: Array.from({ length: taskCount }, (_, index) => taskSchema.parse({
      id: uuid(index + 100), projectId: uuid(index % projectCount + 1),
      title: `合成任务 ${String(index).padStart(4, "0")}${index % 10 === 0 ? " needle" : ""}`,
      status: STATUS_VALUES[index % STATUS_VALUES.length], sourceTool: index % 2 ? "Codex" : "手动填写",
      currentStep: `步骤 ${index % 20}`, blocker: index % 7 ? "" : "等待合成材料",
      conversationUrl: null, lastUpdatedAt: TIMESTAMP,
    })),
  });
}

const round = (value) => Math.round(value * 100) / 100;
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { minMs: round(sorted[0]), medianMs: round(sorted[Math.floor(sorted.length / 2)]), maxMs: round(sorted.at(-1)), samplesMs: values.map(round) };
}

function assertRenderedTasks(document, tasks) {
  const counts = [...document.querySelectorAll('.kanban-column')];
  assert.equal(counts.reduce((sum, column) => sum + Number(column.querySelector('.column-count').textContent), 0), tasks.length, 'Column counts must include folded tasks');
  for (const column of counts) {
    const columnTasks = tasks.filter((task) => task.status === column.dataset.status);
    const page = Number(column.dataset.page || 0);
    const pageSize = Number(column.dataset.pageSize || columnTasks.length || 1);
    assert.ok(Number.isInteger(page) && page >= 0 && page <= Math.max(0, Math.ceil(columnTasks.length / pageSize) - 1), 'Page index must stay within the column');
    const expected = column.classList.contains('is-collapsed') ? [] : columnTasks.slice(page * pageSize, (page + 1) * pageSize).map((task) => task.id);
    const actual = [...column.querySelectorAll('[data-edit-task]')].map((node) => node.dataset.editTask);
    assert.deepEqual(actual, expected, 'Open columns must render the exact task IDs; folded columns must defer their cards');
  }
}

function assertAllPagesReachable(document, tasks) {
  const visited = new Set();
  for (const status of STATUS_VALUES) {
    const expected = tasks.filter((task) => task.status === status).map((task) => task.id);
    const found = [];
    for (let pages = 0; ; pages++) {
      if (pages > tasks.length) throw new Error('Pagination did not terminate');
      const column = document.querySelector(`.kanban-column[data-status="${status}"]`);
      assert.ok(column && !column.classList.contains('is-collapsed'));
      found.push(...[...column.querySelectorAll('[data-edit-task]')].map((node) => node.dataset.editTask));
      const next = column.querySelector('[data-page-control="next"]');
      if (!next || next.disabled) break;
      next.click();
      assertRenderedTasks(document, tasks);
    }
    assert.deepEqual(found, expected, 'Every task must be reachable once through its column pages');
    for (const id of found) { assert.ok(!visited.has(id), 'Pages must not repeat tasks'); visited.add(id); }
  }
  assert.equal(visited.size, tasks.length, 'All synthetic tasks must remain reachable');
}

async function searchMeasurement(document, window, query, tasks) {
  const expected = tasks.length;
  const search = document.getElementById("search");
  const started = performance.now();
  search.value = query;
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  // Most render work is synchronous today; this also supports a future search
  // debounce. Timing stops only once the expected result count reaches the DOM.
  while (Number.parseInt(document.getElementById("count").textContent, 10) !== expected) {
    if (performance.now() - started > 30_000) throw new Error(`Search did not render ${expected} results for ${JSON.stringify(query)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const duration = performance.now() - started;
  assertRenderedTasks(document, tasks);
  return duration;
}

export async function runBenchmark({ sizes = [100, 1000, 5000], iterations = 3, warmups = 1 } = {}) {
  if (!Array.isArray(sizes) || !sizes.length || !Number.isInteger(iterations) || iterations < 1 || iterations > 10 || !Number.isInteger(warmups) || warmups < 0 || warmups > 3) throw new Error("Invalid benchmark configuration");
  const hashes = async () => ({ ...(await sourceSnapshot(ROOT)).hashes, "scripts/benchmark.mjs": sha256(await readFile(new URL("./benchmark.mjs", import.meta.url))) });
  const sourceHashes = await hashes();
  const html = await loadAppTemplate(ROOT);
  const results = [];
  for (const taskCount of sizes) {
    const board = syntheticBoard(taskCount);
    const samples = { domSetup: [], initialRender: [], searchSubset: [], searchEmpty: [], searchReset: [], expandAll: [], allPagesTraversal: [] };
    for (let attempt = 0; attempt < iterations + warmups; attempt++) {
      const setupStart = performance.now();
      // No scripts, resource fetching, MCP server, or production data access.
      const dom = new JSDOM(html, { url: "https://synthetic-benchmark.invalid/" });
      const setupTime = performance.now() - setupStart;
      try {
        dom.window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ viewMode: "board" }));
        const started = performance.now();
        mountBoard(dom.window.document, board, {
          mutate: async () => { throw new Error("Synthetic benchmark must not persist records"); },
          refresh: async () => { throw new Error("Synthetic benchmark must not read records"); },
        });
        const initialTime = performance.now() - started;
        assertRenderedTasks(dom.window.document, board.tasks);
        const subsetTime = await searchMeasurement(dom.window.document, dom.window, "needle", board.tasks.filter((task) => task.title.includes('needle')));
        const emptyTime = await searchMeasurement(dom.window.document, dom.window, "synthetic-no-match", []);
        const resetTime = await searchMeasurement(dom.window.document, dom.window, "", board.tasks);
        const expandStart = performance.now();
        for (let toggle; (toggle = dom.window.document.querySelector('[data-toggle-column][aria-expanded="false"]')); ) toggle.click();
        const expandTime = performance.now() - expandStart;
        assertRenderedTasks(dom.window.document, board.tasks);
        const traversalStart = performance.now();
        assertAllPagesReachable(dom.window.document, board.tasks);
        const traversalTime = performance.now() - traversalStart;
        if (attempt >= warmups) {
          for (const [key, value] of Object.entries({ domSetup: setupTime, initialRender: initialTime, searchSubset: subsetTime, searchEmpty: emptyTime, searchReset: resetTime, expandAll: expandTime, allPagesTraversal: traversalTime })) samples[key].push(value);
        }
      } finally { dom.window.close(); }
    }
    results.push({ taskCount, projectCount: board.projects.length, fixtureSha256: sha256(JSON.stringify(board)), measurements: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, summarize(values)])) });
  }
  if (JSON.stringify(sourceHashes) !== JSON.stringify(await hashes())) throw new Error("Source changed during benchmark; rerun on a stable workspace");
  return {
    formatVersion: 1, version: VERSION, evidence: "synthetic-jsdom",
    limitations: "JSDOM DOM execution only; excludes browser layout, paint, GPU, host IPC, real user data and physical device performance. Measurements are reports, not fixed millisecond pass/fail thresholds.",
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model || "unknown", jsdom: JSON.parse(await readFile(new URL("../node_modules/jsdom/package.json", import.meta.url))).version },
    sourceHashes, iterations, warmups, results,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    let output;
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (!value || seen.has(key)) throw new Error("Benchmark options require unique values");
      seen.add(key);
      if (key === "--sizes" && /^\d+(,\d+)*$/.test(value)) options.sizes = value.split(",").map(Number);
      else if (key === "--iterations" && /^\d+$/.test(value)) options.iterations = Number(value);
      else if (key === "--warmups" && /^\d+$/.test(value)) options.warmups = Number(value);
      else if (key === "--output") output = path.resolve(value);
      else throw new Error("Usage: node scripts/benchmark.mjs [--sizes 100,1000,5000] [--iterations 1..10] [--warmups 0..3] [--output FILE]");
    }
    const report = JSON.stringify(await runBenchmark(options), null, 2) + "\n";
    if (output) await writeFile(output, report, { flag: "wx" });
    console.log(report);
  } catch (error) {
    console.error(`Synthetic benchmark failed: ${error.message}`);
    process.exitCode = 1;
  }
}
