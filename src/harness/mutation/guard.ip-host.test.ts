// Flow 301 F3 (security review of the allowlist feature): `looksLikeIpHost` is
// what refuses a "domain" that is actually an IP address in disguise — including
// the `inet_aton` short/mixed-radix forms (`127.1`) that the original,
// strict-dotted-quad-only check let through. Used by the allowlist proxy
// (`src/harness/process/sandbox/proxy.ts`) as `isIpLiteral`'s replacement, and
// mirrored (duplicated, by necessity — see the export's own doc comment on the
// core/client zone boundary) in `agentTaskDomainProblem`
// (`src/trigger/config.ts`).
import { describe, expect, test } from "bun:test";
import { looksLikeIpHost } from "./guard";

describe("looksLikeIpHost", () => {
  test("a real domain is not an IP host", () => {
    expect(looksLikeIpHost("api.github.com")).toBe(false);
    expect(looksLikeIpHost("example.com")).toBe(false);
    expect(looksLikeIpHost("a.b.c.example.com")).toBe(false);
  });

  test("a strict dotted-quad is an IP host", () => {
    expect(looksLikeIpHost("127.0.0.1")).toBe(true);
    expect(looksLikeIpHost("8.8.8.8")).toBe(true);
  });

  test("F3: inet_aton short and mixed-radix forms are IP hosts", () => {
    expect(looksLikeIpHost("127.1")).toBe(true); // 127.0.0.1, 2-part form
    expect(looksLikeIpHost("10.1.2")).toBe(true); // 3-part form
    expect(looksLikeIpHost("0177.0.0.1")).toBe(true); // octal first octet
    expect(looksLikeIpHost("0x7f.0.0.1")).toBe(true); // hex first octet
  });

  test("F3: flat decimal/hex/octal 32-bit integers are IP hosts", () => {
    expect(looksLikeIpHost("2130706433")).toBe(true); // decimal-encoded 127.0.0.1
    expect(looksLikeIpHost("0x7f000001")).toBe(true); // hex-encoded 127.0.0.1
  });

  test("F3: a domain whose final label is all-numeric or hex-numeric is refused, even when the whole string does not decode as one address", () => {
    expect(looksLikeIpHost("example.123")).toBe(true);
    expect(looksLikeIpHost("example.0x1a")).toBe(true);
  });

  test("bracketed and bare IPv6 are IP hosts", () => {
    expect(looksLikeIpHost("::1")).toBe(true);
    expect(looksLikeIpHost("[::1]")).toBe(true);
    expect(looksLikeIpHost("2606:4700:4700::1111")).toBe(true);
  });
});
