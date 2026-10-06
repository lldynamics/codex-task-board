# Changelog

## 0.11.0

### Reliability
- Saves are serialized by an operating-system-released SQLite lock (`.save-lock.sqlite`) and wait up to 2 seconds instead of failing at once. A `.save-lock` marker left by a process that died on this host (or by this process) is quarantined automatically, so a crash no longer blocks every later save.
- New offline command `restore-backup <name> --confirm-all-clients-stopped` restores a verified backup when `data.json` is unreadable; the damaged file is kept.
- The request history keeps the latest 1,000 receipts (was 10,000). Files with the older, longer history still load and are trimmed on the next save.
- A collector-lock release failure no longer hides the original ingest error.
- The server reports a clear error when started with Node.js older than 22.13.0.

### Codex tasks
- Snapshot freshness follows the observed collection interval (two intervals plus one minute, 3–35 minutes) instead of a fixed 3 minutes.
- A `capturedAt` up to 5 minutes ahead of the server clock is recorded at server time instead of rejecting the collection.

### Model tools
- `learning_board` (the read-only entry) is visible to the model, so asking Codex to open the task board can launch the panel.
- `learning_board_task`, `learning_board_plan` and `learning_board_feedback` return a compact receipt with the changed records instead of the whole board.
- `learning_board_context` omits archived projects, tasks and their sessions by default (`includeArchived: true` returns everything) and reports the omitted counts.

### Interface
- Times use the chosen display time zone, which now defaults to the computer's time zone instead of Asia/Shanghai.
- The visible, idle board picks up records Codex writes through the model tools (checked every 15 seconds).
- Restoring an archived task or project that would overlap scheduled sessions names both sessions.
- The schedule review message shows times in the display time zone instead of raw UTC strings.
- The Chinese catalog lists only text that differs from its key; the interface bundle is about 90 KB smaller.

### Development
- ESLint (`npm run lint`), CI on macOS and Linux with Node 22.13.0/22/24, shared test helpers, and the preview server rejects requests for other hosts.
- `@modelcontextprotocol/sdk` 1.32.1 and `esbuild` 0.28.2.
- The generated `plugins/codex-task-board/` directory and the local QA notes are no longer tracked.

## 0.10.0

- Public release identity `codex-task-board` (MIT, lldynamics) with Chinese and English interfaces.
- Legacy `learning_board_*` tools, the `LearningBoard` data directory, the backup format and view preferences remain compatibility interfaces.
