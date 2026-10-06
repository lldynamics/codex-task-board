import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const helper = new URL("../scripts/preview-directory.mjs", import.meta.url).href;
const ownerScript = `
  import { createPreviewDirectory } from ${JSON.stringify(helper)};
  const directory = await createPreviewDirectory();
  console.log(JSON.stringify({directory}));
  if (process.argv[1] === "fail") throw new Error("Synthetic preview startup failure");
  if (process.argv[1] === "wait") setInterval(() => {}, 1000);
`;

async function until(check, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(description);
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "preview-lifecycle-test-"));
  // A same-prefix legacy directory is deliberately outside the keeper's scope.
  const legacy = path.join(directory, "learning-board-ui-preview-legacy");
  await mkdir(legacy);
  await writeFile(path.join(legacy, "untouched.txt"), "Synthetic legacy preview remains untouched");
  const instances = [];
  t.after(async () => {
    for (const instance of instances) {
      if (instance.child.exitCode === null && instance.child.signalCode === null) instance.child.kill("SIGKILL");
      await instance.closed;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, legacy, instances, env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory } };
}

function owner(t, ctx, args, { detached = false } = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: ctx.env, detached, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "", result;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { error += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { result = { code, signal }; resolve(result); });
  });
  ctx.instances.push({ child, closed });
  return { child, closed, get output() { return output; }, get error() { return error; }, get result() { return result; } };
}

async function allocated(instance) {
  await until(() => instance.output.includes("\n") || instance.result, "Owner did not report its temporary directory");
  assert.ok(instance.output.includes("\n"), instance.error);
  return JSON.parse(instance.output.split("\n")[0]).directory;
}

async function cleaned(ctx) {
  await until(async () => (await readdir(ctx.directory)).every((name) => name === path.basename(ctx.legacy) || name === "listen-failure.mjs"), "Owned preview directory remained after its owner exited");
  assert.equal(await readFile(path.join(ctx.legacy, "untouched.txt"), "utf8"), "Synthetic legacy preview remains untouched");
}

for (const mode of ["normal", "fail"]) {
  test(`preview keeper removes its own directory on ${mode} owner exit and preserves legacy directories`, async (t) => {
    const ctx = await fixture(t), instance = owner(t, ctx, ["--input-type=module", "-e", ownerScript, mode]);
    const directory = await allocated(instance);
    assert.equal(path.dirname(directory), ctx.directory);
    assert.notEqual(directory, ctx.legacy);
    assert.equal((await instance.closed).code, mode === "normal" ? 0 : 1);
    if (mode === "fail") assert.match(instance.error, /Synthetic preview startup failure/);
    await cleaned(ctx);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]) {
  test(`preview keeper cleans an allocated directory after owner ${signal}`, async (t) => {
    const ctx = await fixture(t), instance = owner(t, ctx, ["--input-type=module", "-e", ownerScript, "wait"]);
    const directory = await allocated(instance);
    assert.ok((await readdir(ctx.directory)).includes(path.basename(directory)));
    assert.equal(instance.child.kill(signal), true);
    assert.equal((await instance.closed).signal, signal);
    await cleaned(ctx);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`preview keeper survives ${signal} sent to its isolated owner process group`, async (t) => {
    const ctx = await fixture(t), instance = owner(t, ctx, ["--input-type=module", "-e", ownerScript, "wait"], { detached: true });
    await allocated(instance);
    // Only this fixture and its keeper belong to the newly created group.
    assert.equal(instance.child.exitCode, null);
    process.kill(-instance.child.pid, signal);
    assert.equal((await instance.closed).signal, signal);
    await cleaned(ctx);
  });
}

test("preview owner disconnecting before the keeper is ready cannot leave a directory", async (t) => {
  const ctx = await fixture(t), instance = owner(t, ctx, ["--input-type=module", "-e", `import { createPreviewDirectory } from ${JSON.stringify(helper)}; void createPreviewDirectory(); process.exit(0);`]);
  assert.equal((await instance.closed).code, 0);
  await cleaned(ctx);
});

test("preview allocation failure terminates without keeping its owner alive", async (t) => {
  const ctx = await fixture(t);
  ctx.env.TMPDIR = ctx.env.TMP = ctx.env.TEMP = path.join(ctx.directory, "missing-parent");
  const instance = owner(t, ctx, ["--input-type=module", "-e", ownerScript, "normal"]);
  const result = await instance.closed;
  assert.equal(result.code, 1);
  assert.match(instance.error, /allocation failed|keeper exited/);
  await cleaned(ctx);
});

test("concurrent preview owners clean only their own directory", async (t) => {
  const ctx = await fixture(t);
  const first = owner(t, ctx, ["--input-type=module", "-e", ownerScript, "wait"]);
  const second = owner(t, ctx, ["--input-type=module", "-e", ownerScript, "wait"]);
  const firstDirectory = await allocated(first), secondDirectory = await allocated(second);
  assert.notEqual(firstDirectory, secondDirectory);
  first.child.kill("SIGKILL");
  await first.closed;
  await until(async () => !(await readdir(ctx.directory)).includes(path.basename(firstDirectory)), "First owner's directory remained");
  assert.equal(second.child.exitCode, null);
  assert.ok((await readdir(ctx.directory)).includes(path.basename(secondDirectory)), "A live sibling preview must keep its own directory");
  second.child.kill("SIGTERM");
  await second.closed;
  await cleaned(ctx);
});

test("actual preview startup listen failure cleans seeded temporary data", async (t) => {
  const ctx = await fixture(t), preload = path.join(ctx.directory, "listen-failure.mjs");
  await writeFile(preload, `import { Server } from "node:http"; Server.prototype.listen = function () { queueMicrotask(() => this.emit("error", Object.assign(new Error("Synthetic listen failure"), {code:"SYNTHETIC_LISTEN_FAILURE"}))); return this; };`);
  const instance = owner(t, ctx, ["--import", preload, "scripts/preview.mjs"]);
  assert.equal((await instance.closed).code, 1);
  assert.match(instance.error, /Preview failed: SYNTHETIC_LISTEN_FAILURE/);
  await cleaned(ctx);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL"]) {
  test(`actual running preview serves temporary HTML then cleans up after ${signal}`, async (t) => {
    const ctx = await fixture(t), instance = owner(t, ctx, ["scripts/preview.mjs"]);
    await until(() => instance.output.includes("PREVIEW_URL=") || instance.result, "Preview did not listen");
    const url = instance.output.match(/PREVIEW_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    assert.ok(url, instance.error);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /交互预览 · 临时示例数据/);
    const entries = await readdir(ctx.directory);
    assert.equal(entries.filter((name) => name.startsWith("learning-board-ui-preview-") && name !== path.basename(ctx.legacy)).length, 1);
    assert.equal(instance.child.kill(signal), true);
    const result = await instance.closed;
    assert.equal(signal === "SIGKILL" ? result.signal : result.code, signal === "SIGKILL" ? signal : 0);
    await cleaned(ctx);
  });
}
