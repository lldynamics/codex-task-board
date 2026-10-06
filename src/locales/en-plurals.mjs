// Forms apply to explicit catalog templates before user parameters are inserted.
const forms = new Map([
  ["{count} 项", [["count", "items", "item"]]],
  ["{p1} 项", [["p1", "items", "item"]]],
  ["{p1} 个项目", [["p1", "projects", "project"]]],
  ["{p1} 分钟", [["p1", "minutes", "minute"]]],
  ["{p1} / {p2} 项任务{p3}", [["p2", "tasks", "task"]]],
  ["{p1}：{p2} 项任务；总数不受搜索、状态或来源筛选影响。{p3}", [["p2", "tasks", "task"]]],
  ["{p1}的{p2}任务", []],
  ["{p1} · {p2} 个时段", [["p2", "sessions", "session"]]],
  ["显示 {p1} / {p2} 项计划", [["p2", "plans", "plan"]]],
  ["整段 {p1} 分钟", [["p1", "minutes", "minute"]]],
  ["计划 {p1} 分钟", [["p1", "minutes", "minute"]]],
  ["今日焦点 · {p1} 项", [["p1", "tasks", "task"]]],
  ["待处理 · {p1} 项", [["p1", "tasks", "task"]]],
  ["接下来 · {p1} 项", [["p1", "tasks", "task"]]],
  ["今日焦点 {p1} 项 · {p2} · {p3}。建议最多选择 {p4} 项。", [["p1", "{p1} tasks", "{p1} task"], ["p4", "{p4} tasks", "{p4} task"]]],
  ["今日焦点 {p1} 项 · 待处理 {p2} 项 · 接下来 {p3} 项", [["p1", "tasks", "task"]]],
  ["{p1} 个学习时段 · 总计划 {p2} 分钟 · 本次已完成 {p3} · 本次未完成 {p4}", [["p1", "learning sessions", "learning session"], ["p2", "planned minutes", "planned minute"]]],
  ["今天剩余安排：{p1} 分钟（仅计未结束的已安排时段，按显示时区计算）", [["p1", "minutes", "minute"]]],
  ["已读取 {p1} 项任务{p2}。任务请在工作台查看。{p3}", [["p1", "Read {p1} tasks", "Read {p1} task"]]],
  ["每 {p1} 分钟", [["p1", "minutes", "minute"]]],
  ["每 {p1} 小时", [["p1", "hours", "hour"]]],
]);

export function englishPluralTemplate(key, parameters, template) {
  for (const [count, plural, singular] of forms.get(key) || []) if (Number(parameters[count]) === 1) template = template.replace(plural, singular);
  return template;
}
