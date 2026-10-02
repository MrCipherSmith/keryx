# Implementation Plan

Status: draft for the operator (PRD: docs/requirements/keryx-telegram-permissions/prd.md). Not frozen.

## Approach

A Telegram turn already runs in the operator's shell under the shell's PermissionMode; the strictness is the `ask` default, an approver that skips the saved allowlist, no "Always" button, a 5 minute approval wait and a 30 minute run limit. So no new harness profile: three optional keys in the remote `config.json` (`permissionMode` ask|trust, default trust; `runTimeoutMs` 0 = none; `approvalTimeoutMs` default 15 min), an effective-mode switch while a Telegram turn is active, the allowlist consulted by the Telegram approver, an `always` decision, and `/stop`. The risk gate in `agent.ts` is not touched, so every floor of the shell holds.

## Steps

1. T5 config, protocol and registration (no behaviour change yet).
2. T6 effective mode and allowlist parity; T8 `/stop` and no-limit timer (T8 before the limit default lands: no limit needs a way to stop); T9 permissions CLI and modal in parallel.
3. T7 Always button after T6; T10 `/remote-policy`, settings rows, sidebar line, `serve status` after T5 and T9.
4. T11 tests (floors parity table, fake-bot e2e, old-config compat), T12 docs and version bump, T4 review.
5. Operator-only live acceptance in the topic geekom:keryx (AC18). No live agents in CI.

## Risks

- Default change for existing installs (trust, no limit, 15 min): release note names the rollback keys.
- "Always" widens the allowlist from a phone: same validators as the local dock, nothing offered on a floored call, listed and revocable.
- Parity drift: one table-driven test pins Telegram trust against local trust for every floor.
- Open questions in the PRD section 8 (`/mode` from the topic, a Telegram-only network or outside-path floor, button text length, HTTP serve expiry).
