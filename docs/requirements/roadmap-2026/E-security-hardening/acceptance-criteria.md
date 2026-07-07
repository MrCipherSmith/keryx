# Acceptance Criteria: Block E — Security Hardening

Version: 1.0.0
Every AC is hard and testable against a committed fixture or a deterministic assertion (`F-4` — no
prose metrics). ACn IDs are referenced by `tasks.md` and by `gd-metapro flow ac`.

## AC-Global — deterministic floor preserved (the package-wide gate)

- [ ] **AC0.1** With all Block E backends off (`injectionModel.enabled=false`,
  `piiModel.enabled=false`) and no assets present, `runDetectors` output on the existing security
  test suite and every `security` command is **byte-identical to today** (`C0-7`, `E-2`, `E-13`,
  `NG-E3`). No optional dep imported; no socket opened (`T-4`, `XP1`).
- [ ] **AC0.2** `dependencies` in `package.json` stays empty; any new lib (Prompt Guard 2 runtime,
  NER) is under `optionalDependencies`, imported only via `await import()` inside its adapter
  (`C0-1`, `C0-2`).
- [ ] **AC0.3** Leak-safety unchanged or stronger: no raw secret/PII in any committable artifact;
  masks fixed-width; HMAC fingerprints and the fail-closed gate intact (`E-9`, `NG-E2`).

## AC-E1 — Semantic injection model (G-E1)

- [ ] **AC1.1** `backends.injectionModel.enabled=false` (default) ⇒ injection detection is exactly
  today's regex `detectInjection`; no dep, no asset (`E-1`, `C0-4`).
- [ ] **AC1.2** With the backend enabled and a Prompt Guard 2 asset resolved & sha256-verified,
  injection **recall on `fixtures/injection/` (paraphrase-injection corpus) is measurably higher**
  than the regex-only baseline, with precision ≥ the committed floor. Measured by the harness, not
  prose (`F-4`).
- [ ] **AC1.3** Backend enabled but model asset absent/unverified ⇒ warn once to stderr, fall back
  to regex, **exit 0**; adapter never throws (`C0-5`, `C0-11`).
- [ ] **AC1.4** Model findings are `category:"prompt-injection"` and are escalated to
  require-approval by `resolve.ts` when an egress signal co-occurs — same as the regex path.

## AC-E2 — Modern exfil coverage (G-E2)

- [ ] **AC2.1 (EchoLeak)** Every enumerated markdown-image and reference-style-link vector in
  `fixtures/exfil/` — inline `![alt](URL)`, reference `![alt][ref]` + `[ref]: URL`, and
  `<img src=URL>` — is **flagged** `category:"egress"` and the URL span is **redactable** so
  `applyRedaction` strips it (`E-3`, `E-9`). 100% of enumerated vectors caught (`G-E2` target).
- [ ] **AC2.2 (allowlist)** With a non-empty `egress.allowlist`, a URL to a **non-allowlisted**
  domain is flagged **regardless of send-verb proximity** (deny-by-default); a URL to an
  allowlisted host is **not** flagged by the allowlist rule (`E-4`).
- [ ] **AC2.3 (back-compat)** Empty/absent `egress.allowlist` preserves today's send-verb proximity
  behavior; the existing security test suite still passes with no new false positives.
- [ ] **AC2.4 (SSRF)** RFC-1918, `127/8`, `169.254/16`, `169.254.169.254`, and
  `metadata.google.internal` fixtures are flagged `egress.ssrf-metadata`; benign public URLs are not.

## AC-E4 — Checksum-verifiable PII + optional NER (G-E5)

- [ ] **AC4.1 (Luhn/IBAN)** In `fixtures/structured-pii/`, **valid-checksum** IBAN (mod-97) and
  credit-card (**Luhn**) items are flagged `category:"pii"` with a typed mask, and **invalid-checksum**
  items are **NOT** flagged (the known false positives are eliminated) (`E-6`).
- [ ] **AC4.2 (SSN/IP)** Well-formed SSN (valid area/group/serial) and valid IPv4/IPv6 are flagged;
  malformed variants in the fixture are not.
- [ ] **AC4.3 (NER opt-in)** `piiModel.enabled=false` ⇒ deterministic PII only, byte-identical to
  today. Enabled with NER asset ⇒ NER `category:"pii"` findings merge; enabled without asset ⇒ warn
  once, deterministic PII only, exit 0 (`E-1`, `E-13`, `C0-5`).

## AC-E5 — Multi-runtime hooks (G-E4)

- [ ] **AC5.1** ≥3 runtime targets (Claude Code + Cursor + Windsurf/generic MCP) each emit a
  **validator-checked** hook config routing input/output through `security check-input` /
  `check-output` (`E-7`).
- [ ] **AC5.2 (merge-safe, 2nd runtime)** Installing hooks for a **second** runtime into a config
  that already has user-authored keys preserves every pre-existing key and user hook entry (sentinel
  pattern); re-install is **idempotent** (no duplicate managed groups).
- [ ] **AC5.3** Uninstall removes **only** the managed entries for the named runtime, leaving user
  content and other runtimes untouched.

## AC-E6 — Red-team eval harness (G-E6)

- [ ] **AC6.1** `security eval --corpus all` runs every labeled corpus (injection / exfil / secret /
  PII) through `runDetectors` (+ enabled backends) and emits a **per-detector false-negative-rate**
  report that is deterministic and git-diffable (`E-8`, `F-2`).
- [ ] **AC6.2 (CI gate)** The harness **fails CI (non-zero exit)** when any detector's FN rate
  exceeds its committed threshold in `fixtures/thresholds.json`; passes when all are within
  threshold (`E-8`). A seeded regression (removing a detector rule) demonstrably flips the gate to fail.
- [ ] **AC6.3** The harness runs **pure** (all model backends off) by default and, with
  `--with-model` and the injection asset present, includes the model detector's FN rate.

## AC-E3 — MCP-boundary scanning (G-E3) — cross-reference

- [ ] **AC3.1 (REFERENCE)** `security scan-mcp` and routing MCP tool output through `redactRaw` are
  accepted **in Block A** against `A-interop-mcp/` `fixtures/mcp-threat/` (`M-5`, `E-5`). Block E's
  acceptance requires only that its `DetectorMatch[]` + `guard`-seam conventions remain compatible
  with `detect/mcp.ts`; no Block E AC re-tests Block A.

## AC-Fixtures — acceptance artifacts (F-1..F-4)

- [ ] **AC-F.1** Each of `fixtures/{injection,exfil,structured-pii,secret}/` is committed,
  deterministic, and labeled; each is named as the acceptance gate for its item (`F-1`, `F-2`).
- [ ] **AC-F.2** Each opt-in capability (E1, E4-NER) has both an availability-true path test (asset
  stubbed) and an availability-false fallback test asserting byte-identical deterministic output
  (`T-3`, `F-3`).
