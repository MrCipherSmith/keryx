# Mutating keryx CLI subcommands (wiki enrich, etc.) are not structurally coupled to SAC review — an agent can bypass propose/review entirely once shell_exec is approved

Status: formalized
Source: https://github.com/MrCipherSmith/keryx/issues/391

## Problem

SAC's review gate ("a proposal never becomes knowledge by itself... a human
reviewer gates durable knowledge changes") only fires on the path an agent
*chooses* to take (Slate Seeds → wrap-up → `workspace_propose`). The same
durable outcome — a wiki page landing at `Status: accepted` — is also
reachable directly via `keryx wiki enrich` through `shell_exec`. Once that
shell command is approved (trivially via issue #390's bare wildcard, but a
narrow exact-command grant has the identical effect), the mutation completes
with zero proposal record — invisible to `keryx workspace
catch-up`/`list-proposals`. Confirmed live: a real session used `wiki new` +
`wiki enrich --prompt` to land accepted content with no SAC proposal ever
created; `catch-up` filed the session under an undifferentiated "Unknown (no
resolution recorded)".

## Expected Outcome

Per the campaign's consolidated fix plan (`docs/verification/fix-plan.md`,
issue #391 section), implement both of the following:

1. Route `keryx wiki enrich` through the same guarded-owner-writer /
   propose-then-accept path the agent-facing `workspace_propose` tool
   already uses, instead of writing + auto-accepting directly.
2. Have `keryx workspace catch-up` detect "an SAC-owned path (wiki/memory/
   skill) changed this run, but no proposal exists for it" and report it as
   a distinct, named case — not lumped into "Unknown (no resolution
   recorded)". This is a standing backstop for any future SAC-owned CLI
   subcommand with the same structural gap, not just `wiki enrich`.

## Out of Scope

Issue #390 (separate flow, 193). Rewriting every other CLI subcommand beyond
`wiki enrich` — only the demonstrated case plus the generic `catch-up`
backstop.
