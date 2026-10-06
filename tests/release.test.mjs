import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { checkRelease, checkSourceVersions, createBuildManifest, PLUGIN_DIRECTORY, RELEASE_FILES, sha256, sourceSnapshot } from "../scripts/check-release.mjs";
import { packageRelease } from "../scripts/package-release.mjs";
import { syntheticBoard } from "../scripts/benchmark.mjs";
import { cleanupLegacyPlugin, inspectLegacyPlugin, preserveAndCleanupLegacyPlugin, LEGACY_GENERATED_FILES, LEGACY_PLUGIN_DIRECTORY } from "../scripts/cleanup-legacy-plugin.mjs";
import { PRODUCT_ID, PRODUCT_NAME, DEVELOPER_NAME, MARKETPLACE_ID } from "../src/product-identity.mjs";

const projectLicense = await readFile(new URL("../LICENSE", import.meta.url), "utf8");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "learning-board-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, value) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  };
  const pkg = { name: PRODUCT_ID, version: "0.4.0", author: DEVELOPER_NAME, license: "MIT", dependencies: { example: "1.0.0" }, engines: { node: ">=22.13.0" } };
  await put("package.json", pkg);
  await put("package-lock.json", { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { "": pkg } });
  await put("src/board.mjs", 'export const VERSION = "0.4.0";\n');
  for (const file of ["README.md", "README.en.md", "scripts/build.mjs", "scripts/app-template.mjs", "scripts/check-release.mjs", "scripts/package-release.mjs", "scripts/cleanup-legacy-plugin.mjs", "scripts/sync-icons.mjs", "assets/icon.svg", "assets/phosphor-LICENSE.txt", "assets/screenshots/task-board-zh.jpg", "assets/screenshots/task-board-en.jpg"]) await put(file, `fixture ${file}\n`);
  await put("LICENSE", projectLicense);
  await put(".agents/plugins/marketplace.json", { name: MARKETPLACE_ID, interface: { displayName: PRODUCT_NAME }, plugins: [{ name: PRODUCT_ID, source: { source: "local", path: `./${PLUGIN_DIRECTORY}` } }] });
  const plugin = (file) => `${PLUGIN_DIRECTORY}/${file}`;
  for (const file of RELEASE_FILES.filter((file) => file !== "dist/build-manifest.json")) await put(plugin(file), `fixture ${file}\n`);
  await put(plugin("LICENSE"), projectLicense);
  await put(plugin("package.json"), { name: PRODUCT_ID, version: "0.4.0", author: DEVELOPER_NAME, license: "MIT", private: true, type: "module", engines: { node: ">=22.13.0" } });
  await put(plugin(".codex-plugin/plugin.json"), { name: PRODUCT_ID, version: "0.4.0", mcpServers: "./.mcp.json", interface: { displayName: PRODUCT_NAME, developerName: DEVELOPER_NAME, composerIcon: "./assets/icon.svg", logo: "./assets/icon.svg" } });
  await put(plugin(".mcp.json"), { mcpServers: { [PRODUCT_ID]: { command: "node", args: ["./dist/server.js"], cwd: "." } } });
  await put(plugin("assets/phosphor-LICENSE.txt"), "MIT License\nCopyright (c) Phosphor Icons\n");
  await put(plugin("assets/THIRD-PARTY-NOTICES.txt"), "Third-party licenses\n=== example 1.0.0 ===\n--- LICENSE ---\nFull fixture license text\n");
  const seal = async ({ dependencies = [{ name: "example", version: "1.0.0", licenseFiles: ["LICENSE"] }], imports = ["node:fs"] } = {}) => {
    await put(plugin("dist/build-manifest.json"), await createBuildManifest(root, "0.4.0", dependencies, imports, await sourceSnapshot(root)));
  };
  await seal();
  return { root, put, plugin, seal };
}

