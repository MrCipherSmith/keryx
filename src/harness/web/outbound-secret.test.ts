import { afterEach, describe, expect, test } from "bun:test";
import { containsOutboundSecret } from "./outbound-secret";
import { resetEntropyGateForTests, setEntropyBackendEnabledForTests } from "../../security/service";

// S-8 (flow 355, AC4) and its review-round follow-up F-SEC-F1 (PR #776): the
// outbound check must catch a secret-shaped VALUE wherever it sits in a URL,
// regardless of what the surrounding param/segment is named.

test("an anonymous query param with an opaque high-entropy value is caught", () => {
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  expect(containsOutboundSecret(`https://x.example/c?d=${secret}`)).toBe(true);
});

test("a percent-encoded PARAM NAME does not exempt a secret-shaped value ('t%6fken=')", () => {
  // "t%6fken" decodes to "token" — but the value is checked regardless of the
  // name at all, so the encoding trick buys nothing.
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  expect(containsOutboundSecret(`https://x.example/c?t%6fken=${secret}`)).toBe(true);
});

test("a secret in the URL FRAGMENT is caught", () => {
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  expect(containsOutboundSecret(`https://x.example/c#${secret}`)).toBe(true);
});

test("a secret as a bare path segment is caught", () => {
  const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
  expect(containsOutboundSecret(`https://x.example/webhooks/${secret}`)).toBe(true);
});

test("BOUNDARY — an ordinary URL with no secret-shaped component fetches", () => {
  expect(containsOutboundSecret("https://x.example/webhooks/abc?limit=10")).toBe(false);
});

test("BOUNDARY — a commit SHA in the path is allow-shaped and does not refuse", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  expect(containsOutboundSecret(`https://api.github.com/repos/o/r/commits/${sha}`)).toBe(false);
});

test("a plain (non-URL) query string is still checked by the base pattern/entropy pass", () => {
  const token = `sk-${"A".repeat(24)}`;
  expect(containsOutboundSecret(`leaked key ${token}`)).toBe(true);
});

// Review round 2: the coordinator's own probe against real URLs found these
// two exact cases still refused — both traced to `detect/entropy.ts`; see
// this module's own header and that file's header for the root cause.

test("BOUNDARY (review round 2) — an npm tarball URL with a version number fetches", () => {
  expect(containsOutboundSecret("https://registry.npmjs.org/typescript/-/typescript-5.6.3.tgz")).toBe(false);
});

test("BOUNDARY (review round 2) — a plus-joined multi-word search query fetches", () => {
  // Exactly what `web_search`'s own query string looks like on the wire.
  expect(containsOutboundSecret("https://www.google.com/search?q=bun+test+timeout+flaky")).toBe(false);
});

describe("F-REG-F3: containsOutboundSecret honours backends.entropy.enabled", () => {
  afterEach(() => {
    resetEntropyGateForTests();
  });

  test("entropy off: an opaque high-entropy value (no named pattern) is NOT refused", () => {
    setEntropyBackendEnabledForTests(false);
    const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
    // Both the base `detectEntropy(text)` pass AND the per-component
    // `looksSecretShapedIn` scan are gated by the same flag (review round 2) —
    // a bare query string exercises the first; the URL cases below exercise
    // the second via `?d=`.
    expect(containsOutboundSecret(`leaked key ${secret}`)).toBe(false);
    expect(containsOutboundSecret(`https://x.example/c?d=${secret}`)).toBe(false);
  });

  test("entropy on: the SAME value is refused", () => {
    setEntropyBackendEnabledForTests(true);
    const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
    expect(containsOutboundSecret(`leaked key ${secret}`)).toBe(true);
  });
});
