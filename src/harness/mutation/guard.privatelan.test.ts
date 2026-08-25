import { describe, expect, test } from "bun:test";
import { isPrivateLanHost } from "./guard";

describe("isPrivateLanHost — narrow RFC1918/CGNAT re-permit (never loopback/metadata/public)", () => {
  test("RFC1918 10/8", () => {
    expect(isPrivateLanHost("10.110.43.19")).toBe(true);
    expect(isPrivateLanHost("10.0.0.1")).toBe(true);
  });

  test("RFC1918 172.16/12 and 192.168/16", () => {
    expect(isPrivateLanHost("172.16.0.1")).toBe(true);
    expect(isPrivateLanHost("172.31.255.255")).toBe(true);
    expect(isPrivateLanHost("172.32.0.1")).toBe(false);
    expect(isPrivateLanHost("192.168.1.1")).toBe(true);
  });

  test("CGNAT 100.64/10", () => {
    expect(isPrivateLanHost("100.64.0.1")).toBe(true);
    expect(isPrivateLanHost("100.127.255.254")).toBe(true);
    expect(isPrivateLanHost("100.128.0.1")).toBe(false);
  });

  test("loopback, metadata, unspecified, public, hostnames stay FALSE (narrowing, never widening)", () => {
    expect(isPrivateLanHost("127.0.0.1")).toBe(false);
    expect(isPrivateLanHost("localhost")).toBe(false);
    expect(isPrivateLanHost("::1")).toBe(false);
    expect(isPrivateLanHost("169.254.169.254")).toBe(false);
    expect(isPrivateLanHost("0.0.0.0")).toBe(false);
    expect(isPrivateLanHost("203.0.113.5")).toBe(false);
    expect(isPrivateLanHost("example.com")).toBe(false);
  });

  test("short/encoded forms decode (10.1 = 10.0.0.1, URL with port/path)", () => {
    expect(isPrivateLanHost("10.1")).toBe(true);
    expect(isPrivateLanHost("http://172.16.0.1:8080/v1")).toBe(true);
  });
});
