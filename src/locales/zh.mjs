// Explicit system-message keys. User content is only passed as text parameters.
// Chinese source strings are their own keys; only entries whose displayed
// text differs from the key are listed. Every key is registered in en.mjs.
export default Object.freeze({
  "桌面快照 · 按分钟采集": "桌面快照",
  "桌面快照，按分钟采集": "桌面快照",
  "每 5 秒读取 · 桌面快照按分钟采集": "每 5 秒读取缓存 · 桌面快照",
  "请使用 Codex 自动化功能{p1}现有计划。\\n计划 ID：{p2}\\n仅修改该 ID 的启用状态，保留其任务内容与运行安排。请回复操作结果；若当前宿主不支持，请明确说明未修改。": "请使用 Codex 自动化功能{p1}现有计划。\n计划 ID：{p2}\n仅修改该 ID 的启用状态，保留其任务内容与运行安排。请回复操作结果；若当前宿主不支持，请明确说明未修改。",
  "codex.read-summary": "Codex {result} · {time}{warning}",
  "session.continuity": "（{value}）",
  "timezone.named": "{name}（{value}）",
  "source.summary": "{name}：{mode} · {status}{stale}{partial}{truncated} · {timeKind}：{time}{error}",
  "source.snapshotMode": "桌面快照（按已配置的采集频率更新）",
  "source.pollStatus": "每 {seconds} 秒读取本地快照与元数据 · 不启动模型",
  "source.collectionNotice": "本地读取不会启动模型。原生定时采集须另行配置，会运行模型并消耗 Codex 额度。",
  "source.systemError": "{message} · 错误代码：{code}",
  "automation.pauseVerb": "暂停",
  "automation.resumeVerb": "恢复",
  "pagination.action": "{label}：{action}",
});
