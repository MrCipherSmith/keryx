# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

Source: `docs/requirements/slate/specification.md` AC-34..40 (verbatim
requirement text; renumbered AC1..AC7 for this flow package only — the
`AC-3x` numbering stays canonical in the requirements docpack).

## Criteria

- AC1: No code path allows a `slate.*` MCP call carrying one
  `externalSessionId` to read, list, or write another `externalSessionId`'s
  `.keryx/external-slates/*.json` — verified directly against the
  filesystem in a test, not only against tool call responses.
- AC2: `slate.open` called twice with the same `externalSessionId` never
  creates a second file or errors on the second call — it returns the
  existing external slate's current state, unmodified.
- AC3: An external slate's `anchors` field always equals exactly what the
  calling hand most recently supplied via `slate.open`/`slate.writeSeed` —
  no harness-side tree-walk, worktree-resolve, or runtime-probing code path
  ever writes into an `ExternalSlate.anchors` field.
- AC4: Every `SlateSeed` appended via `slate.writeSeed` carries
  `origin.harness` and `trust: "external-unverified"` before it is
  persisted; no proposal evidence produced from an external slate contains
  a Seed missing either field.
- AC5: `slate.close` never calls `propose` without a `workspaceId` bound
  earlier in that external slate's life (explicit `slate.open` parameter or
  SLATE-16 resolve-or-create) — absent binding, evidence is preserved as a
  local `unbound-candidate` artifact, visible at the next `workspace
  catch-up`, never discarded and never proposed against a guessed id.
- AC6: An external slate whose `lastWriteAt` exceeds the shared
  `withFileLock` stale-lock threshold is auto-closed on the next `slate.*`
  call touching that project's `cwd`, via the identical dispatch/
  `unbound-candidate` path an explicit `slate.close` would take — never left
  open indefinitely, and never closed by a background timer or daemon
  process.
- AC7: The pre-v3 non-goal ("no shared open slate between clients",
  `docs/requirements/slate/README.md`) holds after this flow ships exactly
  as stated, unreversed and unnarrowed — satisfied structurally by AC1, not
  by a policy check layered on top of a shared store.
