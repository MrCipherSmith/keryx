# Implement Block E: Security Hardening (exfil coverage + checksum PII + multi-runtime hooks + red-team eval + opt-in models)

Status: formalized
Source: docs/requirements/roadmap-2026/E-security-hardening/ (PRD/spec/AC0..AC6/tasks are the authoritative source)

## Problem

Raise the opt-in ceiling of the shipped `security` module while keeping its deterministic
regex/checksum detectors as the floor. Every model feature rides the module's pre-existing
`config.backends` seam + Block 0's Asset Resolver/Capability Seam; every non-model feature is
a pure, network-free detector that slots into the existing `runDetectors` pipeline and emits
`DetectorMatch[]`. With zero opt-in flags and no assets, the module behaves byte-identically
to today (C0-7). E3 (scan-mcp + redactRaw routing) already shipped in Block A — here it is a
doc cross-reference only.

## Expected Outcome (Block E spec §§, tasks T1–T27)

- **E2 modern exfil (deterministic early win):** `policies.egress.allowlist: string[]` config (default `[]`,
  deep-merged, malformed⇒defaults); `detect/exfil.ts` (markdown inline/reference image+link + `<img>` →
  `category:"egress"`, redactable `mask:"url"`; deny-by-default vs allowlist); extend `detect/egress.ts` with
  `egress.non-allowlisted-domain` (host ∉ allowlist, proximity-independent) + `egress.ssrf-metadata`
  (RFC-1918, 127/8, 169.254/16, 169.254.169.254, metadata.google.internal); empty allowlist ⇒ today's
  send-verb behavior; wire into `runDetectors` under `policies.egress.enabled`.
- **E4-checksum PII (deterministic early win):** pure validators in `detect/pii.ts` (IBAN mod-97, credit-card
  Luhn, SSN area/group/serial, IPv4/IPv6 range) each GATING its regex candidate → invalid-checksum items NOT
  flagged (false positives eliminated); typed masks (iban/cc/ssn/ip), fixed-width.
- **E5 multi-runtime hooks (deterministic early win):** `agent-hooks/runtimes.ts` per-runtime registry
  ({id, settingsPath, render(), validate()}) for cursor/windsurf/generic-mcp (Claude Code = existing);
  generalize `agent-hooks.ts` sentinel installer over the registry (`install/uninstall --runtime <...|all>`),
  merge-safe/idempotent, targeted uninstall.
- **E6 red-team eval harness (deterministic early win):** `fixtures/{injection,exfil,structured-pii,secret}/` +
  `fixtures/thresholds.json`; `eval/harness.ts` (run each corpus through `runDetectors` (+enabled backends),
  per-detector FN rate, deterministic git-diffable report); `security eval --corpus --with-model` (non-zero
  exit on threshold breach); CI job `security eval --corpus all` gates on FN-rate regression (seeded-regression
  proves the gate flips to fail).
- **E1 injection model (opt-in on backends seam):** `backends.injectionModel {enabled(default false),
  provider:"prompt-guard-2", size, assetId, minConfidence}`; register prompt-guard-2 assets in
  `assets.lock.json` (never bundled); `detect/injection/adapter.ts` CapabilityAdapter (lazy `await import`,
  isAvailable=dep+asset-verified, run→`category:"prompt-injection"` gated by minConfidence, never throws);
  `runDetectors` merges model matches with the always-on regex `detectInjection`, catches adapter errors →
  deterministic path.
- **E4-NER (opt-in on backends seam):** wire `backends.piiModel` (assetId, provider); `detect/pii/ner-adapter.ts`
  over `resolveCapability(cwd,"security.piiNer")`; merge NER `category:"pii"` when available; no-op fallback.
- **E3 (cross-ref only):** doc pointer to Block A `scan-mcp`/`redactRaw`; confirm `detect/mcp.ts` reuses the
  `DetectorMatch[]` + guard-seam conventions. No Block E code.
- **Golden rule (AC0.1/C0-7):** with all Block E backends off and no assets, `runDetectors` output on the
  existing security suite and every `security` command is byte-identical to today — no optional dep imported,
  no socket opened; `dependencies` stays empty, new libs only under `optionalDependencies` (lazy `await import`
  inside adapters); leak-safety unchanged/stronger (fixed-width masks, HMAC fingerprints, fail-closed gate intact).

## Out of Scope

- Re-speccing the shipped security module (extends it only).
- Re-testing Block A's scan-mcp/redactRaw (E3 is cross-reference only here).
- Bundling/auto-downloading model assets (Prompt Guard 2 / NER are XP3 assets via `assets pull`).
