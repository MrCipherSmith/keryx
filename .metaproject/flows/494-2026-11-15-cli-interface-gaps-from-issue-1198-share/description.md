# CLI interface gaps from issue #1198 (first three items)

Problem: keryx commands handle unknown flags, JSON envelopes and flag aliases inconsistently, against `rules/core/cli-interface-design.mdc`.

Expected outcome:
1. One shared helper refuses unknown flags (accepted-flag list, named refusal on stderr, exit 1); the six private copies (`review.ts`, `governance.ts`, `routing.ts`, `decisions.ts`, `product.ts`, `workspace.ts`) use it, and `modules`, `skills`, `memory` gain the guard.
2. `keryx skills verify --all --json` and `--bundled --json` print a versioned object (`schemaVersion`), with the old bare-array shape reachable for one release.
3. `--ref` as an alias of `--target-ref` in `keryx review` prints one stderr notice naming the preferred spelling.

Out of scope: the other #1198 items (health exit 2, review exit 2, docs references, full flag audit).