function unpackNames(archive) {
  const tar = gunzipSync(archive);
  const files = new Map();
  let offset = 0;
  while (tar.subarray(offset, offset + 512).some((byte) => byte !== 0)) {
    const header = tar.subarray(offset, offset + 512);
    const text = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, "").trim();
    const name = text(0, 100);
    const size = Number.parseInt(text(124, 12), 8);
    const expectedChecksum = Number.parseInt(text(148, 8), 8);
    const check = Buffer.from(header);
    check.fill(0x20, 148, 156);
    assert.equal(check.reduce((sum, byte) => sum + byte, 0), expectedChecksum, "POSIX tar header checksum");
    assert.equal(text(136, 12), "00000000000", "mtime fixed for reproducibility");
    assert.equal(text(156, 1), "0", "Only regular files in release");
    assert.ok(!files.has(name), "No duplicate archive paths");
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(tar.subarray(offset).every((byte) => byte === 0));
  return files;
}

test("release gate rejects version drift and stale source or tampered bundles", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await checkRelease(ctx.root)).version, "0.4.0");
  const originalPackage = await readFile(path.join(ctx.root, "package.json"));
  await ctx.put("package.json", { name: "fixture", version: "0.3.1" });
  await assert.rejects(checkSourceVersions(ctx.root), /Version mismatch/);
  await writeFile(path.join(ctx.root, "package.json"), originalPackage);
  await ctx.put("src/change.mjs", "export const newFeature = true;\n");
  await assert.rejects(checkRelease(ctx.root), /Build is stale/);
  await ctx.seal();
  await ctx.put(ctx.plugin("dist/maintenance.js"), "changed bundle\n");
  await assert.rejects(checkRelease(ctx.root), /checksum mismatch: dist\/maintenance.js/);
});

test("release gate enforces licenses, launch configuration and self-contained imports", async (t) => {
  const ctx = await fixture(t);
  await ctx.put(ctx.plugin("assets/THIRD-PARTY-NOTICES.txt"), "Missing dependency notices\n");
  await ctx.seal();
  await assert.rejects(checkRelease(ctx.root), /Missing bundled license notice/);
  await ctx.put(ctx.plugin("assets/THIRD-PARTY-NOTICES.txt"), "=== example 1.0.0 ===\n--- LICENSE ---\n\n");
  await ctx.seal();
  await assert.rejects(checkRelease(ctx.root), /Missing license text/);
  await ctx.put(ctx.plugin("assets/THIRD-PARTY-NOTICES.txt"), "=== example 1.0.0 ===\n--- LICENSE ---\nLicense\n");
  await ctx.seal({ imports: ["zod"] });
  await assert.rejects(checkRelease(ctx.root), /external non-Node imports/);
  await ctx.seal();
  await ctx.put(ctx.plugin(".mcp.json"), { mcpServers: { [PRODUCT_ID]: { command: "node", args: ["../../src/server.mjs"], cwd: "." } } });
  await assert.rejects(checkRelease(ctx.root), /launch configuration/);
});

