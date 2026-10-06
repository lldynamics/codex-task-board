import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAppTemplate } from "../scripts/app-template.mjs";

async function fixture(t, html, css) {
  const root = await mkdtemp(path.join(tmpdir(), "task-board-styles-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/app.html"), html);
  if (css !== undefined) await writeFile(path.join(root, "src/app.css"), css);
  return root;
}

test("template inlines the exact stylesheet while preserving CSP and the script marker", async (t) => {
  const html = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><!-- APP_STYLE --><!-- APP_SCRIPT -->';
  const css = ':root { --accent:#28715b; } .literal::after { content:"$& $1"; }';
  const root = await fixture(t, html, css);
  const output = await loadAppTemplate(root);
  assert.equal(output, html.replace("<!-- APP_STYLE -->", () => `<style>\n${css}\n</style>`));
  assert.ok(!output.includes("<!-- APP_STYLE -->"));
  assert.ok(!output.includes("<link"));
});

test("template fails closed when its stylesheet is missing, empty or can terminate the style tag", async (t) => {
  for (const css of [undefined, " \n ", '.x { content:"</STYLE >"; }']) {
    const root = await fixture(t, "<!-- APP_STYLE -->", css);
    await assert.rejects(loadAppTemplate(root));
  }
});

test("template rejects missing or duplicate style injection markers", async (t) => {
  for (const html of ["<html></html>", "<!-- APP_STYLE --><!-- APP_STYLE -->"]) {
    const root = await fixture(t, html, "body { margin:0; }");
    await assert.rejects(loadAppTemplate(root), /one APP_STYLE marker/);
  }
});
