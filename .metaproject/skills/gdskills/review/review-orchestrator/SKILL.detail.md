# Review Orchestrator — detail

Overflow reference for `review/review-orchestrator`, linked from its SKILL.md.
Read the section SKILL.md points you to; nothing here overrides SKILL.md.

## Project-local reviewers

`keryx review reviewers --json` returns every project-skill under module
`review`. The routing tables in SKILL.md cannot name a project reviewer's
triggers, so each `project` entry carries its own. Use them; do not re-derive
them from the reviewer's prose.

### Selecting project reviewers — the same two filters, from the inventory

| Field | Use |
|---|---|
| `flags` | A flag the user passed that is in this list selects the reviewer **explicitly** — it is then never path-gated, like any flag-selected reviewer. `--all` selects every project reviewer. |
| `paths` | Its path triggers for the **path gate**. No file in scope A matches → `Skipped reviewers`, reason `no-matching-paths`. |
| `pathsSource` | `metadata` (declared `metadata.paths`) or `description` (globs read out of its description). `none` means there is nothing to gate on: **dispatch it** — ambiguity includes. |
| `stackRequires` | Apply stack scoping exactly as for a bundled reviewer carrying `metadata.stack_requires`. |
| `unresolvedRules` | Rules it cites that the project does not have. Dispatch it anyway, tell it in the prompt which rules are absent, and name them once in the report with the fix (`keryx review import --from <overlay>` copies them). Never a finding against the code. |

A description saying another entry point dispatches it ("Dispatched by
vantage-review …") is its author's routing note, not a restriction: this
orchestrator dispatches it through the fields above.

### `drift` — the source moved, the reviewer did not

A project reviewer built from an external file — a rules file, a review profile,
a conventions doc — records where it came from and the hash of that file at
import. `keryx review reviewers` re-reads the source and reports:

| `drift` | Meaning | What to do this round |
|---|---|---|
| `none` | No external source; written here | Nothing |
| `clean` | Source matches the import | Nothing |
| `changed` | Source has moved on since import | Dispatch it, and say so in the report |
| `missing` | Source can no longer be read | Dispatch it, and say so in the report |

**A drifted reviewer still runs.** It is a reviewer built from an older version
of its source, which is a fact about provenance, not a defect in its findings —
suppressing it would trade real coverage for tidiness. Record the drift in
`review_context` and name it once in the report, so the next person knows the
profile is due a re-read. Never file it as a finding against the code under
review: it is a fact about the review, not about the diff.

## CLI-engine reviewers — dispatched as a command, not a sub-agent

`review-jev-docs` and `review-jev-comments` (flow 333) are ADDITIONAL
reviewers, never replacing any other, and their dispatch mechanism differs
from every reviewer named in SKILL.md's own Wave B line above: there is no
platform-native agent to invoke, because each is a deterministic **keryx
program**. Run `keryx review jev-docs (--diff <ref>|--pr <n>) --json` and
`keryx review jev-comments --pr <n> --repo <owner/repo> --json` — the same
diff/PR target every other reviewer's dispatch already checks. Read each
`--json` output as a `REVIEW_RESULT` and merge its `findings` into the
consolidated array exactly like a sub-agent reviewer's: same Sub-Agent
Report Quality Gate, same dedup, same Wave C verification.

Gate each BEFORE running its command, not after: skip it — recorded in
`Skipped reviewers` with the reason, never silently absent — when its own
opt-in (`review.jev.docs`/`review.jev.comments`) is not `true` in
`.metaproject/tasks.config.json`, or when no Jev/OpenRouter credential is
resolvable. Either gate failing means the command itself would refuse before
any read or network call, so checking first saves a doomed dispatch.
`review-jev-comments` additionally needs a comment ledger to already exist
(`keryx review comments collect` run first) — it refuses, before any read,
when there is none.

`keryx review reviewers --json` marks a CLI-engine reviewer with `"engine":
"jev"` on its `bundled` entry — the field's presence, not its absence, is
what distinguishes it from the default (an LLM sub-agent dispatch). The same
pattern applies to `review-jev-rules` (flow 330, when present) and to any
future engine-backed reviewer: gate on its own opt-in and reachability,
dispatch as a command, merge its `--json` output the same way.
