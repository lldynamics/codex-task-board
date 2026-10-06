import * as filesystem from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { mutationInputSchema, dataInputSchema, emptyBoard, LIMITS } from "./board.mjs";
import { checksum, diskSchema, publicBoard, parseDiskBytes, makeBackup, validateBackup, upgradeBackupBoard } from "./store-data.mjs";
import { findScheduledOverlap } from "./schedule-domain.mjs";
import { checkDirectory, readRegularFile, readVerifiedBackup, rawChecksum, writeExclusive, syncDirectory, lockOwnerSchema, acquireProcessLock, BACKUP_PATTERN, MIGRATION_BACKUP, MIGRATION_CHECKSUM } from "./store-files.mjs";

const MESSAGE = {
  INVALID_INPUT: "输入不符合项目、任务、学习时段或备份约定。",
  INVALID_STORE: "本机数据文件损坏、格式未知或超出限制；没有重置或覆写。",
  SAVE_FAILED: "保存未完成；已有数据没有被覆写，请保留输入后重试。",
  BUSY: "另一项保存正在进行，或存在未释放的锁；请稍后重试。",
  REVISION_CONFLICT: "本机数据已更新，请检查最新内容后重新保存。",
  REQUEST_ID_REUSE: "此请求编号已用于不同内容，请生成新的请求编号。",
  REQUEST_EXPIRED: "此请求早于已保留的重试历史；请先检查最新看板，再生成新的请求编号。",
  CAPACITY_EXCEEDED: "本机记录、文件或版本数量已达到上限；没有丢弃项目或任务。",
  NOT_FOUND: "要编辑、归档或移动的记录、目标任务或任务所属项目不存在。",
  SCHEDULE_CONFLICT: "学习时段与已有活动排程重叠；请检查最新日历后调整时间。",
  SESSION_LOCKED: "已开始或已结束的学习时段不能重新排程；已取消的时段不能添加反馈。",
};
const ownerJson = ({ version, token, pid, hostname, createdAt }) => JSON.stringify({ version, token, pid, hostname, createdAt }) + "\n";
class StoreError extends Error {
  constructor(code, board) { super(MESSAGE[code]); this.code = code; this.board = board; }
}
function failed(error) {
  const code = error instanceof StoreError ? error.code : "SAVE_FAILED";
  return { ok: false, error: { code, message: MESSAGE[code] }, ...(error.board ? { board: error.board } : {}) };
}

