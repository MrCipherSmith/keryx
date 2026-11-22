# Specification — OpenSpec in Keryx Metaproject
Version: 0.1.1

Status: Contract for Flow 514. Verification status lives in the Flow journal.

## 1. Ownership and implementation seams

The proposed `openspec` module exposes bounded local reads. Implement its scanner, parser, history, search and link resolver in `src/openspec/`. Explorer v2 composes OpenSpec with existing Graph and Wiki; its relationships are a projection in memory. CLI and Desktop call the same source service. The later Flow operation delegates writes to the Flow owner.

The existing [Explorer implementation](../../../src/integrations/metaproject-explorer.ts) composes Graph and Wiki and exposes [catalog, detail, search and neighbors](../../../src/integrations/metaproject-explorer-contract.ts). [The CLI adapter](../../../src/commands/metaproject-explorer.ts) accepts a bounded request. [The Tauri adapter](../../../apps/desktop/src-tauri/src/metaproject.rs) runs the selected CLI from the project checkout. Preserve that boundary. OpenSpec projection adds no files to the gdgraph database and no pages to Wiki.

[Team Hub import](../../../src/hub/connector.ts) remains a separately invoked path for sharing Markdown. The local source resolves from the selected checkout even if a Hub cache exists. Existing Hub behavior and bindings require no migration.

## 2. Sources and configuration

| Purpose | Path relative to selected checkout |
|---|---|
| Current requirements | `openspec/specs/<capability>/spec.md` |
| Active changes | Immediate directories `openspec/changes/<change>/`, excluding `archive` |
| Archived changes | Immediate directories `openspec/changes/archive/<entry>/` |
| Requirement deltas | `specs/<capability>/spec.md` within an active or archived change |
| Artifacts | `proposal.md`, `design.md`, `tasks.md` and other regular Markdown files within the change |
| Explicit Keryx relationships | Optional `.metaproject/openspec/links.json` |

Presence of a regular `openspec/` directory, including an empty one, enables discovery. Absence produces an actionable empty state. Recognize standard tree layout and Markdown artifacts even in a custom change schema. Follow no path instruction from `config.yaml`, `.openspec.yaml`, custom schemas, templates, Git remotes or the project manifest. Custom store roots, worksets and external references require a separate design. Keryx initialization and upgrades do not create or amend OpenSpec files. There is no required global toggle, installation or migration.

[links-v1.schema.json](schemas/links-v1.schema.json) describes a fully valid link file for authoring and CI. The runtime checks the envelope, version and array length first, then validates each row against the same item rules. A `source` of kind `spec` or `change` names an exact discovered spec file or active/archived change directory. A `target` of kind `wiki`, `file` or `module` names an exact path from the corresponding catalog. The resolver checks normalization, collection membership, containment and duplicates. One invalid row yields a diagnostic for its array index and preserves valid siblings. Unparseable JSON, an invalid envelope or an unsupported version suppresses explicit links and preserves discovery and delta edges.

```json
{
  "version": 1,
  "links": [
    {
      "source": { "kind": "spec", "path": "openspec/specs/pull-request-review/spec.md" },
      "target": { "kind": "wiki", "path": ".metaproject/wiki/architecture/review.md" }
    },
    {
      "source": { "kind": "spec", "path": "openspec/specs/pull-request-review/spec.md" },
      "target": { "kind": "file", "path": "src/review/orchestrator.ts" }
    }
  ]
}
```

## 3. Catalog, identities and source evidence

Conceptual types below specify fields at the service boundary. Transport reuses the Explorer's request/response envelope for Desktop.

| Type | Required fields |
|---|---|
| Catalog | `snapshotId`, availability (`missing\|empty\|ready\|partial\|unavailable`), counts by collection, paged entries, stable diagnostic codes |
| Entry | opaque `id`, `kind` (`spec\|change\|archive`), `title`, normalized `path`, and optional archive date |
| Source reference | relative `path`, 1-based inclusive `startLine` and `endLine` when applicable, SHA-256 of raw file bytes |
| Requirement | title, Markdown body, ordered scenarios, source reference, optional delta operation, section identifier scoped to the entry |
| Scenario | title, rendered body, source reference, section identifier scoped to the entry |
| Change detail | artifact references, addressed capabilities, deltas, related spec results, diagnostics |
| Artifact detail | parent entry, source reference, bounded Markdown, and section anchors when available |
| Search hit | parent entry, source collection, match type, optional section, source reference and bounded plain-text snippet |
| Diagnostic | stable code, safe relative path or link index if available, brief user-readable reason |

