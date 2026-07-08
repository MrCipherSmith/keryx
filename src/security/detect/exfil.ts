import type { DetectorMatch } from "../types";
import { hostAllowed } from "./egress";

// Modern markdown auto-render exfiltration (E2 — EchoLeak / CVE-2025-32711).
//
// A zero-click data-exfil vector: an attacker gets the agent to emit a markdown
// image (or reference link) whose URL encodes stolen context; the rendering
// client auto-fetches it, leaking to the attacker's host. This detector flags
// the URL span in:
//   - inline image      `![alt](URL)`
//   - inline link        `[text](URL)`
//   - reference image/link `![alt][ref]` / `[text][ref]` with `[ref]: URL`
//   - HTML image         `<img src="URL">`
//
// Deny-by-default against `egress.allowlist`: a URL whose host is NOT on the
// allowlist is flagged. An EMPTY allowlist flags every external markdown URL
// (the strictest posture) — safe because the shipped suite carries no markdown
// image/link vectors, so today's inputs gain no false positives (AC2.3).
//
// The URL span carries `mask:"url"` so `applyRedaction` strips the auto-render
// trigger, neutralizing the leak (AC2.1, E-9). Category is `egress`.

const EXFIL_CONFIDENCE = 0.85;

// Extract the lowercased host from an absolute (`http(s)://host`) or
// protocol-relative (`//host`) URL. Returns null for relative/data/other URLs
// (no cross-origin host ⇒ no exfil channel).
function exfilHost(url: string): string | null {
  const abs = /^https?:\/\/([^/?#]+)/i.exec(url);
  const rel = abs ? null : /^\/\/([^/?#]+)/.exec(url);
  const authority = abs?.[1] ?? rel?.[1];
  if (!authority) {
    return null;
  }
  let host = authority;
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  if (!host.startsWith("[")) {
    const colon = host.indexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  return host.toLowerCase();
}

type UrlHit = { url: string; start: number; policyId: string };

// Push a redactable finding for a URL that is external and not allowlisted.
function considerUrl(
  hit: UrlHit,
  allowlist: string[],
  out: DetectorMatch[],
): void {
  const host = exfilHost(hit.url);
  if (!host) {
    return; // relative / data / non-host URL — not an exfil channel
  }
  if (allowlist.length > 0 && hostAllowed(host, allowlist)) {
    return; // explicitly permitted destination
  }
  out.push({
    category: "egress",
    policyId: hit.policyId,
    severity: "critical",
    confidence: EXFIL_CONFIDENCE,
    start: hit.start,
    end: hit.start + hit.url.length,
    value: hit.url,
    mask: "url",
    remediation:
      "Strip or allowlist auto-rendered markdown image/link URLs; they exfiltrate context on render.",
  });
}

// Inline image `![alt](URL …)` and inline link `[text](URL …)`. The `!` prefix
// distinguishes an image; both are auto-fetch/click exfil channels.
const INLINE = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
// Reference use `![alt][ref]` / `[text][ref]` (ref captured in group 2).
const REFERENCE_USE = /(!?)\[[^\]]*\]\[([^\]]+)\]/g;
// Reference definition `[ref]: URL`.
const REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm;
// HTML `<img … src="URL" …>`.
const HTML_IMG = /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

export function detectExfil(
  content: string,
  allowlist: string[] = [],
): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  let m: RegExpExecArray | null;

  // Build the reference-definition table (ref → { url, start }).
  const refs = new Map<string, { url: string; start: number }>();
  REFERENCE_DEF.lastIndex = 0;
  while ((m = REFERENCE_DEF.exec(content)) !== null) {
    const ref = (m[1] ?? "").trim().toLowerCase();
    const url = m[2] ?? "";
    if (ref && url) {
      const start = m.index + m[0].lastIndexOf(url);
      refs.set(ref, { url, start });
    }
  }

  // Inline images and links.
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(content)) !== null) {
    const isImage = m[1] === "!";
    const url = m[2] ?? "";
    if (!url) continue;
    const start = m.index + m[0].indexOf(url, m[0].indexOf("("));
    considerUrl(
      {
        url,
        start,
        policyId: isImage ? "egress.markdown-image-exfil" : "egress.markdown-link-exfil",
      },
      allowlist,
      matches,
    );
  }

  // Reference-style uses resolve to their definition's URL span (redacting the
  // definition neutralizes every use that points at it).
  REFERENCE_USE.lastIndex = 0;
  const flaggedRefStarts = new Set<number>();
  while ((m = REFERENCE_USE.exec(content)) !== null) {
    const ref = (m[2] ?? "").trim().toLowerCase();
    const def = refs.get(ref);
    if (!def || flaggedRefStarts.has(def.start)) {
      continue;
    }
    flaggedRefStarts.add(def.start);
    considerUrl(
      { url: def.url, start: def.start, policyId: "egress.reference-link-exfil" },
      allowlist,
      matches,
    );
  }

  // HTML <img src>.
  HTML_IMG.lastIndex = 0;
  while ((m = HTML_IMG.exec(content)) !== null) {
    const url = m[2] ?? m[3] ?? m[4] ?? "";
    if (!url) continue;
    const start = m.index + m[0].lastIndexOf(url);
    considerUrl(
      { url, start, policyId: "egress.html-image-exfil" },
      allowlist,
      matches,
    );
  }

  return matches;
}
