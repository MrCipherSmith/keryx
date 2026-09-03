# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx ctx hook claude` given a stdin that is opened and never written exits 0 within 5 seconds and writes nothing. Before the change it was still running at 14 seconds.
- AC2: A test drives that case through a real spawned process and fails if the process does not exit; reverting the bounded read makes it red.
- AC3: `ctx hook` still classifies and refuses correctly when stdin carries a normal payload — the existing hook test suite passes unchanged.
- AC4: `ANTIGRAVITY_RUNTIME.validate` reports an inert `type: "prompt"` entry and an absent matcher as needing attention rather than returning `[]`.
- AC5: Whether a runtime's managed group is flat or nested is declared per runtime, and a flat-shaped group no longer validates clean for a nested-shape runtime such as claude.
- AC6: `keryx ctx uninstall-hook` still removes a guard written in every shape any previous build wrote — flat, nested, `Bash`-only matcher and `Bash|Grep` — asserted by a test that drives the real installer and uninstaller.
- AC7: `grep -rn '#keryx:raw' src/` and `git log --grep='# keryx:raw'` are BLOCKED; a genuine trailing `# keryx:raw <reason>` still allows the command and still returns the recorded reason.
- AC8: Each of the three fixes is mutation-verified: reverting it makes at least one named test fail, and the result is recorded in the flow journal.
- AC9: `bun run typecheck` is clean and `bun test src/ctx src/commands` introduces no failures beyond those reproducible on origin/main.
