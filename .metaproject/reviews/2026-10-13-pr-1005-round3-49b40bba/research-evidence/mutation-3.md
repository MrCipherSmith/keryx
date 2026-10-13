# Mutation pass

Command: `bun test src/commands/review-revision-operand.test.ts` (baseline exit 0, 17278 ms). Run in a scratch copy; the worktree was not written.

Killed 1, survived 2, timeout 0, invalid 0.

| Mutant | Where | Change | Result |
|---|---|---|---|
| N21-provenance-hex-off | src/sync/provenance.ts:243 | `typeof commit === "string" && /^[0-9a-f]{4,64}$/i.test(commit)` → `typeof commit === "string"` | killed |
| N22-provenance-end-anchor | src/sync/provenance.ts:243 | `{4,64}$/i` → `{4,64}/i` | survived |
| N23-provenance-start-anchor | src/sync/provenance.ts:243 | `/^[0-9a-f]{4,64}$/i` → `/[0-9a-f]{4,64}$/i` | survived |

A survivor means no assertion pins that behaviour: the severity audit reads it as evidence.
