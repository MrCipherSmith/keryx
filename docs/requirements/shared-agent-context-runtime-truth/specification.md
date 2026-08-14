# Shared Agent Context Runtime Truth — Specification
Version: 0.1.0

## Module identity

Package ID: `shared-agent-context-runtime-truth` (`SAC-RT`). It is a corrective
requirements layer for SAC and Context Operations. It does not own source
content, authorization, Flow state, or durable knowledge.

## Ownership

| Concern | Owner | SAC-RT responsibility |
|---|---|---|
| Source authenticity and detail | Flow, Evidence, Wiki, Memory, Skills | Consume typed descriptors and bounded detail. |
| Authorization and visibility | SAC authorization/Security | Plan only over already authorized descriptors. |
| Retrieval planning | Context Operations deterministic policy | Produce a closed, versioned plan. |
| FWK projection | SAC | Materialize exactly the assembled selection. |
| Trace | Context Operations | Persist canonical assembly decision metadata. |
| Access receipt | SAC | Bind authorization, plan, assembly, freshness, and measured cost. |

## Future storage structure

```text
.metaproject/context-operations/
  plans/<plan-id>.json              # metadata-only, regenerable
  traces/<trace-id>.json            # canonical assembly trace
  access-receipts.jsonl             # existing receipt ledger
  migrations/sac-item-ids-v1.json   # optional old-to-new ID aliases
```

Plans and traces contain IDs, revisions, reasons, and budgets only. They never
contain source bodies, prompts, hidden reasoning, secrets, or hidden-reference
names.

## Configuration shape

Future deterministic configuration:

```json
{
  "schemaVersion": "1.0",
  "policyRevision": "deterministic-fwk-v2",
  "mandatory": {
    "identity": true,
    "scope": true,
    "policies": true,
    "explicitItemIds": []
  },
  "optionalOrder": [
    "task-relevance",
    "source-trust",
    "freshness",
    "applicability",
    "stable-id"
  ],
  "defaultBudget": { "maxItems": 32, "maxTokens": 4096 },
  "detail": { "maxItems": 1, "maxTokens": 4096 }
}
```

Unknown major versions fail closed to the last supported deterministic
baseline. Configuration never contains role grants or security decisions.

## Data contracts

### `ContextDescriptor`

Required fields:

- `stableId`: opaque deterministic identifier;
- `kind`: `fact | work | know-how`;
- `owner`: source owner ID;
- `canonicalRefHash`: non-reversible reference binding where disclosure is not
  authorized;
- `observedRevision` and current `ownerRevision` when available;
- `trust`, `freshness`, `applicability`, and estimated token bound;
- `mandatoryReason` only when explicitly mandatory.

### `RetrievalPlan`

- plan ID and schema version;
- request correlation ID and workspace revision;
- deterministic policy/config revision;
- baseline-authorized IDs in stable order;
- mandatory IDs and reasons;
- optional ordered IDs with public reason codes;
- budget;
- selected and omitted IDs;
- plan digest.

The candidate plan, when enabled for a shadow or eligible experiment, may only
return a subset and order of `baselineAuthorizedIds`. It does not alter the
mandatory core.

### `FreshnessState`

- `fresh`: observed revision equals current owner revision and TTL is valid;
- `changed`: the source exists and its current revision differs;
- `stale`: a policy or owner marks the observation unusable;
- `expired`: observation TTL elapsed;
- `withdrawn`: owner withdrew accepted knowledge;
- `untracked`: no durable observed revision exists;
- `denied`: current actor may not discover or read the source.

`untracked` never upgrades to `fresh` by comparing a newly computed digest with
itself.

### Stable IDs

The ID derivation input is a versioned canonical tuple:

```text
schema-major | workspace-id | owner | kind | canonical-owner-reference
```

The public ID is an opaque digest-derived token. It excludes array position,
display title, mutable status, and current content bytes. A canonical reference
change creates a new ID; a content revision does not.

### Detail result

A progressive result is one of:

- `detail`: bounded redacted owner content plus provenance metadata;
- `metadata-only`: the owner intentionally exposes no body;
- `changed | stale | expired | withdrawn | denied`;
- `context_overflow` when the one mandatory requested item cannot fit.

The body is transient response content. It is not copied into the plan, trace,
or receipt.

### Cost

Each dimension is either a non-negative measured value with `source` and
`precision`, or `{ "state": "unknown", "reason": "..." }`. Numeric zero is
valid only when directly measured.

## Future public surface

Existing command names remain compatible:

```text
keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N]
keryx workspace read <workspace-id> <stable-item-id> [--max-tokens N]
```

Future diagnostic commands:

```text
keryx workspace explain <workspace-id> <item-id-or-receipt-id>
keryx workspace replay <receipt-id>
```

MCP and shell expose equivalent read-only operations. Public callers may not
submit role, visibility, trusted source status, or a candidate-selected ID set.

## Processing sequence

1. Resolve trusted actor and current workspace role revision.
2. Ask source owners for authorized metadata descriptors.
3. Construct the independent deterministic baseline plan.
4. Optionally evaluate a candidate subset in shadow or eligible mode.
5. Validate candidate closure against the baseline and mandatory core.
6. Execute the chosen plan through canonical Context Operations assembly.
7. Materialize only assembled IDs into FWK.
8. Measure or mark unknown cost.
9. Persist trace and minimal receipt.
10. Return normalized output through the selected adapter.

## Integrations

- **Context Operations:** owns plan/assembly policy and trace format.
- **SAC:** owns workspace authorization, FWK materialization, and receipt.
- **Source-owned projections:** supplies typed descriptors and bounded detail.
- **Security:** supplies current strict read/egress decision and redaction.
- **Policy experiment:** remains advisory and subset-only.
- **Unified operations:** later derives CLI/MCP/shell adapters from one registry.
- **Receipt operability:** later adds retention, replay, pruning, and SLOs.

## Compatibility and migration

- Existing positional IDs are accepted as read-only aliases for one declared
  migration window and resolve only when the old manifest revision matches.
- Old receipts remain historical and are never rewritten to new IDs.
- The first corrected default may be released behind `deterministic-fwk-v2`.
- Rollback selects the previous deterministic policy and disables candidate
  execution; it never widens authorization.

## Acceptance criteria

- **AC-01:** baseline IDs are independently computed from the authorized
  request; no candidate report field is reused as the baseline set.
- **AC-02:** a candidate strict subset changes the actual assembled and returned
  manifest by exactly that permitted subset.
- **AC-03:** unknown, duplicate, hidden, or mandatory-removing candidate output
  fails closed to the deterministic plan.
- **AC-04:** with 33 optional descriptors and item budget 32, the result is
  `partial` with exactly one omitted stable ID.
- **AC-05:** mandatory overflow returns only typed `context_overflow` and no
  successful FWK manifest.
- **AC-06:** resource reordering, insertion, and deletion never retarget an
  existing stable ID.
- **AC-07:** changed unpinned content is `untracked` or `changed`, never fresh.
- **AC-08:** progressive detail contains bounded owner-sanitized content or an
  explicit metadata-only outcome.
- **AC-09:** every cost dimension is measured with provenance or unknown; no
  fabricated zero is accepted.
- **AC-10:** explanation/replay does not reveal hidden IDs, refs, or bodies.
- **AC-11:** CLI, stdio MCP, and shell return semantically equal normalized
  results for the same actor, workspace revision, plan, and budget.
- **AC-12:** SAC-disabled behavior remains unchanged, and rollback restores the
  pinned deterministic baseline.
