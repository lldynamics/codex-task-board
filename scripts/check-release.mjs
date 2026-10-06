import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_ID, PRODUCT_NAME, DEVELOPER_NAME, PRODUCT_LICENSE, MARKETPLACE_ID } from "../src/product-identity.mjs";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PLUGIN_DIRECTORY = `plugins/${PRODUCT_ID}`;
export const BUNDLE_FILES = ["dist/app.html", "dist/codex-sync.js", "dist/maintenance.js", "dist/server-core.js", "dist/server.js"];
// Explicit allowlist: never walk or copy a user's data, outputs, caches or source.
export const RELEASE_FILES = [
  ".codex-plugin/plugin.json", ".mcp.json", "LICENSE", "README.md", "README.en.md", "package.json",
  "assets/THIRD-PARTY-NOTICES.txt", "assets/icon.svg", "assets/phosphor-LICENSE.txt",
  "assets/screenshots/task-board-zh.jpg", "assets/screenshots/task-board-en.jpg",
  "dist/build-manifest.json", ...BUNDLE_FILES,
].sort();
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (root, relative) => JSON.parse(await readRegular(root, relative));

// Check every ancestor as well as the file; a symlinked assets/dist directory
// must not turn a release allowlist into an arbitrary filesystem read.
export async function readRegular(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe release path: ${relative}`);
  let current = path.resolve(root);
  if (!(await lstat(current)).isDirectory()) throw new Error(`Release root must be a real directory: ${current}`);
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Release path must be a regular file without symlinks: ${relative}`);
  }
  const bytes = await readFile(current);
  if (!bytes.length) throw new Error(`Required release file is empty: ${relative}`);
  return bytes;
}

export async function checkSourceVersions(root = ROOT) {
  const [pkg, lock, source] = await Promise.all([
    json(root, "package.json"), json(root, "package-lock.json"), readRegular(root, "src/board.mjs"),
  ]);
  const version = source.toString().match(/^export const VERSION = ["']([^"']+)["'];$/m)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("src/board.mjs must export a valid VERSION string");
  for (const [name, value] of [["package.json", pkg.version], ["package-lock.json", lock.version], ["package-lock.json packages root", lock.packages?.[""]?.version]]) {
    if (value !== version) throw new Error(`Version mismatch: ${name} is ${value}, source VERSION is ${version}`);
  }
  if (lock.name !== pkg.name || lock.packages?.[""]?.name !== pkg.name) throw new Error("Root package and lockfile names differ");
  if (pkg.name !== PRODUCT_ID || pkg.author !== DEVELOPER_NAME || pkg.license !== PRODUCT_LICENSE || lock.packages?.[""]?.license !== PRODUCT_LICENSE) throw new Error("Root package release identity, author or MIT license is inconsistent");
  for (const field of ["dependencies", "devDependencies", "engines"]) {
    const sorted = (value) => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b, "en")));
    if (sorted(pkg[field]) !== sorted(lock.packages[""][field])) throw new Error(`Root package and lockfile ${field} differ`);
  }
  return version;
}

