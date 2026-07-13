// Structural mutation guard (flow 013, W10 / M-01, reviewer track: security).
//
// `guardAction` is the fail-closed structural gate in front of any mutating or
// shell-capable action. It denies — BEFORE composing the W3 policy engine — on:
// unavailable scan/isolation, path traversal / symlink escape outside the
// worktree, shell metacharacters in argv, private/loopback/link-local/metadata
// egress, and direct credential/secret access; only a structurally clean action
// is handed to `decide()` for the profile/risk verdict. Deterministic and
// side-effect-free: clock/id arrive via `deps`; path resolution and symlink
// resolution are data-only (`resolveSymlink` is injected, never a real fs call);
// there is NO `Date.now`/`Math.random`/network/fs here (AC2, AC3,
// SC_R15_* scenarios).
import path from "node:path";
import type { ToolRisk } from "../tool/types";
import { decide } from "../policy/engine";
import type { PolicyContext, PolicyDeps, PolicyProfile } from "../policy/types";
import { actionFingerprint, type ActionSpec } from "./fingerprint";

/** A structural-guard verdict: allow the action, or deny it with a reason. */
export type GuardOutcome = { kind: "allow" } | { kind: "deny"; reason: string };

/**
 * Inputs to {@link guardAction}. `risk` is required because the composed
 * `decide()` needs a {@link ToolRisk} to resolve the profile baseline, and
 * {@link ActionSpec} carries none. `resolveSymlink`, when supplied, maps a
 * resolved in-root path to its (data-only) symlink target for escape detection.
 */
export interface GuardInput {
  spec: ActionSpec;
  worktreeRoot: string;
  profile: PolicyProfile;
  interactive: boolean;
  scanAvailable: boolean;
  risk: ToolRisk;
  resolveSymlink?: (resolvedPath: string) => string;
}

/**
 * Shell metacharacters that must never appear inside a single argv token
 * (argv-over-shell: one argument element may not carry shell-interpretable
 * syntax): `;  &  |  \`  $  (  )  <  >`.
 */
