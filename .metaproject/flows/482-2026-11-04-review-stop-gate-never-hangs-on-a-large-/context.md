# Context

Collected deterministically by `keryx flow init` at 2026-11-04T07:16:57.685Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.728] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review (constraint/accepted) - constraints/stale-installed-keryx-binary.md
   `~/.local/bin/keryx` is an installed build, and its version lags the working tree. It is NOT the working tree. Every `keryx …` invocation — including `keryx review ingest`, which is how a managed review package is recorded — runs that build, so the review pipeline routinely does not exercise the code being reviewed.
   claimType: constraint | confidence: high | version: 0.1.0
   scope: module:review, memory, entity:managed-review-package
   provenance: source=fix-round review of PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/220 author=unknown confirmedBy=unknown
2. [1.728] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
3. [1.712] gdctx-flag-allowlist-no-bundle-expansion (known-mistake/accepted) - known-mistakes/gdctx-flag-allowlist-no-bundle-expansion.md
   A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, ripgrep, flag-parsing, entity:buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3) author=unknown confirmedBy=Reproduced this session via `keryx ctx rg -il "todo" src`
4. [1.684] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
5. [1.684] gdctx-stem-classifier-misreads-stdout (known-mistake/accepted) - known-mistakes/gdctx-stem-classifier-misreads-stdout.md
   A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:ctx, classification, output-analysis, entity:classifyLine, importantLines, compactLines, FAILURE_STEMS
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1) author=unknown confirmedBy=Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`

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
- mcp

## Agent Findings

### Incident evidence (2026-11-04)

- Session `f732e03c-fc8e-4cf5-84d8-3eb489ac6706` (keryx 0.4.8, openai-codex/gpt-6.1-terra), PR #1125 review. Final
  replies at 05:49:45Z, 06:04:32Z and 06:39:37Z were persisted, then the turn never ended (bus: `working / streaming`).
  The provider is not the cause: `openai-provider.ts:1063` stops reading at `response.completed`, and the reply was
  already in the transcript.
- The 05:45:42Z reply did not hang: plan follow-through `continue`d before the gate (`agent.ts:4244-4268`). Every later
  stop had a `blocked` plan item, so it reached `holdReviewGate()` (`agent.ts:4274`).
- Live PID 46897: `sample` — Bun pool threads in `__openat_nocancel`, main thread idle in `kevent64`; `lsof` loop caught
  `.metaproject/data/review/mutate-scratch/keryx-mutate-AS0xE6/tree/.claude/worktrees/pr803/...` open.
- `.metaproject/data/review` was 5.8 GB, all of it `mutate-scratch/keryx-mutate-{AS0xE6,STSp3q}` from 2026-10-29
  (287 188 files). After `rm -rf mutate-scratch` the session resumed at 07:10:54Z.
- Checkout composition (files, excluding `.git`/`node_modules`): `.claude/worktrees` 227 555, `.worktrees` 24 650,
  `.metaproject/data` 13 312, `.metaproject/flows` 7 607, `src` 4 348.

### Code

- `src/review/completion-gate.ts:58` `dirSignature` — recursive, sequential, content hash; `:720` signs
  `<root>/.metaproject/data/review`; `:734` signs the package dir; `MAX_HASHED_FILES = 4096` at `:28`.
- `src/commands/agent.ts:3528` `holdReviewGate` — no signal passed; call sites `:4274` (text-only stop) and `:4837`
  (no-progress stop). Turn signal: `const signal = options.signal` / `isAborted()` at `:3219-3220`.
- `src/review/mutate.ts:82` `SCRATCH_DIR`; `:217` `copyTree` skips only `.git`/`node_modules` and the scratch dirs;
  `:276-281` scratch base + `mkdtemp("keryx-mutate-")`; cleanup only on normal exit and SIGINT/SIGTERM.
- Tests: `src/review/completion-gate.test.ts`, `src/commands/agent-review-gate.test.ts`, `src/review/mutate.test.ts`.
- Docs: `src/commands/review.ts:5085` (help), `docs/docs/guides/review-with-a-record.md:195`.

### Related, out of scope

- After `keryx shell -c` the gate nudged toward PR #1124's package: the resumed history (`context.jsonl`) keeps only
  `keryx review ledger build --help` (runSeen) and no command naming the #1125 package, so `pickPackage` fell back to
  the newest open candidate.
