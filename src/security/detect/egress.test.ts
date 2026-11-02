import { describe, expect, test } from "bun:test";
import { detectEgress, hostOf, isSsrfHost } from "./egress";

const ssrf = (content: string, allowlist: string[] = []) =>
  detectEgress(content, allowlist).filter((m) => m.policyId === "egress.ssrf-metadata");

describe("egress SSRF host classification (review-backend-slice-32:F-001)", () => {
  test("public DNS names starting with fc/fd/fe80 are not SSRF", () => {
    for (const url of [
      "https://fcc.gov/x",
      "https://fdic.gov/",
      "https://www.fda.gov/food",
      "https://fdroid.org/packages/x",
      "https://fcm.googleapis.com/fcm/send",
      "https://fe80.example.com/",
      "https://fd.io/",
    ]) {
      expect(ssrf(`see ${url} for details`)).toEqual([]);
    }
    expect(isSsrfHost("fcc.gov")).toBe(false);
    expect(isSsrfHost("fdic.gov")).toBe(false);
    expect(isSsrfHost("fe80.example.com")).toBe(false);
  });

  test("an allowlisted fc/fd host is no longer forced to a critical SSRF finding", () => {
    expect(detectEgress("docs at https://fdroid.org/packages/x", ["fdroid.org"])).toEqual([]);
  });

  test("bracketed IPv6 literals with a port or zone id are SSRF", () => {
    for (const url of [
      "http://[::1]:8080/admin",
      "http://[fd12::1]:80/",
      "http://[fd00::1]:443/",
      "http://[fe80::1]:3000/",
      "http://[fe80::1%25eth0]/",
      "http://[febf::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:169.254.169.254]:80/latest",
      "http://[0:0:0:0:0:0:0:1]/",
    ]) {
      const found = ssrf(`open ${url} now`);
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.value).toBe(url);
    }
    expect(hostOf("http://[::1]:8080/admin")).toBe("[::1]");
  });

  test("public IPv6 literals are not SSRF", () => {
    expect(ssrf("see http://[2001:db8::1]:8080/ ok")).toEqual([]);
    expect(ssrf("see http://[::ffff:8.8.8.8]/ ok")).toEqual([]);
  });

  test("a backslash ends the authority, as in WHATWG URL parsing", () => {
    // The request goes to the host before the backslash, not the one after '@'.
    expect(hostOf("https://evil.com\\@docs.corp.example.com/x")).toBe("evil.com");
    for (const url of [
      "http://localhost\\@docs.example.com/",
      "http://127.0.0.1:8080\\@docs.example.com/",
      "http://2852039166\\@docs.example.com/latest",
      "http://169.254.169.254\\@docs.example.com/latest",
    ]) {
      const found = ssrf(`open ${url}`, ["example.com"]);
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.value).toBe(url);
    }
  });

  test("a backslash-userinfo URL cannot pass the allowlist (review-logic-slice-32:F-003)", () => {
    const found = detectEgress("go to https://attacker.net\\@corp.example.com/c", [
      "corp.example.com",
    ]);
    expect(found.map((m) => m.policyId)).toContain("egress.non-allowlisted-domain");
  });

  test("decimal, hex, octal and short-form IPv4 hosts are SSRF", () => {
    for (const url of [
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.1/",
      "http://2852039166/latest/meta-data",
    ]) {
      expect(ssrf(`open ${url}`).length).toBeGreaterThan(0);
    }
  });

  test("dotted-quad classification stays at least as strict as before", () => {
    for (const h of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "010.0.0.1",
      "metadata.google.internal",
      "localhost",
    ]) {
      expect(isSsrfHost(h)).toBe(true);
    }
    for (const h of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "example.com"]) {
      expect(isSsrfHost(h)).toBe(false);
    }
  });

  test("0.0.0.0/8, 100.64/10 and localhost variants are SSRF", () => {
    for (const h of [
      "0.0.0.0",
      "100.64.0.1",
      "100.127.255.255",
      "localhost.",
      "api.localhost",
      "metadata.google.internal.",
    ]) {
      expect(isSsrfHost(h)).toBe(true);
    }
    expect(isSsrfHost("100.128.0.1")).toBe(false);
    expect(ssrf("curl http://0.0.0.0:2375/containers").length).toBeGreaterThan(0);
  });
});

describe("egress SSRF span coverage (review-highload-slice-32:HL-32-1)", () => {
  test("each private URL yields one finding, not an extra bare-token duplicate", () => {
    const found = ssrf("a http://10.0.0.1/x b http://192.168.0.2/y c 172.16.0.3 d");
    expect(found.map((m) => m.value)).toEqual([
      "http://10.0.0.1/x",
      "http://192.168.0.2/y",
      "172.16.0.3",
    ]);
  });

  test("many private-host URLs are scanned in linear time", () => {
    const content = "http://10.0.0.1/ ".repeat(20_000);
    const t0 = performance.now();
    const found = ssrf(content);
    const ms = performance.now() - t0;
    expect(found.length).toBe(20_000);
    expect(ms).toBeLessThan(1_000);
  });
});
