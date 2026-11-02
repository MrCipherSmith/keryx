import { expect, test } from "bun:test";
import { detectPii } from "./pii";

function ips(content: string): string[] {
  return detectPii(content)
    .filter((match) => match.policyId === "pii.ip")
    .map((match) => content.slice(match.start, match.end));
}

test("a ::-compressed IPv6 address is masked whole", () => {
  expect(ips("peer 2001:db8::1 connected")).toEqual(["2001:db8::1"]);
  expect(ips("host 2001:db8:85a3::8a2e:370:7334 up")).toEqual(["2001:db8:85a3::8a2e:370:7334"]);
  expect(ips("link fe80::1ff:fe23:4567:890a dev eth0")).toEqual(["fe80::1ff:fe23:4567:890a"]);
  expect(ips("bind ::1 and 2001:db8::")).toEqual(["::1", "2001:db8::"]);
});

test("the expanded form and IPv4 are still masked", () => {
  expect(ips("2001:0db8:85a3:0000:0000:8a2e:0370:7334 and 10.0.0.1")).toEqual([
    "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "10.0.0.1",
  ]);
});

test("a :: that is not an address is left alone", () => {
  expect(ips("x :: Int, std::vector, dead::beef, a::b, Foo::Bar, 1:::2")).toEqual([]);
});

test("long hex-and-colon runs scan in linear time", () => {
  for (const content of ["1:".repeat(50_000), "1::".repeat(30_000), "a1:".repeat(30_000)]) {
    const started = performance.now();
    detectPii(content);
    expect(performance.now() - started).toBeLessThan(250);
  }
});
