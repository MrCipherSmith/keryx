# Plan

## Approach chosen: validate where keryx already writes

Follow the `job/store.ts` precedent rather than inventing a mechanism. That
function loads the schema THROUGH the registry (`loadSchema("job-orchestrator-state")`)
specifically so that removing the registration makes every write fail loudly
instead of letting the schema go quietly decorative again — its own comment says
that is the state an audit found it in. Copy the shape, not just the idea.

Concretely, for each unenforced contract, find the point where keryx itself
already handles the value and put the refusal there:

- **`review-pr-feedback-output`** — `keryx review ingest` already reads a report
  and writes a package. A `--report` carrying a `keryx:findings` block from this
  skill can be validated on the way in. This is the closest analogue to
  `writeJob` and the one to do first.
- **`task-implementer-input` / `-output`** — the same question, older: which
  keryx command, if any, ever holds these values.
- **`orchestrator-state`, `agent-event`** — likewise.
- **`flow-orchestrator-input`, `review-pr-feedback-input`** — these describe an
  agent-to-agent payload. Establish whether a keryx-owned path exists at all. If
  none does, the honest outcome is a stated limitation plus a guard, NOT a
  pretend enforcement.

## Rejected

**Route every dispatch through keryx's harness so the child-spawn validator
covers it.** It would work, and it is the wrong size: it changes how every
skill is dispatched in every runtime to close a validation gap. Out of scope
above, recorded here so the next reader knows it was considered.

**A pre-dispatch hook (`security hooks install` shape) that validates payloads.**
Plausible and cheaper than the above, but it enforces per-runtime and only where
installed, so the contract would be refused on one machine and not another. A
worse answer than a stated limitation, because it looks like a guarantee.

**Leave it and document.** Rejected as the whole answer, kept as the fallback
for the members where no keryx-owned path exists — with AC4 making the split
explicit rather than silent.

## Risk

The failure mode to avoid is the one this flow is about: writing a refusal that
does not refuse. Every AC below is verified by RUNNING a rejecting payload
through the real path, never by reading the code — the same discipline that
found all five majors in #424.
