# Implementation Plan — TLS-terminate proxy (HTTPS credential masking)

Status: design

## Problem

Today HTTPS goes through the allowlist proxy as a **blind `CONNECT` relay** — the
proxy sees only the host, never the bytes. Consequences:

- Credential masking works for plaintext HTTP only. Real credentials go to HTTPS,
  so `--mask-env` is deliberately NOT exposed (a sentinel would leave the sandbox
  unchanged over TLS → auth fails and the sentinel leaks).
- No content-level filtering is possible.

To mask credentials on HTTPS the proxy must terminate TLS (MITM) for allowlisted
hosts.

## Approach

**Ephemeral per-run CA + on-demand leaf certs, issued by the system `openssl`
binary; trust delivered through CA env vars (never the system trust store).**

1. **Run CA** — at proxy start (inside the proxy worker) generate an ephemeral CA
   key + self-signed cert. Lives only for the run; the private key never leaves
   the worker; the CA cert PEM is written 0600 into the session tmp (a sandbox
   writable root) and deleted on close.
2. **MITM on CONNECT** — for an allowlisted host, answer
   `200 Connection Established`, then TLS-handshake with the client using a leaf
   cert for the requested SNI host signed by the run CA (issued on demand,
   cached per host for the run). Open our own TLS connection upstream and relay
   the decrypted stream.
3. **Masking** — on the decrypted request, reuse `applyMasks` to substitute
   sentinel → real value in headers for `injectHosts`.
4. **Trust via env, not the system store** — set for the contained process:
   `SSL_CERT_FILE`, `CURL_CA_BUNDLE` (curl/openssl), `NODE_EXTRA_CA_CERTS`
   (node/bun), `REQUESTS_CA_BUNDLE` (python), `GIT_SSL_CAINFO` (git).
5. **Opt-in + fail-closed** — MITM only when explicitly enabled
   (`KERYX_SANDBOX_TLS_TERMINATE=1`). Otherwise HTTPS stays a blind relay and
   masking stays HTTP-only. Enabling is logged.

### Dependency decision

Node/Bun `crypto` can PARSE X.509 (`X509Certificate`) and generate key pairs, but
has **no certificate issuance/signing API** (`createCertificate` is undefined).
Options:

- **(chosen) `openssl` system binary** — shell out for CA + leaf issuance. Keeps
  `dependencies: {}` (same pattern as `sandbox-exec` / `bwrap`). Caveat: macOS
  ships **LibreSSL 3.3.6**, whose flag syntax differs from OpenSSL 3 for some
  cert options (`-addext`, SAN handling) — needs care + tests on both.
- npm cert library (`node-forge`, `@peculiar/x509`) — ergonomic, but a runtime
  dependency: requires optional-dep + dynamic import + AC15 pin + ADR per the
  project dependency policy.

## Steps (slices)

1. **Cert issuance module** — `tls-ca.ts`: generate run CA, issue+cache per-host
   leaf certs via `openssl`. Unit-tested (issue a cert, parse it back with
   `X509Certificate`, assert CN/SAN/issuer chain).
2. **MITM CONNECT handler** — in `proxy.ts`, behind the opt-in flag: terminate
   TLS with the leaf, connect upstream over TLS, relay. Blind relay stays the
   default path.
3. **CA trust wiring** — `setupNetworkRun` writes the CA PEM to session tmp and
   adds the CA env vars to `envAdditions`.
4. **HTTPS masking + live smoke** — local TLS upstream; assert the sentinel is
   replaced with the real value on the decrypted request and never leaves in
   clear.
5. **Expose masking** — `--mask-env NAME@host` on `harness exec` +
   `KERYX_SANDBOX_MASK_ENV` for the agent shell, ONLY after step 4 proves HTTPS
   masking works.

## Risks / honest caveats

- **MITM is invasive.** It decrypts all allowlisted HTTPS traffic for the run.
  Must stay opt-in, be clearly surfaced, and never be the default.
- **CA private key is a sensitive artifact.** Keep it in worker memory + a 0600
  temp file; delete on close; never log, never commit.
- **Not every tool honors CA env vars.** Go-based tools (`gh`, `terraform`,
  `gcloud`) use the system pool and will FAIL TLS verification under MITM — the
  same limitation Claude Code documents. Needs a documented escape (exclude the
  command, or disable TLS-terminate for that run).
- **LibreSSL vs OpenSSL** flag differences on macOS vs Linux.
- **HTTP/2**: terminate as HTTP/1.1; ALPN must not negotiate `h2` unless the
  relay implements it.
- **Performance**: one `openssl` spawn per new host (cached per run) — acceptable.

## Non-goals (this flow)

- Modifying the system trust store.
- Content filtering beyond credential substitution.
- HTTP/2 end-to-end.
