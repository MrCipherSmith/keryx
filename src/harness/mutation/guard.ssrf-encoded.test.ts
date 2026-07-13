// RED tests — W15 H-01 SSRF residual closure, ENCODED private/metadata IPs
// (flow 017, dispatch 017-T6b, task H-01 extension, reviewer track: security).
//
// Extends `guard.ssrf.test.ts`. The prior hardening decoded encoded forms only
// for the LOOPBACK range (127/8); encoded forms of NON-loopback private and
// metadata addresses still returned ALLOW (fail-open, defense-in-depth gap).
// This suite pins each encoded NON-loopback private/metadata vector as a
// `guardAction` deny with a private-address reason, and locks the public
// allow-path (8.8.8.8 in encoded forms must NOT be denied on private grounds).
//
// Fixture/harness pattern mirrors `guard.ssrf.test.ts` / `guard.test.ts`
// (`makeDeps`, profile fixtures, `makeSpec`/`baseGuardInput`, `denyReason`,
// `PRIVATE_REASON_RE`) so this suite composes with the same deterministic,
// side-effect-free contract (fixed clock/id; NO `Date.now`/`Math.random`/
// network/fs). As in the sibling suite, each denial asserts BOTH
// `outcome.kind === "deny"` AND that the reason names the private/loopback/
// metadata/link-local ground — the reason regex is the true signal that the
// generalized decoder (not the generic policy-ask fallthrough) fired.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ToolRisk } from "../tool/types";
import type { PolicyProfile } from "../policy/types";
import { guardAction, type GuardOutcome } from "./guard";
import type { ActionSpec } from "./fingerprint";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

const monitoredProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "monitored-trusted-local",
  profileVersion: "1.0.0",
  fingerprint: sha256("monitored-trusted-local:1.0.0"),
  trustMode: "trusted-local",
  defaults: { read: "allow", write: "ask", shell: "ask", network: "ask", delegate: "ask" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

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
    profile: monitoredProfile,
    interactive: true,
    scanAvailable: true,
    risk: "network",
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

function runGuard(argv: string[]): GuardOutcome {
  return guardAction(baseGuardInput({ spec: makeSpec({ argv }) }), makeDeps());
}

function expectEgressDenied(argv: string[]): void {
  const outcome = runGuard(argv);
  expect(outcome.kind).toBe("deny");
  expect(denyReason(outcome)).toMatch(PRIVATE_REASON_RE);
}

function expectNotPrivateDenied(argv: string[]): void {
  const outcome = runGuard(argv);
  // Public destination: may still hit a normal policy decision (network=ask on
  // the monitored profile), but MUST NOT be denied on private-address grounds.
  if (outcome.kind === "deny") {
    expect(outcome.reason).not.toMatch(PRIVATE_REASON_RE);
  }
}

// === Encoded NON-loopback private / metadata IPs — the residual gap ==========

describe("guardAction — encoded NON-loopback private/metadata egress is denied (AC1 residual, generalized decoder)", () => {
  test("decimal-encoded cloud metadata 2852039166 (== 169.254.169.254) is denied", () => {
    expectEgressDenied(["curl", "http://2852039166/latest/meta-data/"]);
  });

  test("hex-encoded cloud metadata 0xa9fea9fe (== 169.254.169.254) is denied", () => {
    expectEgressDenied(["curl", "http://0xa9fea9fe/latest/meta-data/"]);
  });

  test("flat 32-bit octal loopback 017700000001 (== 127.0.0.1) is denied", () => {
    expectEgressDenied(["curl", "http://017700000001/admin"]);
  });

  test("IPv4-mapped IPv6 two-hex-group loopback ::ffff:7f00:1 (== 127.0.0.1) is denied", () => {
    expectEgressDenied(["nc", "::ffff:7f00:1", "80"]);
  });

  test("IPv4-mapped IPv6 bracketed loopback [::ffff:7f00:1] is denied", () => {
    expectEgressDenied(["curl", "http://[::ffff:7f00:1]:8080/admin"]);
  });

  test("IPv4-mapped IPv6 dotted loopback ::ffff:127.0.0.1 is denied", () => {
    expectEgressDenied(["nc", "::ffff:127.0.0.1", "80"]);
  });

  test("hex-encoded RFC1918 0x0a000001 (== 10.0.0.1) is denied", () => {
    expectEgressDenied(["curl", "http://0x0a000001/internal"]);
  });

  test("decimal-encoded RFC1918 3232235777 (== 192.168.0.1) is denied", () => {
    expectEgressDenied(["curl", "http://3232235777/internal"]);
  });

  test("bare decimal metadata token (no URL wrapper) is denied", () => {
    expectEgressDenied(["nc", "2852039166", "80"]);
  });
});

// === Public allow-path regression lock — decoder must stay purely additive ===

describe("guardAction — generalized decoder stays additive (public encoded IPs not private-denied)", () => {
  test("decimal-encoded public 134744072 (== 8.8.8.8) is NOT denied on private grounds", () => {
    expectNotPrivateDenied(["curl", "http://134744072/resolve"]);
  });

  test("hex-encoded public 0x08080808 (== 8.8.8.8) is NOT denied on private grounds", () => {
    expectNotPrivateDenied(["curl", "http://0x08080808/resolve"]);
  });

  test("a benign hostname token (api.example.com) is not private-denied", () => {
    expectNotPrivateDenied(["curl", "https://api.example.com/v1/status"]);
  });

  test("a plain filename argv with no network destination stays allowed", () => {
    const outcome = guardAction(baseGuardInput({ risk: "read" }), makeDeps());
    expect(outcome).toEqual({ kind: "allow" });
  });
});

// === Boundary locks — 172.16-31 only; adjacent 172.15 / 172.32 stay public ===

describe("guardAction — encoded 172.x boundary is exact (only 16-31 is RFC1918)", () => {
  test("decimal-encoded 172.15.0.1 (2886664193) is NOT private-denied", () => {
    // 172.15.0.1 = 0xAC0F0001 = 2886664193, just below the RFC1918 block.
    expectNotPrivateDenied(["curl", "http://2886664193/x"]);
  });

  test("hex-encoded 172.32.0.1 (0xac200001) is NOT private-denied", () => {
    // 172.32.0.1 just above the RFC1918 block.
    expectNotPrivateDenied(["curl", "http://0xac200001/x"]);
  });

  test("hex-encoded 172.16.0.1 (0xac100001) IS denied (bottom of the range)", () => {
    expectEgressDenied(["curl", "http://0xac100001/x"]);
  });

  test("hex-encoded 172.31.255.255 (0xac1fffff) IS denied (top of the range)", () => {
    expectEgressDenied(["curl", "http://0xac1fffff/x"]);
  });
});
