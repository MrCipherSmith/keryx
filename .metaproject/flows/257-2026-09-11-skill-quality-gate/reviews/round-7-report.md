# Flow 257 review round 7 — verbatim report, closing round

Scope: one commit, `a13c0e8b`, closing round 6's minor finding. Branch
`skills/quality-gate` at `a13c0e8b913826b0691e07231f1ef1e036b62cbf`, the PR
head. Reviewer: one agent, review-only, no subagents. Instructed to read the
comment block as a hostile reader, because rounds 4, 5 and 6 each found an
overstatement or elision in it, and told plainly that an empty answer is the
expected one and not to manufacture a finding.

STATUS: DONE

## Claims checked

| claim in the comment / test name | verdict | how verified |
|---|---|---|
| `mkdir(..., {recursive:true})` follows the link and creates the skill directory INSIDE the target | true | Scratch experiment: the link target gained `brand-new-skill`; the physical `skillsRoot` still holds only the link, and the link was not replaced |
| "the copy never meets a non-directory destination" | true | `install.ts:83` mkdirs `skillDir` before the `cp` at `install.ts:94` |
| "it writes through the link, into someone else's tree" | true, if anything understated | Instrumented install: all 8 orchestration skill directories materialised in the target; `job-orchestrator/` gained `SKILL.md`, `orchestrator-prompt.md` and three schemas |
| "the install runs to completion on every platform" | true, and exercised | Passes locally on macOS; CI runs `ubuntu-latest`, the platform whose `ERR_FS_CP_DIR_TO_NON_DIR` is the whole reason for the note at `install.ts:86-93` |
| "Only the sweep refuses" | true | Exactly one `was not swept` warning, zero notices, zero removals; the hand-written `SKILL.zed.md` survives |
| The test name: the copy follows, the sweep refuses, the refusal reaches `warnings` | all three true | All three asserted in-test and reproduced out-of-test |

**Elisions: none that matter.** Nothing in the block overstates any more, and
the one thing it leaves out — that the whole category, not just
`job-orchestrator`, is re-created in the target — makes the pollution worse, not
milder, so it is not a softening.

**The new assertion is a genuine regression detector, not documentation.** A
mutant was constructed and run: `node:fs/promises.cp` patched to silently skip
when the destination's immediate parent is a symlink — "the copy stops following
the link", mirroring the sweep. Under that mutant the suite goes 30 pass / 1
fail, and the single failure is `src/gdskills/install.test.ts:388`, the new
`existsSync` line and nothing else. The `SKILL.zed.md`, `lstat`, warning and
notice assertions all stay green under the mutant, so that line is the only
guard on the copy-through-link half of the test name.

**Gates.** `bun test src/gdskills/install.test.ts` 31 pass / 0 fail;
`bunx tsc --noEmit -p .` exit 0; `bun run lint` exit 0;
`skills verify --bundled` exit 0; `diff -rq src/gdskills/bundled/rules/core
.metaproject/rules/core` exit 0, no output.

## Findings

**Nothing at or above minor.**

Taste only, no action asked:

- "the canonical build now sits in the target, not in `.metaproject`" is
  physically true, though the *path*
  `.metaproject/skills/gdskills/<category>/…` still resolves there through the
  link; the preceding "COPIED THROUGH the link" removes the ambiguity.
- Ten lines of comment for a twenty-line test — but each line is load-bearing
  after three rounds.

Routing audit: `graph_used: not-relevant` (single named file in scope),
`wiki_used: not-relevant`, `ctx_used: yes`, `raw_rg_used: no`.

## Findings

```json keryx:findings
[]
```
