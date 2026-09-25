# Implementation Plan

Status: active

## Approach

Five independent pack directories, one per stack, authored in parallel by
five sonnet subagent workers against a shared brief (mirrors flow 314's
batch-1 pattern, adapted for the judge-based eval format flow 316/317
delivered). The orchestrator (this session) owns everything cross-cutting:
`STACK_EXTENSIONS`, `install-manifest.json`, calibration recording, the
honest gate run, stability promotion, agent generation, and docs.

Workers never commit, never touch `install-manifest.json` or another pack's
directory, and never run the honest gate themselves (that must be one clean
run per skill, from an unmodified tree, done once by the orchestrator so
`eval.json` is built verbatim from raw output — same discipline as flow
316/317's T13/T23 runs).

## Steps

1. `STACK_EXTENSIONS` extended (done, first commit of this flow).
2. Dispatch 5 parallel pack workers (T2a-T2e), each authoring one pack:
   `pack.json`, `agent-refs.json` (`{"agents": []}` placeholder),
   `rules/*.mdc` (coding-style/patterns/security/testing), and
   `skills/<name>/{SKILL.md,evals.json}` per the pack's skill list. Each
   worker runs its own self-checks (trigger accuracy via `skills eval
   <id>/<name> --json` with no runner, the authoring lint, `skills scout
   --record`) before replying.
3. Orchestrator commits each pack directory at its own task boundary, runs
   `git checkout -- .metaproject/data/gdgraph` after each.
4. Orchestrator extends `install-manifest.json`: new `<id>-rules`/
   `<id>-skills` modules for all five packs; extends the pre-existing
   `framework:nestjs` and `capability:mobx` components' module lists (does
   not duplicate `review-backend`/`nestjs-dto.mdc`/`code-mobx-store-review`/
   `mobx-store-template.mdc`); adds new `framework:vue`,
   `framework:angular`, `framework:nextjs-nuxt` components; adds/extends
   profiles `vue`, `angular`, `nextjs-nuxt` (and confirms `nestjs`'s existing
   profile now also installs the new stack-pack modules). Runs the
   pack.json↔install-manifest stability guard test.
5. Calibration: `skills judge-check <pack>/<skill> --judge
   deepseek:deepseek-chat --scope bundled --samples 3 --record` for every
   new judge scenario, iterating on the *scenario* (never `SKILL.md`) until
   every AG check is green, logging each change made.
6. Honest gate: one clean CLI run per new skill, HEAD unchanged start to
   end: `skills eval --scope bundled --runner deepseek:deepseek-chat --judge
   deepseek:deepseek-chat --strictness high --trials 10 --json`.
   `governance/eval.json` built verbatim from the raw outputs, no editing
   mid-run.
7. Stability decision per pack: `stability: stable` + `agents generate
   --stack <id>` only for a pack whose every skill report clears
   `checkStablePackGate`; every other pack stays `experimental` with the
   specific failing scenario/passRate recorded in the journal and
   `agent-refs.json`.
8. Docs: W1 "Implementation notes: Wave 4 batch 2 (flow 318)" section (packs
   authored, honest gate results per pack, stack coverage count — following
   the exact style of the batch-1/316/317 sections already in the file), W2
   status/coverage if agent pairs were generated, CLI reference if the CLI
   surface changed (it should not — no new commands), ACs confirmed.
9. PR against `feat/agent-platform-expansion`, adversarial opus review loop
   (threshold minor, ≤3 attempts, owner standing rule: 0 blocker + 0 major
   after 3 attempts or a narrow verification round = merge, remaining minors
   deferred to the owner), CI green, merge, flow close.

## Risks

- `extends` on `nextjs-nuxt` naming two packs (`react`, `vue`) is not a
  pattern any existing pack.json uses (all current `extends` values are a
  single string) and the field is not schema-typed. Decision: allow an array
  `["react", "vue"]`; record this as a deliberate content decision, not a
  schema change, since nothing currently parses `extends` as a hard
  dependency graph (module deps are wired via `install-manifest.json`
  `dependencies`, which is a real, checked field the orchestrator sets
  explicitly per module rather than trusting `pack.json`'s own `extends`).
- `mobx`'s pack risks a `scout` "use"/"fork" verdict against the existing
  `code-mobx-store-review` skill for anything review-shaped — the worker
  brief instructs the mobx worker to favor an `implement`-focused skill (and
  possibly `test`) and to leave `review: []` in `pack.json` with a note if
  scout finds high overlap, rather than duplicate coverage.
- DeepSeek honest-gate cost/time: 5 packs × ~4-5 skills × ~2 scenarios ×
  10 trials is a real spend; run scope is `bundled` only, and the runner
  brief's owner rules (minor threshold, ≤3 review attempts) bound the
  fix-loop cost on top of it.
- A pack may legitimately fail the gate (batch 1's own precedent: 2 of 4
  packs failed even after two follow-up flows). This flow reports honest
  failures rather than tuning content to force a pass — same discipline as
  flow 316/317's "never tune a SKILL.md to pass" rule.
