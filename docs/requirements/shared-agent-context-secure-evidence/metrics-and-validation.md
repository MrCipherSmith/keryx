# Shared Agent Context — Secure Minimal Evidence: Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation.** No production security, privacy, or deletion
claim is made until the required owner fixtures and tests pass.

## Required gates

| Metric | Definition | Gate |
|---|---|---|
| Default transcript persistence | Normal wrap-up writes containing full transcript/prompt/reasoning | 0 |
| Schema closure | Candidate writes with forbidden or unknown fields accepted | 0 |
| Sealing integrity | MinimalEvidence records with valid sealed source provenance | 100% |
| Pre-persistence security | Persisted evidence whose exact payload digest and live policy/scanner/minimiser revisions match its scan/minimisation receipt immediately before commit | 100% |
| Trust/sensitivity monotonicity | Derived record upgrades trust or lowers sensitivity | 0 |
| Retention completion | Expired/revoked data with verified deletion/inaccessibility receipt | 100% |
| Archive exception compliance | Archive records lacking all required policy/access/delete fields | 0 |
| Promotion containment | Evidence-to-accepted-knowledge transitions without owner receipt/review | 0 |
| Abuse containment | Abuse-corpus cases that persist prohibited payloads or bypass denial | 0 |

## Minimum fixture matrix

| Area | Required positive and negative fixtures |
|---|---|
| Sealing | Valid sealed terminal session; open/abandoned session; changed terminal revision; consumed nonce; expired/revoked provenance; cross-workspace source. |
| Schema | Valid bounded minimal summary; raw message array; transcript/prompt/hidden-reasoning fields; arbitrary attachment; unknown extension; oversized string; credential/PII marker. |
| Security | Pass; redacted-pass; fail; indeterminate; needs-approval; scanner unavailable; redaction failure; missing digest/revision binding; policy/scanner/minimiser revision mismatch; TOCTOU between scan and write. Every missing or changed binding must deny before commit and persist no candidate payload. |
| Propagation | Trusted/public; lower-trust input; restricted sensitivity; mixed inputs; proposal/receipt/write-intent propagation; prohibited trust upgrade/sensitivity downgrade. |
| Lifecycle | TTL expiry; explicit revoke; successful deletion; crypto-erasure; cache/derivative deletion; deletion-job failure; read after deletion; backup/key deletion evidence for archive. |
| Archive | Disabled default; missing purpose/ACL/key/expiry/delete plan; authorised archive; archive retrieval denial; extract requiring fresh scan; archive expiry/revocation. |
| Promotion | Proposed candidate; self-review denial where policy requires independence; direct writer attempt; missing owner receipt; Flow mutation attempt; auto-promotion attempt. |

## Abuse corpus

Security owns a versioned, access-controlled corpus of synthetic or safely
handled adversarial inputs. It includes secrets and PII markers, prompt
injection/policy-confusion text, hidden-reasoning lookalikes, encoded transcript
fragments, poisoned summary claims, malicious attachments/unknown fields,
cross-workspace provenance, replayed seals, downgrade attempts, deletion-race
cases, and archive-exfiltration attempts. Corpus records contain only the
minimum safe fixture data, expected verdict, policy/scanner versions, and
non-sensitive result digest.

Every policy/schema/minimiser change runs the corpus. A missed containment case
blocks affected rollout, records a minimised incident, and adds a regression
fixture before re-enablement.

## Validation sequence

1. Validate schemas and semantic bounds before scanner invocation.
2. Exercise session seal/provenance and Security scan/minimisation integration,
   including an immediate pre-commit comparison of the exact payload digest
   and live policy/scanner/minimiser revisions; any mismatch must deny with no
   candidate payload persisted.
3. Test lifecycle/deletion in isolated stores and protected archive zone.
4. Run owner-bound proposal/receipt tests proving no automatic promotion.
5. Run the abuse corpus, access-control, replay, and TOCTOU suites.
6. Perform an operator deletion/revocation drill and retain only permitted
   reports; enable a source only when all gates are green.
