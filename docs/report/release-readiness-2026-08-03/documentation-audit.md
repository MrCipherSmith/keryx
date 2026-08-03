# Documentation audit — 2026-08-03

Produced by a six-analyst pass over the source, run to refresh the developer
documentation for `0.2.0`. Every analyst was required to carry a `file:line` for
each claim and to report comments that no longer match the code.

The pass was commissioned to *write* documentation. What it mostly produced was
a list of places where the documentation and the code disagree — including
places written the same day.

Security findings are separate: [security-findings.md](security-findings.md).

---

## A. Claims corrected in this pass

Each of these was live in a published document and is now fixed.

| Claim | Where | Reality |
|---|---|---|
| "semantic memory search, ML-based security detection … use downloadable models that are not bundled and not required" | `README.md` | Both runtimes are the **empty string** — `src/security/detect/index.ts:25`, `src/memory/config.ts:26-30`. The ONNX stack was removed for weight. Re-enabling means editing a source constant and installing a package, not downloading an asset. Only tree-sitter is genuinely asset-driven. |
| "nothing to configure, nothing breaks" | `README.md` | 11 paths fail rather than degrade. `ctx rg` exits non-zero without `ripgrep`; `test suggest`, `flow plan`, and the `--narrate` commands have no deterministic mode and exit non-zero without a credential. `wiki enrich` is the one that degrades properly. |
| `review`, `serve` and `mcp` listed as shipped modules | `README.md` | A module has a manifest entry, a manifest file and a `src/<feature>` behind a verb. `review` and `serve` meet none of that — they are commands. `mcp` **is** a module but is off by default (`init.ts:343-347`). Nine are on after `init` (`init.ts:241-250`). |
| "cost-aware model escalation, git-worktree isolation and bounded peer messaging" listed under **Added** | `CHANGELOG.md` (written this morning) | `child/escalation.ts`, `child/worktree.ts`, `child/peer.ts` and `monitor/reduce-state.ts` are each imported by **exactly one file — their own test**. Verified: zero production callers. Now listed as implemented-but-unwired extension points. |
| "scoped credentials" | `CHANGELOG.md` | `credentials:` is passed only in tests. A live child reads the ambient environment. |
| `--external @xenova/transformers` in the build | `package.json` | The package is in no dependency list and is never imported — it appears only in comments and in a guard test asserting it is never imported. Removed; the build was re-run and the suite is green. |

## B. Two systems that documentation must not merge

The harness analysis produced the single most important structural finding, and
it changes how the architecture document has to be written.

**There are two tool systems, not one.**

1. The durable, schema-bound `ToolRegistry` / `ToolExecutorPort`, which returns
   an `outputHash` — it *structurally cannot* feed content back to a live model.
2. The content-returning `InteractiveTool` layer that the shell actually runs.

`tool/metaproject-operations.ts` is the only bridge, projecting one descriptor
into both.

