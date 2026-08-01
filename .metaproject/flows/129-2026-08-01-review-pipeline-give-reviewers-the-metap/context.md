# Context

Collected deterministically by `keryx flow init` at 2026-08-01T15:27:59.690Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [draft/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-01T13:35:31.492Z)
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

## Agent Findings

Note the irony recorded by the "Related Memory" block above: `keryx flow init`
collected four relevant memory entries automatically, including the very lesson
this flow exists because of. **The review pipeline performs no equivalent step.**
That contrast is the shortest statement of the problem — flow-init already does
what review does not.

### Files this flow changes

| File | What it owns | Change |
|---|---|---|
| `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-input.schema.json` | What a dispatched reviewer receives (105 lines) | add `prior_findings`, `metaproject` |
| `.../review-orchestrator/review-context.schema.json` | The shared Context Pack (333 lines) | add `memory` block |
| `.../review-orchestrator/reviewer-finding.schema.json` | The shape of one finding | add `class_scope`, conditional on `severity` |
| `.../review-orchestrator/SKILL.md` | Context Pack §127-144, budget §164-184, `keryx review` §97-101, scope detection | memory sub-step, fix-round scope rule, mandatory start/ingest |
| `.../review/<15 skills>/SKILL.md` | Per-domain checklists and finding format | finding format only |
| `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-….md` | The lesson | `draft` → `accepted` |

### Verified during formalization — do NOT re-derive

- `reviewer-input.schema.json` has no prior-findings field. Confirmed by reading
  all 105 lines: `review_context`, `reviewer`, `scope_mode`, `context_doc`,
  `issue_url`, `model_class`, `budget`, `branch`, `base_sha`, `diff`,
  `target_path`, `file_contents`. `additionalProperties: true`, so a field can be
  added without breaking an existing producer.
- No reviewer skill and no orchestrator step references `.metaproject/memory`.
  Grep over all 15 skills plus the 831-line orchestrator returns four matches,
  all of them memory-leak checklist items in `review-frontend`,
  `review-highload`, `review-performance` and `review-strict`.
- `.metaproject/data/reviews/` **does not exist**. Eleven review rounds across
  flows 127 and 128 produced no managed-review package.
- `keryx review start|ingest` accept `--target <pr|issue|branch|path|report>`
  and `--ref <ref>`; `keryx review status` takes a review id or path. Probed
  directly. Runtime behaviour beyond argument parsing is unproven in this repo —
  see the plan's third risk.
- `keryx memory search "<q>" --status accepted` works and writes both a markdown
  and a JSON artifact under `.metaproject/data/memory/artifacts/`, so the
  orchestrator can consume the JSON rather than parsing prose.
- The flow-128 lesson is `Status: draft`, which is why AC8 exists: AC2's filter
  is `--status accepted`, so without promotion the one lesson that matters would
  be filtered out by the mechanism this flow adds.

### Lessons applied

`a-fix-round-needs-its-own-review-…` §"How to apply" is this flow's working
rules, and the flow is unusually exposed to them because **its own main task is a
15-member sweep** — the exact per-site shape the lesson is about. Hence T8 before
T9: the guard is written first, derives its list from the filesystem, and stays
red until every member is done.

`allowlist-not-a-boundary` applies to AC3: the `class_scope` requirement must be
enforced by schema validation, not by a sentence in a skill asking reviewers to
please include it. A rule that lives only in prose is matched against nothing.

### Host constraint

ripgrep is not installed on this host; `keryx ctx rg` exits 127. Searches use
`grep` with the `# keryx:raw ripgrep not installed on this host` escape marker
required by the gdctx PreToolUse hook.
