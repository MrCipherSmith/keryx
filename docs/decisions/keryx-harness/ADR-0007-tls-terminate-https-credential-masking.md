# ADR-0007: TLS termination for HTTPS credential masking

- **Status:** Accepted (flow 102)
- **Date:** 2026-07-21
- **Builds on:** ADR-0006 (OS sandbox for shell execution) and the v1.x
  restricted-network allowlist proxy (flow 098).

## Context

The restricted-network posture routes a contained process through a loopback
allowlist proxy. HTTPS went through a blind `CONNECT` relay, so the proxy saw
only the host — never the bytes. Consequently credential masking (contained
process sees a sentinel; the proxy substitutes the real secret on the wire)
worked for plaintext HTTP only. Since real credentials travel over HTTPS, a
`--mask-env` flag would have been a footgun: the sentinel would leave the sandbox
unchanged and authentication would simply fail.

To mask credentials on HTTPS the proxy must terminate TLS.

## Decision

**Opt-in TLS termination (MITM) for allowlisted HTTPS, with an ephemeral per-run
CA issued by the system `openssl`, and trust delivered through CA env vars.**

1. **Run CA** — created inside the proxy worker; the private key never crosses a
   boundary. Only the CA certificate is reported back. Disposed on close.
2. **Termination** — an allowlisted `CONNECT` is answered `200`, and the client's
   raw bytes are piped into an internal HTTPS listener holding a leaf certificate
   for that host. The decrypted request is masked and forwarded to the real
   upstream over TLS (verified against the system store).
3. **The allowlist is enforced again INSIDE the tunnel.** Terminating means the
   proxy now chooses an upstream from the in-tunnel `Host` header, so checking
   only the outer `CONNECT` would make any allowlisted host a route to every
   host. Each terminator is therefore pinned to the `CONNECT` target it was
   created for, and every decrypted request is re-checked against the allowlist
   and reported to the decision log — so a refusal is auditable under the host
   actually addressed, not the tunnel that carried it. Pinning also stops a
   terminator from acting as an open forward proxy on loopback for the rest of
   the run.
4. **Trust** — the CA certificate is written to a temp PEM and delivered via
   `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`,
   `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`. The system trust store is never
   touched. The PEM is removed on close.
5. **Opt-in + fail-closed** — termination only with `--tls-terminate` /
   `KERYX_SANDBOX_TLS_TERMINATE=1`. `--mask-env` WITHOUT termination is
   **refused** with an explanation rather than silently applying to HTTP only.

### Certificate issuance: system `openssl`

Node/Bun `crypto` can PARSE X.509 (`X509Certificate`) but has **no certificate
issuance API**. Issuance therefore shells out to the system `openssl` binary —
the same "system binary, not an npm dependency" pattern as `sandbox-exec` /
`bwrap`, keeping `dependencies: {}` (ADR-0005). An npm cert library
(`node-forge`, `@peculiar/x509`) was considered and rejected to avoid a runtime
dependency.

macOS ships **LibreSSL**, whose `req` has no `-addext`; extensions are therefore
passed via a generated **config file**, which works on both LibreSSL and
OpenSSL 3.

### Bun runtime constraints (verified by probe)

Three Bun limitations shaped the implementation:

1. `server.emit("connection", socket)` — Node's socket-injection trick — is not
   supported ⇒ the decrypted stream is piped into a **real loopback listener**.
2. Server-side `new tls.TLSSocket(sock, { isServer: true })` never completes a
   handshake ⇒ termination uses a real `https.createServer`.
3. `SNICallback` is ignored ⇒ **one internal HTTPS listener per host** (leaf cert
   per host), created on demand and cached for the run.

Also: Bun's http client cannot issue `CONNECT` and `https.request({socket})`
falls back to `fetch`, so tests drive the tunnel with a raw `net` socket +
`tls.connect`.

## Consequences

- Positive: credential masking now works over HTTPS — verified end-to-end on real
  TLS (the upstream receives the real credential; the sentinel never appears on
  the wire), and no substitution occurs outside the declared inject hosts.
- Negative: **MITM is invasive** — it decrypts all allowlisted HTTPS for the run.
  It stays opt-in and is never a default.
- **Not every tool honors CA env vars.** Go-based tools (`gh`, `terraform`,
  `gcloud`) use the system pool and will fail TLS verification under termination
  — the same limitation Claude Code documents. Exclude such commands or disable
  termination for that run.
- One `openssl` invocation per new host (cached per run) and one listener per
  host — acceptable for the expected allowlist sizes.

## Non-goals

- Modifying the system trust store.
- Content filtering beyond credential substitution.
- HTTP/2 end-to-end (termination speaks HTTP/1.1).
