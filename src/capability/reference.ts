// Reference capability (specification.md §13 phase 6; OQ-3; NG0-1; AC0-9,
// AC0-23). A THROWAWAY, NON-SHIPPING capability that exists only to prove the
// seam end-to-end: it exercises dep-import + asset-resolve + deterministic
// fallback without delivering any end-user feature. It is not registered in the
// shipped CLI; it is used by the reference tests and the golden-rule gate.
//
// Deterministic fallback vs. capability output are intentionally different so a
// test can prove which path ran:
//   fallback  → upper-cased text (the zero-dep, byte-stable path)
//   capability→ reversed text    (only reachable when dep + asset are present)

import type { CapabilityAdapter, CapabilitySpec } from "./seam";

export interface ReferenceInput {
  text: string;
}
export type ReferenceOutput = string;

export const REFERENCE_CAPABILITY_ID = "gdref.transform";

// The deterministic path: always available, no dependency, no asset, no network.
export function referenceFallback(input: ReferenceInput): ReferenceOutput {
  return input.text.toUpperCase();
}

// Build a reference spec. `optionalDependency` / `asset` are injectable so the
// availability-true test can point at an always-importable module (and a real,
// verified fixture asset) while the availability-false test points at an absent
// dependency to force the fallback.
export function makeReferenceSpec(
  overrides: { optionalDependency?: string; asset?: string } = {},
): CapabilitySpec<ReferenceInput, ReferenceOutput> {
  return {
    id: REFERENCE_CAPABILITY_ID,
    ...(overrides.optionalDependency !== undefined
      ? { optionalDependency: overrides.optionalDependency }
      : {}),
    ...(overrides.asset !== undefined ? { asset: overrides.asset } : {}),
    load({ dep, asset }): CapabilityAdapter<ReferenceInput, ReferenceOutput> {
      return {
        id: REFERENCE_CAPABILITY_ID,
        async isAvailable() {
          // Available only when whatever this spec declared actually resolved.
          const depOk = overrides.optionalDependency === undefined || dep !== undefined;
          const assetOk = overrides.asset === undefined || asset !== null;
          return depOk && assetOk;
        },
        async run(input) {
          return input.text.split("").reverse().join("");
        },
      };
    },
  };
}

// The "default" reference spec, wired to first-wave optional libs so it mirrors
// how a real block declares a ceiling. With nothing installed and no asset it
// resolves to `null` (the golden-rule path).
export const REFERENCE_CAPABILITY_SPEC = makeReferenceSpec({
  optionalDependency: "web-tree-sitter",
  asset: "gdref-fixture",
});
