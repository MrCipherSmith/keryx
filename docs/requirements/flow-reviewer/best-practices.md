# Flow Reviewer Best Practices
Version: 0.1.0

## Purpose

Record the external agent-orchestration practices applied to the Flow Reviewer
design and map them to Keryx-specific implementation decisions.

## Applied Practices

### Keep one manager responsible for the final result

Manager-style orchestration is appropriate when one component must retain
control, call bounded specialists, enforce shared guardrails, and combine their
outputs. Flow Reviewer follows this pattern: it owns lifecycle and final state,
while specialized reviewers remain bounded workers and Review Orchestrator owns
stateless review planning/consolidation.

Source: [OpenAI Agents SDK: Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/).

### Use code-controlled state for durable workflows

LLM planning remains useful for reviewer selection, but status transitions,
budget enforcement, retries, schema validation, and completion gates should be
deterministic code paths. Structured outputs are validated before they affect
Task Manager state.

Source: [OpenAI Agents SDK: Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/).

### Parallelize only independent work

Reviewer tasks run concurrently only when they do not depend on one another.
Planning, strict synthesis, and final consolidation remain ordered stages.
Multi-agent execution is not used merely to increase agent count: it is reserved
for review domains that can inspect bounded scope independently.

Sources:

- [OpenAI Agents SDK: Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [Anthropic Engineering: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

### Treat tokens as a planned resource

Multi-agent systems can consume substantially more tokens than single-agent
workflows. Flow Reviewer therefore selects only relevant reviewers, reserves a
total budget before dispatch, uses per-task limits, reuses unchanged accepted
results, and escalates model strength only for justified risk.

Source: [Anthropic Engineering: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

### Trace the workflow and each reviewer task

The review flow is the end-to-end trace; each reviewer task and attempt is a
child operation with timestamps, model assignment, context hash, result,
findings, and status events. Stable flow, task, dispatch, and attempt ids allow
cross-session diagnosis and resume.

Sources:

- [OpenAI Agents SDK: Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [OpenAI Agents SDK: Running agents](https://openai.github.io/openai-agents-python/running_agents/)

### Keep sensitive inputs out of traces and artifacts

Observability must not imply storing unrestricted prompts, tool inputs, secrets,
or unrelated source content. Flow Reviewer records compact summaries, hashes,
and controlled artifact references, with explicit redaction and permission
boundaries.

Source: [OpenAI Agents SDK: Tracing and sensitive data](https://openai.github.io/openai-agents-python/tracing/#sensitive-data).

### Reuse stable context without depending on one provider

Stable shared context can improve provider-side caching, but Keryx correctness
must not depend on a specific provider cache. Flow Reviewer uses deterministic
context hashes and artifact reuse first; provider prompt caching is an optional
optimization. Data-retention constraints must be evaluated before enabling
extended cache modes.

Sources:

- [OpenAI API: Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI API: Data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)

## Keryx-Specific Guardrails

- `gdgraph` selects structural scope before broad text search.
- `gdctx` creates compact diff, command, search, and read artifacts.
- `gdwiki` and accepted memory contribute only relevant durable knowledge.
- Existing testing and health artifacts are referenced instead of regenerated
  by every reviewer.
- Every worker message uses existing gdskills schemas.
- Task Manager remains the only flow/task state writer.
- Provider-specific model ids and cache features are detected at runtime and
  never hard-coded into the skill contract.
