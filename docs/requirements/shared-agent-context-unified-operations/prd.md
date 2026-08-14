# Shared Agent Context — Unified Operations: Product Requirements
Version: 0.1.0

## Problem

The 2026-08-14 analysis verified that SAC CLI, MCP, and shell/Harness adapters
duplicate names and wiring; module opt-in semantics differ by surface; the
public guide has drifted; and reviewers/current-workspace users lack safe inbox,
preview, and discovery workflows. These are current-state observations, not
claims that this package has fixed them.

## Goal

Provide one future, declarative operation registry that governs every supported
local SAC surface, so users and agents can understand capability status and
operate workspaces/proposals consistently without receiving an access oracle.

## Users

- Agents need tool contracts, status, and errors that are consistent across
  Harness, CLI, and local MCP.
- Operators need one source for help/docs/defaults/deprecations and diagnostics.
- Reviewers need a visible-authorised proposal inbox and immutable preview.
- Security and owner maintainers need centralised risk, transport, and ACL
  enforcement without a new identity plane.

## Functional requirements

| ID | Requirement |
|---|---|
| RP09-1 | Define one versioned operation registry containing operation ID, inputs/outputs, defaults, risk, local transport allowance, authorisation action, capability/module prerequisites, normalisation, error taxonomy, and deprecation metadata. |
| RP09-2 | Derive CLI command schemas/help, MCP tool schemas, Harness tool descriptors, operator documentation references, and parity fixtures from the registry; hand-written adapters may not redefine semantic defaults or authorisation. |
| RP09-3 | Expose a consistent capability status response that distinguishes module disabled, operation unavailable, denied, transport unsupported, dependency degraded, and enabled—without confirming hidden resource existence. |
| RP09-4 | Provide future workspace `current`, `list`, and `doctor` operations with explicit context selection and safe diagnostics. `current` may return only an authorised binding; `list` omits hidden workspaces; `doctor` reports categories rather than secret/resource details. |
| RP09-5 | Provide future proposal `inbox`, `show`, and `preview` operations. Results are limited to authorised reviewer scope and preview the immutable reviewed digest/evidence/intent, not mutable sidecars or hidden target content. |
| RP09-6 | Provide a future handoff operation that creates/reads structured authorised metadata through the collaboration owner; it does not expose an unrestricted activity ledger or act as a remote-sharing feature. |
| RP09-7 | Standardise typed errors, canonical output normalisation, defaults, pagination/cursors, correlation IDs, deprecation notices, and executable parity tests across supported local transports. |

## Success criteria

- A registry change updates generated/validated schemas and documentation
  fixtures together; drift becomes a failing check rather than a guide defect.
- The same authorised operation has equivalent normalised semantics through
  CLI, local-stdio MCP, and Harness, accounting only for transport metadata.
- Disabled/degraded/denied states are explainable without revealing an
  inaccessible workspace, proposal, reference, or reviewer queue.
- Reviewers can find and preview only proposals within their current authority.
- Deprecated aliases remain bounded, warn consistently, and are removed only
  after parity/usage exit criteria.

## Risks

- A registry can become a large cross-module dependency; it must own surface
  metadata only, not business execution or source data.
- Generated help/docs may expose operations not actually enabled; executable
  capability tests are required.
- Convenience discovery can leak an existence oracle through errors, counts,
  timing, cursors, or doctor output.
- A broad handoff surface can reintroduce remote identity or ledger leakage.

## Recommendation

Start with read-only capability status and workspace/proposal discovery under
existing local identity. Migrate adapter metadata one operation at a time,
prove parity and non-disclosure, then retire duplicated wiring and stale guide
examples. Keep remote identity and UI outside this package.
