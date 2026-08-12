# Context

Collected deterministically by `keryx flow init` at 2026-08-12T08:15:46.671Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

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

### Existing boundaries

- `src/sac/fwk-service.ts` writes metadata-only AccessReceipts linked to the
  canonical Context Operations trace/configuration revision and policy
  revision. Records carry `recordHash` and `previousRecordHash`.
- Receipt append currently trusts the stored chain head. There is no reusable
  full-chain recomputation/continuity check, and the TypeScript type for
  `previousRecordHash` is narrower than its schema.
- `src/ctx/assembly.ts` is the deterministic bounded-selection baseline and
  remains authoritative.
- `src/harness/completion/gate.ts` is the nearest independent task-outcome
  evidence source; a corpus outcome must bind a resolvable immutable artifact
  digest/revision rather than reuse `AccessReceipt.outcome`.
- `src/harness/process/sandbox` provides the existing fail-closed OS containment
  seam. Phase 5 consumes its read-only/network-off contract rather than
  creating a parallel sandbox.
- `src/security/eval/harness.ts` demonstrates stable corpus ordering and pure
  gates, but its binary detector contract is too narrow for SAC outcomes.
- Capability seams already model default-off deterministic fallback.

### Phase status and gaps

- Phases 0–4 are implemented in this branch. Phase 5 has no runtime surface.
- Missing pieces are receipt verification, independent outcomes, corpus rows,
  manifest/quarantine/splits, candidate-baseline evaluation, exact activation
  pins, kill switch and rollback.
- Synthetic fixtures can prove the mechanism and published gates; they are not
  evidence that a production learned policy is better.

### Privacy and integrity constraints

- Corpus rows use explicit allowlisted fields. Actor/workspace identifiers are
  corpus-scoped pseudonyms; raw paths, correlation/session identifiers,
  prompts, transcripts, reasoning, secrets, PII and content are absent.
- Invalid hash chains, missing/digest-mismatched independent outcomes, unknown
  revisions, duplicates, redaction uncertainty and split leakage enter
  quarantine and cannot participate in training or evaluation.
- A local hash chain proves internal continuity only after verification; it is
  not an external signature or trusted timestamp.

### Baseline quality context

- Testing framework: Bun, co-located `*.test.ts`; test-first red/green/refactor
  is required.
- Initial changed-test selection was empty because only the Flow package
  existed.
- Initial Code Health score was 93/WARN; the TypeScript health source was
  unavailable and must be supplemented by explicit `bun run typecheck`.
- Accepted memory warns that the installed `keryx` executable may be stale;
  repository behavior is verified with Bun commands while Flow state continues
  through the CLI-owned interface.

### Initialization workers

- Context collector: `DONE_WITH_CONCERNS`; highlighted the absence of protected
  receipt checkpoints and required paired sandbox allow/deny controls.
- Feature analyzer: `DONE`; mapped AC-12 to receipt integrity, independent
  outcomes, corpus/evaluation, activation and rollback modules.
- Architecture comparison: chose the narrow declarative candidate + host-side
  validator design over embedding learned behavior into the security policy
  engine or adding a second execution path.
