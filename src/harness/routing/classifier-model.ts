// Flow 411: classifier capacity is independent of the execution baseline.
import { isModelDerivable, profileKey, type ModelProfile } from "./model-profile";
import type { FlatPickerProvider } from "./table";

/** Minimum: confirmed standard/deep chat tier; never a guessed tier.
 * Prefer standard, then profile priority, then stable IDs. Only connected,
 * available, caller-authorized models participate. No baseline preference.
 */
export function selectClassifierModel(
  detected: readonly FlatPickerProvider[],
  profiles: Readonly<Record<string, ModelProfile>>,
  allowed: (providerId: string, modelId: string) => boolean,
): { readonly providerId: string; readonly modelId: string } | undefined {
  const candidates: ModelProfile[] = [];
  for (const provider of detected) {
    for (const modelId of provider.models ?? []) {
      const profile = profiles[profileKey(provider.name, modelId)];
      if (!profile?.available || !isModelDerivable(profile)) continue;
      if (profile.strengthTier.value === "light" || profile.strengthTier.source === "unknown" || profile.strengthTier.source === "guessed") continue;
      if (allowed(provider.name, modelId)) candidates.push(profile);
    }
  }
  candidates.sort((a, b) =>
    Number(a.strengthTier.value === "deep") - Number(b.strengthTier.value === "deep") ||
    b.priority.value - a.priority.value ||
    profileKey(a.providerId, a.modelId).localeCompare(profileKey(b.providerId, b.modelId)),
  );
  const selected = candidates[0];
  return selected === undefined ? undefined : { providerId: selected.providerId, modelId: selected.modelId };
}
