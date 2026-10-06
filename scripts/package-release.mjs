import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease, ROOT, sha256 } from "./check-release.mjs";
import { PRODUCT_ID } from "../src/product-identity.mjs";

// POSIX ustar with fixed ownership, mode, mtime and ordering. gzip also emits a
// fixed zero timestamp. Identical plugin bytes therefore yield identical bytes.
export function createArchive(files) {
  const chunks = [];
  for (const { path: relative, bytes } of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const name = `${PRODUCT_ID}/${relative}`;
    if (Buffer.byteLength(name) > 100 || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`Unsupported archive path: ${relative}`);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const octal = (value, offset, length) => {
      const encoded = value.toString(8).padStart(length - 1, "0");
      if (encoded.length >= length) throw new Error("Archive entry exceeds ustar field capacity");
      header.write(`${encoded}\0`, offset, length, "ascii");
    };
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

async function writeOnce(file, bytes) {
  try { await writeFile(file, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readFile(file)).equals(Buffer.from(bytes))) throw new Error(`Refusing to overwrite different release artifact: ${file}`, { cause: error });
  }
}

export async function packageRelease({ root = ROOT, outputDirectory = path.join(root, "outputs/releases") } = {}) {
  const result = await checkRelease(root);
  const archive = createArchive(result.files.map((file) => ({ path: file.path, bytes: result.bytes[file.path] })));
  const archiveName = `${PRODUCT_ID}-${result.version}.tar.gz`;
  const digest = sha256(archive);
  const manifest = Buffer.from(JSON.stringify({
    formatVersion: 1, plugin: PRODUCT_ID, version: result.version,
    sourceFingerprint: result.sourceFingerprint,
    archive: { path: archiveName, size: archive.length, sha256: digest }, files: result.files,
  }, null, 2) + "\n");
  await mkdir(outputDirectory, { recursive: true });
  await writeOnce(path.join(outputDirectory, archiveName), archive);
  await writeOnce(path.join(outputDirectory, `${archiveName}.sha256`), `${digest}  ${archiveName}\n`);
  await writeOnce(path.join(outputDirectory, `${archiveName}.manifest.json`), manifest);
  return { archivePath: path.resolve(outputDirectory, archiveName), sha256: digest, size: archive.length, files: result.files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--output-dir" || !args[1])) throw new Error("Usage: node scripts/package-release.mjs [--output-dir DIRECTORY]");
    const result = await packageRelease(args.length ? { outputDirectory: path.resolve(args[1]) } : {});
    console.log(`Packaged ${result.archivePath}\nSHA256 ${result.sha256}\n${result.files.length} allowlisted files, ${result.size} bytes`);
  } catch (error) {
    console.error(`Release packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
