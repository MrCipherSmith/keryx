# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A test on a scaffolded project (one that carries `.metaproject/core/gdgraph/cli.ts`) fails before the fix: `keryx gdgraph build` leaves no `.metaproject/data/gdgraph/.provenance.json`.
- AC2: After the fix, `keryx gdgraph build` on that same project records provenance naming the current HEAD, and a second build with no commits in between leaves it naming the same commit.
- AC3: The in-process path (no copied runner, or treesitter on) records provenance exactly as it does today (regression test).
- AC4: A build on a repository with no commits, or on a detached HEAD, does not fail and does not write a provenance file naming a commit that does not exist.
- AC5: The chosen repair is stated in the flow journal with its reason, and the paths not chosen carry a comment saying why — in particular whether existing projects are fixed without `keryx update`.
- AC6: `bun run check` passes and `keryx health run` gate is pass.
