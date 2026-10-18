# Deferred: reproducible Orca Keryx host patcher (stock Orca unsupported)

Status: deferred backlog — do not start implementation without a new operator request.
Source: user description (origin: human-request)

## Problem

Stock Orca 1.4.227 has no Keryx agent registration or `/hook/keryx` handler. Merging the Keryx reporter does not add native Orca support. `KERYX_ORCA_HOOKS=1` is opt-in and requires a compatible host; ordinary terminal use does not require it.

An isolated local experimental Orca copy was patched and its UI verified: working → Working, blocked → Waiting for input, idle/stopped → Done. This is a version-specific experiment, not a distributed integration. The installed `/Applications/Orca.app` and primary profile were not modified. An Orca update may invalidate or overwrite host changes.

## Expected Outcome

A future, separately approved patcher can reproduce that host integration safely: verify the source Orca version and hashes; refuse unknown layouts; create a separate application copy; update every required main/renderer agent registry and `/hook/keryx` normalization; preserve ASAR integrity metadata; apply a local ad-hoc signature; and launch only with explicit consent and an isolated profile. Never mutate the installed application or primary profile by default.

The protocol uses authenticated loopback JSON envelopes. Accept only protocolVersion 1 Keryx state events, preserve panel/launch identity, and map working/blocked/idle/stopped to Orca working/waiting/done/session completion. Preserve token secrecy. Prefer upstream native support if Orca exposes a supported extension point.

## Outcome criteria

- Запрос (дословно): «во фло в керикс опиши патчер и что пока нет поддержки, мы пока не будем его делать» (source: interactive operator request 2026-10-18)
- Current delivery: this deferred flow documents the stock-support gap; no patcher is implemented or scheduled.
- Future acceptance, only after approval: unknown versions fail closed; original app/profile hashes remain unchanged; a separate copy passes signing/integrity checks; authenticated reporter events display Working / Waiting for input / Done in the UI, including stopped session boundaries; invalid/unauthenticated events cannot alter state.
- Future tests cover dry run, repeated invocation, partial failure cleanup, rollback by deleting only the created copy/profile, and absence of secrets in logs. Record exact supported version/hashes and test evidence.

## Out of Scope

Implementing, running, packaging or shipping the patcher now; modifying the installed Orca or primary profile; claiming stock Orca support; starting or completing this implementation flow. The Keryx reporter is delivered separately; see `docs/orca-integration.md`.
