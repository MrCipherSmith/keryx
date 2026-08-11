# Acceptance Criteria

## Criteria

- AC1: Agent mode offers a read-only `web_fetch` tool with required `url`, and its trusted system instruction describes it as retrieval of a known public URL.
- AC2: `web_fetch` accepts only absolute HTTPS URLs without embedded credentials and returns bounded text for a successful public response.
- AC3: `web_fetch` rejects loopback, private, link-local, metadata, CGNAT, unspecified, malformed, and DNS-resolution-failed destinations before issuing a request.
- AC4: Automatic redirects are disabled; every manual redirect is revalidated, and loops/excess redirects fail safely.
- AC5: Requests have a finite timeout, use no caller-controlled headers/cookies/credentials, and failures return explicit tool errors without throwing.
- AC6: Fetched content is capped and labelled as untrusted external content; non-text responses do not return binary data.
- AC7: Unit tests cover AC1–AC6 and relevant agent/tool tests pass.
