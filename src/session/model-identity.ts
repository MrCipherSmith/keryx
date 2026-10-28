import { canonicalDigest } from "../remote-control/protocol";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export function isNormalizedWireIdentity(value: string): boolean { return /--[a-f0-9]{64}$/.test(value); }
function wireId(kind: "provider" | "model", value: string, provider?: string): string {
  if (safeId.test(value)) return value;
  const readable = value.replace(/[^A-Za-z0-9._:-]/g, ".").replace(/^[^A-Za-z0-9]+/, "").slice(0, 120) || kind;
  return `${readable}--${canonicalDigest({ kind, value, provider: provider ?? null })}`;
}
export interface NativeModelBinding { providerId: string; modelId: string; actualProviderId: string; actualModelId: string }
/** Wire identities satisfy the frozen Id grammar. Actual provider IDs stay in the local binding.
 * Full domain-separated digests distinguish normalization collisions; callers reject any binding conflict. */
export function wireModelIdentity(actualProviderId: string, actualModelId: string): Pick<NativeModelBinding, "providerId" | "modelId"> {
  return { providerId: wireId("provider", actualProviderId), modelId: wireId("model", actualModelId, actualProviderId) };
}
export function wireCandidateId(actualProviderId: string, actualModelId: string): string {
  const readable = `${actualProviderId}:${actualModelId}`;
  return safeId.test(readable) ? readable : canonicalDigest({ kind: "native-candidate", providerId: actualProviderId, modelId: actualModelId });
}
