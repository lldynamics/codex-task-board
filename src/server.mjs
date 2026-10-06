import { homedir } from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, createFileStore } from "./server-core.mjs";
import { CODEX_SNAPSHOT_DIRECTORY, createCodexService, ingestCodexSnapshot } from "./codex-service.mjs";

// Production uses a fixed relative location under the running user's home.
// It offers no custom storage path via MCP, CLI or a dedicated environment setting.
// Development tests use the core factory.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  // A host that launches an older Node otherwise sees only an opaque startup failure.
  process.stderr.write(`Task Board requires Node.js 22.13.0 or newer; found ${process.version} at ${process.execPath}.\n`);
  process.exit(1);
}
const directory = path.join(homedir(), "Library", "Application Support", "LearningBoard");
const server = await createServer(createFileStore(directory), {
  codex: createCodexService(), collectCodex: (input) => ingestCodexSnapshot(CODEX_SNAPSHOT_DIRECTORY, input),
});
await server.connect(new StdioServerTransport());
