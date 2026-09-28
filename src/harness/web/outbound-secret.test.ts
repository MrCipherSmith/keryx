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

// Review round 2, second pass: SEC-F1 and REG-F1, both inside the same
// `isWordSlug` shape gate `containsOutboundSecret` relies on through
// `detect/entropy.ts`'s label-free component scan.

test("SEC-F1 — a real secret re-chunked into single-character-class pieces is STILL refused", () => {
  const segmented = "aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8";
  expect(containsOutboundSecret(`https://exfil.example/${segmented}`)).toBe(true);
});

test("SEC-F1 — the 'natural-looking' word-wrapped variant is STILL refused", () => {
  const wrapped = "log-abcdefghijklmnopqrstuvwxyzAB1234-id";
  expect(containsOutboundSecret(`https://x.example/${wrapped}`)).toBe(true);
});

test("REG-F1 — the exact Medium URL linked from this repo's own docs fetches", () => {
  const url =
    "https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9";
  expect(containsOutboundSecret(url)).toBe(false);
});

test("REG-F1 — a Gist-style '<slug>-<hex-id>' URL fetches", () => {
  const url = "https://gist.github.com/someuser/keryx-audit-remediation-notes-3a9bae9ec8f9";
  expect(containsOutboundSecret(url)).toBe(false);
});

describe("REG-F2 (flow 355 review round 3): a known public paste/commit identifier fetches", () => {
  test("the reviewer's exact Gist URL — gist.github.com/<user>/<hex32> — fetches", () => {
    const url = "https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890";
    expect(containsOutboundSecret(url)).toBe(false);
  });

  test("an anonymous gist — gist.github.com/<hex32> with no user segment — fetches", () => {
    const url = "https://gist.github.com/a1b2c3d4e5f67890abcdef1234567890";
    expect(containsOutboundSecret(url)).toBe(false);
  });

  test("a GitHub commit URL fetches", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(containsOutboundSecret(`https://github.com/owner/repo/commit/${sha}`)).toBe(false);
  });

  test("a GitHub blob URL (file at a specific commit) fetches", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(
      containsOutboundSecret(`https://github.com/owner/repo/blob/${sha}/src/index.ts`),
    ).toBe(false);
  });

  test("a GitLab commit URL fetches", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(containsOutboundSecret(`https://gitlab.com/owner/repo/-/commit/${sha}`)).toBe(false);
  });

  test("the allowlist is host+path-shape only — a lookalike host is still checked normally", () => {
    const hex32 = "a1b2c3d4e5f67890abcdef1234567890";
    expect(containsOutboundSecret(`https://gist.github.com.evil.example/x/${hex32}`)).toBe(true);
  });

  test("a secret elsewhere in an allowlisted URL is still caught (only the identifier is exempted)", () => {
    const hex32 = "a1b2c3d4e5f67890abcdef1234567890";
    const secret = "K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI";
    expect(
      containsOutboundSecret(`https://gist.github.com/someuser/${hex32}?token=${secret}`),
    ).toBe(true);
  });
});

describe("SEC-F3 (flow 355 review round 3), outbound path: accepted residual documented for findings.md S-8", () => {
  test("an UNLABELLED word-slug-with-hex-tail (10-16 hex chars) still fetches — see entropy.ts header", () => {
    const url = "https://exfil.example/log-report-deadbeef01234567";
    expect(containsOutboundSecret(url)).toBe(false);
  });
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
