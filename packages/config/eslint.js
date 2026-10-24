// Shared flat-config presets. The root eslint.config.js composes them per folder.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export const ignores = {
  ignores: ["**/node_modules/**", "**/out/**", "**/dist/**", "**/.turbo/**"],
};

export const base = tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  rules: {
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/consistent-type-imports": "error",
  },
});

export const node = {
  languageOptions: { globals: { ...globals.node } },
};

export const react = {
  languageOptions: { globals: { ...globals.browser } },
  plugins: { "react-hooks": reactHooks },
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
  },
};
