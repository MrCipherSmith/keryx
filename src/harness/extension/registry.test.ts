// RED tests — W15 H-01 security hardening, SC_R18_UNREGISTERED_EXTENSION_DENIED
// (flow 017, dispatch 017-T5, task H-01, reviewer track: security).
//
// Closes the AC3 deferred @release-0 concern pinned in
// `.metaproject/flows/017-2026-07-13-keryx-harness-w15-hardening/context.md`:
// no extension module exists in `src/harness`. This suite pins the PURE,
// fail-closed `registerExtension` surface — under
// `src/harness/extension/registry.ts` (does NOT exist yet) — that H-02
// documents as the deferred extension capability/grant model (@release-2
// scenarios `SC_R18_REGISTERED_EXTENSION_PROVENANCE` /
// `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY` remain explicitly LATER
// scope; only the Release-0 negative — an unregistered/ungranted extension
// is denied at discovery, with no mutation or authority — is gated here).
//
// Expected RED: `./registry` does not exist, so every import below fails
// ("Cannot find module './registry'") until W15 T6 (impl) adds it. Until
// then this whole file fails to even load — that IS the RED signal (a
// missing-module import error, not an assertion failure).
//
// PINNED SURFACE under test (T6 impl must match exactly):
//   export interface CapabilityGrant {
//     grantId: string;
//     capabilities: string[];
//   }
//   export interface ExtensionManifest {
//     manifestHash: string;   // pinned content hash of the extension manifest
//     extensionVersion: string;
//   }
//   export interface RegisterExtensionInput {
//     extensionId: string;
//     manifest?: ExtensionManifest;       // MUST be present (pinned manifest)
//     capabilityGrant?: CapabilityGrant;  // MUST be present (capability grant)
//   }
//   export type RegisterExtensionResult =
//     | { ok: true; extensionId: string }
//     | { ok: false; reason: string };
//   export function registerExtension(input: RegisterExtensionInput): RegisterExtensionResult;
//
// Fail-closed rule: EITHER `manifest` (a pinned manifest hash) OR
// `capabilityGrant` absent -> `{ ok: false, reason }` (SC_R18_
// UNREGISTERED_EXTENSION_DENIED). Both present (well-formed) -> `{ ok: true,
// extensionId }`. Pure: no discovery-time mutation of the input, no global/
// module-level registry side effect, deterministic (same input twice ->
// deep-equal output; no `Date.now`/`Math.random`/network/fs).
import { describe, expect, test } from "bun:test";
import {
  registerExtension,
  type CapabilityGrant,
  type ExtensionManifest,
  type RegisterExtensionInput,
} from "./registry";

function makeManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    manifestHash: "a".repeat(64),
    extensionVersion: "1.0.0",
    ...overrides,
  };
}

function makeGrant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    grantId: "grant-1",
    capabilities: ["read"],
    ...overrides,
  };
}

function makeInput(overrides: Partial<RegisterExtensionInput> = {}): RegisterExtensionInput {
  return {
    extensionId: "ext-1",
    manifest: makeManifest(),
    capabilityGrant: makeGrant(),
    ...overrides,
  };
}

// === Positive: a pinned manifest AND a capability grant registers cleanly ===

describe("registerExtension — well-formed registration (pinned manifest + capability grant)", () => {
  test("an extension with a pinned manifest and a capability grant registers ok", () => {
    const result = registerExtension(makeInput());
    expect(result).toEqual({ ok: true, extensionId: "ext-1" });
  });
});

// === Negative: SC_R18_UNREGISTERED_EXTENSION_DENIED =========================

describe("registerExtension — SC_R18_UNREGISTERED_EXTENSION_DENIED (fail-closed)", () => {
  test("a registration missing a pinned manifest is denied, reason mentions manifest", () => {
    const input: RegisterExtensionInput = { extensionId: "ext-1", capabilityGrant: makeGrant() };
    const result = registerExtension(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/manifest/i);
  });

  test("a registration missing a capability grant is denied, reason mentions capability/grant", () => {
    const input: RegisterExtensionInput = { extensionId: "ext-1", manifest: makeManifest() };
    const result = registerExtension(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.reason).toMatch(/capability|grant/i);
  });

  test("a registration missing BOTH manifest and capability grant is denied", () => {
    const result = registerExtension({ extensionId: "ext-bare" });
    expect(result.ok).toBe(false);
  });

  test("an empty-string manifestHash (no real pin) is denied, never treated as a satisfied manifest", () => {
    const result = registerExtension(makeInput({ manifest: makeManifest({ manifestHash: "" }) }));
    expect(result.ok).toBe(false);
  });

  test("an empty capabilities array on the grant is denied, never treated as a satisfied grant", () => {
    const result = registerExtension(makeInput({ capabilityGrant: makeGrant({ capabilities: [] }) }));
    expect(result.ok).toBe(false);
  });
});

// === Purity: no discovery-time mutation or authority side effect ===========

describe("registerExtension — pure, no discovery-time mutation or authority (SC_R18)", () => {
  test("calling registerExtension does not mutate its input", () => {
    const input = makeInput();
    const snapshot = JSON.parse(JSON.stringify(input)) as RegisterExtensionInput;
    registerExtension(input);
    expect(input).toEqual(snapshot);
  });

  test("calling registerExtension twice with the same input yields a deep-equal decision (deterministic, no hidden state)", () => {
    const input = makeInput();
    const first = registerExtension(input);
    const second = registerExtension(input);
    expect(first).toEqual(second);
  });

  test("a denied registration followed by a well-formed registration for the same extensionId still succeeds (no persisted deny state / no authority granted on the deny path)", () => {
    const bare: RegisterExtensionInput = { extensionId: "ext-retry" };
    const denied = registerExtension(bare);
    expect(denied.ok).toBe(false);

    const wellFormed = registerExtension(makeInput({ extensionId: "ext-retry" }));
    expect(wellFormed).toEqual({ ok: true, extensionId: "ext-retry" });
  });
});
