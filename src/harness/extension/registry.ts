// Fail-closed extension registration (flow 017, W15 / H-01, reviewer track:
// security). Closes the AC3 deferred @release-0 concern: an unregistered /
// ungranted extension must be denied at discovery, with NO mutation and NO
// authority granted (SC_R18_UNREGISTERED_EXTENSION_DENIED). The richer
// provenance/escalation model (SC_R18_REGISTERED_EXTENSION_PROVENANCE /
// SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY) is explicitly LATER scope.
//
// PURE and deterministic: `registerExtension` reads only its input, mutates
// nothing (no input mutation, no module-level registry, no persisted deny
// state), and has NO `Date.now`/`Math.random`/network/fs. Same input twice ->
// deep-equal output. It grants no discovery-time authority — it only decides
// whether a well-formed (pinned-manifest + capability-granted) extension may be
// registered at all.

/** A capability grant authorizing an extension's declared capabilities. */
export interface CapabilityGrant {
  grantId: string;
  capabilities: string[];
}

/** A pinned extension manifest — its content hash and declared version. */
export interface ExtensionManifest {
  /** Pinned content hash of the extension manifest. */
  manifestHash: string;
  extensionVersion: string;
}

/**
 * Inputs to {@link registerExtension}. Both `manifest` (a pinned manifest) and
 * `capabilityGrant` (an explicit grant) MUST be present and well-formed;
 * either absent (or empty) fails closed.
 */
export interface RegisterExtensionInput {
  extensionId: string;
  manifest?: ExtensionManifest;
  capabilityGrant?: CapabilityGrant;
}

/** A registration decision: registered ok, or denied fail-closed with a reason. */
export type RegisterExtensionResult =
  | { ok: true; extensionId: string }
  | { ok: false; reason: string };

/**
 * Decide whether `input` names a well-formed, registrable extension.
 *
 * Fail-closed (SC_R18_UNREGISTERED_EXTENSION_DENIED):
 *   - missing manifest OR empty `manifestHash` -> deny (reason names "manifest")
 *   - missing capabilityGrant OR empty `capabilities` -> deny (reason names
 *     "capability"/"grant")
 * Only a pinned manifest AND a non-empty capability grant registers ok.
 * Pure: no input mutation, no persisted state, deterministic.
 */
export function registerExtension(input: RegisterExtensionInput): RegisterExtensionResult {
  const { extensionId, manifest, capabilityGrant } = input;

  if (manifest === undefined || manifest.manifestHash.length === 0) {
    return { ok: false, reason: "Extension denied: a pinned manifest (non-empty manifestHash) is required." };
  }
  if (capabilityGrant === undefined || capabilityGrant.capabilities.length === 0) {
    return { ok: false, reason: "Extension denied: a capability grant with at least one capability is required." };
  }

  return { ok: true, extensionId };
}
