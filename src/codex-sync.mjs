#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { CODEX_SNAPSHOT_DIRECTORY, CODEX_SNAPSHOT_MAX_BYTES, createCodexService, ingestCodexSnapshot } from "./codex-service.mjs";

async function inputJson(stream) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > CODEX_SNAPSHOT_MAX_BYTES) throw Object.assign(new Error("Collector input exceeds its size limit"), { code: "INPUT_TOO_LARGE" });
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Collector input must be JSON"), { code: "INVALID_INPUT" }); }
}
function overview(snapshot) {
  const source = (value) => ({ mode: value.mode, state: value.state, lastSuccessAt: value.lastSuccessAt, complete: value.complete, truncated: value.truncated, errorCode: value.error?.code ?? null });
  return {
    version: snapshot.version, observedAt: snapshot.observedAt,
    connection: { state: snapshot.connection.state, source: snapshot.connection.source, lastSuccessAt: snapshot.connection.lastSuccessAt, errorCode: snapshot.connection.error?.code ?? null },
    sources: { threads: source(snapshot.sources.threads), automations: source(snapshot.sources.automations) },
    counts: { threads: snapshot.threads.length, automations: snapshot.automations.length }, completeness: snapshot.completeness,
  };
}

// Dependency injection is for isolated tests; the command line has no custom path option.
export async function runCodexSync(argv, { input = process.stdin, output = process.stdout, errorOutput = process.stderr, directory = CODEX_SNAPSHOT_DIRECTORY, service, now } = {}) {
  try {
    if (argv.length !== 1 || !["ingest", "inspect"].includes(argv[0])) throw Object.assign(new Error("Usage: codex-sync.mjs ingest|inspect"), { code: "INVALID_COMMAND" });
    const result = argv[0] === "ingest"
      ? await ingestCodexSnapshot(directory, await inputJson(input), { now })
      : overview(await (service ?? createCodexService({ directory, now })).read());
    output.write(JSON.stringify(result) + "\n");
    return 0;
  } catch (error) {
    // Neither private paths nor SQLite stderr nor raw collector content are printed.
    errorOutput.write(JSON.stringify({ ok: false, error: { code: typeof error.code === "string" ? error.code : "SYNC_FAILED", message: argv[0] === "ingest" ? "Codex 采集未写入；缓存保持原状态。" : "Codex 状态检查失败。" } }) + "\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCodexSync(process.argv.slice(2));
