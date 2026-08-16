# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Pending proposals from archived workspaces surface in catch-up and
  list-proposals exactly as from active workspaces — archival never silently
  removes discoverability.
- AC2: Catch-up output is always four hard-separated sections, never an
  interleaved feed.
- AC3: A proposal whose evidence has drifted since creation is marked stale
  before display, not only discovered as `stale` after an attempted accept.
- AC4: `keryx workspace catch-up`/`list-proposals` v1 operate strictly on the
  invoking `cwd` — no cross-project aggregation, stated as a scope boundary.
- AC5: A session still mid-run (live lock, age under the shared
  `withFileLock` stale threshold) never appears in catch-up as `unknown`.
