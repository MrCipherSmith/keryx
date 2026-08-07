# Flow Journal

- 2026-08-07T07:48:29.800Z - flow created
- 2026-08-07 - task-implementer: implemented AC1-AC4, recorded AC5 below.

  **Scope decision on `src/commands/agent.ts:308-317`: IN SCOPE.**
  `SYSTEM_INSTRUCTION` (shell.ts:140) governs `runShell`'s plain chat REPL,
  which registers NO `tools` field on its `NormalizedRequest` at all (see
  shell.ts:399-408; TUI sidebar literally labels it "chat · no tools" —
  src/tui/chat-shell.ts:332). That mode can never face a tool-call-budget
  decision. The transcript quote in the flow description ("The instructions
  say be economical, but accuracy matters" — deciding whether to make
  another tool call) can only have come from **agent mode**
  (`runAgentTurn` + `buildAgentSystemInstruction`, agent.ts:244), the only
  path with tools, which carries its own near-duplicate "Be economical with
  output tokens" clause (agent.ts:309, pre-existing, textually distinct from
  shell.ts's). Editing shell.ts alone would satisfy AC1-AC3 as literal text
  but leave the actual tool-trusting disposition unchanged in the only mode
  where it matters, and AC4's fixture (graph_query correctness) can only be
  exercised through agent.ts's instruction. Both files updated with matching
  (not shared-constant) text: economy-governs-prose-only + explicit
  tool-call-budget carve-out + "check when the tool result IS the
  deliverable" clause. No new shared abstraction introduced — kept the
  existing pattern of two independent literals to avoid scope creep.

  **AC1** — `src/commands/shell.ts` `SYSTEM_INSTRUCTION` (now exported) is
  three sentences: (1) brevity, mentions nothing about tools; (2) "That
  economy governs prose only — never how many tools you call."; (3) the
  verification clause. Test: `src/commands/shell.test.ts` describe block
  "SYSTEM_INSTRUCTION (flow 139, AC1-AC3)" — splits on sentence boundaries
  and asserts the brevity sentence contains no "tool" token, plus asserts the
  explicit decoupling sentence is present. Same decoupling clause added to
  `agent.ts`'s instruction (agent.test.ts, "agent.ts scope" test).

  **AC2** — both instructions now say: "When a tool's result is itself the
  deliverable you are about to report (not merely an input you go on to
  reason over), check it against source before presenting it as fact."
  Covered by the AC2 test in shell.test.ts and the AC4 fixture in
  agent.test.ts (below), both of which fail if the clause text is removed.

  **AC3** — brevity wording preserved verbatim in shell.ts ("lead with the
  conclusion", "give the shortest correct answer", "prefer bullet points
  over prose", "omit preamble and restated context"); same test file, AC3
  test. X1 (14.0s-vs-100.6s advantage) is not touched — no change to when a
  tool call happens, only to what the instruction says about the tradeoff.

  **AC4** — `src/commands/agent.test.ts`, test
  "AC4/AC5: agent qualifies a graph_query cycle count that wrongly folds in
  dynamic-import edges". A fake `graph_query` tool (NOT the real gdgraph
  engine) hardcodes the A3-shape wrong answer: "8 import cycles found,
  including 5 through bot/callbacks.ts -> bot/commands/menu.ts and 3
  elsewhere" — deliberately unfiltered, mirroring the pre-fix behavior
  regardless of what the real engine now does. The scripted trajectory has
  the agent make a SECOND tool call (`read_file` on a real fixture file
  containing the `await import()` line) before answering, and the final
  text is asserted to qualify the count (contains "await import"/"dynamic
  import" AND "not load-order"), not just restate "8 cycles". A companion
  sanity test (`qualifiesCycleCount sanity`) pins that a bare restatement
  does NOT pass the qualification check. The fixture also directly asserts
  the real `buildAgentSystemInstruction(...)` output (not a stub string)
  contains "deliverable" and "check it against source" — so it fails
  immediately if the disposition clause is ever deleted, independent of the
  scripted trajectory.

  **AC5** — P1 (`gdgraph` counting `await import()` as an ordinary edge) is
  already fixed in this working tree: `src/gdgraph/query.ts:69` excludes
  `dynamic-import` edges from cycle reporting, and
  `src/gdgraph/import-kind.test.ts` pins the classification. The AC4 fixture
  above does NOT depend on that fix: its `graph_query` tool is a
  hand-written stub with a hardcoded wrong answer, not a call into the real
  gdgraph engine, so it forces the unchecked-trust path (the model must
  still choose to verify) regardless of whether the underlying graph data
  is now correct. Confirmed by inspection — the fixture would fail the same
  way whether P1 is fixed or not, since it never calls the real engine.

  **Verification:** `bun test src/commands/shell.test.ts
  src/commands/agent.test.ts src/commands/agent-tool-surface.test.ts` — 68
  pass, 0 fail. `bun test src/harness/posture/unattended.test.ts
  src/harness/posture/unattended-corpus.test.ts` — 26 pass, 0 fail (both
  build `buildAgentSystemInstruction` and were checked for collateral
  breakage). `tsc --noEmit` on the project — clean, no errors. `keryx health
  run` — PASS, project score 93 (contrary to the dispatch note's warning
  about pre-existing `sandbox.ts` TS errors from a sibling flow; either that
  landed or resolved since the note was written — recorded here for the
  record, not investigated further as it is out of this flow's scope).
- 2026-08-07T09:35:43.706Z - task-done: T1: Collect remaining context
- 2026-08-07T09:35:43.795Z - task-done: T2: Implement per plan
- 2026-08-07T09:35:43.883Z - task-done: T3: Add/adjust tests and make them pass

## Orchestrator note — 2026-08-07

**The worker corrected the finding, and it was right to.** This flow was written
against `src/commands/shell.ts:141`. That instruction governs the plain chat
REPL, which registers no tools at all — so the tool-call-budget disposition the
flow exists to fix could not have lived there.

Verified independently rather than accepted: the A3 transcript's first line reads
`keryx — deepseek/deepseek-v4-flash · agent · unattended:read-only`. Every
benchmark leg ran **agent** mode, governed by `buildAgentSystemInstruction` in
`agent.ts`, which carried its own near-duplicate "be economical" clause. Fixing
`shell.ts` alone would have satisfied AC1-AC3 as text and changed nothing that
was measured.

Both files updated. `findings.md` and the v2 specification corrected — the
finding stands, the citation did not.

Two near-duplicate literals now carry the same guidance, which is a drift risk
the worker flagged and deliberately did not resolve with a shared constant. I
agree with leaving it: the duplication predates this flow, and collapsing two
system prompts into one shared string is a design change that deserves its own
evidence, not a side effect of a wording fix. Worth its own flow.

Gate after all four flows, on a repository cleaned of the 42 stray benchmark
worktrees: `keryx health run` **PASS**, score 93. Combined suite across all four
diffs: **373 pass, 5 skip, 0 fail**.
- 2026-08-07T09:35:48.952Z - task-done: T4: Self-review and prepare draft PR