- Entry identity is derived from kind and case-preserving checkout-relative path, without depending on a line offset or body hash. Checkout identity is enforced by the request's authorized root and the snapshot. Carry the root key separately in UI state.
- Section identity uses the artifact path, parsed heading text, parent section and occurrence in order. Line numbers are navigation evidence. Identical headings and identical section names in separate change artifacts remain addressable. On refresh, verify the selected section using its file digest or a uniquely matching section and content fingerprint. When the text was renamed, or a changed file leaves duplicate candidates, keep the parent entry and show a stale-section message. An old ordinal alone cannot reopen a changed section.
- Content evidence is based on immutable raw bytes for the lifetime of a response. Normalize line endings for parsing, with source ranges mapped to the original lines. Use the matching document digest when opening a search result.
- Snapshot identity covers the selected root, relevant source identities/digests, link configuration and the Graph/Wiki versions used by the shared projection. Build one coherent snapshot per request. If inputs change during construction, retry once or return an explicit retryable diagnostic with no mixed result. Every v2 follow-up may pin the expected snapshot. A stale pin returns a typed error. The client refreshes once, keeps a surviving entry selection and re-resolves its section.
- Archive entries have distinct path-derived identities. Parse only a valid date prefix as an archive date. Sort known dates descending and undated entries after them, using path for tie-breaks. A date names the archive entry's date, with no assertion about release, merge or deploy dates.
- Missing paths, unreadable source and truncation carry distinct evidence. Keep diagnostics free of raw absolute paths or file contents.

## 4. Parsing, history and navigation

Recognize stock `### Requirement: <title>` and `#### Scenario: <title>` headings and the `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements` and `## RENAMED Requirements` sections. Match operation headings case-insensitively. Read a removal as either a plain requirement heading with optional explanatory bullets or a list item containing the heading, with `-`, `*` or `+` and optional backticks around the heading. Preserve supplied Reason and Migration text in headed removal blocks. Pair the explicit `FROM:` and `TO:` entries in the same rename section. Ignore heading-like text inside frontmatter, fenced examples and HTML comments. Preserve original content for rendering and citations. Unsupported or malformed structures stay readable with source ranges and a diagnostic.

An active delta addresses a capability by its delta path. Show the operation and its requirement. Resolve same-title baseline requirements only if the match is unique in the current spec for that capability; compare the exact parsed title after syntactic trimming, preserving case and interior whitespace. Near matches may be shown as unconfirmed suggestions. For rename, use the explicit source title. An active change with a valid addition to a new capability is browsable with an absent-baseline state. A missing or ambiguous baseline for a modification, removal or rename yields an unresolved state. Active changes without delta files remain browsable. Placeholder requirements are unnecessary.

History on a spec is derived from archived deltas for its capability and lists the original operations and artifacts. Archive detail exposes the recorded delta and any surviving current spec as context. A retired capability remains identifiable within archive details. Archived records never act as current baselines. The initial release draws history from the archive in the checkout; it does not reconstruct previous revisions from Git.

## 5. Relationships and search

| Edge | Direction | Evidence |
|---|---|---|
| `changes-spec` | Active or archived change → current spec | Relative path and digest of the matching capability delta |
| `spec-context` | Spec or change → Wiki page, code file or Graph module | Link file path, array index and digest |

- Graph's existing incoming, outgoing and both controls traverse these directions. Deduplicate by endpoints and edge kind with bounded, deterministic provenance. The detail pane shows evidence alongside the relationship list. Missing target nodes produce diagnostics. Keep details readable if Graph is absent or stale; label Graph freshness and resolve only known graph nodes. Archive nodes are excluded from the default Graph overview, and appear for an explicitly selected archive record or when Archive scope is included.
- Default global search scopes include existing Graph and Wiki plus Specs and Changes. Archive is separately selectable. Always reveal source scope before rendering any spec/change excerpt. Match exact path/title first, heading matches next and body matches after. Interleave equally ranked sources so repeated filenames cannot hide all Wiki or OpenSpec results. Tie-break deterministically by kind, path and section position. Deduplicate by entry and section. Filter views keep the original query. Search results open the source and section and report if the source changed.
- Catalog and search operate on the authorized checkout and are independently capped. List, history and search use stable cursor pages so results past graph projection limits remain discoverable. A search cursor binds the snapshot, the normalized query and the scope set. Other cursors bind the snapshot and collection or spec ID. Return a stale error for a cursor used after a snapshot change and an invalid-input error for a cursor used with different parameters.

## 6. Access surfaces and compatibility

The following commands are proposed. They resolve the current working directory through the existing project root convention and read only that checkout.

| Command | Result |
|---|---|
| `keryx openspec list --kind <spec\|change\|archive> [--cursor <cursor>] [--json]` | Paged entries, availability and diagnostics |
| `keryx openspec show <relative-path> [--artifact <relative-path>] [--section <section-id> --expected-digest <sha256>] [--json]` | Entry or contained artifact detail, source refs and relevant operations |
| `keryx openspec search <query> [--scope <all\|spec\|change\|archive>] [--cursor <cursor>] [--json]` | Ranked hits with snippets and references. The default includes spec and change. Explicit `all` includes archives. |

