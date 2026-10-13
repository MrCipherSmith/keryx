# Evidence Retrieval Specification
Version: 0.1.1

## 1. Identity and invariants
Planned module src/evidence/, facade src/evidence/service.ts. Raw relevance is
never truth or acceptance; all items use trustedAsPolicy=false. ERL must not call
memory mutations, wiki enrichment, SAC acceptance or automatic Seed creation.
Verification: judged

## 2. Configuration and storage (planned)
.metaproject/evidence.json follows [configuration schema](schemas/config.schema.json).
Absent config means disabled. Normative defaults: enabled=false, automatic=false,
mode=lexical, roots=[], sessionArchives=false, maxSourceBytes=8 MiB,
maxIndexBytes=256 MiB, maxChunks=100000, maxResults=10, maxTokens=2000,
timeoutMs=1000. Runtime applies defaults; schema annotations alone do not.
Hybrid resolves an approved embedding capability; credentials/remote consent
remain outside project config. Local mode must never start a remote client.

Derived .metaproject/data/evidence/ contains CURRENT, invalidations.jsonl,
generations/<id>/{manifest.json,sources.jsonl,chunks.jsonl,vectors.jsonl} and
staging/. Chunks store sanitized text, never full source copies/credentials.
Manifest binds schema, canonical project/worktree identity, config/source-set hash,
chunker/tokenizer/sanitizer versions, adapter/model/revision/dimensions, counts
and SHA-256 of every member. CURRENT binds generation and manifest SHA-256.
Vectors and locators remain sensitive; restrict artifact permissions.
Verification: judged

## 3. Sources, chunking and identity
Adapters: project-owned session archives via existing store readers and explicit
project-relative UTF-8 files. File roots must remain inside canonical checkout;
recheck realpath containment, traversal and symlink escape on every read. Session
adapter may use configured keryx data directory outside checkout, but must confine
reads to dedicated session storage root and verify canonical project/worktree
ownership from metadata. Ambiguous/missing ownership refuses archive. Index only
decoded textual user/assistant messages and tool input/output fields through a safe
text reader. Opaque provider replay payloads/credentials excluded. No user-global
archive scan or implicit home/forks/.git/dependency scan.
Project identity binds canonical root and worktree scope; moved roots need explicit
rebind/rebuild. No cross-project vector reuse.
SourceId binds project+adapter logical key; versionHash hashes full raw source
bytes. ChunkId binds SourceId+versionHash+locator+sanitized-content hash+chunker.
Embedding reuse key binds sanitized content hash+sanitizer+model identity/dims,
within one project; rename may reuse vector but must replace citation identity.
Use full SHA-256, never shortened cache hashes.
Append changes full source hash: rebind all retained record/chunk citations and
ChunkIds to new verified version, including old records, without reembedding
unchanged sanitized text. Incomplete tails are hashed but not indexed as records.

File locators: inclusive 1-based lines and UTF-8 byte ranges [start,end).
Archive: stable record ID plus byte range within that record. If no durable ID
exists, persist ordinal+raw-record-hash mapping, invalidated on source rewrite;
timestamp/session prefix alone is insufficient. Only complete JSONL records.
Tool spill is a separately allowlisted source linked to a record, not inferred
from preview. Summaries are separate evidence, not coverage of original messages.
Chunking is deterministic, paragraph/record aware, target 400 tokens, hard cap
600, overlap <=50. Pin estimator version; split oversize records on UTF-8 boundaries.
Scan/redact before lexical indexing, embedding, cache and display; failure refuses
source. Locator points to original bytes while contentHash binds sanitized excerpt;
redaction=applied explicitly denotes nonidentical original/display bytes.
Verification: judged

## 4. Search service and algorithm
Planned seam search({project,query,filters,budget,projection?},deps): injectable
clock, approved embedder, scanner, tokenizer, source readers and index repository.
Search is read-only; no background rebuild or query cache writes. Query <=8192
UTF-8 bytes; embedding query is a consented bounded operation, not permission grant.
1. Validate runtime scope/config/query and load one committed generation.
2. Verify manifest/checksums/project/schema; apply invalidation ledger and source
   access/version checks. Unknown ledger refuses retrieval, never serves cached text.
3. Independently rank lexical BM25 candidates and hybrid cosine candidates, each
   pool <=100. Strict same model/revision/dims and finite vectors. Union then
   reciprocal-rank fuse sum(1/(60+rank)); tie SourceId then locator. Lexical-only
   uses pinned lexical rank. Zero lexical overlap cannot eliminate vector candidates.
4. Deduplicate same source/version spans, suppress only proven exact visible spans.
5. Revalidate selected source+locator+hash, reapply security, pack complete bounded
   excerpts. Oversize item skipped with diagnostic, never silently clipped citation.
6. Enforce result count, token budget, index/query work bounds and final prompt caps.

