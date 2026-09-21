# Context

Collected deterministically by `keryx flow init` at 2026-09-21T06:30:04.307Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.834] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown
2. [1.77] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`
3. [1.755] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
4. [1.668] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown
5. [1.655] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-20T13:30:14.257Z)
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

### T5 reproduction (280-T5-T8 implementer, 2026-09-21)

Reproduced on a throwaway repo under scratch space, using THIS branch's CLI
(`bun /home/altsay/keryx/src/cli.ts ...`), not the globally installed 0.2.131:

1. `git init` + one commit with `src/index.ts`.
2. `bun cli.ts init --yes` — scaffolds `.metaproject/`, including
   `.metaproject/core/gdgraph/cli.ts` (the standalone copied runner every
   `keryx init`/`keryx update` project gets — `src/lib/templates.ts`).
3. `bun cli.ts gdgraph build` — before ANY provenance exists. Result:
   `.metaproject/data/gdgraph/.provenance.json` is not even CREATED. Root
   cause: `gdgraphCommand` (`src/commands/gdgraph.ts`) delegates `build` to
   the copied local runner (`.metaproject/core/gdgraph/cli.ts`) whenever it
   exists and treesitter is off (`delegateToLocalRunner`), and that copied
   runner's own `build` handler never calls `recordProvenance` — the
   in-process `recordProvenance` call right after `buildGraph()` in
   `gdgraph.ts` is unreachable in a normal scaffolded project.
4. `bun cli.ts sync --apply` — establishes the gdgraph baseline anyway,
   because `sync.ts`'s `applyModule` calls `recordProvenance` a SECOND time,
   unconditionally, right after `gdgraphCommand(["build"])`, independent of
   whatever the delegated build did or didn't record. Provenance commit after
   this: `7859d359` (the `src/index.ts` commit).
5. `git add -A && git commit` — commits the scaffolded `.metaproject/` tree
   (no `src/` changes). HEAD moves to `c8d07b7b`. This is the
   ".metaproject-only commit" the flow is about.
6. `bun cli.ts sync` (report only):
   ```
   ## gdgraph
     up to date (built at 7859d359)
   ## gdwiki
     no provenance — run `keryx sync --apply` to build + record a baseline
   ```
   Diff stage: `codeOnly(diffSince(cwd, "7859d359"))` is empty (the commit
   touched no `.ts`/`.tsx`/etc. file), so it reports "up to date" and never
   calls `recordProvenance`. Provenance stays at `7859d359`.
7. `bun cli.ts gdgraph build` (manual, after the commit):
   ```
   gdgraph build complete: 1 nodes, 0 edges
   summary: …/artifacts/summary.md
   ```
   `.provenance.json` STILL reads `{"commit": "7859d359...", ...}` afterward —
   confirms point 3: the delegated runner rebuilt the artifact (mtime moved)
   but never touched provenance.
8. `bun cli.ts sync --apply`:
   ```
   ## gdgraph
     up to date (built at 7859d359)
   ## gdwiki
     → built; provenance NOT recorded (baseline) — the code graph is stale:
       HEAD moved since the graph was built (built at 7859d359b8b6, now
       c8d07b7bddae)
   ```
   Confirms AC1 exactly: gdgraph provenance never advances (diff stage says
   "nothing to rebuild"), and the SAME stale commit then makes
   `checkGraphStaleness`/`resolveWikiSourceGate` refuse the wiki baseline —
   the two mechanisms disagree forever, with no command that resolves it.

Full commands/output are reproducible from this sequence; not re-pasted here
in full to keep this file scannable.

### T6 ownership decision — see `journal.md` (`- note (implementer): ...`).
