# Tasks: Block E — Security Hardening

Version: 1.0.0
Atomic tasks T1..Tn. **Kinds**: `impl` (code), `test`, `fixture`, `config`, `docs`, `ci`.
**Deps** reference Block 0 (`B0`), Block A (`BA`), and prior Block E tasks. Sequencing follows
`README.md`: E2 / E4-checksum / E5 / E6 are **deterministic early wins**; E1 / E4-NER are opt-in on
the `backends` seam; E3 is in Block A (referenced).

## Preconditions

- **B0** delivered: `resolveCapability(cwd, id) → Adapter | null`, `resolveAsset(cfg, id)` +
  `assets.lock.json`, `optionalDependencies` policy, and the fixture-corpora harness convention.
- Shipped `src/security/` present (`detect/*`, `config.ts`, `resolve.ts`, `guard.ts`, `service.ts`,
  `agent-hooks.ts`).

---

## Phase 1 — Deterministic early wins (no Block A dependency)

### E2 — Modern exfil coverage (G-E2)
- [ ] **T1** `fixture` — `fixtures/exfil/`: labeled markdown-image / reference-link (EchoLeak,
  CVE-2025-32711), non-allowlisted-domain, and SSRF/metadata vectors + benign controls. Deps: B0. → AC2.1, AC2.4, AC-F.1
- [ ] **T2** `config` — extend `mergeSecurityConfig` + `SecurityConfig` type with
  `policies.egress.allowlist: string[]` (default `[]`), deep-merged; malformed JSON ⇒ defaults.
  Deps: —. → AC2.2, AC2.3
- [ ] **T3** `impl` — `detect/exfil.ts`: markdown inline/reference image+link + `<img>` detectors →
  `category:"egress"`, redactable `mask:"url"`; deny-by-default against `egress.allowlist`. Deps: T2. → AC2.1
- [ ] **T4** `impl` — extend `detect/egress.ts`: deny-by-default `egress.non-allowlisted-domain`
  (host ∉ allowlist, proximity-independent) + `egress.ssrf-metadata` (RFC-1918, `127/8`,
  `169.254/16`, `169.254.169.254`, `metadata.google.internal`); empty allowlist ⇒ today's behavior.
  Deps: T2. → AC2.2, AC2.3, AC2.4
- [ ] **T5** `impl` — wire `detectExfil` into `runDetectors` under `policies.egress.enabled`. Deps: T3, T4. → AC2.1
- [ ] **T6** `test` — unit tests over `fixtures/exfil/`: 100% enumerated vectors flagged, benign not;
  redactability of image/link spans; allowlist deny-by-default + empty-allowlist back-compat. Deps: T1, T5. → AC2.1–AC2.4

### E4-checksum — Structured PII validators (G-E5)
- [ ] **T7** `fixture` — `fixtures/structured-pii/`: valid- and invalid-checksum IBAN/CC + well-formed
  and malformed SSN/IP, labeled. Deps: B0. → AC4.1, AC4.2, AC-F.1
- [ ] **T8** `impl` — add pure validators to `detect/pii.ts`: IBAN mod-97, credit-card Luhn, SSN
  area/group/serial validity, IPv4/IPv6 range; each gates its regex candidate; typed masks
  (`iban`/`cc`/`ssn`/`ip`). Deps: —. → AC4.1, AC4.2
- [ ] **T9** `test` — assert valid-checksum flagged, **invalid-checksum NOT flagged** (false
  positives eliminated), fixed-width masking preserved. Deps: T7, T8. → AC4.1, AC4.2, AC0.3

### E5 — Multi-runtime hooks (G-E4)
- [ ] **T10** `impl` — `agent-hooks/runtimes.ts`: per-runtime `{ id, settingsPath, render(),
  validate() }` registry for `cursor`, `windsurf`, `generic-mcp` (Claude Code = existing). Deps: —. → AC5.1
- [ ] **T11** `impl` — generalize `agent-hooks.ts` sentinel installer over the runtime registry
  (`install/uninstall --runtime <...|all>`), preserving the merge-safe/idempotent algorithm. Deps: T10. → AC5.2, AC5.3
- [ ] **T12** `test` — per-runtime config validators; merge-safety with pre-existing user keys for a
  2nd runtime; idempotent re-install; targeted uninstall. Deps: T11. → AC5.1, AC5.2, AC5.3

### E6 — Red-team eval harness (G-E6)
- [ ] **T13** `fixture` — `fixtures/injection/` (incl. paraphrases) + `fixtures/secret/`; reuse
  `fixtures/exfil/` (T1) + `fixtures/structured-pii/` (T7); `fixtures/thresholds.json` (committed
  per-detector FN ceilings). Deps: T1, T7. → AC6.1, AC-F.1
