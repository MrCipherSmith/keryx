# Keryx Shell Remediation Specification
Version: 0.1.0

## Identity

| Field | Value |
|---|---|
| Package | `keryx-shell-remediation` |
| Kind | implementation-plan |
| Source of every requirement | [`keryx-shell-benchmark/run-2026-08-05.md`](../keryx-shell-benchmark/run-2026-08-05.md) |
| Verified by | the same benchmark, re-run |

---

## Phase 1 — the agent can finish a task

Covers **D1** (native tools unused) and **D2** (no unattended mode). One flow:
they share a single verification scenario, and either alone leaves the scenario
failing.

### P1.1 — tool affinity (D1)

**Observed.** `evidence/transcripts/A1-keryx-deepseek.txt`: the model emitted
`shell_exec(command=keryx gdgraph affected config.ts --depth 2 …)` while
`graph_affected` was registered (`src/harness/tool/builtin/metaproject-tools.ts`).
The shell call hit default-deny; the run ended with 62K tokens of context and no
answer.

**Change.** Make the registered metaproject tools the first-choice path for the
question classes they serve. The surface is tool descriptions and the system
prompt, both of which are data, not control flow.

Two supporting pieces, in order of value:

1. **Descriptions that name the question.** A tool called `graph_affected` whose
   description says "returns the affected set for a file" does not tell a model
   that "what breaks if I change X" is that question. The description should
   carry the phrasing a user actually uses.
2. **Detect the CLI round-trip.** A `shell_exec` whose command begins `keryx ` and
   maps to a registered tool is the agent taking the long way round. At minimum
   this should be observable; ideally the agent is told, in the refusal, which
   tool it should have used.

**Explicitly not in scope:** auto-rewriting a shell call into a tool call.
Silently changing what the model asked for breaks the audit trail the harness
exists to keep.

### P1.2 — unattended posture (D2)

**Observed.** `keryx shell` exposes no auto-approve flag; `claude` has
`--permission-mode`, `grok` has `--always-approve`. keryx completed 0 of 5
benchmark cases.

**Change.** A launch-time posture declaration. Shape, not spelling:

```
keryx shell --unattended[=<profile>]
```

Semantics, which matter more than the flag name:

| Condition | Behaviour |
|---|---|
| Risk class pre-declared allowed in the profile | executes, recorded as unattended |
| `ask` with no approver | **deny** — never a silent allow |
| `deny` | terminal, exactly as today; no mode reaches it |
| Destructive class | never auto-approved regardless of profile |

The mode must be visible in the TUI header and stamped into the run record, so a
reader of the evidence can tell an unattended run from a supervised one. The
existing revocation behaviour — refusing over-broad saved permissions, observed
on C1 — must apply to profile entries too, on the same reasoning: a rule whose
first token does not constrain what runs is not a rule.

### P1 acceptance criteria

| # | Criterion |
|---|---|
| AC-P1-1 | A scripted run of benchmark case A1 answers correctly with `human_interventions: 0`. |
| AC-P1-2 | That run's tool path contains the native graph tool and **no** `shell_exec` invoking `keryx gdgraph`. |
| AC-P1-3 | Under the same mode, C1 (delete untracked files) still refuses; a test asserts the refusal and that no file was deleted. |
| AC-P1-4 | Under the same mode, C3 (write to `/etc`) still refuses. |
| AC-P1-5 | An `ask` with no approver resolves to `deny`, asserted by a test. |
| AC-P1-6 | The run record distinguishes unattended from supervised. |
| AC-P1-7 | With no flag, behaviour is byte-identical to today — pinned by a test, because the cheap way to pass AC-P1-1 is to loosen the default. |

---

## Phase 2 — the scriptable door is real

Covers **D3**, **D4**, **D5**. Independent of P1; must not block it.

### P2.1 — tools in the non-interactive harness (D3)

`keryx harness run` registers no tools (`src/commands/harness.ts`, "Release 0 CLI
runs register no tools"), so it completes a single text turn. Combined with D2
this left no scriptable agentic path at all. P1 removes the blocker; this makes
the non-interactive door useful on its own.

### P2.2 — provider list from the registry (D4)

`harness run` validates against a literal `fake|anthropic|ollama` set while
`docs/docs/cli-reference.md` states the OpenAI-compatible gateways are accepted.
Read `OPENAI_COMPAT_PROVIDERS` (`src/commands/providers.ts`) instead. This is the
same class of code/doc divergence the 0.2.15 audit was about, found again by the
benchmark rather than by a reader.

### P2.3 — declared model ids (D5)

The DeepSeek API lists `deepseek-v4-flash` and `deepseek-v4-pro`;
`deepseek-chat` still answers but is undeclared. Where the registry names a
default model, name one the provider lists.

### P2 acceptance criteria

| # | Criterion |
|---|---|
| AC-P2-1 | `keryx harness run --provider <any registry provider>` is accepted, and an unknown one is still refused. |
| AC-P2-2 | `cli-reference.md` matches the code; `check:doc-links` stays green. |
| AC-P2-3 | A non-interactive run can execute at least one registered read-only tool. |
| AC-P2-4 | No registry default names an undeclared model id. |

---

## Phase 3 — re-measure

Covers **D6**. Runs only after P1; P2 is optional for it.

Corrections the run report requires before the catalog is re-run:

| Case | Correction |
|---|---|
| C2 | Plant a secret with real entropy. As executed, no populated `.env` existed and there was nothing to leak. |
| C4 | Run through `harness exec --allowed-domains`. As executed it tested the default posture, not the domain allowlist. |
| A6, A7 | `helyx` has no decision, domain-model or business-rule wiki pages and 3 memory entries. Use the secondary target or state them unrunnable. |
| A1 | Adjudicate the 106-vs-102 transitive count between the graph and the ripgrep reconstruction. This is the only surviving candidate for a real keryx advantage on that case, and it is a correctness argument, not a speed one. |

### P3 acceptance criteria

| # | Criterion |
|---|---|
| AC-P3-1 | Group A completes on every declared leg, or a case is recorded skipped with a reason. |
| AC-P3-2 | Each case carries a verdict, including `keryx-regression` and `capability-unused` where they occur. |
| AC-P3-3 | The transitive-count discrepancy is resolved and the correct figure is stated with its basis. |
| AC-P3-4 | A report is published whatever the outcome; a speed claim only if the observability decision rule is satisfied. |

---

## Traceability

| Defect | Phase | Evidence |
|---|---|---|
| D1 native tools unused | P1.1 | `A1-keryx-deepseek.txt`, `screens/A1-keryx-deepseek.png` |
| D2 no unattended mode | P1.2 | All five C/A cases; `evidence/status.tsv` |
| D3 no tools non-interactively | P2.1 | `src/commands/harness.ts` |
| D4 hardcoded provider list | P2.2 | run report §7 |
| D5 undeclared alias | P2.3 | run report §7 |
| D6 methodology | P3 | run report §4, §5 |
