# Keryx Shell Remediation v2 — Specification
Version: 1.0.0

Each defect below states its evidence, its root cause **in code**, the change,
and acceptance criteria that can be checked without judgement. Nothing here
claims an implementation exists; every "today" statement was read from the
source or produced by running something.

---

## P1 — `gdgraph` counts `await import()` as an ordinary import edge

### Evidence

`keryx gdgraph query cycles` on `helyx@bfad745b` reports **8 cycles**. Five run
through `bot/callbacks.ts → bot/commands/menu.ts`, and that edge is dynamic:

```ts
// bot/callbacks.ts:76
const { handleMenuCallback } = await import("./commands/menu.ts");
```

The same file uses `await import()` for four more modules and `bot/handlers.ts`
for three. A dynamic import resolves at call time, not module-load time, so it
does not create the load-order cycle the question is about.

Found by the A3 benchmark case: `opencode-deepseek`, on the same model as the
keryx leg and with no native graph tool, reported the distinction; keryx
reported the raw 8.

### Root cause

`src/gdgraph/build.ts:230`.

`Bun.Transpiler#scanImports` **already returns the kind** — verified by running
it:

```
[{"kind":"import-statement","path":"./static.ts"},
 {"kind":"dynamic-import","path":"./dyn.ts"}]
```

and the next line throws it away:

```ts
.map((entry) => entry.path)
```

`extractImportSpecifiers` returns `string[]`, so by the time an edge is written
there is no kind left to filter on. The information is available and discarded
one line after it arrives.

### The change

1. Preserve the kind from `scanImports` through to the edge record.
2. Cycle detection either excludes `dynamic-import` edges or reports them as a
   separate class — **not** silently folded into the same count.
3. `extractImportSpecifiersFallback` is a regex and has no kind. Edges found
   **only** by the fallback must be recorded with an explicit unknown/static
   marker rather than guessed; the spec does not require the regex to classify.

### Acceptance criteria

- AC1: An edge record carries the import kind for every edge the transpiler
  produced, and the kind is one of the values `scanImports` actually returns.
- AC2: `keryx gdgraph query cycles` on `helyx@bfad745b` no longer presents the
  five `commands/menu.ts` cycles as load-order cycles — they are excluded or
  labelled.
- AC3: A fixture asserts the classification directly: a two-file cycle formed by
  a static import is reported; the same cycle formed by `await import()` is not
  reported as a load-order cycle.
- AC4: Edges contributed only by the regex fallback are not silently labelled
  static.
- AC5: The changelog states that previously reported cycle counts on
  lazy-loading codebases were inflated.

---

## P2 — the approval menu offers a grant that can never be honoured

### Evidence

C3's keryx transcript. For

```
echo "keryx benchmark probe $(date -u …)" > /etc/keryx-benchmark-probe.txt && cat /etc/…
```

the menu offers **"Always allow `echo *`" — "Remember this prefix
(permissions.json)"**. `isShellCommandAllowed` (`src/lib/shell-permissions.ts:1080`)
rejects any command with an unquoted metacharacter *before* consulting the
allowlist, and this command has `>`, `&&` and `$( )`. The grant is stored and
never applies to a command of this shape.

### Root cause

`src/lib/shell-permissions.ts:1151` — one asymmetry:

```ts
offerExact:  !destructive && validateShellPattern(exact).ok,   // validates the COMMAND
offerPrefix: !destructive && validateShellPattern(prefix).ok,  // validates only "echo *"
```

`exact` *is* the command, so `offerExact` is correctly withheld here. `prefix` is
the derived pattern, which is clean, so `offerPrefix` is offered.

`pickShellApproval` states the invariant this breaks three lines above the code
that breaks it (`src/tui/tui-shell.ts:438`): *"A grant that cannot be given
safely is not shown at all: an 'always' option the user picks and that is then
silently refused would be worse than absent."*

### The change

Withhold **both** offers when the command itself could never be auto-approved —
i.e. gate on the same predicate `isShellCommandAllowed` applies to the command,
not only on the validity of the derived pattern.

### Acceptance criteria

- AC1: `suggestShellPatterns` returns `offerPrefix: false` for a command
  containing an unquoted metacharacter, with the C3 command as a test input.
- AC2: `offerPrefix` remains `true` for a clean command whose prefix is
  offerable — the fix must not remove the feature.
- AC3: A property-style test asserts the invariant directly: for any command,
  if an offer is made then a stored grant of that pattern would auto-approve
  that command.
- AC4: No behaviour change for destructive commands — they already offer
  neither.

### Note

**Not an escape.** The metacharacter barrier holds and nothing gets through.
What is broken is consent: the user is shown a remedy that provably will not
work, and the grant they would give (`echo *`, forever) is not about the command
on screen.

---

## P3 — the shell system prompt trades verification for brevity

Carried by **flow 139**, already open. Repeated here so the package is complete;
the flow's frozen acceptance criteria are authoritative.

### Where — corrected during implementation

This specification originally pinned P3 to `src/commands/shell.ts:141`. That was
wrong, and flow 139 found it: `SYSTEM_INSTRUCTION` there governs the plain chat
REPL, which registers **no tools** ("chat · no tools" in the TUI), so a
tool-call-budget disposition cannot exist in it. Every benchmark leg ran agent
mode — the A3 transcript opens with
`keryx — deepseek/deepseek-v4-flash · agent · unattended:read-only` — governed by
the near-duplicate clause in `buildAgentSystemInstruction`
(`src/commands/agent.ts`). Both instructions now carry the fix; the one that
mattered is `agent.ts`.