- [ ] **T14** `impl` — `eval/harness.ts`: run each corpus through `runDetectors` (+ enabled
  backends), compute per-detector FN rate, emit deterministic git-diffable report. Deps: T5, T8. → AC6.1
- [ ] **T15** `impl` — `security eval` CLI: `--corpus`, `--with-model`; non-zero exit on threshold
  breach. Deps: T13, T14. → AC6.2, AC6.3
- [ ] **T16** `ci` — CI job runs `security eval --corpus all` (pure) and gates on FN-rate regression;
  seeded-regression test proves the gate flips to fail. Deps: T15. → AC6.2

---

## Phase 2 — Opt-in models on the `backends` seam (Block 0 Asset Resolver)

### E1 — Prompt Guard 2 injection adapter (G-E1)
- [ ] **T17** `config` — extend `mergeSecurityConfig` + type with
  `backends.injectionModel { enabled, provider:"prompt-guard-2", size:"22M"|"86M", assetId,
  minConfidence }`, default off. Deps: —. → AC1.1
- [ ] **T18** `config` — register `prompt-guard-2-22m` / `-86m` in `assets.lock.json`
  (id/url/sha256/size); never bundled. Deps: B0. → AC1.2, AC0.2
- [ ] **T19** `impl` — `detect/injection/adapter.ts`: `CapabilityAdapter<string, DetectorMatch[]>`;
  `isAvailable` = optional dep importable AND asset sha256-verified; `run` = Prompt Guard 2
  inference → `category:"prompt-injection"` matches gated by `minConfidence`. Lazy `await import()`,
  never throws. Deps: T17, T18. → AC1.2, AC1.3
- [ ] **T20** `impl` — in `runDetectors`, resolve `security.injectionModel` capability and merge its
  matches with the always-on regex `detectInjection`; catch adapter errors → deterministic path.
  Deps: T19. → AC1.1, AC1.3, AC1.4
- [ ] **T21** `test` — availability-true (asset stubbed): recall on `fixtures/injection/` > regex
  baseline; availability-false: byte-identical fallback, warn-once, exit 0; escalation preserved.
  Deps: T13, T20. → AC1.1–AC1.4, AC-F.2

### E4-NER — Optional NER PII backend (G-E5)
- [ ] **T22** `config` — wire the existing `backends.piiModel` stub (`assetId`, `provider`
  `"custom"|"presidio"`); register `pii-ner` in `assets.lock.json`. Deps: B0. → AC4.3
- [ ] **T23** `impl` — `detect/pii/ner-adapter.ts` over `resolveCapability(cwd,"security.piiNer")`;
  merge NER `category:"pii"` findings when available; no-op fallback otherwise. Deps: T22, T8. → AC4.3
- [ ] **T24** `test` — availability-true merges NER findings; availability-false = deterministic PII
  byte-identical, warn-once, exit 0. Deps: T23. → AC4.3, AC-F.2

---

## Phase 3 — E3 cross-reference (Block A)

- [ ] **T25** `docs` — cross-reference `A-interop-mcp/` for `security scan-mcp` + `redactRaw`
  routing (E3); confirm `detect/mcp.ts` reuses this block's `DetectorMatch[]` + `guard`-seam
  conventions. **No Block E code.** Deps: BA. → AC3.1

---

## Phase 4 — Package gate & docs

- [ ] **T26** `test` — package-wide `C0-7` gate: all backends off + no assets ⇒ `runDetectors` and
  every `security` command byte-identical to today; no-network sandbox (no socket). Deps: T5, T8,
  T11, T20, T23. → AC0.1, AC0.2, AC0.3
- [ ] **T27** `docs` — update `roadmap-2026/README.md` status and `roadmap.md`; keep this package's
  docs EN (`DOC-1`, `DOC-4`). Deps: T26. → —

---

## Dependency summary

```
B0 ─┬─> T1,T7 ─> T13 ─> T14 ─> T15 ─> T16
    ├─> T18,T22
    └─(seam)─> T19,T23
T2 ─> T3,T4 ─> T5 ─> T6 / T14
T8 ─> T9 / T14 / T23
T10 ─> T11 ─> T12
T17,T18 ─> T19 ─> T20 ─> T21
T22,T8 ─> T23 ─> T24
BA ─> T25
{T5,T8,T11,T20,T23} ─> T26 ─> T27
```

**Critical rule**: no Block E task may land before Block 0's seam + Asset Resolver + fixture harness
(`README` ordering rule 1). E1/E4-NER additionally require the Asset Resolver; E2/E4-checksum/E5/E6
require only the fixture-harness convention and can proceed in parallel with Block A.
