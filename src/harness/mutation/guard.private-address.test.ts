// Flow 301: `isPrivateOrReservedAddress` is what the allowlist proxy
// (`src/harness/process/sandbox/proxy.ts`) calls AFTER resolving an allowed
// domain name, to refuse a resolved loopback/private/link-local/CGNAT/
// unique-local/metadata address — the one point the argv/URL-text scanner
// above (`PRIVATE_EGRESS_PATTERNS`) cannot reach, since that runs before any
// DNS lookup. Pure numeric/lexical classification; no network, no fs.
import { describe, expect, test } from "bun:test";
import { isPrivateIPv4, isPrivateOrReservedAddress } from "./guard";

describe("isPrivateIPv4", () => {
  test("classifies every reserved/private IPv4 range", () => {
    expect(isPrivateIPv4(0, 0, 0, 0)).toBe(true); // unspecified
    expect(isPrivateIPv4(127, 0, 0, 1)).toBe(true); // loopback
    expect(isPrivateIPv4(10, 1, 2, 3)).toBe(true); // RFC1918
    expect(isPrivateIPv4(172, 16, 0, 1)).toBe(true);
    expect(isPrivateIPv4(172, 31, 255, 255)).toBe(true);
    expect(isPrivateIPv4(172, 15, 0, 1)).toBe(false); // just outside 172.16/12
    expect(isPrivateIPv4(172, 32, 0, 1)).toBe(false);
    expect(isPrivateIPv4(192, 168, 0, 1)).toBe(true);
    expect(isPrivateIPv4(169, 254, 169, 254)).toBe(true); // cloud metadata
    expect(isPrivateIPv4(100, 64, 0, 1)).toBe(true); // CGNAT
    expect(isPrivateIPv4(100, 127, 255, 255)).toBe(true);
    expect(isPrivateIPv4(100, 63, 255, 255)).toBe(false);
  });

  test("public addresses are not private", () => {
    expect(isPrivateIPv4(8, 8, 8, 8)).toBe(false);
    expect(isPrivateIPv4(1, 1, 1, 1)).toBe(false);
    expect(isPrivateIPv4(93, 184, 216, 34)).toBe(false);
  });
});

describe("isPrivateOrReservedAddress", () => {
  test("refuses every resolved-IPv4 private/reserved/metadata form", () => {
    expect(isPrivateOrReservedAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("169.254.169.254")).toBe(true); // AWS/GCP/Azure metadata
    expect(isPrivateOrReservedAddress("10.0.0.5")).toBe(true);
    expect(isPrivateOrReservedAddress("172.20.3.4")).toBe(true);
    expect(isPrivateOrReservedAddress("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedAddress("100.64.1.1")).toBe(true);
    expect(isPrivateOrReservedAddress("0.0.0.0")).toBe(true);
  });

  test("refuses IPv6 loopback, link-local, unique-local and unspecified", () => {
    expect(isPrivateOrReservedAddress("::1")).toBe(true);
    expect(isPrivateOrReservedAddress("[::1]")).toBe(true);
    expect(isPrivateOrReservedAddress("::")).toBe(true);
    expect(isPrivateOrReservedAddress("fe80::1")).toBe(true);
    expect(isPrivateOrReservedAddress("fc00::1")).toBe(true);
    expect(isPrivateOrReservedAddress("fd12:3456::1")).toBe(true);
  });

  test("refuses an IPv4-mapped-IPv6 private address (the classic proxy bypass form)", () => {
    expect(isPrivateOrReservedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  test("allows real public addresses, v4 and v6", () => {
    expect(isPrivateOrReservedAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedAddress("1.1.1.1")).toBe(false);
    expect(isPrivateOrReservedAddress("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS
  });

  test("fails closed on a malformed IPv4 octet", () => {
    expect(isPrivateOrReservedAddress("999.1.1.1")).toBe(true);
  });
});
