# Shared Agent Context

Shared Agent Context (SAC) is the shipped local-first entry point for a piece of
work: a file-backed workspace, a bounded Facts / Work / Know-how (FWK) view,
and a reviewed proposal path that promotes a completed session into wiki,
memory, or skills. It stores **workspace-relative references**, not copies of
those owners, and it never becomes a second wiki, Flow tracker, or session store.

The domain lives in `src/sac/`. Operators use `keryx workspace`. Editor agents
use MCP `sac.*` on **local stdio only**. A live `keryx shell` turn can read FWK
through `workspace_overview` / `workspace_read`.

!!! note "What is still experimental"
    The **learned candidate policy** is disabled by default (`enabled: false`,
    `killSwitch: true`) and only synthetic fixtures exist. Phase 6b re-ingestion
    of real receipts/outcomes is not shipped. Core registry, FWK reads,
    propose/review, owner writers, and the access-receipt ledger **are** shipped
    (phases 0–5 and 6a, on `main` since `v0.2.32`, present in `0.2.35`).

Contracts and schemas:
[`docs/requirements/shared-agent-context/`](../../requirements/shared-agent-context/).
This page describes **current behavior**. Where it disagrees with a
`future`/`planned` sentence in an older requirements revision or in satellite
RP-01…RP-12 packages, this page and `src/sac/` win.

## The FWK model

SAC never blurs these three kinds:

- **Facts** — evidence-linked, task-local, freshness-bound statements. A Fact
  never silently becomes long-term knowledge.
- **Work** — a read-only projection of an existing Flow (done, next, blocked,
  verification evidence). SAC never creates a second tracker. Unbound work is
  explicit when no Flow is linked.
- **Know-how** — accepted wiki, memory, or skill items. Raw transcripts and
  hidden reasoning are not Know-how. Graph is not a knowledge owner.

## Create a workspace and register resources

Work from a project cwd that already has `.metaproject/`. Identity is the local
OS user (`user:local-<uid>`). There is no `--actor` flag; adapters pass
`request: undefined`. There is **no session↔workspace auto-bind**: every later
call takes an explicit `workspaceId`.

Discover the **full** surface with `keryx workspace --help`. `keryx commands`
intentionally omits this verb (Phase 1 local-CLI only).

```bash
keryx workspace --help
keryx workspace create --title "Payments retry" --component ./src/payments
keryx workspace list
keryx workspace add-resource <workspace-id> --kind evidence --uri ./src/payments/retry.ts
keryx workspace add-resource <workspace-id> --kind flow --uri ./.metaproject/flows/<flow>/flow.json
keryx workspace show <workspace-id>
```

`--component` and `--uri` must be workspace-relative (`./…`). Absolute, network,
and escaping paths are rejected. `add-resource` takes `--kind`, `--uri`, and
optional `--revision` — not a positional typed-ref.

## Read a bounded overview, then the detail

```bash
keryx workspace overview <workspace-id> --max-items 20 --max-tokens 2000
keryx workspace read <workspace-id> <item-id>
keryx workspace overview <workspace-id> --explain   # human text on stderr; JSON stays on stdout
```

Defaults: overview `maxItems=32` / `maxTokens=4096`; read `maxItems=1` /
`maxTokens=4096`. If a **mandatory** item cannot fit the budget the operation
returns typed `context_overflow` and **no** access receipt. Optional omissions
are listed. Domain denials (`freshness: "denied"`) are ordinary JSON, not a
tool/CLI crash.

Each allowed or denied progressive access appends a metadata-only receipt to
`.metaproject/context-operations/access-receipts.jsonl` (hash-chained;
`src/sac/receipt-integrity.ts`). Receipts do not store retrieved content,
prompts, or hidden reasoning. FWK results are derived response objects — there
is no persisted `fwk-receipt.json`.

## Propose knowledge on wrap-up, and review it

Propose only from a **completed** keryx session (≥ archived messages). Kinds:
`decision`, `wiki-update`, `memory-entry`, `follow-up`, `contract-change`,
`risk`. `--note` is a one-line sidecar beside the proposal; it is **not**
evidence and is outside the frozen schema (known unbound field).

```bash
keryx workspace propose <workspace-id> --kind wiki-update \
  --session <session-id> \
  --note "Retry uses capped exponential backoff"
keryx workspace review <workspace-id> <proposal-id> --decision accepted \
  --reason "owner accepted" \
  --idempotency-key <key>
```

Review decisions: `accepted` | `rejected` | `dismissed`. Accept is possible only
through the harness composition (`createHarnessProposalLifecycleService`): it
wires real owner writers. The local factory is fail-closed and cannot
self-accept.

| Kind | Owner | Lands under |
|---|---|---|
| `wiki-update` | wiki | `.metaproject/wiki/decisions/` |
| `memory-entry` | memory | `.metaproject/memory/` (same guarded seam as `keryx memory new`) |
| `decision`, `follow-up`, `contract-change`, `risk` | skill | `.metaproject/project-skills/sac/<proposal-id>/` |

