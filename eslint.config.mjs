import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  // vscode-extension/ is a separate package with its own tsconfig and its own
  // CI job (typecheck + tests). It was previously matched only by the
  // `**/*.test.ts` block below, which carries no TypeScript parser, so its
  // tests were parsed by espree and every `type` import was a parse error.
  // Deleting those imports to silence it broke the extension's own typecheck.
  { ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".metaproject/**", ".claude/**", ".worktrees/**", "fixtures/**", "vscode-extension/**"] },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    rules: {
      // Adversarial fixtures deliberately send values outside static contracts.
      "@typescript-eslint/no-explicit-any": "off",
      // Empty/throw-only generators model providers with no emitted events.
      "require-yield": "off",
      // Some isolation tests must load a module after configuring its process.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
