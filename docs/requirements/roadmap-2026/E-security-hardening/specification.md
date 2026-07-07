# Specification: Block E — Security Hardening

Version: 1.0.0
Language: EN. Section order follows `DOC-3`: Purpose → Module Identity → Structure → Manifest
Entry → Config → CLI → Service Contract → Actions → Schema → Integration → Hooks → Standard Profile
→ Acceptance → Phases → Open Questions.

---

## 1. Purpose

Harden the shipped `security` module with opt-in semantic injection detection, deterministic modern
exfil coverage, checksum-verifiable PII, a multi-runtime hook installer, and a red-team eval harness
— **without** changing the deterministic default. Regex/checksum detection stays the floor
(`E-2`, `E-13`); all model features ride the pre-existing `config.backends` seam + Block 0 Asset
Resolver and no-op gracefully when assets are absent (`E-1`, `C0-4`, `C0-5`). E3 (MCP-boundary
scanning) is **specified in Block A** and referenced in §11.

## 2. Module Identity

- **Module**: `security` (existing; `modules.security.enabled` in `metaproject.json`).
- **Manifest gate**: unchanged — `isSecurityEnabled(cwd)` (`guard.ts`); missing manifest ⇒ disabled ⇒
  every seam no-ops.
- **New capabilities** (Block 0 Capability Seam, `C0-3`): `security.injectionModel` (E1),
  `security.piiNer` (E4-NER). Each wires the four coordinated parts: `init` flag, manifest
  capability entry, `security.config.json` toggle, and `resolveCapability() → Adapter | null`.
- **Deterministic additions** (no capability, always available): exfil detectors (E2), checksum PII
  validators (E4), multi-runtime hook templates (E5), eval harness (E6).

## 3. Structure (files added / touched under `src/security/`)

```
src/security/
  detect/
    injection.ts        (touched) regex path unchanged; export a stable baseline for the harness
    injection/
      adapter.ts         (NEW, E1) CapabilityAdapter<string, DetectorMatch[]> — Prompt Guard 2
    egress.ts           (touched, E3-allowlist+SSRF) add deny-by-default allowlist + SSRF rules
    exfil.ts             (NEW, E2) markdown-image / reference-link (EchoLeak/CVE-2025-32711) → egress
    pii.ts              (touched, E4) add IBAN/CC-Luhn/SSN/IP checksum validators
    pii/
      ner-adapter.ts     (NEW, E4-NER) CapabilityAdapter over backends.piiModel
    index.ts            (touched) runDetectors: await optional injection/NER adapters, merge matches
  config.ts             (touched) mergeSecurityConfig: injectionModel backend + egress.allowlist
  agent-hooks.ts        (touched, E5) generalize sentinel installer over N runtime targets
  agent-hooks/
    runtimes.ts          (NEW, E5) per-runtime config-path + template + validator registry
  eval/
    harness.ts           (NEW, E6) corpus runner → per-detector FN-rate report + threshold gate
fixtures/
  injection/ exfil/ structured-pii/ secret/   (NEW, E6/F-1) labeled corpora
  thresholds.json                              (NEW, E6) per-detector FN-rate ceilings (committed)
```

Adapters live **beside** their detector (`C0-14`); `index.ts` imports the adapter *interface*, never
the optional dep (`C0-2`). All new detectors are pure and return `DetectorMatch[]` (`E-3`).

## 4. Manifest Entry (`metaproject.json`)

```jsonc
{
  "modules": {
    "security": {
      "enabled": true,
      "capabilities": ["injectionModel", "piiNer"]   // present ⇒ eligible; config toggle still gates
    }
  }
}
```

Capability listed but its `config.backends.*.enabled=false` ⇒ deterministic path (`C0-9`). Missing
manifest ⇒ module + capabilities off.

## 5. Config (`.metaproject/security.config.json`, deep-merged over defaults — `C0-8`)

Extends the shipped `SecurityConfig` (`src/security/types.ts`). New fields, all defaulting to the floor:

