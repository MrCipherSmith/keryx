// The outcome mapping is the whole safety property of the ACP permission path
// (flow 285, T9 / AC3), so it is pinned here answer by answer — including the
// answers a client is not supposed to send.

import { describe, expect, test } from "bun:test";
import { isApprovalFor, type ApprovalMeta } from "../commands/agent";
import {
  ACP_PERMISSION_OPTION_IDS,
  approvalFromPermissionResponse,
  permissionIsEscalated,
  permissionOptionsFor,
} from "./permission";
import type { AcpPermissionOptionKind, AcpRequestPermissionResponse } from "./protocol";

const FINGERPRINT = "fp-abc123";

function meta(overrides: Partial<ApprovalMeta> = {}): ApprovalMeta {
  return { fingerprint: FINGERPRINT, destructive: false, ...overrides };
}

function selected(optionId: string): AcpRequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

describe("the options keryx offers", () => {
  test("an ordinary call can be allowed once, allowed always, or rejected", () => {
    const options = permissionOptionsFor(meta());
    expect(options.map((option) => option.optionId)).toEqual([
      ACP_PERMISSION_OPTION_IDS.allowOnce,
      ACP_PERMISSION_OPTION_IDS.allowAlways,
      ACP_PERMISSION_OPTION_IDS.rejectOnce,
      ACP_PERMISSION_OPTION_IDS.rejectAlways,
    ]);
    // Every kind is one of ACP's four, and every option has a renderable name.
    const kinds: AcpPermissionOptionKind[] = ["allow_once", "allow_always", "reject_once", "reject_always"];
    for (const option of options) {
      expect(kinds).toContain(option.kind);
      expect(option.name.length).toBeGreaterThan(0);
    }
  });

  test("an escalated call is never offered an always-allow", () => {
    // ADR-0009 / `ApprovalMeta`: destructive, credential-touching, publish-leased
    // and untrusted-origin calls are "always prompt, never remember". An ACP
    // client remembers an `allow_always` itself, so the option must not exist.
    for (const escalation of [
      { destructive: true },
      { credentials: true },
      { publishLease: true },
      { untrustedOrigin: true },
      // Flow 306 fix (review finding 5): a hook-tightened `ask` is the same
      // hard floor — never offer allow_always for it.
      { hookAsk: true },
    ] satisfies Partial<ApprovalMeta>[]) {
      const options = permissionOptionsFor(meta(escalation));
      expect(permissionIsEscalated(meta(escalation))).toBe(true);
      expect(options.map((option) => option.kind)).toEqual(["allow_once", "reject_once", "reject_always"]);
    }
  });

  test("a call with no meta at all still gets a full option set", () => {
    // `requestApproval`'s `meta` is optional in the `AgentIO` contract; an ask
    // with none must still be answerable, not unrenderable.
    const options = permissionOptionsFor(undefined);
    expect(options.some((option) => option.kind === "allow_once")).toBe(true);
    expect(options.some((option) => option.kind === "reject_once")).toBe(true);
    expect(permissionIsEscalated(undefined)).toBe(false);
  });
});

describe("the outcome mapping (context.md F-2)", () => {
  const options = permissionOptionsFor(meta());

  test("allow_once is a bare true", () => {
    const response = approvalFromPermissionResponse(selected(ACP_PERMISSION_OPTION_IDS.allowOnce), options, FINGERPRINT);
    expect(response).toBe(true);
    expect(isApprovalFor(response, FINGERPRINT)).toBe(true);
  });

  test("allow_always echoes the fingerprint it was asked about", () => {
    const response = approvalFromPermissionResponse(
      selected(ACP_PERMISSION_OPTION_IDS.allowAlways),
      options,
      FINGERPRINT,
    );
    expect(response).toEqual({ approved: true, fingerprint: FINGERPRINT });
    expect(isApprovalFor(response, FINGERPRINT)).toBe(true);
    // And it authorises THAT action only: the same answer against a different
    // call is a denial, which is the point of binding it (`isApprovalFor`).
    expect(isApprovalFor(response, "fp-some-other-call")).toBe(false);
  });

  test("both rejections are false", () => {
    expect(approvalFromPermissionResponse(selected(ACP_PERMISSION_OPTION_IDS.rejectOnce), options, FINGERPRINT)).toBe(
      false,
    );
    expect(approvalFromPermissionResponse(selected(ACP_PERMISSION_OPTION_IDS.rejectAlways), options, FINGERPRINT)).toBe(
      false,
    );
  });

  test("cancelled is not an answer, and does not authorise the call", () => {
    expect(approvalFromPermissionResponse({ outcome: { outcome: "cancelled" } }, options, FINGERPRINT)).toBe(false);
  });

  test("an optionId keryx never offered is a denial, not an allow", () => {
    // The mapping keys on the KIND of an option keryx sent, never on the text
    // of the id. A client inventing a plausible-looking id gets nothing.
    expect(approvalFromPermissionResponse(selected("allow_everything_forever"), options, FINGERPRINT)).toBe(false);
    expect(approvalFromPermissionResponse(selected(""), options, FINGERPRINT)).toBe(false);
    // Including one that IS a real kind but was not offered for this call: an
    // escalated ask has no always-allow, so echoing that id must not allow it.
    const escalated = permissionOptionsFor(meta({ destructive: true }));
    expect(
      approvalFromPermissionResponse(selected(ACP_PERMISSION_OPTION_IDS.allowAlways), escalated, FINGERPRINT),
    ).toBe(false);
  });

  test("a malformed answer is a denial", () => {
    // Everything here is off the wire; none of it is guaranteed to have the
    // declared shape, and every deviation has exactly one safe reading.
    const malformed: unknown[] = [{}, { outcome: null }, { outcome: "selected" }, { outcome: { outcome: "weird" } }];
    for (const value of malformed) {
      expect(approvalFromPermissionResponse(value as AcpRequestPermissionResponse, options, FINGERPRINT)).toBe(false);
    }
  });

  test("an allow with no fingerprint to bind still allows", () => {
    // `ApprovalMeta` is optional, so there may be nothing to echo. A bare
    // `true` is the historical contract and `isApprovalFor` accepts it.
    expect(approvalFromPermissionResponse(selected(ACP_PERMISSION_OPTION_IDS.allowAlways), options)).toBe(true);
  });
});