export async function sourceSnapshot(root = ROOT) {
  const files = ["package.json", "package-lock.json", "LICENSE", "README.md", "README.en.md", "scripts/build.mjs", "scripts/app-template.mjs", "scripts/check-release.mjs", "scripts/package-release.mjs", "scripts/cleanup-legacy-plugin.mjs", "scripts/sync-icons.mjs", "assets/icon.svg", "assets/phosphor-LICENSE.txt", "assets/screenshots/task-board-zh.jpg", "assets/screenshots/task-board-en.jpg"];
  async function visit(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not supported for releases: ${child}`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  await visit("src");
  const hashes = {};
  for (const file of files.sort()) hashes[file] = sha256(await readRegular(root, file));
  return { hashes, fingerprint: sha256(JSON.stringify(hashes)) };
}

export async function createBuildManifest(root, version, dependencies, externalImports, snapshot) {
  const pluginRoot = path.join(root, PLUGIN_DIRECTORY);
  const artifacts = {};
  for (const file of RELEASE_FILES.filter((file) => file !== "dist/build-manifest.json")) artifacts[file] = sha256(await readRegular(pluginRoot, file));
  return {
    formatVersion: 1, plugin: PRODUCT_ID, version, sourceFingerprint: snapshot.fingerprint,
    sourceHashes: snapshot.hashes, artifacts,
    bundledDependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name, "en")),
    externalImports: [...new Set(externalImports)].sort(),
  };
}

export async function checkRelease(root = ROOT) {
  const version = await checkSourceVersions(root);
  const pluginRoot = path.join(root, PLUGIN_DIRECTORY);
  const bytes = {};
  for (const file of RELEASE_FILES) bytes[file] = await readRegular(pluginRoot, file);
  const manifest = JSON.parse(bytes[".codex-plugin/plugin.json"]);
  const pkg = JSON.parse(bytes["package.json"]);
  const launch = JSON.parse(bytes[".mcp.json"]);
  const built = JSON.parse(bytes["dist/build-manifest.json"]);
  if (manifest.version !== version || pkg.version !== version || built.version !== version) throw new Error("Plugin manifest/package/build versions differ from source VERSION; run npm run build");
  if (manifest.name !== PRODUCT_ID || built.plugin !== PRODUCT_ID || pkg.name !== PRODUCT_ID || pkg.type !== "module" || pkg.engines?.node !== ">=22.13.0") throw new Error("Plugin package metadata is inconsistent");
  if (manifest.interface?.displayName !== PRODUCT_NAME || manifest.interface?.developerName !== DEVELOPER_NAME || pkg.author !== DEVELOPER_NAME || pkg.license !== PRODUCT_LICENSE) throw new Error("Plugin release identity, developer or MIT license is inconsistent");
  if (manifest.mcpServers !== "./.mcp.json" || manifest.interface?.composerIcon !== "./assets/icon.svg" || manifest.interface?.logo !== "./assets/icon.svg") throw new Error("Plugin manifest paths are invalid");
  if (JSON.stringify(launch) !== JSON.stringify({ mcpServers: { [PRODUCT_ID]: { command: "node", args: ["./dist/server.js"], cwd: "." } } })) throw new Error("Plugin launch configuration must use the self-contained Node entrypoint");
  if (pkg.dependencies || pkg.devDependencies) throw new Error("Plugin must not require installed runtime dependencies");
  const marketplace = await json(root, ".agents/plugins/marketplace.json");
  if (marketplace.name !== MARKETPLACE_ID || marketplace.interface?.displayName !== PRODUCT_NAME || marketplace.plugins?.length !== 1 || marketplace.plugins[0].name !== PRODUCT_ID || marketplace.plugins[0].source?.source !== "local" || marketplace.plugins[0].source?.path !== `./${PLUGIN_DIRECTORY}`) throw new Error("Marketplace must expose exactly the public Task Board plugin");
  try {
    await lstat(path.join(root, "plugins/learning-board/.codex-plugin/plugin.json"));
    throw new Error("Legacy generated plugin is still installable; complete the guarded release migration");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const license = await readRegular(root, "LICENSE");
  if (!bytes.LICENSE.equals(license) || !license.toString().includes("MIT License") || !/Copyright \(c\) 2026 lldynamics/.test(license.toString()) || !license.toString().includes("Permission is hereby granted, free of charge") || !license.toString().includes('THE SOFTWARE IS PROVIDED "AS IS"')) throw new Error("Project MIT license or 2026 lldynamics copyright is missing or differs from source");
  const snapshot = await sourceSnapshot(root);
  if (built.formatVersion !== 1 || built.sourceFingerprint !== snapshot.fingerprint || JSON.stringify(built.sourceHashes) !== JSON.stringify(snapshot.hashes)) throw new Error("Build is stale: source fingerprint differs; run npm run build");
  const artifactFiles = RELEASE_FILES.filter((file) => file !== "dist/build-manifest.json");
  if (JSON.stringify(Object.keys(built.artifacts || {}).sort()) !== JSON.stringify(artifactFiles)) throw new Error("Build artifact inventory is incomplete");
  for (const file of artifactFiles) if (built.artifacts[file] !== sha256(bytes[file])) throw new Error(`Build artifact checksum mismatch: ${file}`);
  const allowedImports = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
  if (!Array.isArray(built.externalImports) || built.externalImports.some((name) => !allowedImports.has(name))) throw new Error("Plugin bundles contain external non-Node imports");
  const notices = bytes["assets/THIRD-PARTY-NOTICES.txt"].toString();
  if (!Array.isArray(built.bundledDependencies) || !built.bundledDependencies.length) throw new Error("Bundled dependency license inventory is missing");
  for (const dependency of built.bundledDependencies) {
    const heading = `=== ${dependency.name} ${dependency.version} ===`;
    if (!dependency.name || !dependency.version || !Array.isArray(dependency.licenseFiles) || !dependency.licenseFiles.length || !notices.includes(heading)) throw new Error(`Missing bundled license notice: ${dependency.name}`);
    const section = notices.slice(notices.indexOf(heading) + heading.length).split(/\n=== /)[0];
    for (const license of dependency.licenseFiles) {
      const marker = `--- ${license} ---`;
      if (!section.includes(marker) || !section.slice(section.indexOf(marker) + marker.length).split(/\n--- /)[0].trim()) throw new Error(`Missing license text: ${dependency.name}/${license}`);
    }
  }
  if (!bytes["assets/phosphor-LICENSE.txt"].toString().includes("Phosphor Icons") || !bytes["assets/phosphor-LICENSE.txt"].toString().includes("MIT License")) throw new Error("Phosphor icon license is missing");
  return { plugin: PRODUCT_ID, version, sourceFingerprint: snapshot.fingerprint, files: RELEASE_FILES.map((file) => ({ path: file, size: bytes[file].length, sha256: sha256(bytes[file]) })), bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("Usage: node scripts/check-release.mjs");
    const result = await checkRelease();
    console.log(`Release gate passed: v${result.version}, ${result.files.length} files, source ${result.sourceFingerprint}`);
  } catch (error) {
    console.error(`Release gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
