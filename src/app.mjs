import { App } from "@modelcontextprotocol/ext-apps";
import { VERSION, TOOL_NAME, MUTATION_TOOL_NAME, DATA_TOOL_NAME, emptyBoard } from "./board.mjs";
import { mountBoard } from "./view.mjs";
import { CODEX_TOOL_NAME } from "./codex-domain.mjs";
import { mountCodex } from "./view-codex.mjs";

let app;
let connected = false;
let codex;
const view = mountBoard(document, emptyBoard(), {
  onOpenAutomations: () => codex?.openAutomations() ?? false,
  onOpenWorkbench: () => codex?.setVisible(false) ?? false,
  mutate: (request) => {
    if (!connected) throw new Error("Host is not connected");
    return app.callServerTool({ name: MUTATION_TOOL_NAME, arguments: request });
  },
  refresh: () => {
    if (!connected) throw new Error("Host is not connected");
    return app.callServerTool({ name: TOOL_NAME, arguments: {} });
  },
  data: (request) => {
    if (!connected) throw new Error("Host is not connected");
    return app.callServerTool({ name: DATA_TOOL_NAME, arguments: request });
  },
  // Pick up records Codex writes through the model tools while the panel is idle.
  boardPollMs: 15000,
  openConversation: (url) => app.openLink({ url }),
  openThread: (id) => {
    if (!connected || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Thread cannot be opened");
    return app.openLink({ url: `codex://threads/${id}` });
  },
});
codex = mountCodex(document, {
  beforeSurfaceChange: view.prepareSurfaceChange,
  onSurfaceChange: view.setWorkbenchSurface,
  onReadState: view.setCodexReadState,
  pollInManual: true,
  displayTimeZone: () => view.displayTimeZone,
  onSnapshot: (snapshot) => view.setCodexSnapshot(snapshot),
  onReadError: (message) => view.safeCodexError(message),
  refresh: ({ signal }) => {
    if (!connected) throw new Error("Host is not connected");
    return app.callServerTool({ name: CODEX_TOOL_NAME, arguments: {} }, { signal, timeout: 10000 });
  },
  openThread: (id) => {
    if (!connected || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("Thread cannot be opened");
    return app.openLink({ url: `codex://threads/${id}` });
  },

});

if (window.parent === window) {
  view.setHostState({ connected: false, message: "组件预览 · 不能本机保存" });
} else {
  view.setHostState({ connected: false, message: "正在连接，连接完成后读取本机记录…" });
  app = new App({ name: "任务看板", version: VERSION }, {});
  // The initial global-tool notification can arrive during the handshake.
  app.ontoolresult = (result) => {
    const payload = result?.structuredContent;
    if (payload && Object.hasOwn(payload, "snapshot")) codex.acceptReadResult(result);
    else if (payload && Object.hasOwn(payload, "board")) view.acceptReadResult(result);
    // Manual read failures can omit the board while still carrying a structured error.
    else if (payload?.ok === false && payload.error) view.acceptReadResult(result);
  };
  app.onerror = () => {
    view.reportError("宿主连接发生错误。当前编辑内容已保留；请刷新记录后重试。");
    codex.reportError("宿主连接发生错误。已保留上次 Codex 数据，请刷新后重试。");
  };
  app.ontoolcancelled = () => {
    view.reportError("读取已取消。请刷新记录后重试。");
    codex.reportError("读取已取消。已保留上次 Codex 数据，请刷新后重试。");
  };
  const applyTheme = (context) => {
    if (["light", "dark"].includes(context?.theme)) document.documentElement.dataset.theme = context.theme;
  };
  app.onhostcontextchanged = applyTheme;
  app.connect().then(async () => {
    connected = true;
    applyTheme(app.getHostContext());
    view.setHostState({ connected: true, message: "已连接 · 记录保存于本机" });
    codex.setHostState({ connected: true });
    // Each opening reads the server's board; the browser holds no saved copy.
    await view.refresh();
  }).catch(() => {
    connected = false;
    codex.setHostState({ connected: false });
    codex.reportError("宿主连接未完成，无法读取 Codex 任务。请重新打开看板后重试。");
    view.setHostState({ connected: false, message: "连接未完成 · 当前不能本机保存" });
    view.reportError("无法连接宿主，不能读取或保存本机记录。请重新打开看板。");
  });
}
