# Wiki + Graph + SAC complementary-stack proof

Flow: `153` · Date: 2026-08-14 · CLI: `keryx 0.2.34` installed from this working tree

This is the single operator document for the complementary stack. Every
architecture claim below is backed by a cited file, CLI capture, or test name.

Workspace used in the live run: `workspace-e1b704272f124ba7`
Proposal: `proposal-a41fc4152ad147e2`
Receipt: `receipt-841f9fedf1614997`

---

## Current state

### What the three layers are

| Layer | Role | Owner files | Control |
|---|---|---|---|
| **Graph** | Structural index: files, imports, symbols, blast radius | `.metaproject/data/gdgraph/storage/{nodes,edges,symbols,calls}.jsonl` | Deterministic. `keryx gdgraph build`. Not knowledge. |
| **Wiki** | Curated long-lived understanding: architecture, domain, decisions | `.metaproject/wiki/**` with `Version` + `Status` | Graph scaffolds drafts (`wiki collect`). Humans/agents enrich prose. `Status: accepted` is human-owned. |
| **Memory** | Accepted lessons, decisions, constraints | `.metaproject/memory/**` | Lifecycle (`draft` → `accepted`). Automatic consumers see accepted/current only. |
| **Flow** | Current work state | `.metaproject/flows/<id>/flow.json` | CLI-owned. SAC never writes it. |
| **Session** | Fast working context of one conversation | user-global session store | Harness-owned. Not knowledge. |
| **SAC** | Bounded Facts / Work / Know-how view + reviewed promotion | `.metaproject/workspaces/<id>/workspace.json`, proposals, access receipts | References owners. Knowledge writes only via guarded owner writers after review. |

SAC know-how kinds are only `wiki | memory | skill`
(`src/sac/fwk-service.ts` `FwkKnowHow`). Graph is not a SAC knowledge owner.
Wiki collect *reads* the graph (`src/wiki/service.ts`) to scaffold pages.

### Runtime cycle (agent → update)

```text
task
  → orient (wiki index + graph map)
  → graph tools (where / blast radius)
  → wiki / memory (how / why / lessons)
  → Flow (current work)
  → implement
  → workspace propose (session wrap-up, one-time capability)
  → workspace review (owner/editor)
  → owner writer (wiki decision | memory entry | skill)
  → versions / receipts / ledger
```

Agent tools actually wired in `src/commands/shell.ts`:

- builtins: `get_cwd`, `read_file`, `list_dir`
- metaproject: `search_code`, `graph_affected`, `memory_search`, `wiki_ask`,
  `graph_path`, `graph_symbol`, `repomap`, `test_related`, `health_status`
- SAC: `workspace_overview`, `workspace_read`
- plus `web_fetch`, `web_search`, `shell_exec`, `ask_user`, `spawn_subagent`

MCP (stdio only): `sac.overview`, `sac.read`, `sac.propose`, `sac.review`,
`sac.collaboration` (`src/mcp/tools.ts`). HTTP returns `sac_transport_denied`.

CLI: `keryx workspace create|list|show|add-resource|overview|read|propose|review|collaboration|policy-readiness`.

Proposal kinds → owners (`ownerFor` in `src/sac/proposal-lifecycle.ts`):

| `--kind` | Owner | Write target |
|---|---|---|
| `wiki-update` | wiki | `.metaproject/wiki/decisions/sac-<proposalId>.md` Version `0.1.0` Status `draft` |
| `memory-entry` | memory | `.metaproject/memory/**` via the same seam as `keryx memory new` |
| `decision`, `follow-up`, `contract-change`, `risk` | skill | `.metaproject/project-skills/sac/<proposalId>/` |

### What is written where (ids / versions)

| Event | Artifact | Id / version that changes |
|---|---|---|
| `workspace create` | `workspaces/<id>/workspace.json` | new workspace id |
| `add-resource` | same manifest `resources[]` | `updatedAt` |
| `overview` / `read` | `.metaproject/context-operations/access-receipts.jsonl` | new `receipt-*` + hash-chain `integrity.recordHash` |
| `propose` | `workspaces/<id>/proposals/<pid>.json` | `status: proposed`, `proposalRevision` |
| session wrap-up | `workspaces/<id>/session-evidence/<session>.md` | sha256 evidence revision |
| `review accepted` | append-only transition + owner file | `toStatus: accepted`; wiki Version `0.1.0`; `targetRef` / `receiptRef` |
| `wiki collect` | draft component pages | `Status: draft`, `Version` from template |
| `wiki enrich` | page prose | `Version` / `Status` only if a credentialed model run succeeds |
| `gdgraph build` | graph storage + artifacts | graph snapshot, not wiki Version |
| `flow *` | `flow.json` | flow `status`, task status, `updatedAt` |

