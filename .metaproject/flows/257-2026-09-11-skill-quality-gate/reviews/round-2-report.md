# Flow 257 review round 2 — verbatim report

Scope: narrow — closure of the round-1 findings and the fixes that claim to
close them. Branch `skills/quality-gate`, HEAD
`03c2d1c685feeca74a716ea80ee142630aedfbc0` (rebased onto `origin/main`).
Reviewer: one agent, review-only, no source edits, no subagents.

STATUS: DONE_WITH_CONCERNS

## Closure table

| round-1 finding | status | how it was checked |
|---|---|---|
| T20 install — delete through symlinked parent | closed | All three reproductions executed in tmp trees. Symlinked skills root, symlinked category, symlinked skill dir: victim `SKILL.zed.md` survives in every case, one `skipped-dir` / `reason:"symlink"` outcome each, warning names the blocked component. |
| T20 — case-insensitive FS deletes a user's file | closed | The tmp FS is case-insensitive (`existsSync("SKILL.zed.md")` true for an on-disk `skill.zed.md`). Sweep returned `[]`; the file survives. `readdir` + exact-name match does the work. |
| T20 — silent removals | closed | Happy path removes a genuine stale build and returns `{action:"removed"}`, rendered as a printed notice. `SKILL.md` / `SKILL.detail.md` / `reference.md` untouched; a symlink *as* the candidate file gives `kept-not-regular-file`, target intact. |
| T19/T22 ceilings — message told authors to do what the rule forbids | closed | Message at `bundled-eval.ts:1986` now says "Split the skill… A ceiling only ever moves DOWN". The rule's blockquote matches it word for word (diffed by hand). `bundled-eval.test.ts:1704-1718` reads both files. |
| T19 — ceiling ratchet untested | closed | `ceilingMismatches()` takes the map as an argument, so a raise is exercised, not just the tree: `review/review-clean-code` 545→1200 produces exactly the finding round 1 said went green. Equality in both directions plus a stale-entry check. No exception list. 60 pass / 0 fail. |
| T19 ledger — worker refused the instructed `docs` root | refusal upheld, evidence partly wrong | `package.json` `files` does not publish `docs/skills/`, so the check would fail for every installed user; that measurement settles it. The tree-side measurement is partly false — see NEW-1. Replacement (`REJECTED_CHANGES_LEDGER` + three tests) pins existence, header, separator row, "append-only" and the rule's citation — sufficient for AC11. |
| T21 corpus ratchet | closed | `RANK1_FIRST=285` / `RANK1_TOTAL=287`, both re-measured live and compared with `toBe`, not `>=`. Denominator is the corpus's own counted positives. Lowering silently is impossible; the only escape is `KNOWN_ROUTING_GAPS[].excluded`, a visible registry rather than a number. 181 pass / 0 fail. |
| T19 minor set (6 checks) | closed | Each has its own fixture or unit test (`not formatted` / `not forced` / `not fortunate` rejected; empty `## Verification` body rejected; placeholder Red Flags rows rejected; one `anatomy:sections` finding per skill with a Codex build present to prove over-reporting; `anatomy:red-flags-collision` attributed to the later key only). No false positives: `skills verify --bundled` passes every check across all 67 shipped skills. |
| T22 minor set | closed | `interview` and `interviewer` both exist, so the new NOT-for resolves. `reviewer-skill-creator`'s quoted row matches `src/review/reviewers.ts:200-205` exactly, including `no recorded origin` for `drift === "none"`. `keryx flow check` really takes no id (ran it). Storage rule enumerates both divergence cases and the seven skills. `schemaVersion: 2` with a pinning assertion; no `usedFallbackBuild` in shipped code. |
| T22 refutation — review flags lost their routing home | refutation correct | All ten flags measured: `--frontend` review-frontend 205 vs orchestrator 65; `--backend` 205/65; `--architecture` 205/65; `--performance` 205/65; `--style` 205/65; `--security` review-security-code 75 vs 65; `--strict` / `--all` / `--project-conventions` / `--legacy-profiles` go to the orchestrator itself. `triggerKey` in `catalog-single-source.test.ts:145-165` is order-free, so the collision claim in the ledger holds. |
| T21 — 48 new paraphrases | closed, all 48 checked | Every added positive extracted from `437a6f3e` and scored: 48/48 rank their own skill first, 0 quote any of their own triggers verbatim (`triggers` present on the catalog entries, so the check is non-vacuous). Wording is conversational, e.g. "we're about to get hammered with traffic, will this handler hold up". |