const SHELL_METACHARS = /[;&|`$()<>]/;

/** Private/loopback/link-local/metadata host markers denied at the egress boundary. */
const PRIVATE_HOST_TOKENS = [
  "127.0.0.1",
  "169.254.169.254",
  "10.",
  "172.16.",
  "192.168.",
  "localhost",
] as const;

/**
 * Broadened, purely string/regex private-egress markers. Additive over
 * {@link PRIVATE_HOST_TOKENS}: it keeps every previously-denied form and ADDS
 * the alternate/encoded SSRF bypass vectors (IPv6 loopback, decimal/hex/octal
 * and short-form IPv4 loopback, the full 172.16–172.31 RFC1918 range, the
 * unspecified 0.0.0.0, CGNAT 100.64.0.0/10, and case-insensitive localhost).
 * No DNS/network/fs — a pure lexical check on one argv token (AC1).
 */
const PRIVATE_EGRESS_PATTERNS: readonly RegExp[] = [
  // Case-insensitive localhost (LOCALHOST / LocalHost / localhost).
  /localhost/i,
  // IPv6 loopback ::1 — bare, bracketed `[::1]`, or with a port — but not a
  // longer hex address such as `::1a` / `::10`.
  /::1(?![0-9a-f])/i,
  // IPv4 loopback 127.0.0.0/8: full `127.0.0.1`, short forms `127.1` / `127.0.1`.
  /(?<![0-9.])127\.\d/,
  // Decimal-encoded loopback `2130706433` (== 127.0.0.1).
  /(?<!\d)2130706433(?!\d)/,
  // Hex-encoded loopback (`0x7f000001`, dotted `0x7f.0.0.1`).
  /0x0*7f/i,
  // Octal-encoded loopback first octet (`0177.0.0.1`).
  /(?<!\d)0177\./,
  // Link-local / cloud metadata 169.254.0.0/16 (incl. 169.254.169.254).
  /(?<!\d)169\.254\./,
  // RFC1918 10.0.0.0/8.
  /(?<!\d)10\.\d/,
  // RFC1918 172.16.0.0/12 — the FULL 172.16–172.31 range.
  /(?<!\d)172\.(1[6-9]|2\d|3[01])\./,
  // RFC1918 192.168.0.0/16.
  /(?<!\d)192\.168\./,
  // Unspecified / "all interfaces" 0.0.0.0.
  /(?<!\d)0\.0\.0\.0(?!\d)/,
  // CGNAT shared address space 100.64.0.0/10 (100.64–100.127).
  /(?<!\d)100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

/** Largest 32-bit IPv4 integer; anything above is not a well-formed encoded IPv4. */
const MAX_U32 = 0xffffffff;

/** Split a 32-bit host-order integer into its four dotted-quad octets. */
function u32ToOctets(n: number): [number, number, number, number] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/**
 * True when the decoded four octets fall inside ANY private / reserved /
 * link-local / metadata IPv4 range: unspecified `0.0.0.0`, loopback
 * `127.0.0.0/8`, RFC1918 `10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16`,
 * link-local + cloud metadata `169.254.0.0/16`, and CGNAT `100.64.0.0/10`.
 * Public destinations (e.g. `8.8.8.8`) return `false`. Pure arithmetic.
 */
function isPrivateIPv4(o0: number, o1: number, o2: number, o3: number): boolean {
  if (o0 === 0 && o1 === 0 && o2 === 0 && o3 === 0) return true; // 0.0.0.0 unspecified
  if (o0 === 127) return true; // 127.0.0.0/8 loopback
  if (o0 === 10) return true; // 10.0.0.0/8 RFC1918
  if (o0 === 172 && o1 >= 16 && o1 <= 31) return true; // 172.16.0.0/12 RFC1918
  if (o0 === 192 && o1 === 168) return true; // 192.168.0.0/16 RFC1918
  if (o0 === 169 && o1 === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (o0 === 100 && o1 >= 64 && o1 <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * Parse one flat integer token in decimal, `0x`-hex, or leading-`0` octal into
 * a non-negative 32-bit value, or `null` if it is not a well-formed integer or
 * overflows 32 bits. Overflow / malformed input fall through as not-an-IP
 * (never throws). Pure lexical/arithmetic.
 */
function parseFlatInt(s: string): number | null {
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(s)) value = parseInt(s.slice(2), 16);
  else if (/^0[0-7]+$/.test(s)) value = parseInt(s.slice(1), 8);
  else if (/^[0-9]+$/.test(s)) value = parseInt(s, 10);
  else return null;
  if (!Number.isFinite(value) || value < 0 || value > MAX_U32) return null;
  return value;
}

/**
 * Decode a dotted IPv4 candidate with `inet_aton` mixed-radix / short-form
 * semantics: 2 parts = `a.(24-bit)`, 3 parts = `a.b.(16-bit)`, 4 parts =
 * `a.b.c.d`; each part may be decimal, hex, or octal. Returns the four octets,
 * or `null` when malformed / out of range (never throws).
 */
function decodeDottedIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    const v = parseFlatInt(part);
    if (v === null) return null;
    nums.push(v);
  }
  if (parts.length === 4) {
    if (nums.some((x) => x > 255)) return null;
    return [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number];
  }
  if (parts.length === 3) {
    const [a, b, c] = nums as [number, number, number];
    if (a > 255 || b > 255 || c > 0xffff) return null;
    return [a, b, (c >>> 8) & 255, c & 255];
  }
  const [a, b] = nums as [number, number];
  if (a > 255 || b > 0xffffff) return null;
  return [a, (b >>> 16) & 255, (b >>> 8) & 255, b & 255];
}

/**
 * Decode a single host candidate expressed as an ENCODED IPv4 into its four
 * octets, or `null` when it is not a well-formed encoded IPv4. Covers flat
 * decimal / hex / octal 32-bit integers, dotted mixed-radix + short forms, and
 * IPv4-mapped IPv6 (`::ffff:<ipv4>` as dotted tail or two hex groups). Purely
 * lexical/arithmetic — no DNS, no sockets; malformed input falls through.
 */
function decodeEncodedIPv4(candidate: string): [number, number, number, number] | null {
  const mapped = /::ffff:(.+)$/i.exec(candidate);
  if (mapped) {
    const tail = mapped[1] as string;
    if (tail.includes(".")) return decodeDottedIPv4(tail);
    const groups = tail.split(":");
    if (groups.length === 2 && /^[0-9a-f]{1,4}$/i.test(groups[0] as string) && /^[0-9a-f]{1,4}$/i.test(groups[1] as string)) {
      const n = parseInt(groups[0] as string, 16) * 0x10000 + parseInt(groups[1] as string, 16);
      if (n <= MAX_U32) return u32ToOctets(n);
    }
    return null;
  }
  if (candidate.includes(".")) return decodeDottedIPv4(candidate);
  const n = parseFlatInt(candidate);
  if (n === null) return null;
  return u32ToOctets(n);
}

/**
 * Extract host candidates from an argv token so an encoded IPv4 can be decoded
 * even when embedded in a URL. Strips scheme, path/query/fragment, userinfo,
 * IPv6 brackets, and a trailing `:port` (only when the authority has at most
 * one colon, so multi-colon IPv6 tails such as `::ffff:7f00:1` stay intact).
 * Purely lexical; always includes the raw token as a fallback.
 */
function extractHostCandidates(token: string): string[] {
  const out = new Set<string>();
  let s = token;
  const scheme = s.indexOf("://");
  if (scheme >= 0) s = s.slice(scheme + 3);
  s = s.split(/[/?#]/)[0] ?? s;
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close > 0) {
      out.add(s.slice(1, close));
      s = "";
    }
  }
  if (s.length > 0) {
    const colons = (s.match(/:/g) ?? []).length;
    if (colons <= 1) out.add(s.split(":")[0] ?? s);
    else out.add(s);
  }
  out.add(token.replace(/^\[/, "").replace(/\](?::[0-9]+)?$/, ""));
  out.add(token);
  return [...out].filter((c) => c.length > 0);
}

/**
 * True when a single argv token names a private/loopback/link-local/metadata
 * egress destination in any known plain OR alternate/encoded form. Additive
 * over {@link PRIVATE_HOST_TOKENS} and {@link PRIVATE_EGRESS_PATTERNS} (never
 * denies fewer forms): also DECODES encoded IPv4 host candidates (flat
 * decimal/hex/octal, dotted mixed-radix + short forms, IPv4-mapped IPv6) and
 * checks the decoded address against every private range. Pure lexical.
 */
function isPrivateEgressToken(token: string): boolean {
  if (PRIVATE_HOST_TOKENS.some((host) => token.includes(host))) return true;
  if (PRIVATE_EGRESS_PATTERNS.some((pattern) => pattern.test(token))) return true;
  for (const candidate of extractHostCandidates(token)) {
    const octets = decodeEncodedIPv4(candidate);
    if (octets !== null && isPrivateIPv4(octets[0], octets[1], octets[2], octets[3])) {
      return true;
    }
  }
  return false;
}

/**
 * Additive public export of the private-egress predicate, for reuse by network
 * adapters that must fail-closed on private/loopback/link-local/metadata hosts
 * (RP-01 Anthropic egress guard). Delegates verbatim to the existing
 * {@link isPrivateEgressToken}; this adds NO behavior change to `guardAction`
 * and re-uses the same SSRF-decoding logic rather than reimplementing it.
 */
export function isPrivateEgressHost(host: string): boolean {
  return isPrivateEgressToken(host);
}

/**
 * Additive sibling to {@link isPrivateEgressHost}: TRUE only when `host` names a
 * LOOPBACK destination — `127.0.0.0/8` (incl. short forms like `127.1`),
 * IPv6 `::1` / `[::1]`, case-insensitive `localhost`, and the encoded loopback
 * forms the existing decoder already recognizes (decimal `2130706433`, hex
 * `0x7f000001`). FALSE for metadata/link-local (`169.254.*`), RFC1918
 * (`10.*`/`172.16-31.*`/`192.168.*`), and public hosts. This narrows — it never
 * widens — the SSRF guard: it REUSES {@link decodeEncodedIPv4} /
 * {@link extractHostCandidates} and only accepts a decoded first octet of 127.
 * Adds NO behavior change to `guardAction` / `isPrivateEgressHost`. Pure lexical.
 */
export function isLoopbackHost(host: string): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  const normalized = host.trim();
  // Case-insensitive `localhost` (exact host, not a substring like `notlocalhost`).
  if (/^localhost$/i.test(normalized)) return true;
  // IPv6 loopback `::1`, bare or bracketed `[::1]`.
  const unbracketed = normalized.replace(/^\[/, "").replace(/\]$/, "");
  if (/^::1$/i.test(unbracketed)) return true;
  // Encoded / dotted / short-form IPv4 loopback: decode and require octet0 === 127.
  for (const candidate of extractHostCandidates(normalized)) {
    const octets = decodeEncodedIPv4(candidate);
    if (octets !== null && octets[0] === 127) return true;
  }
  return false;
}

/** Case-insensitive markers of a direct credential/secret file. */
const CREDENTIAL_PATH_TOKENS = [".env", "credentials", ".ssh/", "id_rsa", ".pem"] as const;

/** argv vectors that dump the whole environment (unrestricted secret snapshot). */
const ENV_DUMP_ARGV = new Set(["env", "printenv"]);

function deny(reason: string): GuardOutcome {
  return { kind: "deny", reason };
}

/** True when `candidate`, once resolved, stays inside `root`. */
function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Structurally guard `input`, then compose the W3 policy engine.
 *
 * Order (fail-closed first, then structural denies, then policy):
 *   1. `scanAvailable === false`                    -> deny (scan/isolation)
 *   2. path traversal / symlink escape              -> deny (traversal/escape)
 *   3. shell metacharacters in argv                 -> deny (shell injection)
 *   4. private/loopback/link-local/metadata egress  -> deny (private address)
 *   5. direct credential/secret access              -> deny (credential/env)
 *   6. otherwise                                     -> `decide()` verdict
 */
export function guardAction(input: GuardInput, deps: PolicyDeps): GuardOutcome {
  const { spec, worktreeRoot, profile, interactive, scanAvailable, risk, resolveSymlink } = input;

  // 1. Fail-closed: no scan/isolation, no execution — regardless of profile.
  if (scanAvailable === false) {
    return deny("Required scan/isolation is unavailable; failing closed.");
  }

  // 2. Path traversal / symlink escape — denied before the target is opened.
  const resolvedPath = path.resolve(worktreeRoot, spec.path);
  if (!isWithinRoot(worktreeRoot, resolvedPath)) {
    return deny(
      `Path traversal: ${spec.path} escapes and resolves outside the worktree root ${worktreeRoot}.`,
    );
  }
  if (resolveSymlink !== undefined) {
    const linkTarget = path.resolve(worktreeRoot, resolveSymlink(resolvedPath));
    if (!isWithinRoot(worktreeRoot, linkTarget)) {
      return deny(
        `Symlink escape: ${spec.path} resolves to a target outside the worktree root ${worktreeRoot}.`,
      );
    }
  }

  // 3. Shell injection — any argv token carrying shell metacharacters.
  for (const token of spec.argv) {
    if (SHELL_METACHARS.test(token)) {
      return deny(`Shell injection denied: argv token "${token}" carries shell metacharacters.`);
    }
  }

  // 4. Private/loopback/link-local/metadata egress destination in argv,
  //    including alternate/encoded SSRF bypass forms (AC1). Fires BEFORE the
  //    `decide()` policy fallthrough so the deny carries a private-address reason.
  for (const token of spec.argv) {
    if (isPrivateEgressToken(token)) {
      return deny(
        `Private/loopback/link-local/metadata address egress denied: "${token}".`,
      );
    }
  }

  // 5. Direct credential/secret access — sensitive path or full env dump.
  const lowerPath = spec.path.toLowerCase();
  if (CREDENTIAL_PATH_TOKENS.some((token) => lowerPath.includes(token))) {
    return deny(`Direct credential/secret file access denied: ${spec.path}.`);
  }
  if (spec.argv.length === 1 && ENV_DUMP_ARGV.has(spec.argv[0] as string)) {
    return deny(`Unrestricted environment snapshot denied: ${spec.argv[0]}.`);
  }

  // 6. Structurally clean — compose the W3 policy engine for the verdict.
  const actionFp = actionFingerprint(spec, { worktreeRoot, envAllowlist: [] });
  const ctx: PolicyContext = {
    profile,
    interactive,
    approvals: [],
    actionFingerprint: actionFp,
    targetPath: spec.path,
  };
  const decision = decide({ toolCallId: deps.idSeq(), risk }, ctx, deps);
  if (decision.decision === "allow") {
    return { kind: "allow" };
  }
  return deny(decision.reason ?? `Denied by ${profile.profileId} policy for ${risk}.`);
}
