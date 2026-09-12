# Rejected skill changes

## Purpose
An append-only record of changes to keryx's own bundled skills
(`src/gdskills/bundled/skills/**`) and rules (`src/gdskills/bundled/rules/**`)
that were tried and rejected, with the evidence that sank them. The idea is
adapted (MIT) from the rejected-change ledger in
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills). Its
purpose is to stop the same rejected idea from being re-proposed blindly —
before authoring a change to a shipped skill, search this ledger for that
skill and that idea.

This file lives in `docs/` (not `.metaproject/`) because `.metaproject/`
inside this repository is keryx's own install mirror, and `docs/` is not
part of the npm-published `files` in `package.json` — this ledger is
contributor-facing history for keryx's own skill authoring, not something
that installs into a user's project.

## Append-only rule
Never edit or delete an existing row. When a proposed change to a shipped
skill or rule is rejected (by review, by a routing/behaviour-eval
regression, or by explicit user/maintainer decision), add a new row in the
same change that records the rejection. This file lives on the default
branch (`main`) so its rows survive the rejected PR's branch being deleted.

## Ledger

| date | skill | change tried | why rejected | evidence (before → after) | link |
|---|---|---|---|---|---|
| 2026-09-12 | `review/review-orchestrator` | Add the domain flags (`review --frontend`, `--backend`, `--architecture`, `--security`, `--performance`, `--style`) to its `triggers`, on the argument that the orchestrator owns flag-form requests. | The router strips `--` before matching (`normalizeRouteText`, `src/lib/route-tokens.ts`), so each flag's order-free token set is identical to the `<domain> review` trigger the specialist already owns. Two skills may not share a trigger token set. | `review --frontend` → key `frontend review`, already claimed by `review-frontend` → `catalog-single-source.test.ts` "no two skills share a trigger phrase" fails. | flow 257, T22 |
| 2026-09-12 | `review/review-orchestrator` | Put the six domain flag names into the `description` prose instead, so the orchestrator outranks the specialist on a flag-form request. | Measured routing regression. The description is scored as haystack tokens, so every domain word added is +10 to the orchestrator on any query containing it — and `review-security-code` has no `exact skill`/`skill name` bonus to absorb it. | `review --security`: review-security-code 75 vs review-orchestrator 65 → 75 vs **75**, decided by the alphabetical tie-break in favour of `review-orchestrator`. The same tie takes plain `security review` (75 → 75) away from the security reviewer. | flow 257, T22 |
| 2026-09-12 | `review/*` specialists | Give each specialist its own flag as an extra trigger (`review-style` gains `review --style`, etc.). | A literal no-op. The flag normalizes to the same token set as the `<domain> review` trigger the skill already carries, so nothing scores differently; it only adds a line to keep in sync. | `review --style` → key `review style`; `review-style` already scores 205 on it via the existing `style review` trigger, before → after identical. | flow 257, T22 |
| 2026-09-12 | `planning/{project-discovery,problem-definer,patterns-researcher,planner,consistency-checker,spec-writer,stack-advisor}` | Delete the 14 `SKILL.codex.md`/`SKILL.cursor.md` builds, which differ from their `SKILL.md` by one line, to satisfy "never as an identical copy". | The differing line is `metadata.compatible_harnesses: "cursor,codex,zed,opencode"`, the one field in the tree whose correct value is per-build. Deleting the builds would hand the four non-Claude harnesses a `SKILL.md` that declares no harness list at all, losing the only fact those builds exist to carry. | `diff SKILL.md SKILL.codex.md` = one added `compatible_harnesses` line, ×14; `build-parity.test.ts`'s `HARNESS_FAMILY_DECLARATION` allowance already exempts exactly this hunk for exactly these seven skills. Resolved by stating the case in `rules/core/skills-storage-workflow.mdc` instead. | flow 257, T22 |
