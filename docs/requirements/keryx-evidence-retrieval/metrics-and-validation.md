# Evidence Retrieval Metrics and Validation
Version: 0.1.1

## Acceptance matrix
| Fixture class | Assertion | AC |
|---|---|---|
| Disabled/no config | Existing output unchanged, zero ERL I/O/network | 1 |
| Zero lexical overlap | Vector pool discovers paraphrase | 2 |
| Rewrite/delete/revoke/rename | Current citation or withheld diagnostic | 3 |
| Exact/partial/summary/compacted | Only proven final exact excluded | 4 |
| Append/torn record/truncate/model change | Full/incremental equivalence | 5 |
| Publish crash/two writers/readers | One complete generation or refusal | 5 |
| Secret/traversal/symlink/injection | No disclosure/authority/transmission | 6 |
| Oversize/slow embedder/required context | Caps, one search, named outcome | 7 |
| NaN/dims/checksum/ledger fault | Safe refusal/fallback, no deleted recall | 8 |
| Held-out replay | Paired reproducible report | 9 |

## Paired evaluation (planned)
Consented synthetic/local data, ground-truth source/version/span labels, session/
project holdout, frozen input/query/config/model/tokenizer/chunker/hardware hashes.
No secret data. Include answerable/unanswerable/conflicting/paraphrased/current-
visible/compacted-out questions. Compare A: existing accepted-memory tools; B: ERL
lexical; C: ERL hybrid; D: C + exact visibility; E: D + incremental indexing.
Hold ERL source scope/request budget fixed; A has narrower source coverage and must
not be presented as pure ranking comparison. Same queries/seeds, at least three
timing repetitions; paired bootstrap intervals over queries for quality differences.

Report Recall@10/MRR/source precision, grounded-answer rate (blinded review), false
absence claims, duplicate tokens, false exclusions, p50/p95 latency, embedding
calls/tokens, bytes read/indexed and crash recovery time. Target: C improves recall
without lowering grounded-answer rate; D has zero false exact exclusions in fixtures.
Unchanged indexing must make zero embedding calls; append embeds only new/changed
sanitized chunks. No product latency promise before measurement.

## Release decision
Hard zero fixture gates: cross-scope disclosure, secret leaks, stale citations,
false exact exclusions and authority promotion. Quality report includes uncertainty;
inconclusive benefit keeps hybrid/automatic optional. Config/dataset hashes,
commands/outcomes/failures/unsupported providers appear in report. Operator opts
into scope; benchmark cannot silently enable automatic recall by default.

## Documentation check
python3 docs/requirements/keryx-evidence-retrieval/verify.py checks structure,
versions, local links, JSON/schema refs and PRD fields; not runtime behavior.
Verifier does not metaschema-validate or test accepted/rejected payloads. P0 must
perform both; range ordering, hashes, authorization and serialized-byte proof
remain runtime gates. P1 tests every empty-result row, ownership rejection, opaque
replay exclusion, revoked-on-disk source, delete/delivery race and retention.
