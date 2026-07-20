# Context

Collected deterministically by `keryx flow init` at 2026-07-20T22:09:04.004Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-20T21:03:52.873Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Slice 1 done
- `proxy.ts` loopback allowlist proxy (CONNECT tunnel + HTTP forward), `matchesAllowlist` (exact + `*.domain`). Live loopback tests: allowed tunnels+relays, disallowed → 403.
- `profile.ts` `network: off|on|restricted` + `allowedDomains` + runtime `proxy` addr.
- `seatbelt.ts` restricted rule `(deny network*)` + allow only `localhost:<proxyPort>`. VALIDATED on real macOS (async spawn).
- `network-run.ts` `setupNetworkRun` starts proxy for restricted, yields HTTP(S)_PROXY env + close().
- Linux restricted ⇒ fail-closed in `wrap.ts` (no false boundary without netns+relay).

### BLOCKER — async spawn adapter required
`RealProcessAdapter` uses `spawnSync`, which BLOCKS the event loop, so the in-process
proxy can't serve the contained process during a restricted run (times out). Confirmed:
`spawnSync` even times out a plain `(allow default)` loopback fetch; async `spawn` of the
identical profile returns code=0. ⇒ Wiring `restricted` needs an ASYNC process adapter (a
noted follow-up in real-process-adapter.ts) or an out-of-process proxy. `off`/`on` unaffected.

### Remaining
1. Async adapter (or worker-thread proxy) → wire setupNetworkRun into exec + live restricted smoke.
2. Credential masking (sentinel env + proxy substitution on injectHosts; TLS-terminate scope).