JSON emits one versioned response on stdout. Use the source digest from search when opening an exact section so duplicate headings cannot silently redirect an old locator. Invalid input, unknown identifiers and unreadable authorized roots get distinct errors rather than an empty success. Missing directory and zero matching results are valid empty states. The project-local Metaproject routing index and a portable read skill route spec questions to these commands. Keryx Shell and other harnesses can invoke the same CLI from a project session. No provider-specific bootstrap is required.

Keep existing unversioned Explorer requests and v1 responses unchanged. Check each new request against a closed allowlist in Rust and TypeScript. A fixed, read-only `capabilities` probe with `version: 2` returns supported actions without scanning the checkout. Cache the outcome only for the selected executable and authorized project. A legacy CLI's generic `Invalid request` from that fixed probe permits v1 fallback only after a successful, schema-valid v1 catalog handshake. A typed unsupported-version error from a newer CLI uses the same v1 handshake. Missing executable, timeout, invalid responses and normal data-request errors render errors. Once the probe succeeds, a v2 error never silently downgrades a read. Older Desktop with a newer CLI keeps v1.

| v2 action | Additions to the shared request model |
|---|---|
| `catalog` and `neighbors` | OpenSpec source state and new graph entities and edges. Existing graph direction, depth and projection limits still apply. |
| `detail` | Optional indexed artifact path, section identifier and digest check for opening an exact result. A change artifact must belong to the selected change. |
| `search` | Optional scope set and snapshot cursor. |
| `openspec-list` | Collection and optional snapshot cursor. |
| `openspec-history` | Selected spec ID and optional snapshot cursor. |

Every data response carries `schemaVersion: 2` and `snapshotId`. Requests may pin `expectedSnapshotId`, and paged calls implicitly pin it through their cursor. A root path is supplied through the existing outer project binding. There is no path override in the inner request. CLI JSON and Desktop boundary validators use the typed shapes in §3. The legacy-probe fixture must exercise the actual v1 argument parser and confirm the v1 handshake, not a fabricated explicit negotiation error.

## 7. Desktop interaction

- Add **OpenSpec** alongside **Graph** and **Wiki** in Metaproject. Use existing project-scoped location, search, selected entity, graph filters and detail surfaces. The OpenSpec tab has **Specs**, **Changes** and **Archive**. Use project-local selection for the open root and remember the last OpenSpec collection within that project.
- Opening a spec shows its requirements and collapsible scenarios, source path, related changes, archived entries and links. Opening a change shows artifacts and a requirement-delta list with text labels for each operation. Open the right section from search. Graph keeps the picked spec or change and highlights the relevant neighborhood instead of fitting the full project after every click.
- Reuse existing Markdown and keyboard patterns, theme tokens and focus indicators. Provide accessible text for edge type and delta operation. From a linked result, the user can navigate back with their original search and selection intact.
- Render missing directory, empty list, no search matches, partial scan, stale graph, unsupported CLI, malformed source and source-read error as distinct states. Use a refresh action for OpenSpec. A graph rebuild is an explicit existing action. Refresh or checkout switch uses generation keys and drops late responses from the previous snapshot, root or query.
- Mark raw HTML inert and suppress remote media/automatic requests. Repo-relative preview navigation must resolve inside the same authorized checkout and to a supported graph or source item. Opening an external link is a separate explicit user action through existing external link handling.

## 8. Limits and failure handling

Use the repo's [contained file reader](../../../src/lib/contained-read.ts) with a test for the filesystem boundary. During discovery reject symlink entries, path traversal, nonregular files and paths outside the selected root, including symlinked directories. Pin input identity across the authorized read and reject entry swaps. Avoid walking unrelated directories. Unknown auxiliary files, template commands and metadata are never evaluated. Use only checkout-local source, with no network fetch or OpenSpec subprocess for discovery or refresh.

Initial budgets for implementation and measurement are 10,000 candidate directory entries per scan, 1 MiB per text file, 64 MiB of total text admitted per snapshot, four concurrent content reads, 100 records per list/search page, 1 MiB per response, and existing Graph limits of 200 projected nodes and 400 edges. Use deterministic traversal, bounded path depth of 12 within `openspec/` and cancellation or request-generation checks. Limits are ceilings with clear partial diagnostics. Reserve scan budget per collection so an archive cannot hide all current specs. Filter and page evidence before serialization. Reuse parsed unchanged content while the local service is alive if profiling justifies it. Do not require a persistent cache for the scoped release. No cache may serve another checkout.

## 9. Draft Flow intake (later increment)

