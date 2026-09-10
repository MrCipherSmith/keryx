# Three harness defects, and what they do to the numbers

Found 2026-09-09 while designing a second measurement on a large external
repository. All three are in `scripts/benchmark/`, all three are fixed, and each
carries its own commit. They are recorded here rather than only in a git log
because one of them changes what the published 2026-09-05 figures mean.

| # | defect | fixed in | affects published data? |
|---|---|---|---|
| 1 | keryx leg reported one request's prompt, not the turn's sum | `653dec6` | no |
| 2 | claude leg had no environment isolation at all | `da056b7` | **yes** |
| 3 | keryx leg verified nothing: no isolation, no roster | `8fb6eac` | no |

---

## 1. The keryx leg's context cost was one request, not the turn

`retrieval-agent-keryx.ts` read `turn_end.usage`. That field carries the shell's
`lastUsage` (`src/commands/shell.ts:990`), which is a plain assignment on every
provider call — the last one wins. So a turn that made fifteen requests reported
the prompt of the fifteenth.

The claude and grok legs read the `result` event's `usage`, which is the sum over
a turn's requests. `results-keryx.md` establishes this empirically: deduplicating
the assistant messages sums to exactly the result event's total, which is why
~25-tool-call tasks show 1.5–2.6M context tokens, a figure no single request
could produce.

So the two legs were never the same quantity. On a long task the keryx leg
understated its own context cost by roughly an order of magnitude, **in keryx's
favour**, on the one metric the cost half of the pre-registered rule is computed
from.

The stream already carried one `usage` event per provider call, and
`run-ablation-mutating.ts:167` already accumulated. Two conventions existed in
one repository and the retrieval leg had picked the wrong one. Fixed by summing;
`providerCalls` is now recorded so the shape of the number is visible in the row.

**No published figure changes.** The 2026-09-05 data predates the `harness`
field — every row in both results files lacks it, and every model is
`claude-sonnet-5` or `claude-opus-5`. The keryx leg has never produced a
published number. This would have corrupted the three-harness run the runbook
describes.

**What is still an assumption,** and belongs in any write-up that quotes a keryx
token figure: `NormalizedUsage` (`src/harness/provider/types.ts:100`) carries no
cache fields, so if x.ai excludes a cached prefix from `prompt_tokens` this leg
still undercounts per call. The sum fixes the shape, not that residual. Bound it
by running one prompt through both this leg and the grok CLI and comparing; an
order of magnitude apart means the cost half is not comparable and only recall
is reportable.

---

## 2. The claude leg ran under the operator's own environment

This is the one that touches the published numbers.

`buildClaudeEnv` copied the entire parent environment and overrode exactly one
key, `PORT`. No temporary HOME, no allowlist. So every arm — including every
`context-off` arm — was handed:

- `~/.claude/CLAUDE.md`, which carries **this project's own keryx routing
  block**. The control arm was instructed to route through the system under test,
  into a tree where `.metaproject/` had just been deleted.
- 79 global skills, among them `job-orchestrator` and `graphify`.
- six MCP servers, including a GitHub code searcher and `backend-graph`, a second
  retrieval system.
- every `ANTHROPIC_*`, `CLAUDE_*`, `XDG_*` and `GH_TOKEN` in the shell —
  `CLAUDE_CONFIG_DIR` among them, which alone relocates the whole configuration
  and would defeat a temporary HOME had there been one.

The grok leg had already measured what this costs and called it disqualifying in
its own docblock: a clean HOME reports 0 instruction files, 0 MCP servers and 27
tools against ~130, and the same four-word prompt costs 12,975 input tokens
instead of 27,863. That argument was written down and acted on for one leg only.

### What it does to the 2026-09-05 result

The bias runs **toward keryx**. An obstructed control arm — told to route through
a workspace that is not there — performs worse than an honest one, which widens
the gap the measurement reports as keryx's benefit.

That run reported no support for the claim anyway. So the direction of the error
does not rescue a positive finding; it means the negative finding was obtained
under conditions that favoured a positive one. That is worth stating plainly
rather than treating the defect as purely prospective.

The context-token figures from that run are also inflated on both arms by roughly
the global instruction load the grok leg measured, which is not symmetric between
arms because the routing block is only actionable in one of them.

### The fix

Both CLI legs now build their environment from an **allowlist**, not a copy with
exclusions, because the dangerous variables are the ones nobody listed.
Credentials pass; configuration redirectors and answer-reaching tokens do not,
refused by name and by prefix so the next `MCP_*` variable is caught without
anyone remembering to add it. Managed settings, which live outside HOME entirely
and which no temporary HOME can hide, are refused rather than silently inherited.

Claude Code on macOS keeps its credential in the Keychain — scoped to the user,
not to HOME — so an isolated HOME authenticates normally and there is nothing to
link. The Linux file is linked when present.

The grok leg's own environment was still `{...process.env, HOME}`, the same hole
minus one variable, and moved onto the same builder: the two legs should differ
in wrapper, not in what leaked into them.

---

## 3. The keryx leg verified nothing

`assertRoster` has guarded the claude and grok legs from the start — no init
event means the environment is unverified; an MCP server means a second
retrieval system; a web tool means the answer is reachable from outside the
checkout, which matters because a task's query is a merged pull request's subject
line on a public repository.

The keryx leg had none of it, and could not have: `createKeryxAgent` set no
environment, and `ShellEvent` carried no roster to check. The harness most
load-bearing for claims about keryx was the only arm nobody could verify.

`turn_start` now carries the turn's sorted tool names — the shell already had
them on `deps.tools`, and `interactiveAgentToolNames` already existed. The field
is optional so older transcripts still parse, and an arm whose roster was never
announced is **refused**, because unverified is not the same as clean.

The arm also runs under an isolated HOME with `XDG_DATA_HOME` pointed at a
temporary directory. keryx reads its user-global state from there
(`src/lib/config-dir.ts:67`): `permissions.json` — the shell's auto-approval
allowlist — plus `sandbox.json`, `projects.json` and `auth.json`. Under the
operator's own, an arm inherited a permission set accumulated over months, and
registered every throwaway checkout into a registry that already holds twenty
such leftovers.

`XDG_DATA_HOME` is itself on the forbidden list, because inherited it relocates
the configuration the isolation exists to hide. The exemption is therefore **by
value**: this leg's own temporary path passes, the operator's does not.

---

## What this does not fix

Listed so the next reader does not mistake silence for absence.

- **stderr is piped and never drained** in all three adapters. A child that
  fills the pipe buffer blocks, then dies to the wall-clock timer with no
  diagnostic.
- **No `SIGKILL` escalation.** `proc.kill()` sends SIGTERM; `claude` and `grok`
  spawn children that survive it.
- **No liveness supervision of any kind** — no stall detection, no heartbeat, no
  output-silence timer. `scripts/watchdog.ts` is referenced by
  `src/gdskills/bundled/rules/core/shared-definitions.mdc:72` and does not exist.
- **Subagents are disabled on the grok leg and enabled on the claude leg**
  (`--no-subagents` versus nothing). Since `.metaproject/index.md` instructs the
  context arm to fan out through gdskills workers and says nothing to the control
  arm, an asymmetry in whether subagent turns fold into reported usage is an
  asymmetry between arms, not just between legs.
- **The `context-off` arm runs with `keryx` on PATH** and is verified only
  indirectly, through `inventoryAfter.hasGraphDb === false`. Nothing asserts the
  arm could not invoke the binary.
