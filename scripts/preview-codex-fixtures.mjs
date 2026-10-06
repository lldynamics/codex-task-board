import { unavailableCodexSnapshot } from "../src/codex-domain.mjs";

// Synthetic UI fixtures only. The production build never imports this module.
export function previewCodexSnapshot(now = new Date().toISOString(), {english = false} = {}) {
  const snapshot = unavailableCodexSnapshot(now);
  snapshot.connection = { state: "connected", lastSuccessAt: now, error: null, scope: english ? "Synthetic examples · Local and Fedora" : "合成示例 · 本机与 Fedora", source: "desktop-snapshot" };
  const source = { mode: "snapshot", state: "connected", lastSuccessAt: now, complete: true, truncated: false, error: null };
  snapshot.sources = { threads: { ...source }, automations: { ...source } };
  snapshot.completeness = { threads: true, automations: true, truncated: false };
  const fixtures = [
    ["检查登录流程", "active", null, "running", null, "local"],
    ["完善任务卡片布局", "active", null, "running", null, "fedora"],
    ["确认发布范围", "active", "approval", null, null, "local"],
    ["补充目标平台", "active", "input", null, null, "local"],
    ["验证备份恢复", "idle", null, "completed", null, "local"],
    ["完成快捷键支持", "idle", null, "completed", "complete", "local"],
    ["检查连接异常", "error", null, "failed", null, "fedora"],
    ["后续优化清单", "notLoaded", null, null, null, "local"],
  ];
  const englishTitles = ['Check the sign-in flow','Polish task card layout','Confirm release scope','Specify the target platform','Verify backup restoration','Complete keyboard shortcuts','Investigate connection errors','Future improvements'];
  snapshot.threads = fixtures.map(([title, runtimeStatus, attention, lastTurnStatus, goalStatus, hostId], index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    hostId, title: english ? englishTitles[index] : title, runtimeStatus, attention, lastTurnStatus, goalStatus,
    cwd: hostId === "fedora" ? "/home/demo/projects/task-board" : "/Users/demo/projects/task-board", updatedAt: now,
  }));
  snapshot.automations = [
    { id: "preview-monitor", name: english ? "Collect task status (example)" : "任务状态自动采集（示例）", status: "ACTIVE", kind: "heartbeat", rrule: "RRULE:FREQ=MINUTELY;INTERVAL=2", timeZone: "Asia/Shanghai", targetThreadId: snapshot.threads[0].id, lastRunAt: now, nextRunAt: new Date(Date.parse(now) + 120000).toISOString() },
    { id: "preview-review", name: english ? "Daily project review (example)" : "每日项目检查（示例）", status: "PAUSED", kind: "cron", rrule: "RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0", timeZone: "Asia/Shanghai", targetThreadId: null, lastRunAt: null, nextRunAt: null },
  ];
  return snapshot;
}
