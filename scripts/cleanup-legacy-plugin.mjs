import { lstat, mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { readRegular, sha256 } from "./check-release.mjs";

// The previous build emitted only these files. Never recursively remove a
// plugin directory: an extra or modified file may be hand-maintained work.
export const LEGACY_PLUGIN_DIRECTORY = "plugins/learning-board";
export const LEGACY_GENERATED_FILES = [
  ".codex-plugin/plugin.json", ".mcp.json", "README.md", "package.json",
  "assets/THIRD-PARTY-NOTICES.txt", "assets/icon.svg", "assets/phosphor-LICENSE.txt",
  "dist/build-manifest.json", "dist/app.html", "dist/codex-sync.js",
  "dist/maintenance.js", "dist/server-core.js", "dist/server.js",
].sort();
const GENERATED_DIRECTORIES = [".codex-plugin", "assets", "dist"];

async function readLegacyPlugin(root) {
  const directory = path.join(root, LEGACY_PLUGIN_DIRECTORY);
  let stat;
  try { stat = await lstat(directory); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Legacy plugin must be a real generated directory");
  const parent = await lstat(path.join(root, "plugins"));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Legacy plugin parent must be a real directory without symlinks");
  const files = [];
  const directories = [];
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Legacy plugin contains a symlink; preserve it: ${child}`);
      if (entry.isDirectory()) { directories.push(child); await visit(child); }
      else if (entry.isFile()) files.push(child);
      else throw new Error(`Legacy plugin contains an unsupported entry; preserve it: ${child}`);
    }
  }
  await visit();
  if (JSON.stringify(files.sort()) !== JSON.stringify(LEGACY_GENERATED_FILES) || JSON.stringify(directories.sort()) !== JSON.stringify(GENERATED_DIRECTORIES)) throw new Error("Legacy plugin has files outside the exact generated allowlist; preserve it before migration");
  const bytes = {};
  for (const file of LEGACY_GENERATED_FILES) bytes[file] = await readRegular(root, `${LEGACY_PLUGIN_DIRECTORY}/${file}`);
  const inventory = LEGACY_GENERATED_FILES.map((file) => ({ path: file, size: bytes[file].length, sha256: sha256(bytes[file]) }));
  const plan = { directory: LEGACY_PLUGIN_DIRECTORY, files: inventory, fingerprint: sha256(JSON.stringify(inventory)) };
  return { directory, bytes, plan };
}

export async function inspectLegacyPlugin(root) {
  return (await readLegacyPlugin(root))?.plan ?? null;
}

async function removePlannedFiles(root, plan) {
  const current = await readLegacyPlugin(root);
  if (!current || JSON.stringify(current.plan) !== JSON.stringify(plan)) throw new Error("Legacy generated files changed after the approved migration snapshot; preserve them");
  for (const file of LEGACY_GENERATED_FILES) await unlink(path.join(current.directory, file));
  for (const relative of GENERATED_DIRECTORIES) await rmdir(path.join(current.directory, relative));
  await rmdir(current.directory);
  return { removed: LEGACY_GENERATED_FILES.map((file) => `${LEGACY_PLUGIN_DIRECTORY}/${file}`) };
}

export async function cleanupLegacyPlugin(root) {
  const current = await readLegacyPlugin(root);
  if (!current) return { removed: [] };
  const { bytes, plan } = current;
  const manifest = JSON.parse(bytes[".codex-plugin/plugin.json"]);
  const pkg = JSON.parse(bytes["package.json"]);
  const built = JSON.parse(bytes["dist/build-manifest.json"]);
  const artifacts = LEGACY_GENERATED_FILES.filter((file) => file !== "dist/build-manifest.json");
  if (manifest.name !== "learning-board" || pkg.name !== "learning-board" || manifest.version !== built.version || pkg.version !== built.version || built.formatVersion !== 1 || JSON.stringify(Object.keys(built.artifacts || {}).sort()) !== JSON.stringify(artifacts)) throw new Error("Legacy plugin does not match its generated build manifest; preserve it before migration");
  for (const file of artifacts) if (built.artifacts[file] !== sha256(bytes[file])) throw new Error(`Legacy generated file was modified; preserve it before migration: ${file}`);
  return removePlannedFiles(root, plan);
}

// One-time migration for a reviewed current snapshot, including stale generated
// metadata. It preserves all 13 original byte streams in a compressed JSON
// history record that cannot expose another installable plugin entrypoint.
// Build never calls this: the release owner must freeze writers and supply the
// exact plan returned by inspectLegacyPlugin.
export async function preserveAndCleanupLegacyPlugin(root, plan) {
  const current = await readLegacyPlugin(root);
  if (!current || JSON.stringify(current.plan) !== JSON.stringify(plan)) throw new Error("Legacy generated files differ from the approved migration snapshot; nothing was removed");
  const manifest = JSON.parse(current.bytes[".codex-plugin/plugin.json"]);
  const pkg = JSON.parse(current.bytes["package.json"]);
  if (manifest.name !== "learning-board" || pkg.name !== "learning-board") throw new Error("Legacy plugin identity is unexpected; preserve it without migration");
  const history = gzipSync(Buffer.from(JSON.stringify({
    formatVersion: 1, ...plan,
    contents: LEGACY_GENERATED_FILES.map((file) => ({ path: file, encoding: "base64", bytes: current.bytes[file].toString("base64") })),
  }, null, 2) + "\n"), { level: 9 });
  for (const relative of ["outputs", "outputs/legacy-plugin-migration"]) {
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Migration history must use a real directory: ${relative}`);
  }
  const historyRelative = `outputs/legacy-plugin-migration/learning-board-${plan.fingerprint}.snapshot.json.gz`;
  const historyPath = path.join(root, historyRelative);
  try { await writeFile(historyPath, history, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readRegular(root, historyRelative)).equals(history)) throw new Error("Refusing to overwrite different migration history", { cause: error });
  }
  if (!(await readRegular(root, historyRelative)).equals(history)) throw new Error("Migration history verification failed; nothing was removed");
  const result = await removePlannedFiles(root, plan);
  return { ...result, historyPath, historySha256: sha256(history), fingerprint: plan.fingerprint };
}