### Fallback as implemented (not the imagined chain)

There is **no** automatic `hosted → local → cache` hop.

| Path | If the primary model is unavailable | Evidence |
|---|---|---|
| `wiki enrich`, narrate/suggest/plan (`runModelTurn`) | **Fail-closed.** No FakeProvider, no write. | `src/harness/provider/single-turn.ts` L9–18; live run below |
| Shell/harness `makeProvider("anthropic")` without key | Offline `FakeProvider` (no network) | `src/harness/provider/make-provider.ts` L52–56 |
| `ollama` | Always treated as credentialed (loopback). **Not auto-selected.** | `hasCredential("ollama")` returns true |
| Graph / wiki collect / wiki ask / memory search / SAC overview | Keep working | live run below |

`keryx wiki enrich --provider anthropic` with no Anthropic key in this run
still printed `model: "deepseek-v4-flash"` because the model id is taken from
shell `auth.json` when `--model` is omitted (`resolveEnrichProviderModel`).
That is display-only: `credentialAvailable: false` and the page is `skipped`.

### Gaps observed before this flow

- PATH `keryx` was **0.2.28**; `workspace` was invisible. Memory constraint
  `stale-installed-keryx-binary` applied.
- Installed `dist/cli.js` resolved SAC schemas as
  `../../docs/...` from `dist/`, i.e. the *parent of the package* → ENOENT.
  `keryx workspace create` was broken on the installed CLI.
- SAC module is opt-in and still **off** (workspace CLI works anyway).
- No wiki page explained the split. SAC guide showed stale
  `propose --summary/--evidence` flags.
- No `src/sac` component wiki page.
- No session ↔ workspace binding (`workspace-context-tool.ts` comment).
- Learned policy experiment is kill-switched (`policy-readiness`).

---

## Planned behavior

- One document (this file) that a human can re-run.
- Facts / Work / Know-how labelled at read time (`--explain`).
- Fail-closed model path + live deterministic-stack proof.
- Schema load works from `src/sac` **and** from installed `dist/cli.js`.
- PATH CLI matches the working tree (0.2.34).
- No invented auto-fallback chain (would violate fail-closed).

---

## Implemented changes

| Change | Why |
|---|---|
| Reinstalled PATH `keryx` from this tree (`bun run build && npm install -g .`) | 0.2.28 hid `workspace`; constraint says PATH is not the working tree |
| `src/sac/fwk-explain.ts` + `workspace overview\|read --explain` | Human F/W/K trace on stderr; JSON stays on stdout |
| `resolveSacNormativeSchemaPath` walks up from `import.meta.url` and cwd | Installed CLI can load schemas |
| `package.json` `files` includes `docs/requirements/shared-agent-context/schemas` | Global install ships the contracts |
| `.metaproject/wiki/architecture/wiki-graph-sac.md` | Architecture page for the split |
| `docs/docs/guides/shared-agent-context.md` propose example | Matches real `--session` / `--kind` / `--note` |
| This runbook | Reproducible expected/actual |

---

## Verification

Focused tests (working tree):

```text
bun test src/sac/fwk-explain.test.ts src/commands/workspace.test.ts \
  src/sac/contracts.test.ts src/sac/wiki-owner-writer.test.ts \
  src/sac/proposal-lifecycle.test.ts
→ 21 + 15 + overlapping files green (0 fail)
```

Named tests that back the claims:

- `explain labels Facts, Work, and Know-how owners without mixing layers`
- `workspace overview --explain keeps JSON on stdout and FWK labels on stderr`
- `normative schema path walks up from a dist-like folder, not a sibling of the package`
- `createRealWikiOwnerWriter.persist writes a real wiki decision page from hash-verified evidence`
- `accepted transition requires guarded target receipt and same-key retry returns it`

### Reproducible scenario (5 steps)

