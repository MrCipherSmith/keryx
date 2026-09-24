// Flow 308 (W8, Lane B, T6): the `impactEvidence` config block must never
// change `computeConfigChecksum` for a config that never mentions it
// (existing checksums keep verifying), and must make the kill switch
// tamper-evident once it IS present.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SECURITY_CONFIG,
  computeConfigChecksum,
  mergeSecurityConfig,
  resolveImpactEvidenceConfig,
  verifyConfigChecksum,
} from "./config";

describe("impactEvidence config + checksum", () => {
  test("a config without impactEvidence keeps its checksum byte-identical", () => {
    const before = computeConfigChecksum(DEFAULT_SECURITY_CONFIG);
    const merged = mergeSecurityConfig({});
    expect(merged.impactEvidence).toBeUndefined();
    const after = computeConfigChecksum(merged);
    expect(after).toBe(before);
  });

  test("mergeSecurityConfig leaves impactEvidence absent unless the parsed config declares it", () => {
    const merged = mergeSecurityConfig({ mode: "enforced" });
    expect(merged.impactEvidence).toBeUndefined();
  });

  test("resolveImpactEvidenceConfig fills in defaults whether or not the block is declared", () => {
    const withoutBlock = mergeSecurityConfig({});
    expect(resolveImpactEvidenceConfig(withoutBlock)).toEqual({
      enabled: true,
      strict: false,
      exemptGlobs: [],
      dampenAfter: 3,
    });

    const withBlock = mergeSecurityConfig({
      impactEvidence: { enabled: false, strict: false, exemptGlobs: [], dampenAfter: 3 },
    });
    expect(resolveImpactEvidenceConfig(withBlock)).toEqual({
      enabled: false,
      strict: false,
      exemptGlobs: [],
      dampenAfter: 3,
    });
  });

  test("a declared impactEvidence block is covered by the checksum: tampering it without resealing mismatches", () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    expect(verifyConfigChecksum(sealed).match).toBe(true);

    // Tamper the kill switch without resealing.
    const tampered = { ...sealed, impactEvidence: { ...sealed.impactEvidence!, enabled: false } };
    expect(verifyConfigChecksum(tampered).match).toBe(false);
  });

  test("two configs that differ only in impactEvidence get different checksums", () => {
    const a = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const b = mergeSecurityConfig({ impactEvidence: { enabled: false, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    expect(computeConfigChecksum(a)).not.toBe(computeConfigChecksum(b));
  });
});