test("release gate rejects incorrect public identity, developer, MIT license and duplicate installations", async (t) => {
  for (const [name, mutate, expected] of [
    ["root identity", async (ctx) => {
      const pkg = JSON.parse(await readFile(path.join(ctx.root, "package.json")));
      pkg.author = "Local Prototype";
      await ctx.put("package.json", pkg);
    }, /Root package release identity/],
    ["plugin developer", async (ctx) => {
      const manifest = JSON.parse(await readFile(path.join(ctx.root, ctx.plugin(".codex-plugin/plugin.json"))));
      manifest.interface.developerName = "Local Prototype";
      await ctx.put(ctx.plugin(".codex-plugin/plugin.json"), manifest);
    }, /developer or MIT license/],
    ["plugin license field", async (ctx) => {
      const pkg = JSON.parse(await readFile(path.join(ctx.root, ctx.plugin("package.json"))));
      pkg.license = "UNLICENSED";
      await ctx.put(ctx.plugin("package.json"), pkg);
    }, /developer or MIT license/],
    ["license bytes", async (ctx) => { await ctx.put(ctx.plugin("LICENSE"), projectLicense.replace("2026 lldynamics", "2025 Someone Else")); }, /Project MIT license/],
    ["missing project license", async (ctx) => { await rm(path.join(ctx.root, ctx.plugin("LICENSE"))); }, /ENOENT/],
    ["duplicate marketplace entries", async (ctx) => {
      const marketplace = JSON.parse(await readFile(path.join(ctx.root, ".agents/plugins/marketplace.json")));
      marketplace.plugins.push({ name: "learning-board", source: { source: "local", path: "./plugins/learning-board" } });
      await ctx.put(".agents/plugins/marketplace.json", marketplace);
    }, /exactly the public Task Board plugin/],
    ["legacy installable directory", async (ctx) => { await ctx.put(`${LEGACY_PLUGIN_DIRECTORY}/.codex-plugin/plugin.json`, { name: "learning-board" }); }, /Legacy generated plugin is still installable/],
  ]) {
    await t.test(name, async (subtest) => {
      const ctx = await fixture(subtest);
      await mutate(ctx);
      await assert.rejects(checkRelease(ctx.root), expected);
    });
  }
});

