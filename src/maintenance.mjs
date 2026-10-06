import * as filesystem from "node:fs/promises";
import path from "node:path";
import { homedir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import { inspectLockSnapshot, checkDirectory, readRegularFile, readVerifiedBackup, writeExclusive, syncDirectory, acquireProcessLock, isBackupName, MIGRATION_BACKUP, MIGRATION_CHECKSUM } from "./store-files.mjs";
import { publicBoard, makeBackup, parseDiskBytes } from "./store-data.mjs";

export const MAINTENANCE_USAGE = `Usage:
  node dist/maintenance.js inspect-lock
  node dist/maintenance.js list-backups
  node dist/maintenance.js export-backup <backup-name> --output <new-file>
  node dist/maintenance.js restore-backup <backup-name> --confirm-all-clients-stopped
  node dist/maintenance.js recover-lock --expected-token <uuid> --expected-fingerprint <sha256> --confirm-all-clients-stopped
  For legacy/invalid owner metadata, omit --expected-token and use the inspected fingerprint.
Storage is fixed to ~/Library/Application Support/LearningBoard.
Lock recovery only quarantines a verified lock after all clients have stopped.
restore-backup runs only when data.json is unreadable or missing: it keeps the damaged
file as data.damaged-<time>.json and installs the verified backup as data.json.`;
const recoverySchema = z.object({ expectedToken: z.uuid().optional(), expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/), confirmAllClientsStopped: z.literal(true) }).strict();

