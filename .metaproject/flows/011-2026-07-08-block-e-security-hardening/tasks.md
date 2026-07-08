# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

Maps the block spec's T1–T27 (docs/requirements/roadmap-2026/E-security-hardening/tasks.md)
onto flow task units. Phase 1 = deterministic early wins; Phase 2 = opt-in models on the backends seam.

| ID | Kind | Title | Spec tasks | Satisfies |
|----|------|-------|-----------|-----------|
| T1 | context | Study security module (config/resolve/detect/agent-hooks) + Block 0 seam/assets (done Phase 1) | — | — |
| T2 | implement | E2 exfil: `policies.egress.allowlist` config + `detect/exfil.ts` (image/link/img, redactable url) + extend `detect/egress.ts` (non-allowlisted-domain deny-by-default + ssrf-metadata) + wire into runDetectors | T2–T5 | AC2, AC3, AC4 |
| T3 | implement | E4-checksum PII: pure validators in `detect/pii.ts` (IBAN mod-97, Luhn, SSN, IP range) gating regex candidates; typed masks | T8 | AC5 |
| T4 | implement | E5 multi-runtime hooks: `agent-hooks/runtimes.ts` registry (cursor/windsurf/generic-mcp) + generalize sentinel installer (install/uninstall --runtime), merge-safe/idempotent | T10, T11 | AC8 |
| T5 | implement | E6 eval harness: `eval/harness.ts` (per-detector FN rate, deterministic report) + `security eval --corpus --with-model` CLI (non-zero exit on breach) + thresholds.json | T14, T15 | AC9 |
| T6 | implement | E1 injection model: `backends.injectionModel` config + prompt-guard-2 assets + `detect/injection/adapter.ts` CapabilityAdapter (lazy import, never throws) + runDetectors merge (regex + model, catch → deterministic) | T17–T20 | AC7 |
| T7 | implement | E4-NER: wire `backends.piiModel` + `detect/pii/ner-adapter.ts` over resolveCapability; merge NER when available, no-op fallback | T22, T23 | AC6 |
| T8 | test | Fixtures + tests: exfil/, structured-pii/, injection/, secret/, thresholds.json; 100% flagged/benign-not, checksum valid/invalid, hooks merge-safe/idempotent, FN-rate gate + seeded-regression flip, availability true/false, CI eval job, package-wide byte-identical + no-network | T1,T6,T7,T9,T12,T13,T16,T21,T24,T26 | AC1..AC10 |
| T9 | docs | E3 cross-ref (Block A scan-mcp/redactRaw, no code) + roadmap-2026 README status (Block E ✅ landed = roadmap complete) | T25, T27 | AC10, AC11 |
| T10 | review | Adversarial review (byte-identity / no-top-level-import / no-network / leak-safety / never-throw) + draft PR | — | AC1, AC11 |

## Notes
- **Golden rule is the block-completion gate:** T8's package-wide byte-identical (all backends off + no assets) + no-network sandbox tests (AC1) must be green.
- E2/E4-checksum/E5/E6 are deterministic early wins (no Block A dep). E1/E4-NER are opt-in models on the pre-existing `backends` seam + Block 0 Asset Resolver.
- E3 (scan-mcp) already shipped in Block A — cross-reference only here, NO Block E code.
- `dependencies` stays `{}`; any new model runtime under `optionalDependencies`, lazy `await import` inside adapters (static guard extended). Empty `egress.allowlist` ⇒ today's behavior. Leak-safety unchanged/stronger.
