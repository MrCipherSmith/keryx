import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/**", "dist/**", "build/**", "coverage/**", ".metaproject/**", ".claude/**", ".worktrees/**", "fixtures/**"] },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.test.ts"],
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