// Tests alone inject the store root and PID probe. Production never accepts a
// custom root, environment variable, or arbitrary backup source path.
export function createMaintenance(directory, { io = filesystem, host = hostname(), pidProbe = (pid) => process.kill(pid, 0) } = {}) {
  const root = path.resolve(directory);
  const backupsPath = path.join(root, "backups");
  async function readBackup(name) {
    if (!isBackupName(name)) throw new Error("Unknown backup name");
    await checkDirectory(io, root);
    await checkDirectory(io, backupsPath);
    const loaded = await readVerifiedBackup(io, backupsPath, name);
    return { name, ...loaded };
  }
  return {
    async inspectLock() {
      const rootStat = await checkDirectory(io, root, { absent: true });
      if (!rootStat) return { ok: true, locked: false };
      try {
        const snapshot = await inspectLockSnapshot(io, root);
        return { ok: true, locked: true, type: snapshot.type, reason: snapshot.reason, ...(snapshot.owner ? { token: snapshot.owner.token, owner: snapshot.owner } : {}), ...(snapshot.processOwner ? { processOwner: snapshot.processOwner } : {}), fingerprint: snapshot.fingerprint };
      } catch (error) {
        // A missing lock is normal; missing/invalid owner inside a present lock
        // remains an error and is never automatically recoverable.
        if (error.code === "ENOENT" && !(await checkDirectory(io, path.join(root, ".save-lock"), { absent: true }))) return { ok: true, locked: false };
        throw error;
      }
    },
    async recoverLock(raw) {
      const options = recoverySchema.parse(raw);
      const before = await inspectLockSnapshot(io, root);
      if ((before.owner && before.owner.token !== options.expectedToken) || (!before.owner && options.expectedToken !== undefined) || before.fingerprint !== options.expectedFingerprint) throw new Error("Lock changed; inspect it again");
      if (before.processOwner?.hostname === host) {
        let dead = false;
        try { await pidProbe(before.processOwner.pid); }
        catch (error) {
          if (error.code !== "ESRCH") throw new Error("Owner process cannot be safely ruled out", { cause: error });
          dead = true;
        }
        if (!dead) throw new Error("Owner process is still alive");
      }
      const current = await inspectLockSnapshot(io, root);
      if ((current.owner && current.owner.token !== options.expectedToken) || (!current.owner && options.expectedToken !== undefined) || current.fingerprint !== options.expectedFingerprint) throw new Error("Lock changed; inspect it again");
      const quarantineName = `.save-lock-quarantine-${randomUUID()}`;
      const quarantine = path.join(root, quarantineName);
      // The unique destination never replaces a prior diagnostic directory.
      try { await io.lstat(quarantine); throw new Error("Quarantine destination exists"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await io.rename(path.join(root, ".save-lock"), quarantine);
      await syncDirectory(io, root).catch(() => {});
      return { ok: true, recovered: true, quarantine: quarantineName, type: current.type, ...(current.owner ? { token: current.owner.token } : {}) };
    },
    async listBackups() {
      const rootStat = await checkDirectory(io, root, { absent: true });
      if (!rootStat || !(await checkDirectory(io, backupsPath, { absent: true }))) return { ok: true, backups: [] };
      const entries = await io.readdir(backupsPath);
      const names = entries.filter(isBackupName);
      if (entries.includes(MIGRATION_CHECKSUM) && !names.includes(MIGRATION_BACKUP)) names.push(MIGRATION_BACKUP);
      names.sort().reverse();
      const backups = [];
      for (const name of names) {
        try {
          const loaded = await readBackup(name);
          backups.push({ name, valid: true, sha256: loaded.sha256, sourceSchemaVersion: loaded.sourceVersion, revision: loaded.disk.revision, projectCount: loaded.disk.projects.length, taskCount: loaded.disk.tasks.length });
        } catch {
          backups.push({ name, valid: false, error: { code: "INVALID_BACKUP", message: "备份缺少完整性记录、校验失败、格式损坏或不是安全的普通文件；未导出或改写。" } });
        }
      }
      return { ok: true, backups };
    },
    async restoreBackup(name, { confirmAllClientsStopped } = {}) {
      if (confirmAllClientsStopped !== true) throw new Error("Stop every task board client, then pass --confirm-all-clients-stopped");
      const loaded = await readBackup(name);
      const dataPath = path.join(root, "data.json");
      const lock = await acquireProcessLock(path.join(root, ".save-lock.sqlite"), { waitMs: 0 }).catch(() => { throw new Error("A task board client is still saving; stop it and retry"); });
      try {
        if (await checkDirectory(io, path.join(root, ".save-lock"), { absent: true })) throw new Error("A save lock is present; inspect and recover it first");
        let current = null;
        try { current = (await readRegularFile(io, dataPath)).bytes; }
        catch (error) { if (error.code !== "ENOENT") current = Buffer.alloc(0); }
        if (current) {
          let readable = true;
          try { parseDiskBytes(current); } catch { readable = false; }
          if (readable) throw new Error("data.json is readable; restore backups from the task board panel instead");
        }
        const temporary = path.join(root, `.data-${randomUUID()}.tmp`);
        await writeExclusive(io, temporary, loaded.bytes);
        const damaged = current ? `data.damaged-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json` : null;
        try {
          if (damaged) await io.rename(dataPath, path.join(root, damaged));
          await io.rename(temporary, dataPath);
        } catch (error) { await io.unlink(temporary).catch(() => {}); throw error; }
        await syncDirectory(io, root).catch(() => {});
        return { ok: true, restored: name, revision: loaded.disk.revision, ...(damaged ? { damagedFile: damaged } : {}) };
      } finally { lock.release(); }
    },
    async exportBackup(name, output) {
      if (typeof output !== "string" || !output.trim()) throw new Error("A new output file is required");
      const loaded = await readBackup(name);
      const backup = makeBackup(publicBoard(loaded.disk));
      const filename = path.resolve(output);
      await checkDirectory(io, path.dirname(filename));
      await writeExclusive(io, filename, JSON.stringify(backup, null, 2) + "\n");
      await syncDirectory(io, path.dirname(filename)).catch(() => {});
      return { ok: true, output: filename, sourceRevision: loaded.disk.revision };
    },
  };
}

export async function runMaintenanceCLI(args, maintenance = createMaintenance(path.join(homedir(), "Library", "Application Support", "LearningBoard"))) {
  const [command, ...rest] = args;
  if ((command === "--help" || command === "help") && rest.length === 0) return { ok: true, help: MAINTENANCE_USAGE };
  if (command === "inspect-lock" && rest.length === 0) return maintenance.inspectLock();
  if (command === "list-backups" && rest.length === 0) return maintenance.listBackups();
  if (command === "export-backup" && rest.length === 3 && rest[1] === "--output") return maintenance.exportBackup(rest[0], rest[2]);
  if (command === "restore-backup" && rest.length === 2 && rest[1] === "--confirm-all-clients-stopped") return maintenance.restoreBackup(rest[0], { confirmAllClientsStopped: true });
  if (command === "recover-lock") {
    const values = {};
    let confirmed = false;
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index];
      if (flag === "--confirm-all-clients-stopped" && !confirmed) confirmed = true;
      else if ((flag === "--expected-token" || flag === "--expected-fingerprint") && values[flag] === undefined && rest[index + 1] && !rest[index + 1].startsWith("--")) values[flag] = rest[++index];
      else throw new Error(MAINTENANCE_USAGE);
    }
    return maintenance.recoverLock({ expectedToken: values["--expected-token"], expectedFingerprint: values["--expected-fingerprint"], confirmAllClientsStopped: confirmed });
  }
  throw new Error(MAINTENANCE_USAGE);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const result = await runMaintenanceCLI(process.argv.slice(2)); process.stdout.write(result.help ?? (JSON.stringify(result, null, 2) + "\n")); }
  catch (error) { process.stderr.write(`Maintenance refused: ${error.message}\n`); process.exitCode = 1; }
}