// Directory and filesystem injection are factory dependencies, never MCP parameters.
// Production supplies only its fixed directory. Tests use temporary directories.
export function createFileStore(directory, { io = filesystem, pidProbe = (pid) => process.kill(pid, 0), lockWaitMs = 2000 } = {}) {
  const root = path.resolve(directory);
  const dataPath = path.join(root, "data.json");
  const lockPath = path.join(root, ".save-lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const backupPath = path.join(root, "backups");
  const processLockPath = path.join(root, ".save-lock.sqlite");

  async function checkRoot() {
    try { return await checkDirectory(io, root, { absent: true }); }
    catch { throw new StoreError("INVALID_STORE"); }
  }
  async function load() {
    try {
      await checkRoot();
      const { bytes } = await readRegularFile(io, dataPath);
      const loaded = parseDiskBytes(bytes);
      return { ...loaded, bytes, sourceRevision: loaded.disk.revision };
    } catch (error) {
      if (error.code === "ENOENT") return { disk: { ...emptyBoard(), historyStartRevision: 0, appliedRequests: [] }, sourceVersion: 4, bytes: null };
      throw new StoreError("INVALID_STORE");
    }
  }
  // Holding the process lock, an existing marker can only belong to a writer
  // that died (or an older plugin version). Quarantine it only when its owner
  // is a process on this host that no longer exists; keep it as diagnostics.
  async function recoverAbandonedMarker() {
    try {
      const entries = await io.readdir(lockPath);
      if (entries.length !== 1 || entries[0] !== "owner.json") return false;
      const { bytes } = await readRegularFile(io, ownerPath, 4096);
      const previous = lockOwnerSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (previous.hostname !== hostname()) return false;
      // Our own PID means a marker this process failed to clean up earlier.
      if (previous.pid !== process.pid) {
        try { await pidProbe(previous.pid); return false; }
        catch (error) { if (error.code !== "ESRCH") return false; }
      }
      await io.rename(lockPath, path.join(root, `.save-lock-quarantine-${randomUUID()}`));
      return true;
    } catch { return false; }
  }
  async function acquireLock() {
    const owner = { version: 1, token: randomUUID(), pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() };
    try { owner.processLock = await acquireProcessLock(processLockPath, { waitMs: lockWaitMs }); }
    catch (error) { throw new StoreError(error.code === "LOCKED" ? "BUSY" : "SAVE_FAILED"); }
    try {
      try { await io.mkdir(lockPath, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== "EEXIST" || !(await recoverAbandonedMarker())) throw new StoreError(error.code === "EEXIST" ? "BUSY" : "SAVE_FAILED");
        await io.mkdir(lockPath, { mode: 0o700 });
      }
    } catch (error) {
      owner.processLock.release();
      throw error instanceof StoreError ? error : new StoreError("SAVE_FAILED");
    }
    try {
      // File creation is exclusive; ownership is always checked before cleanup.
      await io.writeFile(ownerPath, ownerJson(owner), { flag: "wx", mode: 0o600 });
      const handle = await io.open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      return owner;
    } catch {
      await releaseLock(owner);
      throw new StoreError("SAVE_FAILED");
    }
  }
  async function releaseLock(owner) {
    if (!owner) return;
    try { await releaseMarker(owner); }
    finally { try { owner.processLock?.release(); } catch { /* The OS releases it when the process exits. */ } }
  }
  async function releaseMarker(owner) {
    try {
      await checkDirectory(io, lockPath);
      const { bytes } = await readRegularFile(io, ownerPath, 4096);
      const actual = lockOwnerSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (actual.token !== owner.token) return;
      await io.unlink(ownerPath);
      try { await io.rmdir(lockPath); }
      catch {
        // Retain diagnostics if removal of our empty directory fails. Never
        // overwrite another owner's file or remove unexpected lock contents.
        if ((await io.readdir(lockPath)).length === 0) await io.writeFile(ownerPath, ownerJson(owner), { flag: "wx", mode: 0o600 }).catch(() => {});
      }
    } catch { /* A cleanup failure cannot negate a committed transaction. */ }
  }
  async function assertUnchanged(originalBytes) {
    await checkRoot();
    let current;
    try { current = (await readRegularFile(io, dataPath)).bytes; }
    catch (error) {
      if (error.code === "ENOENT" && originalBytes === null) return;
      throw new StoreError("SAVE_FAILED");
    }
    if (originalBytes === null || !current.equals(originalBytes)) throw new StoreError("SAVE_FAILED");
  }
  async function prepareBackups(loaded) {
    const created = [];
    let createdDirectory = false;
    try {
      try { await io.mkdir(backupPath, { mode: 0o700 }); createdDirectory = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      await checkDirectory(io, backupPath);
      await io.chmod(backupPath, 0o700);
      const names = await io.readdir(backupPath);
      const hasMigration = names.includes(MIGRATION_BACKUP) || names.includes(MIGRATION_CHECKSUM);
      if (hasMigration) await readVerifiedBackup(io, backupPath, MIGRATION_BACKUP);
      else if (loaded.sourceVersion === 2) {
        const migration = path.join(backupPath, MIGRATION_BACKUP);
        await writeExclusive(io, migration, loaded.bytes);
        created.push(migration);
        const checksumPath = path.join(backupPath, MIGRATION_CHECKSUM);
        await writeExclusive(io, checksumPath, rawChecksum(loaded.bytes) + "\n");
        created.push(checksumPath);
        await readVerifiedBackup(io, backupPath, MIGRATION_BACKUP);
      }
      const name = `revision-${String(loaded.sourceRevision).padStart(16, "0")}-${rawChecksum(loaded.bytes)}.json`;
      const filename = path.join(backupPath, name);
      try { await writeExclusive(io, filename, loaded.bytes); created.push(filename); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const verified = await readVerifiedBackup(io, backupPath, name);
      if (!verified.bytes.equals(loaded.bytes)) throw new Error("Backup bytes differ from the current disk");
      await syncDirectory(io, backupPath);
      await syncDirectory(io, root);
      return { created, createdDirectory };
    } catch {
      await discardBackups({ created, createdDirectory });
      throw new StoreError("SAVE_FAILED");
    }
  }
  async function discardBackups(backups) {
    if (!backups) return;
    for (const filename of backups.created) await io.unlink(filename).catch(() => {});
    if (backups.createdDirectory) await io.rmdir(backupPath).catch(() => {});
  }
  async function pruneBackups() {
    try {
      await checkDirectory(io, backupPath);
      const names = (await io.readdir(backupPath)).filter((name) => BACKUP_PATTERN.test(name)).sort().reverse();
      const files = [];
      for (const name of names) {
        const stat = await io.lstat(path.join(backupPath, name));
        if (stat.isFile() && !stat.isSymbolicLink()) files.push(name);
      }
      for (const name of files.slice(20)) await io.unlink(path.join(backupPath, name));
    } catch { /* Retention cleanup is best effort after the commit point. */ }
  }
  async function atomicSave(disk, originalBytes) {
    const bytes = JSON.stringify(disk, null, 2) + "\n";
    if (Buffer.byteLength(bytes, "utf8") > LIMITS.bytes) throw new StoreError("CAPACITY_EXCEEDED");
    const tempPath = path.join(root, `.data-${randomUUID()}.tmp`);
    let created = false;
    try {
      await writeExclusive(io, tempPath, bytes);
      created = true;
      await assertUnchanged(originalBytes);
      // This rename is the commit point. Subsequent cleanup cannot report failure.
      await io.rename(tempPath, dataPath);
      created = false;
    } catch (error) { throw error instanceof StoreError ? error : new StoreError("SAVE_FAILED"); }
    finally { if (created) await io.unlink(tempPath).catch(() => {}); }
    await syncDirectory(io, root).catch(() => {});
  }

  return {
    async read() {
      try { return { ok: true, board: publicBoard((await load()).disk) }; }
      catch (error) { return failed(error); }
    },
    async data(rawInput) {
      const parsed = dataInputSchema.safeParse(rawInput);
      if (!parsed.success) return failed(new StoreError("INVALID_INPUT"));
      const input = parsed.data;
      let backup;
      if (input.action === "preview_restore") {
        try { backup = upgradeBackupBoard(validateBackup(input.backup)); } catch { return failed(new StoreError("INVALID_INPUT")); }
      }
      try {
        const board = publicBoard((await load()).disk);
        if (input.action === "export") return { ok: true, backup: makeBackup(board) };
        return { ok: true, board, preview: {
          sourceRevision: backup.revision, projectCount: backup.projects.length, taskCount: backup.tasks.length, sessionCount: backup.sessions.length,
          archivedProjectCount: backup.projects.filter((project) => project.archivedAt !== null).length,
          archivedTaskCount: backup.tasks.filter((task) => task.archivedAt !== null).length,
        } };
      } catch (error) { return failed(error instanceof StoreError ? error : new StoreError("INVALID_INPUT")); }
    },
    async mutate(rawInput) {
      const parsed = mutationInputSchema.safeParse(rawInput);
      if (!parsed.success) return failed(new StoreError("INVALID_INPUT"));
      const input = parsed.data;
      if (input.operation.type === "restore_board") {
        try { validateBackup(input.operation.backup); } catch { return failed(new StoreError("INVALID_INPUT")); }
      }
      let owner;
      let latest;
      let backups;
      let committed = false;
      try {
        await checkRoot();
        await io.mkdir(root, { recursive: true, mode: 0o700 });
        owner = await acquireLock();
        const loaded = await load();
        const disk = loaded.disk;
        latest = publicBoard(disk);
        const fingerprint = checksum(input);
        const previous = disk.appliedRequests.find((entry) => entry.requestId === input.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new StoreError("REQUEST_ID_REUSE", latest);
          return { ok: true, board: latest, replayed: true, appliedRevision: previous.appliedRevision, ...(previous.entityId ? { entityId: previous.entityId } : {}) };
        }
        if (input.expectedRevision < disk.historyStartRevision) throw new StoreError("REQUEST_EXPIRED", latest);
        if (input.expectedRevision !== disk.revision) throw new StoreError("REVISION_CONFLICT", latest);
        if (disk.revision >= Number.MAX_SAFE_INTEGER) throw new StoreError("CAPACITY_EXCEEDED", latest);

        const operation = input.operation;
        const now = new Date().toISOString();
        let entityId;
        function saveSession(session) {
          const existing = session.id ? disk.sessions.find((item) => item.id === session.id) : undefined;
          if (session.id && !existing) throw new StoreError("NOT_FOUND", latest);
          if (existing && (existing.status !== "scheduled" || Date.parse(existing.startAt) <= Date.parse(now))) throw new StoreError("SESSION_LOCKED", latest);
          if (existing && existing.taskId !== session.taskId) throw new StoreError("INVALID_INPUT", latest);
          const task = disk.tasks.find((item) => item.id === session.taskId);
          const project = task && disk.projects.find((item) => item.id === task.projectId);
          if (!task || !project) throw new StoreError("NOT_FOUND", latest);
          if (task.archivedAt !== null || project.archivedAt !== null || Date.parse(session.startAt) <= Date.parse(now)) throw new StoreError("INVALID_INPUT", latest);
          if (existing) Object.assign(existing, session, { lastUpdatedAt: now });
          else {
            if (disk.sessions.length >= LIMITS.sessions) throw new StoreError("CAPACITY_EXCEEDED", latest);
            disk.sessions.push({ objective: "", completionCriteria: "", ...session, id: randomUUID(), status: "scheduled", feedback: "", actualMinutes: null, lastUpdatedAt: now });
          }
          return existing?.id ?? disk.sessions.at(-1).id;
        }
        if (operation.type === "save_project") {
          const project = operation.project;
          entityId = project.id ?? randomUUID();
          if (project.id) {
            const index = disk.projects.findIndex((item) => item.id === project.id);
            if (index < 0) throw new StoreError("NOT_FOUND", latest);
            disk.projects[index] = { ...disk.projects[index], ...project, lastUpdatedAt: now };
          } else {
            if (disk.projects.length >= LIMITS.projects) throw new StoreError("CAPACITY_EXCEEDED", latest);
            disk.projects.push({ ...project, id: entityId, archivedAt: null, lastUpdatedAt: now });
          }
        } else if (operation.type === "save_task") {
          const task = operation.task;
          if (!disk.projects.some((project) => project.id === task.projectId)) throw new StoreError("NOT_FOUND", latest);
          entityId = task.id ?? randomUUID();
          if (task.id) {
            const index = disk.tasks.findIndex((item) => item.id === task.id);
            if (index < 0) throw new StoreError("NOT_FOUND", latest);
            disk.tasks[index] = { ...disk.tasks[index], ...task, lastUpdatedAt: now };
          } else {
            if (disk.tasks.length >= LIMITS.tasks) throw new StoreError("CAPACITY_EXCEEDED", latest);
            disk.tasks.push({ archivedAt: null, priority: "normal", dueDate: null, ...task, id: entityId, lastUpdatedAt: now });
          }
        } else if (operation.type === "create_task" || operation.type === "patch_task") {
          const existing = operation.type === "patch_task" ? disk.tasks.find((task) => task.id === operation.taskId) : undefined;
          if (operation.type === "patch_task" && !existing) throw new StoreError("NOT_FOUND", latest);
          const projectId = existing?.projectId ?? operation.task.projectId;
          const project = disk.projects.find((item) => item.id === projectId);
          if (!project) throw new StoreError("NOT_FOUND", latest);
          if (project.archivedAt !== null || (existing && existing.archivedAt !== null)) throw new StoreError("INVALID_INPUT", latest);
          entityId = existing?.id ?? randomUUID();
          if (existing) Object.assign(existing, operation.patch, { lastUpdatedAt: now });
          else {
            if (disk.tasks.length >= LIMITS.tasks) throw new StoreError("CAPACITY_EXCEEDED", latest);
            disk.tasks.push({
              archivedAt: null, priority: "normal", dueDate: null, ...operation.task,
              id: entityId, sourceTool: "Codex", lastUpdatedAt: now,
              conversationUrl: operation.currentThreadId ? `codex://threads/${operation.currentThreadId.toLowerCase()}` : null,
            });
          }
        } else if (operation.type === "archive_project" || operation.type === "archive_task") {
          const collection = operation.type === "archive_project" ? disk.projects : disk.tasks;
          entityId = operation.type === "archive_project" ? operation.projectId : operation.taskId;
          const record = collection.find((item) => item.id === entityId);
          if (!record) throw new StoreError("NOT_FOUND", latest);
          record.archivedAt = operation.archived ? (record.archivedAt ?? now) : null;
          record.lastUpdatedAt = now;
        } else if (operation.type === "restore_board") {
          const backup = upgradeBackupBoard(validateBackup(operation.backup));
          disk.projects = backup.projects;
          disk.tasks = backup.tasks;
          disk.sessions = backup.sessions;
          if (backup.dailyFocus) disk.dailyFocus = backup.dailyFocus;
          else delete disk.dailyFocus;
        } else if (operation.type === "set_focus_task") {
          entityId = operation.taskId;
          const task = disk.tasks.find((item) => item.id === operation.taskId);
          const project = task && disk.projects.find((item) => item.id === task.projectId);
          if (operation.focused && (!task || !project)) throw new StoreError("NOT_FOUND", latest);
          if (operation.focused && (task.archivedAt || project.archivedAt || task.status === "completed")) throw new StoreError("INVALID_INPUT", latest);
          const previous = disk.dailyFocus;
          const ids = new Set(previous?.date === operation.date && previous?.timeZone === operation.timeZone ? previous.taskIds : []);
          if (operation.focused) ids.add(operation.taskId); else ids.delete(operation.taskId);
          disk.dailyFocus = { date: operation.date, timeZone: operation.timeZone, taskIds: [...ids] };
        } else if (operation.type === "save_session") {
          entityId = saveSession(operation.session);
        } else if (operation.type === "record_session_feedback" || operation.type === "cancel_session") {
          entityId = operation.sessionId;
          const session = disk.sessions.find((item) => item.id === entityId);
          if (!session) throw new StoreError("NOT_FOUND", latest);
          if (operation.type === "cancel_session") {
            if (session.status !== "scheduled") throw new StoreError("SESSION_LOCKED", latest);
            session.status = "cancelled";
          } else {
            if (session.status === "cancelled") throw new StoreError("SESSION_LOCKED", latest);
            session.status = operation.status;
            session.feedback = operation.feedback;
            session.actualMinutes = operation.actualMinutes;
          }
          session.lastUpdatedAt = now;
        } else if (operation.type === "apply_schedule") {
          const project = operation.newProject;
          if (project) {
            if (disk.projects.some((item) => item.id === project.id)) throw new StoreError("INVALID_INPUT", latest);
            if (disk.projects.length >= LIMITS.projects) throw new StoreError("CAPACITY_EXCEEDED", latest);
            disk.projects.push({ ...project, archivedAt: null, lastUpdatedAt: now });
          }
          if (disk.tasks.length + operation.newTasks.length > LIMITS.tasks) throw new StoreError("CAPACITY_EXCEEDED", latest);
          const taskIds = new Set(disk.tasks.map((item) => item.id));
          for (const task of operation.newTasks) {
            if (taskIds.has(task.id)) throw new StoreError("INVALID_INPUT", latest);
            taskIds.add(task.id);
            const targetProject = disk.projects.find((item) => item.id === task.projectId);
            if (!targetProject) throw new StoreError("NOT_FOUND", latest);
            if (targetProject.archivedAt !== null) throw new StoreError("INVALID_INPUT", latest);
            disk.tasks.push({ archivedAt: null, priority: "normal", dueDate: null, ...task, lastUpdatedAt: now });
          }
          const sessionIds = new Set();
          for (const session of operation.sessions) {
            if (session.id && sessionIds.has(session.id)) throw new StoreError("INVALID_INPUT", latest);
            if (session.id) sessionIds.add(session.id);
            saveSession(session);
          }
        } else {
          entityId = operation.taskId;
          const index = disk.tasks.findIndex((task) => task.id === operation.taskId);
          if (index < 0) throw new StoreError("NOT_FOUND", latest);
          if (operation.beforeTaskId === operation.taskId) throw new StoreError("INVALID_INPUT", latest);
          if (operation.beforeTaskId !== null) {
            const anchor = disk.tasks.find((task) => task.id === operation.beforeTaskId);
            if (!anchor) throw new StoreError("NOT_FOUND", latest);
            if (anchor.status !== operation.status) throw new StoreError("INVALID_INPUT", latest);
          }
          const [task] = disk.tasks.splice(index, 1);
          const moved = { ...task, status: operation.status, lastUpdatedAt: now };
          const destination = operation.beforeTaskId === null ? disk.tasks.length : disk.tasks.findIndex((item) => item.id === operation.beforeTaskId);
          disk.tasks.splice(destination, 0, moved);
        }
        if (disk.dailyFocus) {
          const activeProjects = new Set(disk.projects.filter((project) => !project.archivedAt).map((project) => project.id));
          const eligible = new Set(disk.tasks.filter((task) => !task.archivedAt && task.status !== "completed" && activeProjects.has(task.projectId)).map((task) => task.id));
          disk.dailyFocus.taskIds = disk.dailyFocus.taskIds.filter((id) => eligible.has(id));
        }
        // Validate once against the final candidate board. Adjacent intervals
        // and atomic swaps are allowed; intermediate batch overlap is harmless.
        if (findScheduledOverlap(disk)) throw new StoreError("SCHEDULE_CONFLICT", latest);
        // Every record this operation wrote carries this operation's timestamp.
        const changed = Object.fromEntries(["projects", "tasks", "sessions"].map((key) => [key, disk[key].filter((record) => record.lastUpdatedAt === now).map((record) => record.id)]));
        disk.revision += 1;
        disk.appliedRequests.push({ requestId: input.requestId, fingerprint, appliedRevision: disk.revision, ...(entityId ? { entityId } : {}) });
        const overflow = Math.max(0, disk.appliedRequests.length - LIMITS.retainedRequests);
        if (overflow) { disk.appliedRequests.splice(0, overflow); disk.historyStartRevision += overflow; }
        diskSchema.parse(disk);
        // Reject capacity before creating any backup, including oversize restores.
        if (Buffer.byteLength(JSON.stringify(disk, null, 2) + "\n", "utf8") > LIMITS.bytes) throw new StoreError("CAPACITY_EXCEEDED", latest);
        if (loaded.bytes !== null) backups = await prepareBackups(loaded);
        await atomicSave(disk, loaded.bytes);
        committed = true;
        await pruneBackups();
        return { ok: true, board: publicBoard(disk), replayed: false, appliedRevision: disk.revision, ...(entityId ? { entityId } : {}), changed };
      } catch (error) {
        return failed(error instanceof StoreError ? new StoreError(error.code, error.board ?? latest) : new StoreError("SAVE_FAILED", latest));
      } finally {
        if (!committed) await discardBackups(backups);
        await releaseLock(owner);
      }
    },
  };
}
