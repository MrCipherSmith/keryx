# keryx workspace catch-up never scans .keryx/external-slates/

Status: formalized
Source: https://github.com/MrCipherSmith/keryx/issues/395

## Problem

`keryx workspace catch-up`'s unbound-candidate scan (`src/sac/catch-up.ts`)
only reads `slate-archive/*-unbound-candidate.json` under a keryx-native
session's own store. The external MCP Slate surface stores its data
separately, at `.keryx/external-slates/<externalSessionId>.json` (per
`slate.md`'s own "On-disk layout" section) — `catch-up` has no code path
that reads that directory at all.

Confirmed live: a closed, never-bound external slate genuinely persists on
disk (nothing is discarded) but never surfaces anywhere in `catch-up`'s
output — not under "Unbound candidates" (empty), not under "Unknown" (that
section only lists internal session UUIDs). This contradicts `slate.md`'s
explicit documented promise that unbound work "surfaces at the next `keryx
workspace catch-up` as `unbound-candidate`, never silently discarded."

## Expected Outcome

`keryx workspace catch-up` additionally scans `.keryx/external-slates/*.json`
for closed, unbound (no `workspaceId` ever recorded) entries, and reports
them in the same `unbound-candidate` shape it already uses for internal
sessions.

## Out of Scope

Changing the external MCP slate storage format itself. The stale-slate
auto-close reclaim mechanism (already confirmed working correctly in the
campaign, see SLATE-06 — not affected by this gap).