test("guarded legacy cleanup deletes only a complete unchanged generated package", async (t) => {
  async function legacyFixture(subtest) {
    const ctx = await fixture(subtest);
    const legacy = (file) => `${LEGACY_PLUGIN_DIRECTORY}/${file}`;
    for (const file of LEGACY_GENERATED_FILES) await ctx.put(legacy(file), `generated ${file}\n`);
    await ctx.put(legacy(".codex-plugin/plugin.json"), { name: "learning-board", version: "0.4.0" });
    await ctx.put(legacy("package.json"), { name: "learning-board", version: "0.4.0" });
    const artifacts = {};
    for (const file of LEGACY_GENERATED_FILES.filter((file) => file !== "dist/build-manifest.json")) artifacts[file] = sha256(await readFile(path.join(ctx.root, legacy(file))));
    await ctx.put(legacy("dist/build-manifest.json"), { formatVersion: 1, version: "0.4.0", artifacts });
    return { ...ctx, legacy };
  }
  await t.test("unchanged exact allowlist", async (subtest) => {
    const ctx = await legacyFixture(subtest);
    await ctx.put("plugins/unrelated/keep.txt", "unrelated plugin");
    assert.deepEqual((await cleanupLegacyPlugin(ctx.root)).removed, LEGACY_GENERATED_FILES.map(ctx.legacy));
    await assert.rejects(readFile(path.join(ctx.root, ctx.legacy(".codex-plugin/plugin.json"))), { code: "ENOENT" });
    assert.equal(await readFile(path.join(ctx.root, "plugins/unrelated/keep.txt"), "utf8"), "unrelated plugin");
    assert.deepEqual(await cleanupLegacyPlugin(ctx.root), { removed: [] });
  });
  await t.test("extra hand-maintained file", async (subtest) => {
    const ctx = await legacyFixture(subtest);
    await ctx.put(ctx.legacy("notes.txt"), "user work");
    await assert.rejects(cleanupLegacyPlugin(ctx.root), /exact generated allowlist/);
    assert.equal(await readFile(path.join(ctx.root, ctx.legacy("notes.txt")), "utf8"), "user work");
    for (const file of LEGACY_GENERATED_FILES) assert.ok((await readFile(path.join(ctx.root, ctx.legacy(file)))).length);
  });
  await t.test("modified generated file", async (subtest) => {
    const ctx = await legacyFixture(subtest);
    await ctx.put(ctx.legacy("README.md"), "unrecognized work");
    await assert.rejects(cleanupLegacyPlugin(ctx.root), /modified.*README.md/);
    assert.equal(await readFile(path.join(ctx.root, ctx.legacy("README.md")), "utf8"), "unrecognized work");
    for (const file of LEGACY_GENERATED_FILES) assert.ok((await readFile(path.join(ctx.root, ctx.legacy(file)))).length);
  });
  await t.test("symlinked artifact", async (subtest) => {
    const ctx = await legacyFixture(subtest);
    await rm(path.join(ctx.root, ctx.legacy("README.md")));
    await symlink(path.join(ctx.root, "README.md"), path.join(ctx.root, ctx.legacy("README.md")));
    await assert.rejects(cleanupLegacyPlugin(ctx.root), /symlink/);
    assert.equal(await readFile(path.join(ctx.root, "README.md"), "utf8"), "fixture README.md\n");
    assert.ok((await readFile(path.join(ctx.root, ctx.legacy(".codex-plugin/plugin.json")))).length);
  });
  await t.test("reviewed current snapshot preserves every original byte despite stale build metadata", async (subtest) => {
    const ctx = await legacyFixture(subtest);
    await ctx.put(ctx.legacy("package.json"), { name: "learning-board", version: "0.10.0" });
    const plan = await inspectLegacyPlugin(ctx.root);
    const original = new Map();
    for (const file of LEGACY_GENERATED_FILES) original.set(file, await readFile(path.join(ctx.root, ctx.legacy(file))));
    const result = await preserveAndCleanupLegacyPlugin(ctx.root, plan);
    assert.deepEqual(result.removed, LEGACY_GENERATED_FILES.map(ctx.legacy));
    const preserved = await readFile(result.historyPath);
    assert.equal(result.historySha256, sha256(preserved));
    const history = JSON.parse(gunzipSync(preserved));
    assert.deepEqual(history.files, plan.files);
    assert.equal(history.fingerprint, plan.fingerprint);
    assert.deepEqual(history.contents.map((file) => file.path), LEGACY_GENERATED_FILES);
    for (const file of history.contents) assert.deepEqual(Buffer.from(file.bytes, file.encoding), original.get(file.path));
    assert.equal(await inspectLegacyPlugin(ctx.root), null);
    assert.equal((await checkRelease(ctx.root)).version, "0.4.0");
  });
  await t.test("a stale approved snapshot removes nothing", async (subtest) => {
    const ctx = await legacyFixture(subtest);
    const plan = await inspectLegacyPlugin(ctx.root);
    await ctx.put(ctx.legacy("package.json"), { name: "learning-board", version: "0.10.0" });
    await assert.rejects(preserveAndCleanupLegacyPlugin(ctx.root, plan), /differ from the approved migration snapshot/);
    for (const file of LEGACY_GENERATED_FILES) assert.ok((await readFile(path.join(ctx.root, ctx.legacy(file)))).length);
    await assert.rejects(readFile(path.join(ctx.root, "outputs/legacy-plugin-migration")), { code: "ENOENT" });
  });
  await t.test("an extra file after snapshot preserves the entire legacy directory", async (subtest) => {
    const ctx = await legacyFixture(subtest);
    const plan = await inspectLegacyPlugin(ctx.root);
    await ctx.put(ctx.legacy("user.txt"), "private work");
    await assert.rejects(preserveAndCleanupLegacyPlugin(ctx.root, plan), /exact generated allowlist/);
    assert.equal(await readFile(path.join(ctx.root, ctx.legacy("user.txt")), "utf8"), "private work");
    for (const file of LEGACY_GENERATED_FILES) assert.ok((await readFile(path.join(ctx.root, ctx.legacy(file)))).length);
  });
});

test("release fingerprint includes extracted CSS and the shared template loader", async (t) => {
  const ctx = await fixture(t);
  await ctx.put("src/app.css", ":root { --accent: #28593e; }\n");
  await assert.rejects(checkRelease(ctx.root), /Build is stale/);
  await ctx.seal();
  assert.equal((await checkRelease(ctx.root)).version, "0.4.0");
  await ctx.put("scripts/app-template.mjs", "export const changedTemplateLoader = true;\n");
  await assert.rejects(checkRelease(ctx.root), /Build is stale/);
});

