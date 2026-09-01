# Context

Collected deterministically by `keryx flow init` at 2026-08-31T23:32:32.528Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] Theme switch repaints already-rendered chrome via old-slot value matching - `.metaproject/memory/lessons/theme-switch-repaint.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-22T15:31:16.004Z)
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
- mcp

## Agent Findings

_(flow-init skill appends here)_

## Established facts (enumerated, not recalled)

Method: for each of the eleven names in `CONTRACTS`, search for the quoted name
across `.ts` files excluding tests and `contracts.ts` itself. Four names appear;
seven do not. The table is in `description.md`.

The enforcement precedent to copy — `src/job/store.ts:70-93`:

    const schema = (await loadSchema("job-orchestrator-state")) as Record<string, unknown>;
    const result = validateAgainstSchemaObject(schema, state);
    if (!result.valid) throw new Error(`Refusing to write … it does not validate against …`);

Note it loads through the registry rather than by path, and its comment says
why: "if the registration is removed this throws and every `job` write fails
loudly, instead of the schema quietly becoming decorative again — which is the
state the audit found it in."

## The claim phrasings that need reconciling (AC5)

Introduced by PR #424 and now unbacked at the points they describe:

- `review-pr-feedback/SKILL.md` Step 9: "a registered contract, so
  `keryx skills contracts validate … --schema flow-orchestrator-input` refuses a
  malformed one. Validate before dispatching."
- `flow-orchestrator/SKILL.md`: the same instruction before the constraint table.
- `review-pr-feedback/SKILL.md`: "a dispatch without it is refused by the schema".

Each is TRUE of the command and FALSE of the path, because nothing runs the
command unless the agent does. That distinction is what AC5 exists to make
visible in the text.

## Prior art in this repository

- `src/gdskills/enforcement-claims.test.ts` — exists because a skill claimed
  "the schema rejects the dispatch otherwise" for `reviewer-input`, which no code
  could do. Its guard pins both the removal AND the reason, so the prose cannot
  drift back. This flow's AC3/AC5 follow that construction.
- `src/gdskills/contracts.ts`, the `task-implementer` registration comment: the
  same gap, recorded in 2026 and still open — five `ASSERT … → ABORT(…)` refusals
  in a skill that nothing could perform.
- `src/gdskills/installed-registry-integrity.test.ts` — the derive-from-CONTRACTS
  guard shape AC4 should follow.

## Where this came from

Round 4 of the review on PR #424 (merged `bfaf3b16`), finding `SEC F-107`. The
reviewer stated it as "nothing validates the output in production", which is
broader than the truth — `src/review/managed.ts` does validate, and its refusal
is what rejected that review's own ingest. The narrower, verified version is the
table in `description.md`.