Create is only offered for active changes. Preview is a read and returns a content fingerprint covering the change's included artifacts and addressed current specs, including explicit missing baselines. If a complete fingerprint cannot be calculated, explain why Create is unavailable. Keep a Git HEAD annotation when available and use byte identity as the authority for local uncommitted edits. Each proposed criterion cites a requirement/scenario range. Removed behavior and renamed requirements require operator judgment. The preview shows editable criterion suggestions without adopting them. Artifact text is never interpreted as executable code.

A user-confirmed write re-reads the active change and checks the preview fingerprint before delegating to the existing Flow owner. Store the canonical source paths, owner checkout identity, revision annotation, fingerprint and criterion provenance with the new draft using the Flow owner's mutation protocol. Serialize lookup/create under that owner's lock or equivalent idempotent operation. A retry or simultaneous confirmation for the same canonical source and fingerprint returns the same draft. A newer fingerprint returns source drift for an existing open draft. Offer opening it, or deliberately replacing its source through a separate reviewed update to that draft. A frozen Flow never changes its pinned criteria as a side effect of reading source.

The normal Flow review/freeze/start is unchanged. Read-only callers can preview. The write surface uses the same project ownership and consent checks as other local Flow creation entry points. Tests cover duplicate submission, lost response, an edit between preview and create, an archived/missing source and a frozen existing Flow. Creating or finishing a Flow has no OpenSpec archive/sync side effect.

## 10. Acceptance criteria

Commands name planned test files. CI executes automated criteria when the runtime lands. See the [implementation plan](implementation-plan.md) for the native walkthrough.

### AC1 — Discovery and isolation (R1, R6)

A stock checkout, an empty OpenSpec checkout and a checkout with no OpenSpec return distinct honest states. A second worktree's content stays isolated. Over-budget, unreadable, symlinked and swapped sources return bounded diagnostics, and current Graph/Wiki remain available.

Verification: exec `bun test src/openspec/catalog.test.ts src/integrations/metaproject-explorer.test.ts`

### AC2 — Delta and history semantics (R2)

Fixture includes addition, modification, both removal forms, rename, ignored fenced and commented headings, unknown syntax, case/whitespace near matches, duplicate requirement titles, an active no-delta change, a valid dated archive, undated archive and a retired capability. Source details and line ranges agree with committed bytes.

Verification: exec `bun test src/openspec/history.test.ts`

### AC3 — Search and discoverability (R3, R6)

Query opens the exact matching source section. Active and archived hits are scoped correctly. Large collections paginate; same-name duplicates and a changed snapshot cannot navigate to an unrelated document. Reusing a search cursor with a changed query or scope fails explicitly.

Verification: exec `bun test src/openspec/search.test.ts src/integrations/metaproject-explorer.test.ts`

### AC4 — Graph evidence and bidirectional access (R4)

Fixtures exercise projected specs/changes, inbound/outbound backlinks, stale Graph, missing targets, conflicting input and graph limits. Each edge has validated evidence and no requirement/scenario nodes are emitted.

Verification: exec `bun test src/integrations/metaproject-explorer.test.ts`

### AC5 — CLI and protocol parity (R5)

CLI, Explorer v2 and Desktop return compatible root-scoped identities and source references. V1 requests and responses remain compatible. The mixed-version matrix exercises explicit mismatch, real error and absent CLI.

Verification: exec `bun test src/commands/openspec.test.ts src/integrations/metaproject-explorer.test.ts`

### AC6 — Desktop behavior and safety (R2, R3, R4, R5, R6)

Tests drive selection, scope, focus, compact layout states, stale callbacks, fallback and rendering of malicious Markdown without side effects. Native evidence covers layout and end-to-end plumbing.

Verification: exec `cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx src/platform/metaproject.test.ts`

### AC7 — Packaged Desktop and Shell (R7)

Operator follows the live walkthrough, checks the same scenario in Shell, and records the checkout, sidecar/version, results and large-archive responsiveness. Include evidence of shared search, archive and graph navigation.

Verification: judged

### AC8 — Draft intake and source drift (R8, later)

Repeated submits return one draft, stale previews cannot create a draft, and archived and partial inputs decline with a reason. Frozen criteria remain pinned and the existing Flow lifecycle still works.

Verification: exec `bun test src/flow/openspec-intake.test.ts && (cd apps/desktop && bun test src/metaproject/MetaprojectView.dom.test.tsx)`

## References

- [OpenSpec concepts and archive](https://github.com/Fission-AI/OpenSpec/blob/v2.1.1/docs/concepts.md)
- [OpenSpec requirement block parser](https://github.com/Fission-AI/OpenSpec/blob/v2.1.1/src/core/parsers/requirement-blocks.ts)
- [OpenSpec CLI and validation](https://github.com/Fission-AI/OpenSpec/blob/v2.1.1/docs/cli.md)
- [Keryx Desktop explorer guide](../../docs/guides/desktop-metaproject.md)
- [Keryx Flow acceptance-layer package](../keryx-acceptance-layer/README.md)
