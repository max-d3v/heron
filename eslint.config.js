import { base, ignores, node, react } from "@heron/config/eslint";

export default [
  ignores,
  ...base,
  { files: ["packages/**/*.ts", "apps/desktop/src/main/**/*.ts", "apps/desktop/src/preload/**/*.ts", "*.ts", "*.js"], ...node },
  { files: ["apps/desktop/src/renderer/**/*.{ts,tsx}"], ...react },
];
