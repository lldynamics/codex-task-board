# 发布身份与兼容接口

正式插件 ID、npm 包名与仓库名统一为 `codex-task-board`；开发者为 `lldynamics`，许可证为 MIT。界面显示“任务看板”或“Task Board”，由用户选择语言。

下列旧标识是有意保留的兼容契约，不是第二套产品：

| 接口 | 保留的标识 | 原因 |
| --- | --- | --- |
| MCP 工具 | `learning_board`、`learning_board_*` | 既有采集计划和调用脚本继续可用。 |
| 正式数据目录 | `~/Library/Application Support/LearningBoard/` | 不搬移已有数据、备份、锁与请求回执。 |
| 备份格式 | `learning-board-backup` | 既有导出备份继续按原规则校验和恢复。 |
| 浏览器视图偏好 | `learning-board:*:preferences:v1` 等既有键 | 保留项目、筛选、时区和侧栏偏好。 |

语言偏好使用独立的 `codex-task-board:locale:v1`，切换语言不修改任务内容或数据修订号。

首次从旧本地原型升级时，先在旧界面导出备份，再安装并启用 `codex-task-board`。不要同时启用旧 `learning-board` 插件和新插件，避免出现两套入口。插件 ID 的改变不会自动替换 Codex 已安装的旧缓存；客户端需要按支持的安装流程选择新身份。

构建过程只调整仓库内的生成包，正式数据目录与已安装插件缓存不参与构建。旧工具名与存储路径不需要用户手动改名；请勿为了统一名称手工移动数据、删锁或改备份字段。