**And no shipped path registers a tool.** Both production executors are
refusals — `src/commands/harness.ts:247` ("Release 0 CLI runs register no
tools") and `src/lib/serve-turn.ts:313` ("Remote turns register no tools in this
slice"). So `keryx harness run` and `keryx serve` are single text turns today.

The consequence for prose: **"the policy engine gates the tools your agent
runs" is false as a single sentence.** It mixes the first system's code with the
second system's behaviour. The two must be described separately, each with its
own citation.

Likewise, the approval flow that actually gates `shell_exec` is a `y/N` prompt in
`src/commands/agent.ts` — `mutation/approval.ts:checkApproval` is reached only
from `keryx harness extension`.

## C. Confirmed correct

Worth recording, because the pass was adversarial and these survived it:

- **Authentication runs before routing** in `keryx serve`. Auth is at
  `serve-server.ts:680-696`; the URL is first parsed 39 lines later at `:709`.
  One fixed 401 on every path and method; an unauthenticated caller cannot even
  cause a body read.
- **The approval boundary on a remote turn** is real, and enforced one layer
  deeper than the transport: `policy/engine.ts:233-241` converts `ask` to `deny`
  for non-interactive contexts, and a remote turn is non-interactive by
  construction.
- **"Zero runtime dependencies"** is true and test-enforced.
- **The harness cannot write `flow.json`** — three independent mechanisms.
- **Policy precedence** is one function with seven gates in fixed order;
  `credential` and `destructive` are derived from `write` and can never
  auto-allow.
- **Masking without TLS termination fails closed** — no branch returns non-empty
  masks with `tlsTerminate: false`.
- **The Linux refusal of `restricted` networking** is asserted in CI.

## D. Open defects found, not fixed here

| # | Defect | Evidence |
|---|---|---|
| ~~D1~~ **FIXED in 0.2.5** | `keryx modules` knew 8 of 10 modules — `security` and `mcp` are absent (`commands/modules.ts:23-32`). Every toggle re-invokes `init` with flags derived from that list, so toggling *anything* silently drops `modules.mcp` from a project that had it enabled. | `modules.ts:131-139`, `init.ts:347`, `:598-600` |
| D2 | The five model-backed commands disagree on the exit code for one condition. `wiki enrich` exits 0 and marks pages skipped; the four `narrate` users exit 1. | — |
| D3 | `no-optional-imports.test.ts` derives its forbidden list from `optionalDependencies`, so a package that is externalized but undeclared is not covered by the guard. | `no-optional-imports.test.ts` |
| D4 | `keryx harness run` returns an unstable `completion` shape, typed `unknown`: success emits a `CompletionGateResult`, the catch path emits an ad-hoc object. | `commands/harness.ts:213-216` |
| D5 | `HarnessRunInput.credentialRef` is required by `startRun` but must be stripped before schema validation. | — |
| D6 | `CAPABILITY_REGISTRY` is empty, so the uniform `--<cap>` wiring is inert while three real ceilings are hand-wired in parallel. | — |
| D7 | The `stream` request field on a turn is validated and stored but never read; SSE is only via `GET /v1/turns/{id}/events`. | — |
| D8 | No durable session store exists — `InMemorySessionStore` is the sole implementation. (The *serve* turn store is separate and genuinely durable.) | — |
| D9 | `src/eval/` has zero production consumers; `keryx security eval` uses a second, separate harness. | `src/security/eval/harness.ts` |
| D10 | The root `--help` omits `orient`, `sync`, `session` and several subcommands; it is hand-written and has drifted from `CLI_ROUTES`. | `src/cli.ts:51` |

## E. Stale comments, verified with both locations

Twenty-plus were found. The concentration is in the newest code, which is the
expected place for it: the slice that added a route did not update the header
that counted the routes.

- `serve-server.ts:20-27` — "two entries", "Both routes are reads", "cannot run a
  turn". There are five routes including turn submission (`:393-414`).
- `serve-server.ts:932-938` — `drain()` claims the window is "empty by
  construction — `handleServeRequest` is synchronous", contradicted by `:701-704`
  in the same file and by `async` at `:624`.
- `commands/serve.ts:790` and `:257` — help note and runtime banner both list two
  routes, in a file that imports `assembleSubmitTurn` at `:58`.
- `serve-turn.ts:808` — "Mirrors `SubmitTurnOutcome` in `serve-server.ts`", which
  `serve-server.ts:368-379` records as the leftover it removed.
- `serve-config.ts:33-39` — profile "carried and reported, never resolved"; false
  since `serve-server.ts:239`.
- `serve-server.ts:717-719` — "five read routes"; there are four.
- `.metaproject/wiki/components/src-harness.md` — documents a fixture-corpora
  harness of four files. That code moved to `src/eval/`. **The page is about
  different code entirely.**
- `.metaproject/wiki/architecture/os-sandbox.md:132-133` — see
  [security-findings.md](security-findings.md) SF-3.
- `sandbox/profile.ts:59` — "session temp dir" is the shared OS `tmpdir()`.
- `harness/child/isolation.ts` — header describes a trust ordering the code
  later repudiated.

## F. What this says about the process

The June-to-August habit that produced this project's central lesson —
[branching on a value whose domain you never wrote down](../../../.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md)
— has a documentation twin, and this audit is the evidence for it: **a claim
whose evidence was never written down.**

Six of the items in section A were written by someone who had read the
specification and reported it as the implementation. Two of them were written
*today*, in the release notes, by me. The specification said the multi-agent
engine has worktree isolation and peer messaging; it does, as tested modules
with no caller. Reporting that as a shipped feature took one sentence and no
verification.

The countermeasure that worked here is the one worth keeping: **every analyst
was required to carry a `file:line`, and to say explicitly when a capability was
specified but not wired.** That single constraint produced every finding in
section A. The instruction "document the system" produces prose; the instruction
"cite the line or say you could not find it" produces an audit.
