# Context

Collected deterministically by `keryx flow init` at 2026-10-01T10:26:50.256Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.704] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
2. [1.648] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
3. [1.621] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.593] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
5. [1.586] Findings reach a review round through the report's keryx:findings block, and a round without one silently records none (known-mistake/accepted) - known-mistakes/review-ingest-discards-verdicts.md
   `keryx review ingest --report <md>` reads structured findings from a fenced ` ```json keryx:findings ` block inside the report. A report without that block ingests as `findings: in=0`, and every `--verifications` claim naming one of its findings is then discarded as unresolvable — because the finding it names is not in the round.
   claimType: known-mistake | confidence: high | version: 0.3.0
   scope: module:review, flow, entity:parseEmbeddedFindings, ManagedReviewInput.findings, flow-complete gate
   provenance: source=manual link=https://github.com/MrCipherSmith/keryx/pull/499 author=MrCipherSmith confirmedBy=flow 243 closed through the gate on round r06 with 3 findings, 3 refuted verdicts, 0 discarded
   caveat: Version 0.2.0 of this entry asserted the opposite — that `review ingest`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-09-29T17:13:55.539Z)
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

- No snapshot/backup exists in any wiki writer today: `keryx ctx rg "backup|snapshot"`
  over `src/wiki/enrich.ts`, `deep-enrich.ts`, `service.ts`, `refresh.ts` finds only the
  freshness "snapshot version" concept (`service.ts:452`), not a store backup.
- Changelog handling lives in `src/wiki/refresh.ts:166` (`appendChangelogLine`); enrich
  has no equivalent preservation check.
- `--force` is parsed in `src/commands/wiki.ts:172,195,658`.
- Wiki writers to audit: `src/wiki/enrich.ts`, `src/wiki/deep-enrich.ts`,
  `src/wiki/refresh.ts`, `src/wiki/service.ts`, `src/sac/wiki-owner-writer.ts`.
- Downstream evidence (vantage-frontend, 2026-10-01): `.metaproject/` gitignored (line 42),
  0 tracked files; enrich run rewrote 98/504 pages, dropped `## Changelog` on 6,
  reworded attestations on 5, `Version` < changelog on 2; `wiki validate` silent on all.
- Related memory: [wiki enrich model command](wiki-enrich-model-command.md);
  downstream gets changes only via npm release + `keryx update`.

### T1 — every write/delete into `.metaproject/wiki/` (origin/main 5ab21a265)

Page writers that must go through the versioned `writeWikiPage()` / `deleteWikiPage()`:

| # | site | reached by | kind |
|---|---|---|---|
| W1 | `src/wiki/enrich.ts:909` | `wiki enrich` (RLM off), TUI `tui-shell.ts:8866` | overwrite |
| W2 | `src/wiki/enrich.ts:1206` (`finishSuccess`) | `wiki enrich` (RLM light/deep) | overwrite |
| W3 | `src/wiki/service.ts:1158` (`writeCollectedPage`) | `wiki collect [--force\|--changed]`, `keryx sync --apply` (`sync.ts:562`, `changed:true` ⇒ force) | create / overwrite |
| W4 | `src/wiki/service.ts:388` (`wikiPruneOrphans`) | `keryx sync --apply` (`sync.ts:234`) | delete |
| W5 | `src/wiki/service.ts:137` (`wikiCreatePage`) | `wiki new --force` | create / overwrite |
| W6 | `src/wiki/refresh.ts:149` (`migrateMarkers`) | `wiki migrate-markers` | overwrite |
| W7 | `src/wiki/refresh.ts:352` (`refreshOne`) | `wiki refresh` | overwrite |
| W8 | `src/wiki/refresh.ts:459` (`verifyPages`) | `wiki verify` | overwrite |
| W9 | `src/sac/wiki-owner-writer.ts:98` | SAC proposal accept | create (`decisions/sac-*.md`) |

Not pages, kept out of per-page history (documented, not silently skipped):
`service.ts:165` `index.md` managed block (regenerated on every collect);
`wiki/.sections.json` registry (`section-tombstone.ts:134`);
`templates/page.md` written only if missing (`update.ts:667`, `init.ts:945`).

Corrections to the frozen text: there is no `keryx wiki sync --apply` — the command is
`keryx sync --apply`; `keryx update` never overwrites a wiki page (create-if-missing on
the template only). AC1 amended accordingly.

### T1 — root cause of "collect --force strips front-matter and replaces prose"

Verified on the real vantage store: 476/504 pages carry the line
``Generated by `keryx wiki collect` `` (it lives in the 0.1.0 changelog entry, so enrich keeps
it), and enrich can never promote Status (flow 194), so enriched pages stay `Status: draft`.
`writeCollectedPage` treats `Status: draft` + marker as "unmodified generated draft" and
overwrites the WHOLE file. Example: `components/src-auth.md` — full enriched prose,
Version 0.2.0, an attestation changelog entry — would be replaced by the 0.1.0 stub on
the next `wiki collect --force`, or on `keryx sync --apply` when `src/auth` changed.
The page's own text promises the opposite ("Reference … regenerated by `--force`. The prose
sections above are the agent/human-owned part"). `src/wiki/managed-block.ts` already has
`<!-- keryx:reference:begin/end -->` markers (`wiki migrate-markers`) — T6 should make
collect replace only that block (and `## Related Wiki`), never the whole page.

### T1 — enrich invariant gaps