```jsonc
{
  "policies": {
    "egress": {
      "enabled": true,
      "action": "block",
      "allowlist": []            // E3: deny-by-default when non-empty; [] preserves today's proximity behavior
    }
  },
  "backends": {
    "injectionModel": {          // E1 — NEW backend on the existing seam
      "enabled": false,
      "provider": "prompt-guard-2",
      "size": "22M",             // "22M" | "86M"
      "assetId": "prompt-guard-2-22m",     // resolved via Block 0 assets.lock.json
      "minConfidence": 0.5
    },
    "piiModel": {                // E4-NER — existing stub, now wired
      "enabled": false,
      "provider": "custom",      // or "presidio"
      "assetId": "pii-ner"
    }
  }
}
```

- `mergeSecurityConfig` extended to merge `injectionModel`, `egress.allowlist`, and honor the
  `piiModel.assetId`. Unknown keys ignored; malformed JSON ⇒ defaults (`C0-8`).
- `configChecksum` (existing) covers the `policies` block, so `egress.allowlist` tamper is detected
  by the shipped `verifyConfigChecksum` (strengthens `E-9`).
- Assets are **never bundled** (`A-5`); `assetId` resolves through Block 0's `resolveAsset(cfg, id)`
  which sha256-verifies on every load and returns `null` ⇒ fallback (`A-3`, `A-6`, `A-7`).

## 6. CLI