## New findings

**NEW-1 — minor — `src/gdskills/bundled-eval.ts:1342-1348`.** The recorded
evidence for refusing the `docs` root states of eight named paths, including
`docs/analysis`, `docs/plans`, `docs/report`, that "None of them exists in this
repository and none of them should." All three do exist here (`ls -d`
confirms). At least 3 of the claimed 13 would-be findings would not fire, and
the count is overstated. The refusal still stands on the `package.json` `files`
measurement, verified independently. Fix: name only the autodoc-generated
paths, and drop or re-measure the count. The same numbers are repeated at
`bundled-eval.test.ts:2038-2041`.

**NEW-2 — minor — `src/gdskills/install.ts:96-98` → `src/commands/update.ts:240-245`.**
Every `removed` outcome is pushed into `InstallGdskillsResult.warnings` and
printed by `keryx update` under `heading("Warnings")`. About 88 identical
runtime copies were removed, so the first `keryx update` after this release
prints roughly 88 lines under a heading that says "Warnings" for work that
succeeded exactly as designed; `install.ts` itself calls these "notices" in its
doc comment. No exit-code effect. Fix: split the field into `notices` and
`warnings`, or print removals under their own heading.

**NEW-3 — minor — `src/gdskills/bundled-eval.test.ts:1714-1718`.** The claim is
that the rule quotes the message verbatim and a test reads both. The test reads
the rule file but asserts only `"A ceiling **moves down**, never up"`, and only
`"Split the skill"` + `/only ever moves DOWN/` on the message. The verbatim
blockquote is never compared against the message string, so the two can drift in
every word outside those three fragments. Fix: strip `> ` from the blockquote
and compare it to the finding text.

## Tree consistency and the trim workflow

`bun test src/gdskills/bundled-eval.test.ts` → 60 pass, 0 fail; all 67 shipped
skills sit at exactly their recorded ceiling and `SKILL_LENGTH_CEILINGS.size ===
67`.

An author who legitimately trims a skill must, in the same commit: edit the
`SKILL.md`, recount, and set that key in `skill-length-ceilings.ts` to the new
count; a new skill needs a new entry, a deleted skill needs its entry removed.
An asymmetry worth telling authors about: `skills verify --bundled` fires only
on `lines > ceiling`, so a trim without a ceiling update looks green locally and
goes red in CI. And because the rule forbids raising, the tree is now
length-frozen: adding a sentence to any skill requires a compensating deletion
or a split. That is the design, but it is not stated anywhere an author would
look.

## Checked and cleared

Containment walk composition (`resolveSweepableDir` per component, `realpath`
equality at `install.ts:232`); category probed once, so one symlinked category
yields one notice rather than 67; ENOENT/ENOTDIR treated as steady state, not a
warning; `retiredRuleWarning` null-filter still applied after the refactor;
`EXCLUDED_POSITIVES` sourced from the visible `KNOWN_ROUTING_GAPS` registry;
`bundledSkillFiles` returns only `SKILL.md`, so the size assertion is not
counting the 15 harness builds; no `usedFallbackBuild` reference outside
comments and journals; `.metaproject` copies of the rule and the four edited
skills byte-identical to the bundled originals; `install.test.ts`,
`export-runtime-builds.test.ts`, `catalog-single-source.test.ts`,
`build-parity.test.ts`, `status-contract.test.ts` → 130 pass / 0 fail;
`routing-corpus.test.ts` → 181 pass / 0 fail; `route-tokens.test.ts` → 31 pass /
0 fail. No full-suite run started.

Routing audit: `graph_used: no (not-relevant — review of a known diff, no
discovery)`, `wiki_used: no (not-relevant)`, `ctx_used: yes`, `raw_rg_used: no`.