Both enrich paths funnel through `repairEnrichedFrontmatter` → `validateEnrichedMarkdown`
→ `setFrontmatterStatus` (W1 inline, W2 via `finalizeEnrichedText`). Only Status is
re-asserted; the model's own front-matter (incl. a lower `Version`) is kept, and nothing
checks `## Changelog` or attestation entries. The system prompt (`enrich.ts:176`) says
"Rewrite it" with no instruction to keep the changelog. One guard at
`finalizeEnrichedText` + the inline path covers both.

### T10 — real-store round trip (AC2 evidence, 2026-10-01)

Copy of vantage-frontend's `.metaproject/` (504 pages) at
`<keryx>/.claude/worktrees/vf-wiki-check/` (gitignored), pristine wiki kept aside.
Branch code (`bun src/cli.ts`), run from inside the copy:

1. `diff -rq pristine copy/.metaproject/wiki` → empty.
2. `wiki collect --force` → run `run-20261001T110940Z-bd80e6`, 50 files changed
   (31 pages overwritten, 18 created, index.md). `components/src-auth.md` went from
   181 lines of enriched prose to the 90-line generated stub — the T1 root cause,
   reproduced on real data.
3. `wiki restore --run run-20261001T110940Z-bd80e6` → 50 restored/deleted, 0 conflicts.
4. `diff -rq pristine copy/.metaproject/wiki` → empty; with `-s`, 509 files reported
   identical.

The first attempt left `index.md` different (it was outside the history then); it
now goes through `writeWikiPage` too, which is why step 2 counts it.

Incident during this task (recorded for honesty): a `cd` into the scratchpad was
silently reset to the main checkout, and one `wiki collect --force` ran against the
keryx repo's own tracked wiki on branch feat/health-project-linter-and-tsc (48 pages).
Undone with `wiki restore --run` (all 48 pages byte-identical to git) plus
`git checkout` of index.md; `git status` of that checkout matched its session-start
state afterwards.

### T6 — invariants, real-store check (2026-10-01)

`src/wiki/page-invariants.ts`: changelog/Version/front-matter/managed-block rules,
`preserveEnrichInvariants` (enrich: model changes prose only; front matter, changelog
and managed block come back from the original, one entry + Version bump added) and
`mergeGeneratedSections` (collect --force on an existing draft: Reference + Related
Wiki regenerated; map-page data sections only on never-enriched pages; Related Wiki
keeps the enricher's own lines). A page that still breaks an invariant is not written
(enrich: `failed`, collect: `skipped` + `invariantReason`, exit 1).

Same vantage copy, `wiki collect --force` (branch code), checked page by page with a
script comparing pristine vs new: 29 pages changed, 0 invariant violations; every
non-generated line kept except 5 rewordings of the generator's own "Graph-derived …"
note and one `## Related wiki` → `## Related Wiki` heading case. `src-auth.md`: prose
lines 1-113 byte-identical, Reference/Related Wiki regenerated, Version 0.2.0 → 0.2.1,
attestation entry intact, one new changelog line. Before T6 the same command cut it
from 181 to 90 lines.

Found on real data and fixed during T6 (each now has a test):
- enriched map pages carry prose under the generator's own headings (quality-map's
  `## Findings by Source` held `### Interpretation`) → map data sections are no longer
  regenerated on enriched pages;
- an enricher's sentence in Related Wiki (testing-map) → Related Wiki is additive.

Mutation check: with `preserveEnrichInvariants` and `mergeGeneratedSections` disabled,
6 of the AC5-AC9 integration tests fail; restored, all pass.

### T7 — wiki validate, real-store check (2026-10-01)

`validatePageInvariants` (service.ts): `Version` below the newest changelog entry on
every page; changelog dropped / entry removed or reworded / front-matter key dropped /
managed block dropped / section duplicated, against the page's previous version from
its history (`readPreviousVersion`, which skips back past a restore so the undo of a
damage is not itself flagged). A page with no history gets only the Version check.

Vantage copy: pristine → `validate` clean; after `collect --force` → clean; after
hand-damaging three pages the way the 2026-10-01 run did (attestation reworded on
src-auth, `## Changelog` removed on src-cases-store, Version lowered on scripts) →
exactly those 3 issues, exit 1; `wiki restore <page>` on each → clean again.

Found on real data during T7 and fixed (each with a test): a merge appended a second
Reference section on 6 pages whose enricher had shortened the heading to `## Reference`
(Reference now matched by prefix; `section-duplicated` added to the invariants);
`restore <page>` without `--version` went one version too far back after a hand edit;
`readPreviousVersion` flagged a restore as a removal.

AC11 exception, approved by the user on 2026-10-01 ("Исправить страницу"): keryx's own
wiki failed the new Version check — `components/src-harness.md` had YAML
`Version: 1.0.1`, changelog newest 1.0.2. Data fix, the only wiki page this branch
touches (`git diff --stat -- .metaproject/wiki`: 1 file, +1/-2): YAML Version → 1.0.2,
the stray `Version: 1.0.2` line removed. No text or Status changed.

Root cause found while fixing it: lines 10-151 of that page are a whole model reply
wrapped in a ```markdown fence, with a second front matter inside — an earlier enrich
wrote the reply as-is (the prompt shows the page in a ```markdown fence). Prevention
added: `unwrapFencedReply` in both enrich paths, with a test. The page itself is still
wrapped; unwrapping it means choosing between its two Summary values, a content call
left to the user.

### T1 — writers outside keryx

vantage-frontend has its own `.metaproject/core/gdwiki/verify-prose.mjs` (not shipped by
keryx; source of the "Deterministic repair by verify-prose.mjs" attestation entries). It
writes pages directly, so it is covered only by manual-edit detection on the next keryx
write — stated in AC12's "not covered".
