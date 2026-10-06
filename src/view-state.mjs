import { boardSchema } from "./board.mjs";
import { systemTimeZone } from "./schedule-domain.mjs";

export function createViewState(initialBoard) {
  const board = boardSchema.parse(initialBoard);
  return {
    board, projectsById: new Map(board.projects.map((project) => [project.id, project])),
    codex: { snapshot: null, projection: { projects: [], tasks: [], source: null, freshness: null }, signature: "", error: "", read: { managed: false, phase: "waiting" }, collapsed: new Set() },
    host: { connected: false, loaded: false }, activity: { kind: "idle" },
    writes: { save: null, move: null, action: null },
    editor: { kind: null, id: undefined, revision: board.revision, snapshot: "", baseline: null, conflicts: [], availability: "available", pendingAction: null, returnFocus: null },
    schedule: { timeZone: systemTimeZone(), anchorDate: null, draft: null, snapshot: "", pendingAction: null, returnFocus: null },
    backup: { preview: null, exportText: "" }, feedback: { error: "", successTimer: null }, fieldEdit: null, fieldUndo: null,
    presentation: { surface: "tasks", mode: "next", preferences: null, pages: new Map(), collapsed: new Set(["paused", "failed"]), draggingId: null, filterOpen: false },
    sidebar: { collapsed: false, open: false, search: "", narrow: null, editorOpener: null },
  };
}