test("release gate rejects symlinked files and ancestor directories", async (t) => {
  const ctx = await fixture(t);
  const icon = path.join(ctx.root, ctx.plugin("assets/icon.svg"));
  await rm(icon);
  await symlink(path.join(ctx.root, "assets/icon.svg"), icon);
  await assert.rejects(checkRelease(ctx.root), /without symlinks/);
  await rm(path.join(ctx.root, ctx.plugin("assets")), { recursive: true });
  await symlink(path.join(ctx.root, "assets"), path.join(ctx.root, ctx.plugin("assets")));
  await assert.rejects(checkRelease(ctx.root), /without symlinks/);
});

test("release archive is deterministic, allowlisted, independently checksummed and refuses overwrite", async (t) => {
  const ctx = await fixture(t);
  for (const file of ["data/board.json", "outputs/private.txt", "node_modules/private.txt", "src/private.mjs", ".env"]) await ctx.put(ctx.plugin(file), "SYNTHETIC_PRIVATE_SENTINEL");
  const first = await packageRelease({ root: ctx.root, outputDirectory: path.join(ctx.root, "output-a") });
  const second = await packageRelease({ root: ctx.root, outputDirectory: path.join(ctx.root, "output-b") });
  const a = await readFile(first.archivePath);
  const b = await readFile(second.archivePath);
  assert.deepEqual(a, b);
  assert.equal(sha256(a), first.sha256);
  const files = unpackNames(a);
  assert.deepEqual([...files.keys()], RELEASE_FILES.map((file) => `${PRODUCT_ID}/${file}`));
  assert.equal(files.get(`${PRODUCT_ID}/LICENSE`).toString(), projectLicense);
  assert.ok(files.has(`${PRODUCT_ID}/README.en.md`));
  assert.ok(files.has(`${PRODUCT_ID}/assets/screenshots/task-board-zh.jpg`));
  assert.ok(files.has(`${PRODUCT_ID}/assets/screenshots/task-board-en.jpg`));
  assert.ok(!gunzipSync(a).includes(Buffer.from("SYNTHETIC_PRIVATE_SENTINEL")));
  const manifest = JSON.parse(await readFile(`${first.archivePath}.manifest.json`));
  assert.equal(manifest.plugin, PRODUCT_ID);
  assert.equal(manifest.archive.path, "codex-task-board-0.4.0.tar.gz");
  assert.equal(manifest.archive.sha256, sha256(a));
  assert.equal(manifest.archive.size, a.length);
  for (const file of manifest.files) assert.equal(sha256(files.get(`${PRODUCT_ID}/${file.path}`)), file.sha256);
  assert.equal(await readFile(`${first.archivePath}.sha256`, "utf8"), `${sha256(a)}  codex-task-board-0.4.0.tar.gz\n`);
  await packageRelease({ root: ctx.root, outputDirectory: path.dirname(first.archivePath) });
  await writeFile(first.archivePath, "unrelated user artifact");
  await assert.rejects(packageRelease({ root: ctx.root, outputDirectory: path.dirname(first.archivePath) }), /Refusing to overwrite/);
  assert.equal(await readFile(first.archivePath, "utf8"), "unrelated user artifact");
});

test("performance fixtures are reproducible, valid at all target sizes and synthetic", () => {
  for (const size of [100, 1000, 5000]) {
    const board = syntheticBoard(size);
    assert.equal(board.tasks.length, size);
    assert.equal(board.projects.length, 10);
    assert.equal(board.tasks.filter((task) => task.title.includes("needle")).length, size / 10);
    assert.equal(sha256(JSON.stringify(board)), sha256(JSON.stringify(syntheticBoard(size))));
  }
  assert.throws(() => syntheticBoard(5001), /Task count/);
});
