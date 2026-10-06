import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STYLE_MARKER = "<!-- APP_STYLE -->";

// Production, temporary preview and DOM fixtures all consume the same styles.
// The release remains a single HTML document with no stylesheet requests.
export async function loadAppTemplate(root = ROOT) {
  const html = await readFile(path.join(root, "src/app.html"), "utf8");
  if (html.split(STYLE_MARKER).length !== 2) throw new Error("App template must contain one APP_STYLE marker");
  const css = await readFile(path.join(root, "src/app.css"), "utf8");
  if (!css.trim() || /<\/style[\s>]/i.test(css)) throw new Error("App stylesheet is empty or cannot be safely inlined");
  return html.replace(STYLE_MARKER, () => `<style>\n${css}\n</style>`);
}
