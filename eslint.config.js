const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const prettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  // course-interview/ is a rendered artifact, not source: its styles.css and main.js are copied
  // verbatim from the codebase-to-course skill and run in a browser, so linting them with this
  // repo's Node config reports hundreds of "window is not defined". Regenerate, do not repair.
  {
    ignores: [
      "**/dist/**",
      "**/generated/**",
      "legacy/**",
      "**/*.config.js",
      "course-interview/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // k6 scripts run in k6's own runtime, not Node: __ENV, __VU and __ITER are injected
    // globals, and the k6/* module specifiers are resolved by the binary rather than from
    // node_modules. Declaring them here keeps `pnpm lint` covering the script instead of
    // the script having to opt out with file-level eslint-disable comments.
    files: ["k6/**/*.js"],
    languageOptions: {
      globals: { __ENV: "readonly", __VU: "readonly", __ITER: "readonly" },
    },
  },
  {
    // The storefront runs in a browser with JSX, neither of which the service configs cover.
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { window: "readonly", document: "readonly", fetch: "readonly" },
    },
  }
);
