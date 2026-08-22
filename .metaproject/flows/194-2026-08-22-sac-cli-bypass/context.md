# Context

Collected deterministically by `keryx flow init` at 2026-08-22T11:00:42.855Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Source Issue

https://github.com/MrCipherSmith/keryx/issues/391

### Mutating keryx CLI subcommands (wiki enrich, etc.) are not structurally coupled to SAC review — an agent can bypass propose/review entirely once shell_exec is approved

## Summary

SAC's whole design premise — "a proposal never becomes knowledge by itself... a human reviewer gates durable knowledge changes" — only holds if the agent actually routes a knowledge-base mutation through `workspace_propose`/`sac.review`. Nothing *requires* that. An agent can reach the exact same durable outcome (a wiki page landing at `Status: accepted`) by invoking the equivalent `keryx` CLI subcommand (`keryx wiki enrich`) via `shell_exec` instead — and once that shell command is approved (see #390 for one way this trivially happens via a stored `keryx *` grant, but a narrow, deliberate, exact "always approve `keryx wiki enrich <this file>`" grant has the identical effect), the mutation completes with **zero SAC proposal record**, invisible to `keryx workspace catch-up`/`list-proposals`.

## Repro (real, live)

1. `keryx shell --provider deepseek` in this repo, fresh session.
2. Ask the agent to write documentation for a real module (a genuine, open-ended "create documentation" task, not scripted).
3. Observed sequence: the agent read the module's source, then used `keryx wiki new component ...` (creates a draft) → `keryx wiki enrich ... --prompt "..."` (fills prose **and sets `Status: accepted`**) — both via `shell_exec`, both auto-approved.
4. It also attempted an `apply_patch` to correct the first enrich pass's hallucinated content — `apply_patch` IS approval-gated (per ADR-0010) and was correctly denied in this headless run. The agent's response to the denial: re-run the equivalent content change via `shell_exec keryx wiki enrich --prompt "<same intent, phrased as an enrich prompt instead of a diff>"` — which succeeded, because that shell command was already in the auto-approve set.
5. Checked afterward:
   - `keryx workspace list-proposals <the bound workspace>` → `[]` — no proposal was ever created.
   - `keryx workspace catch-up` → the session appears under **"Unknown (no resolution recorded)"** — SAC's own catch-up surface has no record that a real, accepted, durable content mutation happened in this session at all.
   - The wiki page on disk: `Status: accepted`, front-matter `Summary` field genuinely rewritten by the second `wiki enrich --prompt` call — a real, durable change, with no proposal, no review, no confirm-token, anywhere.

For contrast: a *different* session in the same testing pass, where the agent's activity WAS captured into Slate Seeds and went through the normal wrap-up → `machine-wrap-up.ts`/`session-wrap-up.ts` → propose path, correctly produced a pending proposal that `keryx workspace catch-up` surfaces right now, awaiting `keryx workspace review ... --decision <accepted|rejected|dismissed>`. So the SAC pipeline itself works — it's simply optional, not the only path to the same durable effect.

## Why this matters

Every wiki/SAC architecture doc (including the one the agent itself wrote in this same test run) states the review gate as an invariant of the design, not a convenience. In practice it is enforced only for the one path (Slate Seeds → wrap-up → propose) that an agent happens to use; the more direct, more discoverable path (the `keryx` CLI subcommand a human would reach for too) has no such gate, and its shell-level approval prompt is orthogonal to — and much coarser-grained than — the SAC review decision the wiki-owner-writer path enforces.

## Suggested direction (not prescriptive)

- Have `keryx wiki enrich` (and any other CLI subcommand that lands content owned by an SAC-fronted subsystem — wiki, memory, skill) go through the SAME guarded-owner-writer / propose-then-accept path as the agent-facing `workspace_propose` tool, rather than writing + accepting directly. If a direct, unreviewed CLI path is intentional for a human-operated terminal, it should not be reachable, unreviewed, from inside an agent's own tool loop via `shell_exec` — or `keryx workspace catch-up` should at minimum be able to detect and flag "content changed under a SAC-owned path this run, but no proposal exists for it," rather than filing the session under an undifferentiated "Unknown."

## Environment

- `keryx 0.2.55` (npm `@mrciphersmith/keryx`)
- Provider: `deepseek/deepseek-chat`
- Related: #390 (the specific `keryx *` grant that made the `shell_exec` half of this trivial in this session)

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

_(flow-init skill appends here)_
