# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `classifyCommand` does not block `npm run test:unit | grep -E 'Test Files'`, `bun test 2>&1 | tail -5`, `echo hi | grep hi`, or `keryx ctx rg 'foo' | grep -c 'bar'`. Every one of these blocked before the change.
- AC2: `classifyCommand` still blocks `grep -rn 'foo' src/`, `grep -n 'foo' src/some/file.ts`, and `grep -rn 'foo' src/ | head -20` — piping a code search into a pager does not stop it being a code search.
- AC3: `classifyCommand` still blocks `cd x && rg y` and `cat f | rg y`, the two cases the shallow split exists to catch.
- AC4: The `# keryx:raw <reason>` escape still suppresses a block, and the recorded reason is still returned.
- AC5: A `Grep` tool payload is refused by `runCtxHook` with a non-zero exit and a message naming `keryx ctx rg`; before the change it exited 0 with no output.
- AC6: A payload for a tool that is neither `Bash` nor a declared native search tool exits 0 and writes nothing — the guard fails open on anything it cannot classify.
- AC7: The installed Claude `PreToolUse` matcher covers both `Bash` and `Grep`, and `validate` reports a pre-existing `Bash`-only install as needing reinstall rather than as valid.
- AC8: A test drives the outside proposal's five pass/block specimens through the real classifier and asserts the agreed verdict for each, including the one deliberate divergence (`git log ... | grep -v ...` stays blocked).
- AC9: `bun run typecheck` is clean, and `bun test src/ctx src/commands --timeout 30000` introduces no failures beyond those reproducible on origin/main.
