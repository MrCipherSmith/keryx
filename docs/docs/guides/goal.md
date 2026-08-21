# `/goal` — deterministic starts, optional autonomous continuation

`keryx shell`/TUI already binds a session to a Slate and a SAC workspace
implicitly, by watching for an action-intent turn. `/goal <text>` is the
explicit, deterministic alternative: it opens the Slate immediately, skips
the heuristic, and — since SLATE-27 — can optionally keep re-driving the
turn on your behalf instead of stopping after one.

```text
/goal <text> [--workspace <id>] [--auto [N]]
```

Agent-mode only (`keryx shell`, TUI, `harness run --goal ...`). Chat mode has
no tools and no Slate, so `/goal` has no chat-mode meaning.

## The one-shot form (SLATE-15/16)

```text
/goal Add rate limiting to the /export endpoint
```

- Opens the Slate and injects Anchors (root, touched files, runtime) into
  history once, so the model doesn't have to re-derive them.
- Resolves-or-creates a SAC workspace binding by the same tool-calling
  judgment `ask_user`/`spawn_subagent` already use — pass `--workspace <id>`
  to skip that judgment and bind explicitly:

```text
/goal Add rate limiting to the /export endpoint --workspace ws_a1b2c3
```

`--workspace <id>` is only recognized at the very end of the line — never
mid-sentence — so ordinary goal text that happens to contain the word
"workspace" is never swallowed as a flag.

- Runs exactly one turn, then stops. Whether the goal was actually achieved
  is left to the model's own narrative — nothing re-checks it.

## Bounded autonomous continuation (SLATE-27)

```text
/goal Migrate the billing module off the deprecated client --auto
```

`--auto` (optionally followed by a positive-integer round cap — default
`8`) arms a round-capped loop instead of stopping after the first turn:

1. **Durable "is this done" record, reused, not reinvented.** If the Slate's
   Course has no Flow bound yet, `--auto` provisions one — `flow init` →
   `freeze` → `start`, with one acceptance criterion tied directly to the
   goal text — and binds it. An already-bound Flow is reused as-is.
2. **The loop.** After the first turn, while the Flow isn't done and rounds
   remain, `/goal` synthesizes a continuation message naming the Flow's
   live remaining tasks and re-drives the turn. The stop signal is the
   *same* `isCourseDone`/`courseFromSlate` check the ordinary wrap-up path
   already runs on every turn — not a second, parallel "is it done"
   detector.
3. **One verifier call before the final stop, not an evidence catalog.**
   Once the loop's ordinary stop condition is met (or the round budget is
   exhausted), a single `spawn_subagent` (`read_only`) call independently
   checks the stated goal against the current repository state and reports
   `{ achieved, gaps }`. On a rejected verdict with rounds still left, the
   Slate reopens (fresh Anchors, same bound Flow/workspace) for exactly one
   more round — a single second chance, never a re-verify loop.

```text
/goal Migrate the billing module off the deprecated client --auto 5
```

An explicit round cap overrides the default `8`. A non-integer value after
`--auto` is never a parse error — it falls through as ordinary goal text,
matching how `--workspace` already handles the same ambiguity.

### Isolation

The armed round budget lives only on the in-memory session object
(`SlateSessionRef.autoGoalRounds`) — it is **never** written to
`slate.json`. A forked or resumed session gets a brand-new session object
that structurally never has this field set, so an unattended loop can never
silently carry over into a session that never asked for it.

### What still gates every write

`--auto` changes how many turns run before `/goal` stops — nothing else.
Every tool call inside every round still goes through the exact same
`resolveApprovalDecision` gate as a manual turn. Nothing about approval
mode changes.

## Not shipped (do not treat as current)

- No cross-session autonomous resumption — an armed `--auto` loop does not
  survive a process restart, `keryx sessions fork`, or `/resume`.
- Not a general adversarial multi-skeptic committee — one verifier call per
  stop attempt, not several running in parallel.
- No new persistent goal-state file or event log — the Flow (`flow.json`)
  is the durable record; `slate.json` stays exactly what SLATE-1/16 already
  defined.

## Where to go next

- [Shared Agent Context](shared-agent-context.md) — the resolve-or-create
  workspace binding and wrap-up dispatch `/goal` reuses unchanged.
- [Slate for external agents](slate.md) — the sibling MCP-exposed surface
  for hands other than keryx's own runtime.
- [Requirements: `/goal` continuation](https://github.com/MrCipherSmith/keryx/tree/main/docs/requirements/goal-continuation) —
  the competitor survey this feature is drawn from, and its as-built design.
