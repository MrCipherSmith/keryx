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

// Extract the lowercased host from an `http(s)://…` URL the way the request
// would resolve it, or null when the URL is malformed. The WHATWG parser is the
// source of truth: it treats `\\` as `/`, drops `[v6]:port`, and normalises
// decimal/hex/octal IPv4 forms. Text it rejects (e.g. a `%25` zone id) falls back
// to a literal authority read.
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    if (host) {
      return host.toLowerCase();
    }
  } catch {
    // fall through to the literal read
  }
  return literalHostOf(url);
}

// Literal authority read: strips userinfo, port, path, query and fragment, and
// ends the authority at a backslash like the WHATWG parser does.
function literalHostOf(url: string): string | null {
  const m = /^https?:[/\\]{2}([^/?#\\]+)/i.exec(url);
  if (!m || m[1] === undefined) {
    return null;
  }
  let authority = m[1];
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    authority = authority.slice(at + 1);
  }
  if (authority.startsWith("[")) {
    // Keep the bracketed IPv6 literal, drop the `:port` after it.
    const close = authority.indexOf("]");
    return close > 0 ? authority.slice(0, close + 1).toLowerCase() : null;
  }
  const colon = authority.indexOf(":");
  if (colon >= 0) {
    authority = authority.slice(0, colon);
  }
  return authority.toLowerCase() || null;
}

// Every reading of the URL's host. A guard flags a URL when ANY reading is
// private or non-allowlisted, so a parser disagreement cannot hide a target.
function hostCandidates(url: string): string[] {
  const hosts = [hostOf(url), literalHostOf(url)].filter((h): h is string => !!h);
  return [...new Set(hosts)];
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

function isPrivateV4(a: number, b: number): boolean {
  if (a === 0) return true; // 0/8 "this network" (0.0.0.0 reaches localhost)
  if (a === 10) return true; // 10/8 RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + metadata IP
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 RFC-1918
  if (a === 192 && b === 168) return true; // 192.168/16 RFC-1918
  return false;
}

// Dotted quad read as plain decimal (`010` is 10), as the shipped rule did.
function decimalV4(h: string): [number, number] | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return null;
  const o = v4.slice(1, 5).map((n) => Number(n));
  if (o.some((n) => n > 255)) return null;
  return [o[0] as number, o[1] as number];
}

// IPv4 read as the WHATWG/inet_aton parser does: 1-4 parts, each decimal, 0x hex
// or 0-prefixed octal, the last part filling the remaining bytes.
function whatwgV4(h: string): [number, number] | null {
  const parts = h.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^(0|[1-9]\d*)$/.test(p)) n = Number(p);
    else return null;
    nums.push(n);
  }
  const last = nums.pop() as number;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let value = last;
  nums.forEach((n, i) => {
    value += n * 256 ** (3 - i);
  });
  return [Math.floor(value / 2 ** 24), Math.floor(value / 2 ** 16) % 256];
}

// Parse an IPv6 literal (brackets and zone id already removed) into 8 hextets.
function parseV6(h: string): number[] | null {
  let text = h;
  const tail: number[] = [];
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const o = (v4[2] as string).split(".").map(Number);
    if (o.some((n) => n > 255)) return null;
    tail.push(((o[0] as number) << 8) | (o[1] as number), ((o[2] as number) << 8) | (o[3] as number));
    text = `${v4[1] as string}0`; // placeholder hextet, dropped below
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = read(halves[0] as string);
  const rest = halves.length === 2 ? read(halves[1] as string) : [];
  if (!head || !rest) return null;
  if (tail.length > 0) (rest.length > 0 ? rest : head).pop();
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  return [...head, ...new Array<number>(8 - given).fill(0), ...rest, ...tail];
}

// True when `host` is a private / loopback / link-local / cloud-metadata target.
export function isSsrfHost(host: string): boolean {
  const h = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (h === "metadata.google.internal" || h === "localhost" || h.endsWith(".localhost")) {
    return true;
  }
  // IPv6 classification applies only to IPv6 literals, never to DNS names
  // such as fcc.gov or fdic.gov.
  if (h.includes(":")) {
    const g = parseV6(h.replace(/%.*$/, ""));
    if (!g) return false;
    const [g0, , , , , g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    if (g.slice(0, 7).every((x) => x === 0) && g7 <= 1) return true; // :: and ::1
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) {
      return isPrivateV4(g6 >> 8, g6 & 0xff); // ::ffff:a.b.c.d IPv4-mapped
    }
    return false;
  }
  return [decimalV4(h), whatwgV4(h)].some((v4) => v4 !== null && isPrivateV4(v4[0], v4[1]));
}

export function detectEgress(
  content: string,
  allowlist: string[] = [],
): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  // SSRF URL spans, pushed in ascending order (the URL scan walks left to right).
  const ssrfSpans: { start: number; end: number }[] = [];

  EXTERNAL_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXTERNAL_URL.exec(content)) !== null) {
    const url = m[0];
    const start = m.index;
    const end = start + url.length;
    const hosts = hostCandidates(url);

    // SSRF / metadata takes precedence over the other URL rules.
    if (hosts.some(isSsrfHost)) {
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
      ssrfSpans.push({ start, end });
    } else if (
      hosts.length > 0 &&
      allowlist.length > 0 &&
      hosts.some((h) => !hostAllowed(h, allowlist))
    ) {
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
  let span = 0;
  while ((m = BARE_SSRF_HOST.exec(content)) !== null) {
    const value = m[0];
    const start = m.index;
    const end = start + value.length;
    // Skip a token already covered by a scheme-qualified SSRF URL above. Both
    // walks are ascending, so a moving cursor keeps this linear.
    while (span < ssrfSpans.length && (ssrfSpans[span] as { end: number }).end <= start) {
      span += 1;
    }
    const cur = ssrfSpans[span];
    const covered = cur !== undefined && start >= cur.start && end <= cur.end;
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