### Evidence

`src/commands/shell.ts:141` — the wording the finding was read from, and
duplicated almost verbatim in `agent.ts`, which is where it had effect:

> "You are the keryx interactive shell assistant. Be economical with output
> tokens: lead with the conclusion, give the shortest correct answer, prefer
> bullet points over prose, and omit preamble and restated context."

The model applies it to more than prose. From the A1 transcript, while deciding
whether to make another tool call:

> "The instructions say be economical, but accuracy matters."

Outcome on two independent cases, both against `opencode` on the **same model**:

| Case | keryx | `opencode` |
|---|---|---|
| A3 | 8 cycles, 14.0 s, unqualified | 5 of 8 are dynamic imports (100.6 s) |
| A4 | 14 orphans, 14.0 s, unqualified | only 2 are genuine (100.8 s) |

### The change

Three properties, not a wording tweak:

1. Economy governs **output length**, not tool-call budget. The current sentence
   conflates two axes and the model resolves the conflation by making fewer
   calls.
2. State when a first-party tool result is to be checked against source —
   specifically when that result *is* the deliverable rather than an input to it.
3. Keep the brevity. 14.0 s against 100.6 s is a real advantage.

### The counterweight, which the fix must not ignore

On the A1 re-run the leg that **did** verify produced a **false** correction:

> "The gdgraph index lists 24 direct dependents; text search finds 25.
> `tests/unit/find-duplicate-definitions.test.ts` is missing from the graph."

That file does not contain the string `config` at all. The text search matched a
literal `"Reading: config.ts"` inside an assertion in a different file.

So the target disposition is **check when the tool's answer is the
deliverable** — not "distrust the tool". A verifier that invents a correction has
degraded the answer as much as an agent that skipped the check.

### Acceptance criteria

See flow 139 AC1–AC5. Coordination requirement: P1 must land first, or AC4's
fixture passes because the underlying data got better rather than because the
disposition changed.

---

## P4 — a Linux install has no OS containment and nothing says so

### Evidence

```
$ keryx harness exec --allow-real-subprocess --allowed-domains example.com -- /bin/echo hi
{"outcome":{"kind":"blocked","reason":"Contained spawn failed: OS sandbox launcher
 unavailable on linux … failing closed (install bubblewrap on Linux …)"}}
```

`scripts/install.sh` is 144 lines and mentions `bwrap`, `bubblewrap` and
`sandbox` **zero** times. There is no `doctor` or preflight command in
`src/standard/command-registry.ts`.

Per the project's own runbook
(`docs/verification/linux-sandbox-verification.md`):

| Capability | Linux (bubblewrap) | macOS (Seatbelt) |
|---|---|---|
| Filesystem containment | yes | yes |
| Network OFF | yes | yes |
| `--allowed-domains` | **not implemented — fails closed** | yes |
| `--mask-env` | **not implemented — fails closed** | yes |

### Root cause

Two independent things, and only the second is a defect:

1. The domain allowlist is genuinely **not implemented** on Linux: `restricted`
   means "deny all except one loopback socket"; `bwrap --unshare-net` gives the
   process *its own* loopback, not the one the proxy listens on, so it needs a
   network namespace plus a relay. Failing closed rather than downgrading "only
   these domains" to "the whole internet" is correct. **Out of scope** — see
   README non-goals.
2. The two capabilities that **are** implemented on Linux both require
   `bubblewrap`, and nothing — installer, CLI, or output — tells the user
   whether it is present. Combined with `KERYX_SANDBOX_SHELL` being off by
   default (`src/harness/tool/builtin/shell-exec-tool.ts:10`), a user can run
   keryx indefinitely believing they have containment they do not have.

### The change

1. Installation reports, per platform, which containment capabilities are
   available and what is required for the rest — install the launcher, offer to,
   or state plainly what is unavailable without it.
2. A command answers the same question at any time, without running a contained
   command: launcher present or not, and the per-capability matrix for this
   platform.

### Acceptance criteria

- AC1: On a Linux host without `bubblewrap`, installation states that OS
  containment is unavailable and names what provides it.
- AC2: A CLI command reports launcher availability and the per-capability matrix
  for the current platform, and exits non-zero on nothing — it is a report, not
  a gate.
- AC3: The report distinguishes "not installed" from "not implemented on this
  platform". Those are different sentences and conflating them is the current
  problem in a new place.
- AC4: The matrix in the output and the matrix in
  `docs/verification/linux-sandbox-verification.md` are generated from, or
  tested against, one source — so they cannot drift.
- AC5: No change to what `KERYX_SANDBOX_SHELL` defaults to.

---

## Cross-cutting: what must not regress

| # | Invariant | Guarded by |
|---|---|---|
| X1 | keryx's group-A answers stay fast — the 14.0 s figure is a product decision | P3 flow AC3, S5 in the PRD |
| X2 | The metacharacter barrier keeps rejecting commands before the allowlist | P2 AC3 |
| X3 | Every contained path keeps failing closed | P4 AC5 |
| X4 | `--unattended` keeps granting no shell and only `risk:"read"` tools | unchanged by this package |
