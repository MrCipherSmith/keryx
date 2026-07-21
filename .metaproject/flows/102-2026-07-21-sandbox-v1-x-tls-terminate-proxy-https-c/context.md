# Context

Collected deterministically by `keryx flow init` at 2026-07-21T08:33:42.470Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-20T22:45:48.065Z)
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

_(flow-init skill appends here)_

## Agent Findings — slice 2 (MITM), Bun runtime constraints

Three Bun limitations forced the final design (each verified by probe):

1. `server.emit("connection", socket)` — Node's socket-injection trick — is NOT
   supported. Decrypted streams must be piped into a REAL loopback listener.
2. Server-side `new tls.TLSSocket(sock, { isServer: true, key, cert })` never
   completes a handshake (no `secure`, no data). Termination must use a real
   `https.createServer`.
3. `SNICallback` is IGNORED by `https.createServer` (static key/cert wins), so a
   single TLS listener cannot serve many hosts.

=> Final design: ONE internal HTTPS terminator PER HOST (leaf cert for that
host), created on demand and cached for the run; `CONNECT` answers 200 and pipes
the client's raw bytes into that host's terminator, which handshakes, decrypts,
masks, and forwards to the real upstream over TLS.

Also: Bun's http client cannot issue `CONNECT` (builds a URL from `path`), and
`https.request({socket})` falls back to fetch — tests therefore drive the tunnel
with a raw `net` socket + `tls.connect`.