Run from the repo root on `keryx 0.2.34` built from this tree.
Captures live in
`.metaproject/flows/153-2026-08-14-prove-wiki-graph-sac-complementary-stack/verification/`.

#### Step 1 — create workspace

```bash
keryx workspace create --title "Wiki-graph-SAC proof (flow 153)" --component ./src/sac/service.ts
```

| | |
|---|---|
| **Expected** | JSON workspace, `status: active`, resource `component: ./src/sac/service.ts` |
| **Actual** | `id=workspace-e1b704272f124ba7`, `status=active`, component bound |

Before the schema-path fix the same command on installed `dist/cli.js` failed:

```text
ENOENT: .../goodea/docs/requirements/shared-agent-context/schemas/workspace-manifest.schema.json
```

#### Step 2 — bind wiki, memory, flow, evidence

```bash
WID=workspace-e1b704272f124ba7
keryx workspace add-resource "$WID" --kind wiki --uri ./.metaproject/wiki/architecture/wiki-graph-sac.md
keryx workspace add-resource "$WID" --kind memory --uri ./.metaproject/memory/constraints/stale-installed-keryx-binary.md
keryx workspace add-resource "$WID" --kind flow --uri ./.metaproject/flows/153-2026-08-14-prove-wiki-graph-sac-complementary-stack/flow.json
keryx workspace add-resource "$WID" --kind evidence --uri ./.metaproject/flows/153-2026-08-14-prove-wiki-graph-sac-complementary-stack/description.md
```

| | |
|---|---|
| **Expected** | Manifest lists five resources; nothing copied into SAC |
| **Actual** | `component`, `wiki`, `memory`, `flow`, `evidence` URIs only |

#### Step 3 — overview with F/W/K trace

```bash
keryx workspace overview "$WID" --explain
```

| | |
|---|---|
| **Expected** | JSON + stderr labels: Facts from evidence, Work from flow.json, Know-how wiki=1 memory=1; receipt id |
| **Actual** | `freshness=fresh` · Facts 1 · Work `bound` snapshot `in-progress` next `T1..T7` · Know-how wiki + memory · `receipt-841f9fedf1614997` decision `allowed` |

Explain excerpt (actual stderr):

```text
SAC explain (FWK — Facts / Work / Know-how)
  freshness: fresh
  receipt: receipt-841f9fedf1614997  decision=allowed
  Facts (1) — evidence-linked, task-local; not durable knowledge
  Work (bound) — Flow projection only; SAC does not write flow.json
  Know-how (2: wiki=1 memory=1 skill=0) — references to owning stores, not SAC copies
  Not written here: graph nodes/edges (navigation only), session transcripts, hidden reasoning.
```

#### Step 4 — fallback: model refuses, stack continues

```bash
ANTHROPIC_API_KEY= keryx wiki enrich --force --limit 1 --provider anthropic --dry-run --json
keryx gdgraph affected src/sac/service.ts
keryx wiki status
keryx memory search "stale installed keryx binary" --status accepted
```

| | |
|---|---|
| **Expected** | Enrich: `credentialAvailable: false`, page `skipped`, `enriched: 0`. Graph/wiki/memory still return data. |
| **Actual** | `skipped: 1` reason `no credential for provider "anthropic"`. Graph listed SAC deps + `src/mcp/tools.ts`. Wiki `total pages: 45`. Memory hit #1 is the stale-binary constraint. |

What continues: graph query, wiki status/read, memory search, SAC overview/review.
What degrades: model-backed enrich/narrate/suggest/plan. No silent local-model hop.

#### Step 5 — propose from a real session, accept, owner write

Needs a session with ≥2 archived messages (`keryx sessions list`). This run used
`efdc4c01` (“SAC harness integration demo”).

```bash
keryx workspace propose "$WID" --kind wiki-update --session efdc4c01 \
  --note "SAC complements wiki and graph; it does not replace them."
keryx workspace review "$WID" proposal-a41fc4152ad147e2 \
  --decision accepted \
  --reason "Proof: wiki-update lands in wiki owner, not SAC store." \
  --idempotency-key flow-153-wiki-update-1
```

