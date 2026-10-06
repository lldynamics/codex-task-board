import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = { kanban:'kanban', list:'list-bullets', search:'magnifying-glass', plus:'plus', 'folder-plus':'folder-plus', pencil:'pencil-simple', close:'x', warning:'warning-circle', link:'arrow-square-out', down:'caret-down', right:'caret-right', up:'arrow-up', 'arrow-down':'arrow-down', refresh:'arrows-clockwise', check:'check-circle', dots:'dots-three', grip:'dots-six-vertical' };
const icons = {};
for (const [name, file] of Object.entries(names)) icons[name] = await readFile(path.join(root, 'node_modules/@phosphor-icons/core/assets/regular', `${file}.svg`), 'utf8');
// Rewrite generated files only when their content changes, so builds leave
// src/ untouched unless the icon set or the Phosphor package changed.
const generated = `// Generated from @phosphor-icons/core 2.1.1 (MIT). See assets/phosphor-LICENSE.txt.\nconst icons = ${JSON.stringify(icons)};\nexport function icon(document, name) {\n  const node = document.createElement('span');\n  node.className = 'icon';\n  node.setAttribute('aria-hidden', 'true');\n  // Only bundled, trusted library SVG is inserted; never user-provided content.\n  node.innerHTML = icons[name] || '';\n  return node;\n}\nexport function mountIcons(document) {\n  for (const node of document.querySelectorAll('[data-icon]')) node.replaceWith(icon(document, node.dataset.icon));\n}\n`;
async function writeIfChanged(file, value) {
  let current;
  try { current = await readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!current || !current.equals(Buffer.from(value))) await writeFile(file, value);
}
await writeIfChanged(path.join(root, 'src/icons.mjs'), generated);
await writeIfChanged(path.join(root, 'assets/phosphor-LICENSE.txt'), await readFile(path.join(root, 'node_modules/@phosphor-icons/core/LICENSE')));
