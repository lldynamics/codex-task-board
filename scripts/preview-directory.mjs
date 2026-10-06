import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The keeper allocates its own directory and removes it only after the owner
// has gone. It never accepts a deletion path or scans other preview directories.
export function createPreviewDirectory() {
  const keeper = fork(fileURLToPath(import.meta.url), ["--keep-preview-directory"], {
    execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  return new Promise((resolve, reject) => {
    let ready = false;
    keeper.once("error", reject);
    keeper.once("exit", (code, signal) => {
      if (!ready) reject(new Error(`Preview directory keeper exited (${signal || code})`));
      else {
        console.error("Preview directory keeper stopped unexpectedly; stopping this preview.");
        process.exit(1);
      }
    });
    keeper.once("message", (message) => {
      if (message?.type !== "ready" || typeof message.directory !== "string") {
        if (keeper.connected) keeper.disconnect();
        reject(new Error("Preview directory keeper did not allocate a directory"));
        return;
      }
      ready = true;
      // The keeper must not keep a failed or otherwise finished owner alive.
      keeper.unref();
      keeper.channel.unref();
      resolve(message.directory);
    });
  });
}

async function keepPreviewDirectory() {
  if (!process.connected) throw new Error("Preview directory keeper requires its owner's IPC channel");
  const allocation = mkdtemp(path.join(tmpdir(), "learning-board-ui-preview-"));
  let cleanup;
  function release() {
    return cleanup ??= (async () => {
      try { await rm(await allocation, { recursive: true, force: true }); }
      catch (error) {
        console.error(`Preview directory cleanup failed: ${error.code || error.message}`);
        process.exitCode = 1;
      } finally {
        if (process.connected) process.disconnect();
      }
    })();
  }
  process.on("disconnect", () => void release());
  // Terminal signals may reach both processes. The owner exits first so that
  // in-flight store work cannot recreate files after cleanup.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
  try {
    const directory = await allocation;
    if (!process.connected) { await release(); return; }
    process.send({ type: "ready", directory }, (error) => { if (error) void release(); });
  } catch (error) {
    console.error(`Preview directory allocation failed: ${error.code || error.message}`);
    await release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--keep-preview-directory") throw new Error("This helper is started only by the preview owner");
  await keepPreviewDirectory();
}
