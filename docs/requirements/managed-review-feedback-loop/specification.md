# Managed Review Feedback Loop Specification
Version: 0.2.0

## Identity

- Capability name: Managed Review Feedback Loop.
- Runtime owner: `src/review` and `keryx review` persistence commands.
- Target orchestration skill: `gdskills/review/flow-reviewer`.
- Stateless review engine: `gdskills/review/review-orchestrator`.
- Supporting skills: `flow-orchestrator`, `job-orchestrator`,
  `entity-skill-learner`, `docpack-review`.
- Supporting modules: `tasks`, `gdskills`, `gdctx`, `memory`, `health`.
- Status: first runtime slice implemented.

## Planned Storage Structure

When attached to an existing flow:

```text
.metaproject/flows/<flow-dir>/reviews/<review-id>/
  manifest.json
  scope.md
  coverage.md
  report.md
  findings.json
  learning.md
  decisions.md
```

When standalone:

```text
.metaproject/reviews/<review-id>/
  manifest.json
  scope.md
  coverage.md
  report.md
  findings.json
  learning.md
  decisions.md
```

The `manifest.json` file must follow
[schemas/managed-review-package.schema.json](schemas/managed-review-package.schema.json).

## Planned CLI and Skill Surface

The exact CLI names are implementation choices, but the capability needs these
user-level operations:

| Operation | Purpose |
|---|---|
| `review attach` | Attach a review package to an existing flow. |
| `review start` | Create a standalone managed review package. |
| `review ingest` | Ingest an existing review report and classify findings. |
| `review status` | Show review package status, coverage, and unresolved decisions. |
| `review complete` | Mark managed review decisions as recorded. |

The existing skill surface supports equivalent behavior for compatibility. The
target `flow-reviewer` contract is defined in the
[Flow Reviewer requirements package](../flow-reviewer/README.md):

```json
{
  "mode": "lightweight | attach-review | review-flow | ingest",
  "target": "pr | issue | branch | path",
  "target_ref": "<url-or-path-or-branch>",
  "flow_id": "<optional-flow-id>",
  "reviewers": ["review-logic", "review-testing-practices"],
  "context_mode": "none | light | full"
}
```

## Flow Detection

The managed review caller, and ultimately `flow-reviewer`, must try to resolve a
related flow from:

1. explicit `flow_id`;
2. PR URL stored in `.metaproject/flows/*/flow.json.pr.url`;
3. issue URL stored in `.metaproject/flows/*/flow.json.source.ref`;
4. branch or PR metadata available from the review context;
5. user-selected flow when multiple candidates match.

If no match is found, the reviewer may continue in lightweight mode or create a
standalone managed review package when requested.

## Review Package Documents

### `scope.md`

Records target, PR/issue/branch/path, base/head, changed files, context mode,
and any token-budget omissions.

### `coverage.md`

Records selected and skipped reviewers:

```text
reviewer: review-testing-practices
status: run | skipped | failed | needs_context
reason: <why>
```

### `report.md`

Contains the consolidated human-readable review report sorted by severity.

### `findings.json`

Contains normalized findings compatible with existing review-finding concepts:

```json
{
  "id": "F-001",
  "severity": "minor",
  "reviewer": "review-testing-practices",
  "file": "src/example.test.ts",
  "line": 42,
  "summary": "Missing regression test",
  "classification": "skill_learning_candidate",
  "flow_relevance": "post_flow_feedback"
}
```

### `learning.md`

Contains an explicit `Skill Learning` decision:

```markdown
## Skill Learning

- `pipelines/pipeline-runner-store` <- F-001, F-004: add checklist for
  runPipeline/runStep parity and synthetic task id handling.
```

If no learning applies:

```markdown
## Skill Learning

- none
```

### `decisions.md`

Records decisions for each finding:

- fix now;
- create follow-up task;
- learn/update skill;
- accept risk;
- discard with reason.

## Data Contracts

The managed review package manifest schema is
[schemas/managed-review-package.schema.json](schemas/managed-review-package.schema.json).

The implementation should reuse existing `review-finding`,
`subagent-dispatch`, and `subagent-result` contracts where possible instead of
introducing incompatible reviewer payloads.

## Integrations

### `flow-orchestrator`

Before completing a flow, `flow-orchestrator` should require a review coverage
record or explicitly record why managed review was skipped. It should not
silently treat one narrow reviewer as full review coverage.

### `review-orchestrator`

`review-orchestrator` owns stateless reviewer selection and report
consolidation. `flow-reviewer` owns managed review flow creation, per-reviewer
tasks and history, package lifecycle, and post-flow decisions. Existing
`review-orchestrator` managed modes are transitional compatibility behavior.

### `entity-skill-learner`

Learning candidates from `learning.md` feed proposal generation. Applying a
proposal remains a separate read-and-approve step.

### `memory`

Accepted process lessons may be ingested into memory after review decisions are
approved. Draft or disputed findings must not influence future work as accepted
memory.

### `health`

When reviewing a PR, managed review may reference latest health artifacts but
must not claim checks are green unless health or CI evidence exists.

## Acceptance Criteria

- AC1: A managed review can attach to an existing flow by PR URL or explicit
  flow id.
- AC2: A managed review writes `manifest.json`, `scope.md`, `coverage.md`,
  `report.md`, `findings.json`, `learning.md`, and `decisions.md`.
- AC3: The coverage document records every selected, skipped, failed, or
  context-starved reviewer with a reason.
- AC4: The learning document is always present and includes either candidates
  or `none`.
- AC5: Post-flow findings are classified before the review package is completed.
- AC6: Lightweight review mode remains available without writing flow artifacts.
- AC7: Documentation and runtime tests prove managed review does not mutate
  `flow.json` directly.
- AC8: Target orchestration ownership and migration are documented by the
  `flow-reviewer` package without overstating current implementation.
