# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The `build` script in `package.json` externalizes `@opentui/core` (adds `--external @opentui/core`), and `bun run build` completes with exit code 0 producing `dist/cli.js` (no "Could not resolve @opentui/core-*" errors).
- AC2: The built `dist/cli.js` runs: `node ./dist/cli.js --help` (or `bun ./dist/cli.js --help`) exits 0 and prints the keryx help, with `@opentui/core` resolved at runtime rather than bundled.
- AC3: The change is confined to the `build` script only — `dependencies` stays `{}` and `optionalDependencies` stays exactly `@modelcontextprotocol/sdk`, `@opentui/core`, `web-tree-sitter`; the AC15 guard (`src/testing/block-d-no-network.test.ts`) and the no-optional-imports guard (`src/capability/no-optional-imports.test.ts`) stay green, and no `preinstall`/`install`/`postinstall` hook is added.
- AC4: On the resulting PR, the GitHub Actions "typecheck, tests, standard" workflow completes successfully (green), including the "Install dependencies" step that previously failed.
