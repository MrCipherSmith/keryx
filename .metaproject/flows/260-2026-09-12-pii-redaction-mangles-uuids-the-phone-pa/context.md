# Context

Collected deterministically by `keryx flow init` at 2026-09-12T08:33:33.007Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.7] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
2. [1.676] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
3. [1.62] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
4. [1.615] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
5. [1.573] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-08T20:19:50.211Z)
- refresh: `keryx health run`

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
