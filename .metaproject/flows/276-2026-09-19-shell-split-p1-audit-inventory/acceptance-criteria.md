# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `docs/requirements/keryx-shell-split/source-text-audit-inventory.md` covers every test file that reads the source text of `src/tui/tui-shell.ts` or `src/commands/shell.ts` — 16 files and 46 read sites against `origin/main` at `398acb4a` — and no file is listed that does not.
- AC2: For every individual `test(...)` that asserts over either file's source text, the inventory records six things: the technique (substring, negated substring, indexOf ordering, occurrence count, character window, regex), the exact literal or the anchor and width of the window, the behaviour it protects stated as what a user would see go wrong, whether that behaviour is observable today through an exported function or an injected dependency, the concrete conversion (behavioural test, or the seam module to extract), and the cosmetic edit that would break the audit as written. A describe block summarised as one row does not satisfy this.
- AC3: Each audit is classified as exactly one of `behavioural` (convertible by driving existing exported code), `seam` (naming the module to extract), or `structural` (a genuine statement about source structure that stays a text audit, with the reason and how it is rewritten to survive a folder split).
- AC4: `src/shell-source-audits.test.ts` re-derives the set of source-text-reading tests from the tree and fails when it disagrees with the inventory's `## Manifest` block on either the file set or the per-file read-site count; demonstrated by altering one manifest row and observing the failure name that row.
- AC5: That scan attributes a read only to a line naming one of the two paths outside a comment, resolved against both the test's own directory and `src/`, so it catches the joined form (`path.join(import.meta.dir, "..", "tui", "tui-shell.ts")`) and the helper form (`source("commands/shell.ts")`) and excludes files that merely name either path in prose; proven by a boundary test naming `commands/goal-command.test.ts`, which does both.
- AC6: `docs/requirements/keryx-shell-split/README.md` states the four-PR order and why conversion must precede the split, cites the seam pattern (`src/tui/bus-wake.ts`, `src/tui/bus-command.ts`), and records that `launchTuiAgentShell` is a single ~3,940-line closure that P3 can relocate but not decompose by movement.
- AC7: No production file is modified. `git diff --stat origin/main` shows changes only under `.metaproject/flows/276-*/`, `docs/`, the single new file `src/shell-source-audits.test.ts`, and the one `test:core` entry in `package.json` that registers it — without which `src/core-package.test.ts` proves the new test would run in neither CI job.
- AC8: The roadmap lists the package with its status, and the absence of the backlog entry this work was said to come from is recorded rather than left as a silent discrepancy.
- AC9: typecheck, lint and the full test suite are green in CI on the PR head.
