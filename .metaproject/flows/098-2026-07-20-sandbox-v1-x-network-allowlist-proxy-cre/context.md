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

### Slice 2 done — event-loop blocker RESOLVED (worker-thread proxy)
`spawnSync` blocks the main event loop, so an in-thread proxy can't serve the contained
process during a restricted run. FIX: run the proxy in a WORKER THREAD (`proxy-worker.ts`),
which has an independent event loop that keeps serving while main is blocked. `network-run.ts`
now spawns the worker and waits for its `{ready, port}`.

PROVEN end-to-end on real macOS with the PRODUCTION sync spawnSync path
(`network-restricted.smoke.test.ts`, flag-gated): allowlisted host reachable via proxy
(`OK-UP`), disallowed host → proxy `403` body, direct network → seatbelt denies the bypass.

Done in this flow: proxy engine, profile model, seatbelt restricted rule, worker-thread
lifecycle, Linux fail-closed, live e2e smoke. `off`/`on` unaffected.

### Slice 3 done — exec-path opt-in wired
`keryx harness exec --allowed-domains a,b` (or `KERYX_SANDBOX_ALLOWED_DOMAINS`) now runs
restricted: `harnessExec` is async, awaits `setupNetworkRun`, merges HTTP(S)_PROXY into the
command env + env-allowlist, constrains the sandbox to the loopback proxy, and closes the
proxy in a `finally`. `buildDefaultShellAdapter` takes a profile override. Proven end-to-end
through the real CLI (`harness-exec-restricted.smoke.test.ts`, flag-gated): a non-allowlisted
host is refused by the proxy (403 body), never reaching upstream.

FINDING: the executor's structural guard denies loopback/private-egress addresses in argv
(anti-SSRF) BEFORE the proxy — so `--allowed-domains localhost` is blocked by the guard, not
the proxy. This is correct: real allowlists target public hosts. The smoke therefore proves
the proxy path via a deny (deterministic, no internet).

### Remaining
1. Credential masking (sentinel env + proxy substitution on injectHosts; TLS-terminate scope).
2. Wire restricted into the AGENT shell_exec path (not just `harness exec`).
3. Dist caveat: worker path is `import.meta.url`-relative (works from src; verify under the
   bundled build or ship the worker as a separate asset).
4. Pre-existing (NOT this flow): `tsc` error in `src/tui/tui-shell.ts:1256` (liveSession)
   from a parallel session's work on main — needs their fix.
