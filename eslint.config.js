// ESLint for the extension and its tests. Dev tooling only.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "test-results/**", "playwright-report/**", ".e2e-profile/**"],
  },
  js.configs.recommended,
  {
    // The service worker, popup, offscreen document and shared modules.
    files: ["*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // Manifest content scripts are classic scripts, not modules.
    files: ["content-*.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    files: ["tests/**/*.js", "e2e/**/*.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
