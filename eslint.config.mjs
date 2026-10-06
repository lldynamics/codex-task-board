import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "plugins/", "design/", "outputs/", "validation-evidence/", ".npm-cache/", "src/icons.mjs"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true }] },
  },
  // Browser modules run inside the MCP App iframe.
  { files: ["src/app.mjs", "src/view*.mjs", "src/i18n.mjs", "scripts/preview-client.mjs"], languageOptions: { globals: { ...globals.browser } } },
  // esbuild replaces this constant in the preview bundle.
  { files: ["scripts/preview-client.mjs"], languageOptions: { globals: { PREVIEW_TOKEN: "readonly" } } },
];
