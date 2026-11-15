# Acceptance criteria
- AC1: `keryx modules status --bogus`, `keryx skills verify --bundled --bogus` and `keryx memory search --bogus x` exit 1 and print one stderr line naming `--bogus`. [verify: exec `bun test src/commands/cli-unknown-flags.test.ts`]
- AC2: no private `rejectUnknownFlags`/`rejectUnknownOptions` definition remains outside the shared helper. [verify: invariant `keryx ctx rg -n "function rejectUnknown(Flags|Options)" src`]
- AC3: `keryx skills verify --all --json` and `--bundled --json` output parses to an object with numeric `schemaVersion`; a test pins required keys. [verify: exec `bun test src/commands/skills.verify-json.test.ts`]
- AC4: `keryx review <cmd> --ref x` prints exactly one stderr notice naming `--target-ref`; `--target-ref` prints none. [verify: exec `bun test src/commands/review-ref-alias.test.ts`]
- AC5: existing tests of touched commands still pass. [verify: exec `bun test src/commands`]
