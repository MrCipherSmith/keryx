# Agent Protocol — Sandbox Harness Hardening
Version: 0.1.0

## When the user asks to “test the sandbox deeply”

1. Hard gate: project root + `.metaproject/index.md` if required by project rules.
2. Prefer **one** invocation of the portable probe:

   ```bash
   ./scripts/sandbox-deep-probe.sh
   # optional: ./scripts/sandbox-deep-probe.sh --live-smokes
   ```

   Output: `RUN_DIR=.metaproject/tmp/sandbox-probe-<utc>/` with `REPORT.md` and
   `report.json`. Matrix min: A2, B1, B2 (+CONTROL), C1 (+CONTROL), C2
   (decisions on macOS / Linux fail-closed note), F1, R1.

3. Read only `RUN_DIR/REPORT.md` for the summary. Do not re-run the entire matrix
   tool-by-tool unless the script is missing.
4. Never print real API key values. Synthetic fixtures only (`sk-fixture-…`).

## Interpreting harness outcomes

| Observation | Agent must |
|-------------|------------|
| `kind: "blocked"` | Stop; report `reason` verbatim; do not weaken sandbox |
| `kind: "completed"`, `exitCode != 0` | Report failure; do not assume sandbox bug without CONTROL |
| Restricted run, `decisions[].allowed: false` | Report **deny** even if curl exitCode is 0 |
| `decisions: []` on restricted | Do not claim allowlist was exercised |
| Exit 71 / empty reason | Prefer `outcome.reason` / `sandbox.detail` when present; include full JSON |

### Decisions over exitCode (AC-H6 / P-OPS-2)

For **restricted** allowlist runs, **`network.decisions` is authoritative**.
HTTP clients (including `curl`) may exit **0** when the proxy returns 403 for a
denied host. Agents must **not** claim network success or allowlist exercise from
`exitCode` alone. If `decisions` is missing or empty, report that the allowlist
was not exercised — do not invent a PASS.

## Structural guard

- Do not put shell metacharacters (`>`, `|`, `&&`) in `harness exec` argv.
- Write a small executable helper script under the workspace, then:

  ```bash
  keryx harness exec -- /path/to/helper.sh
  ```

- Absolute program paths only (`/bin/echo`, `/usr/bin/curl`).

## Mask / TLS

- Auto mask (P0.b): unset mode → auto when keys present; TLS auto-derived when masks non-empty.
- Explicit mask without TLS must fail closed (H1). If it does not, file as security defect under this package.
- Keys: `/connect` → user-global `auth.json` only.

## Approval patterns

- Prefer `always` prefix for first token when repeating the same tool family (`bash *`, `keryx *`).
- Multiline heredoc: allow patterns match newlines (PR #181). Still prefer scripts over huge heredocs.

## Dual-axis / live smokes

- Default CI: unit dual-axis only.
- Live: `KERYX_DUAL_AXIS_LIVE=1`, `KERYX_ALLOW_REAL_SUBPROCESS=1` on host with `bun` on PATH.
- Axis A SKIP is valid when multi-agent unavailable; Axis B is mask proof.
