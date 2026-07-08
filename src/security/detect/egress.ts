import type { DetectorMatch } from "../types";

// Egress / exfiltration heuristics (policies.md egress.default). Detects
// instructions to send data to an external URL and attempts to publish private
// project files. These are the escalation trigger for prompt-injection (§7a).
//
// Block E (E3) extends this with two deny-by-default rules, both gated so the
// shipped send-verb behavior is byte-identical when no allowlist is configured:
//   - `egress.non-allowlisted-domain` — ONLY when `allowlist` is non-empty: any
//     http(s) host not on the allowlist is flagged regardless of send-verb
//     proximity (AC2.2). Empty allowlist ⇒ today's proximity behavior (AC2.3).
//   - `egress.ssrf-metadata` — ALWAYS on: RFC-1918 / loopback / link-local /
//     cloud-metadata hosts (AC2.4). The existing suite contains no such hosts,
//     so this adds no new false positives on today's inputs.

const SEND_VERB =
  /\b(send|post|upload|exfiltrate|transmit|forward|leak|curl|wget|fetch|email|share)\b/i;
const EXTERNAL_URL = /\bhttps?:\/\/[^\s"'<>)]+/gi;

const PRIVATE_FILE =
  /(\.metaproject\/memory\b|\.metaproject\/data\/[^\s"']*\/raw\b|raw\s+logs?\b|\.env\b|local\s+config)/gi;

const SEND_WINDOW = 60;

// Bare SSRF host tokens (no scheme required): dotted-quad IPs (classified below)
// and the GCP metadata hostname. Scanned in addition to full URLs so a
// scheme-less `curl 169.254.169.254/...` or `fetch metadata.google.internal`
// vector is still caught (proximity-independent).
const BARE_SSRF_HOST =
  /\b(?:(?:\d{1,3}\.){3}\d{1,3}|metadata\.google\.internal)\b/gi;

// Extract the lowercased host from an `http(s)://…` URL, or null when the URL is
// malformed. Strips userinfo, port, path, query and fragment.
export function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  if (!m || m[1] === undefined) {
    return null;
  }
  let authority = m[1];
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    authority = authority.slice(at + 1);
  }
  // Strip a :port suffix (but keep IPv6 brackets intact).
  if (!authority.startsWith("[")) {
    const colon = authority.indexOf(":");
    if (colon >= 0) {
      authority = authority.slice(0, colon);
    }
  }
  return authority.toLowerCase();
}

// True when `host` is covered by the allowlist: an exact match or a subdomain of
// an allowlisted apex (`api.example.com` is allowed by `example.com`).
export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase().replace(/^\*\./, "");
    return h === e || h.endsWith(`.${e}`);
  });
}

// True when `host` is a private / loopback / link-local / cloud-metadata target.
export function isSsrfHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "metadata.google.internal" || h === "localhost") {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const o = v4.slice(1, 5).map((n) => Number(n));
    if (o.some((n) => n > 255)) {
      return false;
    }
    const [a, b] = o as [number, number, number, number];
    if (a === 10) return true; // 10/8 RFC-1918
    if (a === 127) return true; // 127/8 loopback
    if (a === 169 && b === 254) return true; // 169.254/16 link-local + metadata IP
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 RFC-1918
    if (a === 192 && b === 168) return true; // 192.168/16 RFC-1918
    return false;
  }
  // IPv6 loopback / unique-local / link-local.
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) {
    return true;
  }
  return false;
}

export function detectEgress(
  content: string,
  allowlist: string[] = [],
): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  const ssrfSpans = new Set<string>();

  EXTERNAL_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXTERNAL_URL.exec(content)) !== null) {
    const url = m[0];
    const start = m.index;
    const end = start + url.length;
    const host = hostOf(url);

    // SSRF / metadata takes precedence over the other URL rules.
    if (host && isSsrfHost(host)) {
      matches.push({
        category: "egress",
        policyId: "egress.ssrf-metadata",
        severity: "critical",
        confidence: 0.8,
        start,
        end,
        value: url,
        remediation:
          "Block requests to private, loopback, link-local, or cloud-metadata hosts (SSRF).",
      });
      ssrfSpans.add(`${start}:${end}`);
    } else if (host && allowlist.length > 0 && !hostAllowed(host, allowlist)) {
      // Deny-by-default: proximity-independent when an allowlist is configured.
      matches.push({
        category: "egress",
        policyId: "egress.non-allowlisted-domain",
        severity: "high",
        confidence: 0.7,
        start,
        end,
        value: url,
        remediation:
          "Destination host is not on the egress allowlist; add it explicitly or remove the reference.",
      });
    }

    // Shipped rule (unchanged): send-verb proximity flags an external URL. Kept
    // independent of the allowlist so today's behavior is byte-identical.
    const before = content.slice(Math.max(0, start - SEND_WINDOW), start);
    if (SEND_VERB.test(before)) {
      matches.push({
        category: "egress",
        policyId: "egress.external-url-send",
        severity: "critical",
        confidence: 0.75,
        start,
        end,
        value: url,
        remediation:
          "Do not send project data to external URLs without explicit approval.",
      });
    }
    if (m.index === EXTERNAL_URL.lastIndex) {
      EXTERNAL_URL.lastIndex += 1;
    }
  }

  // Scheme-less SSRF host tokens (proximity-independent).
  BARE_SSRF_HOST.lastIndex = 0;
  while ((m = BARE_SSRF_HOST.exec(content)) !== null) {
    const value = m[0];
    const start = m.index;
    const end = start + value.length;
    // Skip a token already covered by a scheme-qualified SSRF URL above.
    const covered = [...ssrfSpans].some((span) => {
      const [s, e] = span.split(":").map((n) => Number(n));
      return start >= (s ?? 0) && end <= (e ?? 0);
    });
    if (!covered && isSsrfHost(value)) {
      matches.push({
        category: "egress",
        policyId: "egress.ssrf-metadata",
        severity: "critical",
        confidence: 0.8,
        start,
        end,
        value,
        remediation:
          "Block requests to private, loopback, link-local, or cloud-metadata hosts (SSRF).",
      });
    }
    if (m.index === BARE_SSRF_HOST.lastIndex) {
      BARE_SSRF_HOST.lastIndex += 1;
    }
  }

  PRIVATE_FILE.lastIndex = 0;
  while ((m = PRIVATE_FILE.exec(content)) !== null) {
    const value = m[0];
    // Only treat a private-file reference as egress when paired with a send verb
    // somewhere in the surrounding window (otherwise it is a benign mention).
    const window = content.slice(
      Math.max(0, m.index - SEND_WINDOW),
      Math.min(content.length, m.index + value.length + SEND_WINDOW),
    );
    if (!SEND_VERB.test(window)) {
      continue;
    }
    matches.push({
      category: "egress",
      policyId: "egress.private-file-publish",
      severity: "high",
      confidence: 0.65,
      start: m.index,
      end: m.index + value.length,
      value,
      remediation: "Never publish private memory/raw/config files externally.",
    });
    if (m.index === PRIVATE_FILE.lastIndex) {
      PRIVATE_FILE.lastIndex += 1;
    }
  }

  return matches;
}