A failed owner write becomes `stale`, never `accepted`. The same
`--idempotency-key` replays the original terminal event. Flow wrap-up as a
propose source is **not** wired — only `source: "session"`.

Collaboration is **read-only** on the shipped adapters:

```bash
keryx workspace collaboration <workspace-id>
```

`CollaborationService.record` has no production CLI/MCP caller. Collaboration
and proposal lifecycle both append `activity.jsonl` with incompatible event
shapes — a mixed file can make collaboration overview fail.

## Agent surfaces (MCP and shell)

MCP tools (`src/mcp/tools.ts`), **local stdio / in-process only**. HTTP returns
`{ code: "sac_transport_denied" }` before workspace discovery:

| Tool | Mutating |
|---|---|
| `sac.overview` | no |
| `sac.read` | no |
| `sac.collaboration` | no |
| `sac.propose` | yes |
| `sac.review` | yes |

Harness tools on a local `keryx shell` agent turn (`risk: "read"`). They are
**not** on `keryx serve` / chat-only mode. There is no `workspace_list` tool —
discover ids with `keryx workspace list` via `shell_exec`:

| Tool | Same service as |
|---|---|
| `workspace_overview` | `keryx workspace overview` |
| `workspace_read` | `keryx workspace read` |

CLI and MCP reads share `normalizeFwkResult`. Never-shipped names
(`workspace.fwk`, `workspace.get`, `workspace.proposal create --from-flow`)
are not commands.

## On-disk layout

```text
.metaproject/workspaces/<workspace-id>/
  workspace.json
  proposals/<id>.json
  proposals/<id>.<hash>.{decision,approval,write-intent,write-result}.json
  activity.jsonl
  session-evidence/<sessionId>.md

.metaproject/context-operations/
  access-receipts.jsonl
  access-receipts.checkpoint.json
```

`workspace.json` is the only SAC primary record. Knowledge bodies stay in
wiki / memory / project-skills.

## Advanced: phase-6 runtime opt-in policy (off by default)

By default SAC uses a **deterministic baseline** policy. An optional learned
candidate sits behind `resolvePolicySelection`. It activates only when an
explicit pinned config and a complete integrity chain succeed; any failure is
**fail-closed** back to the baseline.

Config path: `.metaproject/context-operations/policy-experiment/config.json`.

```json
{
  "enabled": false,
  "killSwitch": true,
  "candidateArtifactRef": "./fixtures/sac-policy-experiment/artifacts/candidate.json",
  "candidateArtifactDigest": "<sha256>",
  "candidateVersion": "<immutable-version>",
  "baselineArtifactRef": "./fixtures/sac-policy-experiment/artifacts/deterministic-baseline.json",
  "baselineArtifactDigest": "<sha256>",
  "baselineVersion": "<immutable-version>",
  "corpusRef": "./fixtures/sac-policy-experiment/corpus.json",
  "corpusDigest": "<sha256>",
  "corpusVersion": "<immutable-version>",
  "evaluationReportRef": "./fixtures/sac-policy-experiment/evaluation-report.json",
  "evaluationDigest": "<sha256>"
}
```

Rules the guard enforces:

- **Off by default.** The candidate is selected only when `enabled` is `true`
  **and** `killSwitch` is `false`; a missing config keeps the baseline.
- **Explicit pins.** Every artifact needs a workspace-relative ref, a matching
  `sha256` digest and an immutable version; `latest`/`main`/`head`-style versions
  are rejected.
- **Fixed-order integrity chain.** Baseline → candidate → corpus → evaluation
  report → deterministic activation. Any parse error, digest mismatch, schema
  failure or activation mismatch falls back to the baseline.
- **Rollback.** Rolling back forces `enabled: false` and `killSwitch: true`.

Before flipping `enabled: true`, verify the chain (validates pins even while
disabled; exits non-zero when `integrityReady` is false):

```bash
keryx workspace policy-readiness
```

This path does not change any public CLI or MCP schema and never enables the
candidate implicitly. The operator process for **real** (non-synthetic) artifacts
is in the
[Phase 6b operator playbook](../../requirements/shared-agent-context/phase-6b-operator-playbook.md);
runtime re-ingestion of raw receipts/outcomes is still planned — see
[phase-6-real-opt-in-readiness.md](../../requirements/shared-agent-context/phase-6-real-opt-in-readiness.md).

## Not shipped (do not treat as current)

- Automatic session↔workspace linkage (`--workspace` on `keryx shell`).
- Propose from a Flow wrap-up snapshot.
- SAC over MCP HTTP or `keryx serve`.
- Public collaboration writer / member / archive APIs.
- Phase 6b real-data re-ingestion.
- Satellite RP-01…RP-12 capabilities.

Source reads of workspace files require POSIX `openat` + `O_NOFOLLOW` (macOS /
Linux). There is no Win32 fallback for that path.
