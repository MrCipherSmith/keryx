# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Before any detector change, a baseline of `keryx security eval --corpus all` is recorded in the flow journal (per-corpus precision/recall or the eval's own figures); after the change the same run is recorded again, and the redaction and injection corpora do not regress (no drop in precision or recall on any existing case). New corpus cases are added for every evasion and every allow-shape named below.
- AC2: (S-6) `redactSensitiveText` (`src/security/redact.ts`) runs the entropy detector (`src/security/detect/entropy.ts`, same thresholds `keryx security scan` uses) after the pattern pass on tokens of 20+ characters, redacting as `[REDACTED:entropy]`; allow-shapes keep 40-hex git SHAs, 7–12-hex short SHAs, UUIDs, and npm/sha256/sha512 integrity strings untouched. Tests: a 43-char random base64 bearer token in tool output is redacted; a git SHA, a UUID and an `sha512-…` integrity string are not; the false-positive count on a fixture of 200 realistic tool outputs (git log, npm install, bun test, ls) is recorded and is 0.
- AC3: (S-7) the injection phrase detectors (`src/security/detect/injection.ts`) match across line breaks and after Unicode confusable folding (NFKC plus a Cyrillic/Greek look-alike map); corpus gains "Ignore all previous\ninstructions" and "Ignіre all previous instructions" (Cyrillic і) and both are detected; no existing benign corpus case becomes a detection.
- AC4: (S-8) `web_fetch` and `web_search` refuse, before any network connection, a URL or query that the secret detectors (patterns + entropy with the AC2 allow-shapes) flag; the refusal names the reason `outbound secret-shaped content` and records a security finding with policyId `egress.outbound-secret`. Tests: `web_fetch({url:"https://x.example/c?k=sk-…"})` makes no fetch call and returns the refusal; an ordinary URL with a commit SHA in its path still fetches.
- AC5: (S-9) `displayUrl` (`src/mcp-servers/http-headers.ts`) masks a path segment of 16+ characters that matches a token pattern or the entropy detector as `…`; `keryx mcp list`, `mcp doctor --json` and the trust prompt all show the masked form. Test with `https://host/v1/<32 random hex>/mcp` → `https://host/v1/…/mcp`, and `https://host/v1/users/mcp` unchanged.
- AC6: (S-10) the win32 browser-open plan (`src/lib/oauth/open-url.ts`) never passes the URL through `cmd /c start` re-tokenisation: it validates the scheme is `https` (or `http` for loopback) and the URL contains no characters outside RFC 3986, refusing otherwise, and spawns with the URL as a single argv entry of a launcher that does not re-parse it. Tests: `https://a/?x=1&calc.exe&` is refused before spawn; a clean URL appears unchanged as one argv entry.
- AC7: (R-MIN1, R-I1, R-I2) `isDeniedForMcpChild` and its regexes move to `src/security/credential-shape.ts`; `mcp-servers/spawn-env.ts` and `harness/external/env.ts` import it (import-zone entry added, import-policy test green); the first-pass by-name check is case-insensitive (`anthropic_api_key` stripped); `GLUED_SECRET_RE` is anchored to name boundaries; every existing spawn-env boundary row still passes.
- AC8: typecheck, lint, the touched test files, `src/security`, `src/mcp-servers`, `src/harness/web` and the import-policy test pass; `docs/docs` security page (or the page that documents redaction/egress) describes entropy redaction and the outbound check; ledger rows S-6, S-7, S-8, S-9, S-10, S-11 (if touched), R-MIN1, R-I1, R-I2 in `docs/requirements/keryx-audit-remediation/findings.md` carry fixed/open with the test name; CHANGELOG entry and package.json bump.
