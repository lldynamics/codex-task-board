import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { checkSourceVersions, checkRelease, createBuildManifest, sourceSnapshot, PLUGIN_DIRECTORY } from "./check-release.mjs";
import { loadAppTemplate } from "./app-template.mjs";
import { PRODUCT_ID, PRODUCT_NAME, DEVELOPER_NAME, PRODUCT_LICENSE, MARKETPLACE_ID } from "../src/product-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Fail before writing artifacts when source/package/lock versions diverge.
const VERSION = await checkSourceVersions(root);
await import("./sync-icons.mjs");
const snapshot = await sourceSnapshot(root);
const pluginRoot = path.join(root, PLUGIN_DIRECTORY);
const dist = path.join(pluginRoot, "dist");
await mkdir(dist, { recursive: true });
await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
await mkdir(path.join(pluginRoot, "assets"), { recursive: true });
await mkdir(path.join(pluginRoot, "assets/screenshots"), { recursive: true });

const appBuild = await build({
  absWorkingDir: root, metafile: true,
  entryPoints: [path.join(root, "src/app.mjs")], bundle: true, write: false,
  platform: "browser", format: "iife", target: "es2022", minify: true,
  legalComments: "inline",
});
// Prevent bundled code from terminating its containing inline script.
const appScript = appBuild.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await loadAppTemplate(root);
await writeFile(path.join(dist, "app.html"), template.replace("<!-- APP_SCRIPT -->", () => `<script>${appScript}</script>`));
const builds = [appBuild];
for (const [source, output] of [["server.mjs", "server.js"], ["server-core.mjs", "server-core.js"], ["maintenance.mjs", "maintenance.js"], ["codex-sync.mjs", "codex-sync.js"]]) {
  builds.push(await build({
    absWorkingDir: root, metafile: true,
    entryPoints: [path.join(root, "src", source)], bundle: true,
    platform: "node", format: "esm", target: "node22", outfile: path.join(dist, output),
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    legalComments: "inline",
  }));
}
await copyFile(path.join(root, "assets/icon.svg"), path.join(pluginRoot, "assets/icon.svg"));
await copyFile(path.join(root, "assets/phosphor-LICENSE.txt"), path.join(pluginRoot, "assets/phosphor-LICENSE.txt"));
for (const locale of ["zh", "en"]) await copyFile(path.join(root, `assets/screenshots/task-board-${locale}.jpg`), path.join(pluginRoot, `assets/screenshots/task-board-${locale}.jpg`));

// Distribute original license/notice files for every dependency in the bundles.
const packages = new Map();
for (const result of builds) {
  for (const input of Object.keys(result.metafile.inputs).filter((file) => file.includes("node_modules/"))) {
    let directory = path.dirname(path.resolve(root, input));
    while (directory.startsWith(path.join(root, "node_modules") + path.sep)) {
      let metadata;
      try { metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); } catch { /* Keep walking up to the package root. */ }
      if (metadata?.name && metadata?.version) { packages.set(directory, metadata); break; }
      directory = path.dirname(directory);
    }
  }
}
const notices = ["Third-party licenses for bundled dependencies\nOriginal license and notice texts follow.\n"];
const dependencies = [];
for (const [directory, metadata] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const files = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(license|copying|notice)([.-]|$)/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (!files.length) throw new Error(`Missing license text for bundled dependency ${metadata.name}`);
  dependencies.push({ name: metadata.name, version: metadata.version, licenseFiles: files.map((file) => file.name) });
  notices.push(`\n=== ${metadata.name} ${metadata.version} ===\n`);
  for (const file of files) {
    const text = await readFile(path.join(directory, file.name), "utf8");
    if (!text.trim()) throw new Error(`Empty license text for bundled dependency ${metadata.name}/${file.name}`);
    notices.push(`--- ${file.name} ---\n${text}\n`);
  }
}
await writeFile(path.join(pluginRoot, "assets/THIRD-PARTY-NOTICES.txt"), notices.join("\n"));

const json = (value) => JSON.stringify(value, null, 2) + "\n";
await writeFile(path.join(pluginRoot, ".codex-plugin/plugin.json"), json({
  name: PRODUCT_ID, version: VERSION,
  description: "Local projects, Codex task snapshots and learning schedules. / 管理本机项目、Codex 任务快照与学习排程。",
  mcpServers: "./.mcp.json",
  interface: {
    displayName: PRODUCT_NAME, shortDescription: "Codex tasks and learning calendar / Codex 任务与学习日历",
    longDescription: "A local task board with Chinese and English UI, Codex metadata snapshots and a learning calendar. Scheduled plans are arranged in your Codex conversation. / 本机任务看板支持中英文界面、Codex 状态快照与学习日历；定时计划由用户直接在 Codex 对话中安排。",
    developerName: DEVELOPER_NAME, category: "Productivity", capabilities: ["Interactive", "Read", "Write"],
    composerIcon: "./assets/icon.svg", logo: "./assets/icon.svg",
    defaultPrompt: ["Open Task Board. / 打开任务看板。"],
  },
}));
await writeFile(path.join(pluginRoot, ".mcp.json"), json({
  mcpServers: { [PRODUCT_ID]: { command: "node", args: ["./dist/server.js"], cwd: "." } },
}));
await writeFile(path.join(pluginRoot, "package.json"), json({ name: PRODUCT_ID, version: VERSION, author: DEVELOPER_NAME, license: PRODUCT_LICENSE, private: true, type: "module", engines: { node: ">=22.13.0" } }));
await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
const marketplacePath = path.join(root, ".agents/plugins/marketplace.json");
const marketplaceContent = json({
  name: MARKETPLACE_ID, interface: { displayName: PRODUCT_NAME },
  plugins: [{ name: PRODUCT_ID, category: "Productivity", source: { source: "local", path: `./${PLUGIN_DIRECTORY}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  }],
});
// A rebuild need not rewrite the registered marketplace configuration.
let registeredMarketplace;
try { registeredMarketplace = await readFile(marketplacePath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (registeredMarketplace !== marketplaceContent) await writeFile(marketplacePath, marketplaceContent);
await copyFile(path.join(root, "README.md"), path.join(pluginRoot, "README.md"));
await copyFile(path.join(root, "README.en.md"), path.join(pluginRoot, "README.en.md"));
await copyFile(path.join(root, "LICENSE"), path.join(pluginRoot, "LICENSE"));
const after = await sourceSnapshot(root);
if (snapshot.fingerprint !== after.fingerprint) throw new Error("Source changed during build; rebuild after edits complete");
const externalImports = builds.flatMap((result) => Object.values(result.metafile.outputs).flatMap((output) => output.imports.filter((item) => item.external).map((item) => item.path)));
await writeFile(path.join(dist, "build-manifest.json"), json(await createBuildManifest(root, VERSION, dependencies, externalImports, snapshot)));
await checkRelease(root);
console.log(`Built self-contained plugin: ${PLUGIN_DIRECTORY}`);
