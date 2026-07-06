# gdskills: orchestrator and subagent contracts

Version: 0.2.0

## 1. Decision

Metaproject should use a schema-first protocol for communication between orchestrators and subagents.

The selected approach is based on the strongest parts of the `goodai-base` pattern:

- JSON Schema input/output contracts for orchestrators and skills;
- persisted orchestrator state;
- explicit context construction for every subagent dispatch;
- machine-readable subagent statuses;
- structured review findings;
- artifacts passed by path/reference instead of copying large content into prompts.

Metaproject must not depend on `goodai-base`; the protocol is implemented as native `gd-metapro` contracts.

## 2. Validation

The approach is valid and should be adopted because it prevents common multi-agent failures:

- free-text responses that hide blockers;
- subagents guessing missing context;
- orchestrators parsing natural language for status;
- duplicated or inconsistent finding formats;
- context blowups from passing entire histories;
- inability to resume orchestrations after interruption.

No better lightweight alternative was identified for this project. Fully custom binary protocols or event buses are unnecessary for MVP. Plain Markdown alone is too ambiguous. Function-call-only protocols are too runtime-specific. JSON Schema gives us a portable contract across Codex, Claude, CLI and future MCP runtimes.

## 3. Standard

All orchestrator/subagent communication must use these contract layers:

| Contract | Direction | Purpose |
|---|---|---|
| `subagent-dispatch` | orchestrator -> subagent | Task, acceptance criteria, context refs, files to read, constraints, output contract. |
| `subagent-result` | subagent -> orchestrator | Status, summary, artifacts, changed files, findings, questions, errors, metrics. |
| `orchestrator-state` | persisted | Resume state, phase, plan, dependencies, artifacts, metrics. |
| `review-finding` | reviewer -> review-orchestrator | Normalized review finding with severity, evidence, confidence and fix. |
| `agent-event` | append-only log | Lifecycle events for observability and debugging. |

Human-readable Markdown may be included as `summary_markdown`, but it must not be the only contract between agents.

## 4. Status Model

All subagent results use:

- `DONE` - all acceptance criteria met;
- `DONE_WITH_CONCERNS` - task completed, but orchestrator must consider concerns;
- `NEEDS_CONTEXT` - specific missing information is required;
- `BLOCKED` - cannot continue without orchestrator or user decision;
- `FAILED` - execution failed after allowed self-fix attempts.

The first machine-readable field is `status`. If a runtime requires Markdown output, the first line should also be:

```text
STATUS: <STATUS>
```

## 5. Dispatch Requirements

Every subagent dispatch must include:

- `task`;
- `acceptance_criteria`;
- `context_refs`;
- `files_to_read`;
- `constraints`;
- `allowed_actions`;
- `output_contract`;
- `budget`;
- `provenance`.

Subagents must not rely on inherited chat history. Orchestrators construct the context explicitly.

## 6. Artifact Policy

Large artifacts are passed by reference:

```json
{
  "path": ".metaproject/data/gdctx/artifacts/latest.md",
  "kind": "context",
  "exists": true,
  "summary": "Compact context for init and gdskills changes"
}
```

Raw logs and large outputs stay in `.metaproject/data/*/raw` or `.metaproject/data/*/artifacts`. Subagent prompts receive only summaries and paths unless the content is small and essential.

## 7. Runtime Storage

Recommended storage:

```text
.metaproject/
  core/
    gdskills/
      contracts/
        subagent-dispatch.schema.json
        subagent-result.schema.json
        orchestrator-state.schema.json
        review-finding.schema.json
        agent-event.schema.json
  data/
    gdskills/
      runs/
        <run-id>/
          state.json
          events.jsonl
          dispatches/
          results/
          artifacts/
```

## 8. Integration Rules

Use these contracts in:

- `job-orchestrator`;
- `review-orchestrator`;
- `context-collector`;
- `task-implementer`;
- `code-verifier`;
- `feature-analyzer`;
- `entity-skill-verifier`;
- `entity-skill-learner`;
- future `gdwiki`, Code Health and Documentation Memory orchestrations.

Any new orchestrator must define:

- input contract;
- output contract;
- state contract if resumable;
- event contract if it dispatches subagents;
- validation command or validation step.

## 9. MVP Implementation

MVP should ship native JSON Schema files in `src/gdskills/contracts/` and install/copy them into `.metaproject/core/gdskills/contracts/` when `gdskills` is enabled.

CLI validation:

```bash
gd-metapro skills contracts validate <file> --schema subagent-result
```

Supported MVP commands:

```bash
gd-metapro skills contracts list
gd-metapro skills contracts validate <file> --schema agent-event
gd-metapro skills contracts validate <file> --schema orchestrator-state
gd-metapro skills contracts validate <file> --schema review-finding
gd-metapro skills contracts validate <file> --schema subagent-dispatch
gd-metapro skills contracts validate <file> --schema subagent-result
```

The validator is intentionally lightweight and covers the schema features used by native Metaproject contracts: required fields, object/array/string/integer/boolean/null types, enum, additionalProperties, array items, local `$defs` refs, file refs, minimum, minLength and pattern.