| | |
|---|---|
| **Expected** | Proposal `proposed` then transition `accepted`. Wiki owner file created. SAC store still has only references. |
| **Actual** | `proposal-a41fc4152ad147e2` → `toStatus: accepted`. Written: `.metaproject/wiki/decisions/sac-proposal-a41fc4152ad147e2.md` Version `0.1.0` Status **`draft`**. `targetRef=./wiki/decisions/sac-proposal-a41fc4152ad147e2.md`. |

The page summary is the propose `--note`. Provenance links the hash-verified
session export. SAC did not become the wiki.

---

## Findings & next steps

### Can this be called innovative?

The pieces separately are known: code graphs, project wikis, agent memory,
task trackers, proposal queues. The uncommon combination is:

1. **Hard ownership split** with fail-closed promotion (SAC cannot accept its
   own write; Flow cannot be mutated through SAC; graph is never “knowledge”).
2. **FWK** (Facts ≠ Work ≠ Know-how) as a typed read contract with receipts,
   freshness, and budget overflow — not one embedding store.
3. **Owner writers** that reuse the existing wiki/memory/skill security seams
   instead of a new durable store.
4. **Deterministic stack stays up** when the model is gone.

Closest analogues and the difference:

| Analogue | Difference |
|---|---|
| Mem0 / Zep / Letta memory | Those *are* the store. SAC is not; wiki/memory stay owners. |
| Cursor/Claude memories + rules | Session/user scoped, no reviewed promotion into a versioned wiki. |
| Sourcegraph / graphify | Graph only. No FWK, no proposal receipt. |
| Aider/Cline repo map | Prompt packing, not a durable collaboration object. |
| Notion/ADR + GitHub issues | Human workflow. No typed Facts/Work/Know-how receipt or owner write-intent. |

### Residual gaps (explicit)

| Item | Status |
|---|---|
| No automatic hosted → ollama → cache | **By design.** Fail-closed. Do not add without a new AC. |
| `sac` module still default-off | Design. CLI works without enabling it. |
| No `src/sac` component wiki page | Deferred. Architecture page covers the split. |
| No `--workspace` on `keryx shell` | Agent must pass `workspaceId` every call. |
| Learned policy experiment off | `policy-readiness.integrityReady=false`. Out of scope. |
| Enrich `--page wiki-graph-sac` matched **zero** pages | Use `--page architecture/wiki-graph-sac` or `--force`. Slug matching is suffix-based; this page is accepted so default draft select misses it. |
| Enrich prints shell `model` even when provider has no key | Cosmetic. `credentialAvailable` is the gate. |
| Session evidence is a transcript export inside the workspace | Required for hash-verified wrap-up. Do not treat it as Know-how. |
| Decision page lands as `Status: draft` | Correct: review writes a candidate wiki page; wiki acceptance is a separate owner step. |

### Article prompt

```text
Write a short technical essay: “Shared Agent Context is not another memory.”

Thesis: Keryx splits agent context into three owned layers — a deterministic
code graph (structure), a versioned project wiki + accepted memory (durable
knowledge), and Shared Agent Context (a local Facts/Work/Know-how view with
reviewed promotion). SAC does not store knowledge; it references owners and
can only land a wiki/memory/skill write after an append-only review that
returns a correlation-bound owner receipt.

Prove it with this run (do not invent numbers):
- keryx 0.2.34, workspace-e1b704272f124ba7
- overview --explain: Facts 1, Work bound to flow 153, Know-how wiki=1 memory=1, receipt-841f9fedf1614997
- wiki enrich without Anthropic key: credentialAvailable false, skipped 1, enriched 0; gdgraph/wiki/memory still answered
- propose wiki-update from session efdc4c01 → review accepted →
  .metaproject/wiki/decisions/sac-proposal-a41fc4152ad147e2.md Version 0.1.0 Status draft

Contrast Mem0/Zep (the store is the product), Cursor memories (no owner write
receipt), and repo maps (prompt packing). End with the rule: if the model
disappears, navigation and accepted knowledge still work; only generation stops.
```

---

## Routing audit

- `graph_used`: `keryx gdgraph affected src/sac/service.ts`, repomap, wiki collect relationship
- `wiki_used`: index, src-wiki, src-memory, src-gdgraph, new architecture/wiki-graph-sac
- `ctx_used`: `keryx ctx rg` over src/sac, src/wiki, src/commands, src/harness
- `raw_rg_used`: no
- `memory_used`: stale-installed-keryx-binary (PATH reinstall)
