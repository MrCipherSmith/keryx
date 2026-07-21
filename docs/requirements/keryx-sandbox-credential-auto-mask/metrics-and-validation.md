# Metrics and Validation — Dual-Axis Verification
Version: 0.2.0

## Purpose

Define how to prove credential masking and related network policy without
confusing the **model credential path** with the **sandboxed shell path**, and
without leaking secrets into artifacts.

This is the refined dual-axis protocol held from product discussion; it is the
acceptance companion for P0+ and a runbook for operators after global keryx
updates.

## Reliability levels

| Level | Meaning |
|-------|---------|
| `exact` | Asserted by test or structured log field |
| `observed` | Operator-run live check with redacted notes |
| `unknown` | Not measured this run |

## Preflight (must run first)

| Check | Pass condition | Fail action |
|-------|----------------|-------------|
| PF1 keryx binary | Expected version/path for the build under test | Stop; fix PATH |
| PF2 key present | Named key non-empty in env **or** auth.json (record name only) | Stop; `/connect` or export |
| PF3 openssl | `openssl version` succeeds if TLS needed | Stop; install or skip TLS axes |
| PF4 sandbox launcher | sandbox-exec / bwrap available when shell sandbox on | Stop or set allow-unsandboxed only for negative tests |
| PF5 mode under test | Record maskMode + whether auto or manual | Continue |

Never print key values in preflight output.

## Axis A — Subagent / model network

**Question:** Can a child agent complete an LLM turn under its policy (tools RO,
network allowed for provider)?

| ID | Check | Pass |
|----|-------|------|
| A1 | spawn_subagent (or harness child) reaches provider | Turn completes or typed auth error — not silent FakeProvider when key expected |
| A2 | Tool policy | Child cannot write/shell if policy denies |
| A3 | Not a mask proof | **Do not** require sentinel in child model process env |

**Verdict:** `PASS` \| `FAIL` \| `SKIP` (no multi-agent build)

## Axis B — shell_exec credential mask

**Question:** Does restricted sandboxed shell hide the real key and still allow
allowlisted HTTPS via proxy unmask?

| ID | Check | Pass |
|----|-------|------|
| B1 | Child `printenv <KEY>` | Output is sentinel or empty-not-real; **≠** real key |
| B2 | HTTPS to inject host | Upstream accepts auth (or fixture proxy sees unmasked Authorization) |
| B3 | Non-inject host | Real key not substituted |
| B4 | Mask without TLS | Tool/harness returns error; no spawn success |
| B5 | Auto mode (P0) | With key only in auth.json and no MASK_ENV, B1–B2 still hold when mode=auto |

**Verdict:** separate from Axis A.

## Axis C — Harness CLI parity

**Question:** Same inputs → same resolution as shell_exec?

| ID | Check | Pass |
|----|-------|------|
| C1 | Equivalent env + flags produce equal `MaskResolution` (unit or golden JSON) | Deep equal masks, tls, mode |
| C2 | `--mask-mode manual` matches env-only manual | Same as shell |

## Artifact contract

```text
RUN_DIR/
  preflight.md          # no secrets
  axis-a.md
  axis-b.md
  axis-c.md
  resolution.json       # MaskResolution schema; no realValue fields
  REPORT.md             # summary table only
```

### REPORT.md required table

| Axis | Verdict | Notes |
|------|---------|-------|
| Preflight | … | … |
| A | … | … |
| B | … | … |
| C | … | … |

**Redaction gate:** if the real key substring appears anywhere under `RUN_DIR`,
the run is **FAIL** regardless of functional pass (AC10).

## Metrics (optional run efficiency)

| Metric | Definition |
|--------|------------|
| `axes_pass_count` | Number of A/B/C with PASS |
| `axes_fail_count` | Number of A/B/C with FAIL |
| `redaction_violations` | Count of secret hits in artifacts |
| `auto_masks_count` | From resolution.masks where source auto/merged |
| `explicit_masks_count` | source explicit |

Do not invent timings; wall clock only if measured.

## Scenario catalog (tests)

### S1 — Auto derive deepseek

Given mode=auto, `DEEPSEEK_API_KEY` set, no MASK_ENV,  
when resolve runs,  
then masks include `DEEPSEEK_API_KEY` @ `api.deepseek.com` and tls auto-derived.

### S2 — Manual only

Given mode=manual, key set, no MASK_ENV,  
when resolve runs,  
then masks empty and tls not auto-derived.

### S3 — Fail closed TLS

Given non-empty masks and tlsExplicit=false,  
when resolve runs,  
then ok=false.

### S4 — Merge

Given auto would mask KEY@a.com and explicit `KEY@b.com`,  
when resolve runs,  
then injectHosts for KEY are from explicit.

### S5 — Sentinel live (observed or integration)

Given restricted shell_exec with resolved masks,  
when child prints env,  
then value ≠ real key.

### S6 — Redaction

Given REPORT generated with fixture key `sk-test-fixture-not-real`,  
when scanning RUN_DIR,  
then zero matches for that string (tests use a distinct fixture).

## Relationship to implementation phases

| Phase | Minimum validation |
|-------|-------------------|
| P0 | S1–S4 unit + shell wire fixture; S5 if environment allows |
| Verify | Full dual-axis runbook + AC10 |
| P1 | Resolution order with sandbox.json |
| P2 | extraMasks from project policy |

## Operator dual-axis prompt (refined, keep for later runs)

Use after global keryx update; do not paste real keys into the chat log.

```text
Goal: Dual-axis verification of keryx sandbox credential masking + subagent network.

Preflight: key presence (name only), openssl, sandbox launcher, keryx version.
Record maskMode (auto|manual|off). Prefer auto after P0.

Axis A: spawn_subagent / child model turn — policy tools RO, network for LLM.
  Do NOT treat success as mask proof.

Axis B: shell_exec under KERYX_SANDBOX_SHELL restricted + mask/TLS.
  Assert child env hides real key; inject host works; foreign host no unmask;
  mask without TLS fails closed.

Axis C: harness CLI equivalent inputs → same MaskResolution.

Artifacts under RUN_DIR; redact secrets; three separate verdicts + preflight.
Write REPORT.md table only. FAIL if real key appears in any artifact.
```
