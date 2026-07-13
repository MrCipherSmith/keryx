// RED tests — W15 H-01 security hardening, SSRF/private-egress bypass closure
// (flow 017, dispatch 017-T5, task H-01, reviewer track: security).
//
// Closes the AC1 deferred @release-0 concern pinned in
// `.metaproject/flows/017-2026-07-13-keryx-harness-w15-hardening/context.md`:
// `src/harness/mutation/guard.ts:45-53` `PRIVATE_HOST_TOKENS` is matched via
// plain substring `token.includes(host)` and therefore misses alternate/
// encoded private-egress forms — IPv6 loopback, decimal/hex/octal-encoded IPv4,
// short-form IPv4, the full `172.16`-`172.31` RFC1918 range, `0.0.0.0`, CGNAT
// `100.64.`, and case-insensitive `localhost`. This suite pins each bypass
// form as a `guardAction` deny (SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED,
// broadened). Every case below is EXPECTED RED until W15 T6 (impl) broadens
// `PRIVATE_HOST_TOKENS`/its matcher — additively, per AC1, never touching an
// existing allow-path.
//
// Fixture/harness pattern mirrors `src/harness/mutation/guard.test.ts`
// (`makeDeps`, profile fixtures, `makeSpec`/`baseGuardInput`, `denyReason`)
// so this suite composes with the same deterministic, side-effect-free
// contract (fixed clock/id via `makeDeps()`; NO `Date.now`/`Math.random`/
// network/fs; `resolveSymlink` never a real fs call).
//
// Each vector asserts BOTH `outcome.kind === "deny"` AND that the deny reason
// specifically names the private/loopback/link-local/metadata ground (matches
// `/private|loopback|metadata|link-local|address/i`) — exactly like the
// existing suite's redirect/private-address test. This is deliberate: under
// `risk: "network"` + `monitoredProfile` (network default `ask`), an
// UNCAUGHT vector still resolves to `{kind:"deny"}` via the composed
// `decide()` ask->headless-adjacent path (an "ask" decision maps to a guard
// deny with an unrelated "Approval required..." reason) — so asserting kind
// alone would pass vacuously even without hardening. Asserting the REASON
// regex is what makes the RED failure meaningful: today's guard denies these
// vectors only via the generic policy-ask path, never for a "private/
// loopback/metadata/link-local/address" reason, so the reason assertion is
// the true signal that hardening is missing.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ToolRisk } from "../tool/types";
import type { PolicyProfile } from "../policy/types";
import { guardAction, type GuardOutcome } from "./guard";
import type { ActionSpec } from "./fingerprint";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Deterministic deps — mirrors guard.test.ts `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// ---------------------------------------------------------------------------
// Profile fixtures — mirrors guard.test.ts (no invented profile shape).
// ---------------------------------------------------------------------------
const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const monitoredProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "monitored-trusted-local",
  profileVersion: "1.0.0",
  fingerprint: sha256("monitored-trusted-local:1.0.0"),
  trustMode: "trusted-local",
  defaults: { read: "allow", write: "ask", shell: "ask", network: "ask", delegate: "ask" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

// ---------------------------------------------------------------------------
// Action-spec / guard-input builders — mirrors guard.test.ts.
// ---------------------------------------------------------------------------
const worktreeRoot = "/repo/worktree";

function makeSpec(overrides: Partial<ActionSpec> = {}): ActionSpec {
  return {
    path: `${worktreeRoot}/src/index.ts`,
    argv: ["cat", `${worktreeRoot}/src/index.ts`],
    env: {},
    ...overrides,
  };
}

interface GuardTestInput {
  spec: ActionSpec;
  worktreeRoot: string;
  profile: PolicyProfile;
  interactive: boolean;
  scanAvailable: boolean;
  risk: ToolRisk;
  resolveSymlink?: (p: string) => string;
}

function baseGuardInput(overrides: Partial<GuardTestInput> = {}): GuardTestInput {
  return {
    spec: makeSpec(),
    worktreeRoot,
    profile: readOnlyProfile,
    interactive: true,
    scanAvailable: true,
    risk: "read",
    ...overrides,
  };
}

function denyReason(outcome: GuardOutcome): string {
  if (outcome.kind !== "deny") {
    throw new Error(`Expected a deny outcome, got ${outcome.kind}`);
  }
  return outcome.reason;
}

const PRIVATE_REASON_RE = /private|loopback|metadata|link-local|address/i;

function expectEgressDenied(argv: string[]): void {
  const outcome = guardAction(
    baseGuardInput({ spec: makeSpec({ argv }), risk: "network", profile: monitoredProfile }),
    makeDeps(),
  );
  expect(outcome.kind).toBe("deny");
  expect(denyReason(outcome)).toMatch(PRIVATE_REASON_RE);
}

// === AC1 — SSRF / private-egress bypass forms (broadened PRIVATE_HOST_TOKENS) ===

describe("guardAction — SSRF/private-egress hardening, alternate/encoded forms (AC1, SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED broadened)", () => {
  test("IPv6 loopback bare form ::1 is denied", () => {
    expectEgressDenied(["curl", "http://[::1]/admin"]);
  });

  test("IPv6 loopback bracketed form [::1] is denied", () => {
    expectEgressDenied(["curl", "http://[::1]:8080/admin"]);
  });

  test("IPv6 loopback bare token (no brackets, no scheme) is denied", () => {
    expectEgressDenied(["nc", "::1", "4444"]);
  });

  test("decimal-encoded loopback IP 2130706433 (== 127.0.0.1) is denied", () => {
    expectEgressDenied(["curl", "http://2130706433/admin"]);
  });

  test("hex-encoded loopback IP 0x7f000001 (== 127.0.0.1) is denied", () => {
    expectEgressDenied(["curl", "http://0x7f000001/admin"]);
  });

  test("octal-encoded loopback IP 0177.0.0.1 (== 127.0.0.1) is denied", () => {
    expectEgressDenied(["curl", "http://0177.0.0.1/admin"]);
  });

  test("short-form loopback IP 127.1 (== 127.0.0.1) is denied", () => {
    expectEgressDenied(["curl", "http://127.1/admin"]);
  });

  test("RFC1918 172.17.0.0/16 (outside the previously-listed 172.16. only) is denied", () => {
    expectEgressDenied(["curl", "http://172.17.0.5/internal"]);
  });

  test("RFC1918 172.20.0.0/16 (outside the previously-listed 172.16. only) is denied", () => {
    expectEgressDenied(["curl", "http://172.20.0.5/internal"]);
  });

  test("RFC1918 172.31.0.0/16 (edge of the 172.16-172.31 range) is denied", () => {
    expectEgressDenied(["curl", "http://172.31.255.5/internal"]);
  });

  test("unspecified address 0.0.0.0 is denied", () => {
    expectEgressDenied(["curl", "http://0.0.0.0:9999/admin"]);
  });

  test("CGNAT 100.64.0.0/10 is denied", () => {
    expectEgressDenied(["curl", "http://100.64.0.5/internal"]);
  });

  test("uppercase LOCALHOST is denied (case-insensitive match)", () => {
    expectEgressDenied(["curl", "http://LOCALHOST:8080/admin"]);
  });

  test("mixed-case LocalHost is denied (case-insensitive match)", () => {
    expectEgressDenied(["curl", "http://LocalHost/admin"]);
  });
});

// === Allow-path regression lock — broadening must stay purely additive =====

describe("guardAction — SSRF hardening broadening stays additive (regression lock)", () => {
  test("a benign public https destination is still not denied for a private-address reason", () => {
    const outcome = guardAction(
      baseGuardInput({
        spec: makeSpec({ argv: ["curl", "https://api.example.com/v1/status"] }),
        risk: "network",
        profile: monitoredProfile,
      }),
      makeDeps(),
    );
    if (outcome.kind === "deny") {
      expect(outcome.reason).not.toMatch(PRIVATE_REASON_RE);
    }
  });

  test("a plain filename argv with no network destination stays allowed", () => {
    const outcome = guardAction(baseGuardInput(), makeDeps());
    expect(outcome).toEqual({ kind: "allow" });
  });

  test("a host string that merely CONTAINS digits resembling an unrelated public IP is not denied on private-address grounds", () => {
    // Sanity: broadening must not become an over-broad numeric-token match
    // that snags an ordinary public dotted-quad IP unrelated to any private
    // range (e.g. 8.8.8.8 is a well-known public resolver).
    const outcome = guardAction(
      baseGuardInput({
        spec: makeSpec({ argv: ["curl", "http://8.8.8.8/resolve"] }),
        risk: "network",
        profile: monitoredProfile,
      }),
      makeDeps(),
    );
    if (outcome.kind === "deny") {
      expect(outcome.reason).not.toMatch(PRIVATE_REASON_RE);
    }
  });
});