[Search result schema](schemas/search-result.schema.json) is normative v1 shape.
Codes: ok (>=1 item), no-match (eligible indexed corpus searched), index-absent,
disabled, budget-exceeded, source-unavailable, timeout. Non-ok returns no items.
Semantic unavailable/error -> lexical with semantic-fallback diagnostic.
Corrupt/incompatible generation -> source-unavailable with index-corrupt or
index-incompatible; explicit rebuild required. Changed source withheld with
stale-source; denied/unreadable/removed sources withheld, coverage=partial.
Coverage=full means only configured eligible indexed scope, never all history.
Use coverage=unknown on unavailable/disabled/index-absent/timeout/budget refusal.
Filtered exact-visible candidates produce visible-filtered diagnostic rather than
an implication that historical content never existed. Diagnostics are finite
reason codes from schema enum, never source text, queries or secret paths.
Counts belong to separate content-free counters, not free-form diagnostics.

Empty-result table after disabled/index/corruption/timeout checks:

| Condition | code | coverage | Diagnostic |
|---|---|---|---|
| Configured indexed scope genuinely empty | no-match | full | empty-corpus |
| Nonempty catalog, all sources withheld | source-unavailable | unknown | source reason(s) |
| Eligible corpus searched, no hits | no-match | full or partial | withholding reasons if partial |
| All valid hits exact-visible | no-match | full or partial | visible-filtered |
| Valid nonvisible hits all exceed packing budget | budget-exceeded | unknown | packing-budget |
| Hits lost during delivery revalidation, none remain | source-unavailable | unknown | source reason(s) |

Any valid deliverable item yields ok; omitted oversized items carry packing-budget.
No-match with visible-filtered means no additional evidence, not no history.
Partial requires an eligible source searched and another withheld; full means none
withheld in configured indexed scope. Withholding reasons: source-denied,
source-removed, source-unreadable, retention-expired, stale-source. Other reasons:
semantic-fallback, index-corrupt, index-incompatible, ledger-unavailable,
visibility-unstable, index-absent, disabled, query-budget, query-timeout.
source-unavailable/disabled/index-absent/timeout/budget-exceeded use unknown;
ok/no-match use full or partial. Generation null before load, otherwise pinned
ID including subsequent refusal.
Verification: judged

## 5. Final-request visibility
[Visible projection schema](schemas/visible-projection.schema.json) defines an
ephemeral artifact, not accepted knowledge. Never reuse trusted context manifest's
available-source mechanism unchanged: it currently marks available policy sources
trusted. New raw sources remain untrusted in every serialization.
Build projection after bounded history, redaction, truncation and provider-specific
serialization. requestHash binds exact ordered model message content including
system/user/tool/context messages, excluding transport credentials; providerAdapter
binds serialization version. Bind each span to SourceId/versionHash/locator and
exact sanitized span hash. Only coverage=exact can suppress wholly covered identical
bytes. Partial, summary, unknown or differently transformed spans retain candidates.
Proof requires matching serialized span bytes, not topic/filename/session prefix.
Same-session compacted-out messages remain recallable; exact older visible messages
may suppress. Unsupported provider adapters emit unknown, not heuristic exact.

Auto pipeline reserves evidence budget in base request, freezes projection, searches
once, inserts untrusted evidence, then verifies suppression against final projection.
If final assembly evicted a suppressing span, undo that suppression and repack once
from original candidates without extra search/network. Still unstable -> omit auto
evidence with visibility-unstable diagnostic; no fixpoint loop. Evidence cannot evict
latest user or required policy. Manual search does not require a projection.
Verification: judged

## 6. Surfaces and integration (all planned)
- keryx evidence index [--full]: approved mutation, progress/outcome metadata.
- keryx evidence search <query> [--json]: bounded explicit read-only retrieval.
- keryx evidence status: counts/state/model only, no excerpt bodies.
- keryx evidence clear: approved deletion of derived store, not sources.
- evidence_search {query,limit?}: read-only harness tool; runtime owns roots,
  project, security, projection and budget. Agent cannot grant arbitrary file access.
No memory_search flag silently merging accepted/raw results. Integrate through
src/session/store.ts (archive reader), src/session/bounded-request.ts (bounded
assembly), provider serializer seams (actual payload), existing embedding capability
resolution, scanner/output protection and harness tool registration. Check exact
HEAD call sites before coding; do not copy unchecked memory embedding cache.
Forgetting/session deletion must notify ERL before source-owner deletion success.
Verification: judged

## 7. Acceptance criteria
- AC1/R1,R7: disabled mode preserves prompt/memory output and performs no ERL I/O.
- AC2/R2: zero-overlap semantic fixture discovered, deterministic fallback.
- AC3/R3,R6: citations reproduce sanitized text; stale/deleted/revoked withheld.
- AC4/R4: final exact suppressed; partial/summary/compacted-out retained.
- AC5/R5: incremental=fresh; no mixed generations under crash/concurrency.
- AC6/R7: traversal/secret/injection/remote-consent adversarial gates pass.
- AC7/R8: one auto search per turn, required-context and request caps intact.
- AC8/R9: corrupt/model/dims/ledger faults have named safe outcomes.
- AC9/R10: paired evaluation and rollout decision, no unsupported benefit claim.
Verification: judged

Normative detail: [policies](policies.md), [lifecycle](artifact-lifecycle.md),
[agent protocol](agent-protocol.md), [implementation](implementation-plan.md),
[validation](metrics-and-validation.md). Schema shape does not prove semantic,
privacy, identity, range-order or payload-hash invariants; runtime tests must.
