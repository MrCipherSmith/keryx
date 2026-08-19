# Context

Collected deterministically by `keryx flow init` at 2026-08-19T17:59:35.927Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-08T20:19:50.211Z)
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

Brainstorm and interview were run interactively on 2026-08-19 and their output
is committed, not summarised here: see
`docs/requirements/keryx-external-agent-runtime/` (commit `64054c55`), whose
`brainstorm.md` records the reference designs studied, every option considered,
and the eleven resolved forks with reasoning.

### Verified facts (checked directly, not assumed)

- **Installed CLIs on this machine:** `codex-cli 0.147.0` at
  `~/.local/bin/codex`, `claude 2.1.220` (Claude Code) at the nvm node path,
  `opencode` present. `gemini` absent.
- **Flag surfaces** were read from `codex exec --help` and `claude --help` on
  those exact versions. The load-bearing findings: `claude -p` supports
  `--input-format stream-json` (so headless is a *bidirectional* channel, not
  fire-and-forget), `--session-id <uuid>` (keryx can assign the id),
  `--max-budget-usd`, `--json-schema`; `codex exec` supports `--json`,
  `-s read-only`, `-C`, `--output-schema`, `--ignore-user-config`, `--ephemeral`
  and an `exec resume` subcommand.
- **`src/harness/child/git-worktree-port.ts`** runs `git worktree add --detach
  <path> <ref>` with `ref` defaulting to `HEAD`, so uncommitted changes are NOT
  carried into a worktree; its `merge` deliberately refuses a dirty worktree
  rather than force-merging. This is why the working diff must travel in the
  prompt.
- **`src/harness/tool/builtin/spawn-subagent-tool.ts`** already exports
  `SubagentMode = "read_only" | "general"` (line 39), `SubagentCompletionStatus`
  (line 62) and `StructuredSubagentResult` (line 77). No new status vocabulary
  is needed.
- **`subagent-dispatch.schema.json`** already carries a `model` block (flow 089)
  and an `allowed_actions` enum containing `read`/`write`/`run-command`/
  `network`/`spawn-subagent`. The new `runtime` block sits beside `model`.
- **`src/harness/child/worktree.ts`** exports `needsWorktree(policy,
  allowedActions)` — the containment decision hooks into an existing predicate.
- **`src/tui/`** already has `modal-host.ts` (reusable `openModal`, implemented
  flow 154), `subagent-inspector.ts` / `subagent-session.ts` (clickable sidebar,
  live `store.subscribe(refresh)`, sticky-bottom scrollbox), and the pure queue
  helpers `main-queue.ts` (`QueuedMainQuestion`, `parseQueueCommand`,
  `removeMainQueueItem`, `editMainQueueItem`, `reinsertMainQueueItem`).
- **Working precedent in-repo:** `scripts/benchmark/run-ablation-codex.ts`
  already spawns `codex exec -s read-only --json -C <root>` via `Bun.spawn`,
  parses its JSONL events and runs it in isolated worktrees against an
  already-authenticated CLI with no API key.

### Reference implementation studied

`/home/altsay/bots/helyx` — a production Telegram/Claude Code system on this
machine. Two patterns: an inverted MCP channel (`channel/`), and a headless
reviewer (`services/reviewer-service.ts`) whose `ReviewerKind` is
`"codex" | "provider" | "claude"`. Twelve measured failures from the second are
encoded as requirements in the docpack — among them that `--allowed-tools` does
not restrict, that `--permission-mode plan` turns a review into a
plan-approval request indistinguishable from success, that an inherited
`ANTHROPIC_API_KEY` *breaks* the subscription path, and that `claude -p` prints
its login refusal to stdout with exit code 0.

### Open unknowns — these are T1, not assumptions

1. **The `spawnChild` seam is unverified.** `SpawnChildRequest` (`spawn.ts:40`),
   `SpawnChildInput` (`:55`) and `SpawnChildDeps` (`:89`) are exported, but
   their fields have not been read. Whether there is a point of substitution for
   the execution strategy, or whether the in-process loop is hardcoded, is the
   single unknown able to move the estimate materially.
2. **No fixtures exist.** ACs resting on recorded JSONL transcripts from both
   CLIs have nothing to run against; none have been captured. Capturing them
   spends the operator's subscription quota.
3. **Flag combinations unverified on the live versions.** `--help` was read, but
   `claude -p --output-format stream-json` was never run, and whether
   `--json-schema`, `--input-format stream-json` and `--verbose` compose is
   unknown. The event mapping table in specification §6.2 is assembled from
   helyx's parser (written against an older Claude version) and the ablation
   script — plausible, unverified.
4. **`src/capability/` was never opened.** The opt-in gate claim rests on the
   harness README's description of it.

### Standing constraints from memory that bear on this flow

- `stale-installed-keryx-binary` — the `keryx` on PATH is a stale build, so a
  review pipeline invoking it does not exercise the code under review. Verify
  against a locally built binary.
- `flow-ids-allocated-per-clone` — this flow took id 176; a concurrent clone can
  collide, as happened at 173→174. Check before opening the PR.
- `tui-alignself-height-collapse` — relevant to the modal work.
- `allowlist-not-a-boundary` — directly on point: it is the same reasoning that
  makes the tool deny-list non-load-bearing here (decisions D-08).
