# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review jev-triage --report <dir|findings.json> [--json]` exists, is advisory/annotate-only (never drops or demotes a finding on its own), and is gated on `review.jev.triage` in `.metaproject/tasks.config.json` plus a resolvable Jev/OpenRouter credential — both gates refuse before any read or network call, mirroring `review-jev-contract`'s `jevContractGateRefusal`.
- AC2: severity calibration asks exactly one Jev `noul` per blocker/major finding — "does this finding name a concrete trigger AND a concrete observable outcome?" (the orchestrator's own canonical severity boundary test) — and records `severity_check: {p, flagged}` per finding id, `flagged` meaning `p < 0.4`; no finding is ever auto-demoted.
- AC3: duplicate-merge candidate pairs are built deterministically — only among findings sharing a file, or with overlapping line ranges, or with overlapping quotes — never a full n² scan with no gate; one `noul` per pair ("same underlying defect at the same site?"), output as `merge_candidates` with `p`; nothing is ever silently merged.
- AC4: verifier queue order asks one `noul` per finding ("does the evidence plausibly follow from the quoted code?") and outputs `verify_order` sorted lowest-plausibility-first; this is prioritisation only and never skips verification of any finding.
- AC5: every claim/finding/quote/evidence string sent to Jev is redacted through `src/security/service.ts` first; Jev batches are capped at ≤40% of the 64k token budget and ≤3 items per batch, with a real vendor `max_tokens_exceeded` (HTTP 400) retried once, split in half, mirroring `src/commands/review-jev-contract.ts`'s `attemptBatch`/split logic; a `--max-calls`-style cap on total items is enforced and truncation is reported (`budget.itemsSkipped`), never silent.
- AC6: `review-orchestrator/SKILL.md` gains one compact line describing `jev-triage` running after the Sub-Agent Report Quality Gate and before Wave C, and stays at its recorded line-count ceiling (`skill-length-ceilings.ts`, currently 1723) — both the bundled copy and the `.metaproject/skills` copy stay byte-identical; `SKILL.detail.md` documents the flag, gating, and annotation shape in full.
- AC7: a `/triage` shell one-shot runs `jev-triage` against the latest review package in the current flow and prints its annotations, following the same one-shot (not modal) pattern as `/contract`/`/risk`.
- AC8: `docs/docs/cli-reference.md` (subcommand table + a `### review jev-triage` section), `HELP_GROUPS` (`src/standard/help-groups.ts`, both the `/triage` slash entry and any CLI listing needed), `docs/docs/commands-by-task.md` (regenerated via `scripts/generate-commands-by-task.ts`), and `keryx review` USAGE text are all updated and consistent with the shipped flags.
- AC9: hermetic tests cover the core batching/pairing/annotation logic (pure, no network) and the CLI adapter end-to-end via fixtures (`--fixtures`) and an injected `env` option for the Jev credential — no test reads `OPENROUTER_API_KEY`/the saved key from the machine; opt-in-off and no-credential paths are both covered; `bun run typecheck`, `bun run lint`, the related test files, and `bun ./scripts/opentui-tests-no-skips.ts src/tui` all pass.
- AC10: a live check runs `keryx review jev-triage` with `env -u OPENROUTER_API_KEY` (the saved OpenRouter key resolves instead) against an existing review package with blockers and majors in this repo (e.g. `.metaproject/flows/327-*/reviews/327-r01`), stays within roughly 40 Jev calls, never prints the credential, and its annotations (including a few hand-labelled by the operator) are reported in the flow journal/PR.