No new top-level verbs are introduced by Block E (E3's `security scan-mcp` is a **Block A** verb).
Block E reuses the shipped `security` CLI plus Block 0's asset subcommands and the E5 hook installer:

```bash
# Deterministic — unchanged surface; new detectors run automatically inside `scan`/`check`.
gd-metapro security scan <path>
gd-metapro security check-input  --source untrusted-external
gd-metapro security check-output

# E1 / E4-NER assets (Block 0 subcommands, module-scoped):
gd-metapro security assets pull <id>     # explicit, sha256-verified; the ONLY network path (A-6)
gd-metapro security assets list
gd-metapro security assets verify <id>

# E5 multi-runtime hooks:
gd-metapro security hooks install   --runtime <claude|cursor|windsurf|generic-mcp>[,...]
gd-metapro security hooks uninstall --runtime <...>

# E6 eval harness (also invoked in CI):
gd-metapro security eval [--corpus injection|exfil|secret|pii|all] [--with-model]
```

`--runtime all` installs every registered target. `eval` exit code is non-zero on a threshold breach
(the CI gate, `E-8`).

## 7. Service Contract

The shipped `SecurityService` (`check`, `redact`, `report`, `gate`) is **unchanged in shape**. New
behavior is internal to `runDetectors` and `resolveDecision`:

- `runDetectors(content, config)` gains: the exfil detectors (E2), checksum PII (E4), and — when the
  respective capability is available — the injection-model and NER adapter matches, merged before
  `dedupeOverlaps`. Adapter resolution is `await`ed but **never throws**; on unavailability it is
  skipped (deterministic path). Signature and return type (`DetectorMatch[]`) are preserved.
- `redact()` / `guardOutput()` / `securityFlowGate()` are unchanged; new redactable spans (markdown
  images, structured PII) simply carry a `mask` so `applyRedaction` strips them.

### 7.1 Capability adapter shape (Block 0 seam)

```ts
// src/security/detect/injection/adapter.ts
interface CapabilityAdapter<In, Out> {
  readonly name: string;                 // "security.injectionModel"
  isAvailable(): Promise<boolean>;       // optional dep importable AND asset sha256-verified
  run(input: In): Promise<Out>;          // Prompt Guard 2 inference → DetectorMatch[]
}
// resolveCapability(cwd, "security.injectionModel") → CapabilityAdapter | null (null ⇒ fallback)
```

Contract (binding, mirrors `analyze()`/`guardOutput` try/catch → degrade):
1. capability disabled ⇒ adapter not resolved, no dep import, no asset touch (`C0-4`).
2. enabled but dep/asset absent or checksum fails ⇒ **warn once (stderr), regex path, exit 0** (`C0-5`).
3. adapter throws at runtime ⇒ caught in `runDetectors`, degrade to deterministic matches (`C0-11`).

## 8. Actions (detector behavior)

### 8.1 E1 — Prompt Guard 2 injection adapter
- Input: the same `content` string `detectInjection` sees. Output: `DetectorMatch[]` with
  `category:"prompt-injection"`, `confidence` from the model score gated by
  `backends.injectionModel.minConfidence`, `severity:"low"` (escalation to require-approval still
  happens in `resolve.ts:escalateInjection` when an egress signal co-occurs — **unchanged**).
- The regex `detectInjection` **always runs** and is the baseline; the model is additive recall.
- Runtime: user-provided model asset (22M/86M) resolved by Block 0; inference via the optional dep
  named in specification Open-Question OQ-1. No network at inference (`XP1`).

### 8.2 E2 — Modern exfil detectors (pure, `category:"egress"`)
- **Markdown auto-render (EchoLeak / CVE-2025-32711)** — `detect/exfil.ts`:
  - inline image `![alt](URL)` and reference-style image/link `![alt][ref]` / `[text][ref]` with a
    matching `[ref]: URL` definition; HTML `<img src="URL">`. The URL span is **redactable**
    (`mask:"url"`) so `applyRedaction` strips the auto-render trigger. Deny-by-default: any such URL
    whose host is not on `egress.allowlist` is flagged.
- **Egress domain allowlist (deny-by-default)** — `detect/egress.ts`:
  - when `egress.allowlist` is non-empty, every `http(s)://host` whose host ∉ allowlist is flagged
    `egress.non-allowlisted-domain` **regardless of send-verb proximity** (`E-4`). Empty allowlist ⇒
    today's send-verb proximity rule (back-compat).
- **SSRF / private-IP / metadata** — `detect/egress.ts`:
  - RFC-1918 (`10/8`, `172.16/12`, `192.168/16`), loopback `127/8`, link-local `169.254/16`, the
    cloud metadata IP `169.254.169.254`, and `metadata.google.internal` → `egress.ssrf-metadata`.

### 8.3 E4 — Checksum PII validators (pure, `category:"pii"`)
Added to `detect/pii.ts`; each candidate regex match is confirmed by a checksum before it becomes a
match (removes the fixture's known false positives, `E-6`):
- **IBAN** — structure + ISO 7064 mod-97-10 == 1. `mask:"iban"`.
- **Credit card** — 13–19 digits passing the **Luhn** check. `mask:"cc"`.
- **SSN** — US SSN format with area/group/serial validity (no `000`/`666`/`9xx` area, no `00` group,
  no `0000` serial). `mask:"ssn"`.
- **IP** — valid IPv4 (octet range) / IPv6. `mask:"ip"`.
All redaction is fixed-width typed masking (length-hiding), preserving `E-9`.

### 8.4 E4-NER — optional NER adapter
`resolveCapability(cwd, "security.piiNer")` over `backends.piiModel`. Available ⇒ merges NER
person/location findings as `category:"pii"`; unavailable ⇒ deterministic PII only, byte-identical
(`E-1`, `E-13`).

### 8.5 E5 — Multi-runtime hook installer
`agent-hooks/runtimes.ts` registers, per runtime, a `{ id, settingsPath, render(), validate() }`.
The shipped Claude-Code sentinel/merge algorithm (`_gdMetaproManaged` + `stripManaged` +
idempotent re-append) generalizes so each target is installed **merge-safe** (user keys preserved),
idempotent, and uninstall removes only managed entries. Targets: `claude`
(`.claude/settings.json`), `cursor`, `windsurf`, `generic-mcp` (≥3 satisfy `E-7`).

### 8.6 E6 — Eval harness
`eval/harness.ts` runs each labeled corpus through `runDetectors` (+ enabled backends), compares
flagged vs expected labels, and emits a per-detector **false-negative-rate** report. CI fails when
any detector's FN rate exceeds `fixtures/thresholds.json` (`E-8`). Deterministic and git-diffable
(`F-2`, `F-4`); runs pure by default and optionally `--with-model` when the injection asset is present.

## 9. Schema

- **No change** to `security-finding.schema.json` / `security-report.schema.json` — new detectors
  reuse existing `category`/`action`/`mask` fields. New `policyId` values:
  `egress.markdown-image-exfil`, `egress.reference-link-exfil`, `egress.non-allowlisted-domain`,
  `egress.ssrf-metadata`, `pii.iban`, `pii.credit-card`, `pii.ssn`, `pii.ip`,
  `prompt-injection.model`.
- **`fixtures/thresholds.json`** (E6): `{ "<detectorId>": { "maxFnRate": <0..1> } }`, committed.
- **`assets.lock.json`** entries (Block 0 schema) for `prompt-guard-2-22m`, `prompt-guard-2-86m`,
  `pii-ner`: `{ id, url, sha256, size }`.

## 10. Integration

- `runDetectors` (existing pipeline) is the single integration point for E1/E2/E4 (`E-3`).
- `resolve.ts` escalation (`escalateInjection`) and `computeGate` consume the new findings unchanged.
- `redactRaw`/`guardOutput`/`securityFlowGate` seams unchanged; new redactable spans strengthen leak
  safety (`E-9`).
- Block 0 Asset Resolver + Capability Seam provide `resolveAsset` / `resolveCapability` for E1/E4-NER.
- **E3 (Block A)**: Block A's `tools.ts` routes MCP tool output through `redactRaw` from the first
  commit (`M-5`), and `security scan-mcp` (`detect/mcp.ts`) reuses this block's `DetectorMatch[]`
  convention. See §11.

## 11. Hooks

- **Agent hooks (E5)**: `security hooks install --runtime <...>` writes merge-safe guard hooks per
  runtime (§8.5). Each runtime config routes `check-input`/`check-output` through the CLI.
- **`flow` health gate**: `securityFlowGate` unchanged; new detectors feed it additively.
- **CI hook (E6)**: `security eval --corpus all` in CI; non-zero exit gates the pipeline (`E-8`).

## 12. Standard Profile

Block E emits no new standard artifact; it hardens the module already documented under
`docs/requirements/security/`. The E5 hook templates and the E6 corpora are committed, git-diffable
project artifacts (`DOC-1`). Docs stay EN (`DOC-4`) and update `roadmap.md` (`DOC-1`).

## 13. Acceptance

See [acceptance-criteria.md](acceptance-criteria.md). Gate corpora (`F-1`): `fixtures/injection/`
(E1), `fixtures/exfil/` (E2), `fixtures/structured-pii/` (E4), `fixtures/secret/` + all of the above
(E6). Package-wide gate `C0-7`: with all backends off and no assets, `runDetectors` and every
`security` command are byte-identical to today.

## 14. Phases

1. **P1 — deterministic early wins (no A dependency)**: E2 exfil detectors, E4 checksum PII, E5
   multi-runtime hooks, E6 harness + corpora. Depends only on Block 0's fixture-harness convention.
2. **P2 — opt-in models**: E1 injection adapter + E4-NER adapter on the `backends` seam + Block 0
   Asset Resolver.
3. **P3 — E3 cross-ref**: consumed from Block A once its MCP surface lands (`M-5`); no Block E code
   beyond the `detect/mcp.ts` convention reference.

## 15. Open Questions

- **OQ-1** Prompt Guard 2 inference runtime (ONNX/transformers `optionalDependency` vs user-provided
  subprocess binary) — decide with Block 0's Asset Resolver author. Does not affect the deterministic
  path.
- **OQ-2** NER provider enum: reuse `piiModel.provider:"custom"` or add `"presidio"`.
- **OQ-3** Windsurf / generic-MCP hook config schema — pin a validated schema version at
  implementation time (`E-7`).
- **OQ-4** FN-rate thresholds' initial values — seed from the first green run, then ratchet.
