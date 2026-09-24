// Flow 308 (W8, Lane B, T6): the `impactEvidence` config block must never
// change `computeConfigChecksum` for a config that never mentions it
// (existing checksums keep verifying), and must make the kill switch
// tamper-evident once it IS present.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SECURITY_CONFIG,
  computeConfigChecksum,
  mergeSecurityConfig,
  renderSecurityConfig,
  resolveImpactEvidenceConfig,
  resolveImpactEvidenceConfigTrusted,
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

  test("F17: a dampenAfter <= 0 (or non-finite) is rejected and falls back to the default, never merged as-is", () => {
    for (const bad of [0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const merged = mergeSecurityConfig({
        impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: bad },
      });
      expect(resolveImpactEvidenceConfig(merged).dampenAfter).toBe(3);
    }
  });

  test("F17: a valid dampenAfter override is truncated to a whole number and kept", () => {
    const merged = mergeSecurityConfig({
      impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 5.9 },
    });
    expect(resolveImpactEvidenceConfig(merged).dampenAfter).toBe(5);

    const mergedOne = mergeSecurityConfig({
      impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 1 },
    });
    expect(resolveImpactEvidenceConfig(mergedOne).dampenAfter).toBe(1);
  });

  test("F11: resolveImpactEvidenceConfigTrusted returns the resolved config untouched when the checksum verifies", () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: false, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    const { config, tampered } = resolveImpactEvidenceConfigTrusted(sealed);
    expect(tampered).toBe(false);
    expect(config.enabled).toBe(false); // an honestly-sealed kill switch IS honored
  });

  test("F11: resolveImpactEvidenceConfigTrusted ignores an untrusted enabled:false and falls back to safe defaults", () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    const tampered = { ...sealed, impactEvidence: { ...sealed.impactEvidence!, enabled: false, exemptGlobs: ["**/*"] } };

    const result = resolveImpactEvidenceConfigTrusted(tampered);
    expect(result.tampered).toBe(true);
    expect(result.config.enabled).toBe(true);
    expect(result.config.exemptGlobs).toEqual([]); // the whole block is untrusted, not just `enabled`
    expect(result.config.dampenAfter).toBe(3);
  });

  test("F11: a tampered block's strict:true is still honored (never a bypass, only more protective)", () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: true, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    const tampered = { ...sealed, impactEvidence: { ...sealed.impactEvidence!, enabled: false } };

    const result = resolveImpactEvidenceConfigTrusted(tampered);
    expect(result.tampered).toBe(true);
    expect(result.config.strict).toBe(true);
    expect(result.config.enabled).toBe(true);
  });

  test("F11: a config that cannot be established (configUnreadable) is treated as tampered too", () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: false, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged), configUnreadable: true };
    const result = resolveImpactEvidenceConfigTrusted(sealed);
    expect(result.tampered).toBe(true);
    expect(result.config.enabled).toBe(true);
  });

  test("F11 (round 2): an impactEvidence block with NO configChecksum at all is untrusted, not verified — a hand-written enabled:false is ignored, detail is 'absent'", () => {
    // A hand-written config: the block is present, but `configChecksum` was
    // never computed for it at all (not merely wrong).
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: false, strict: false, exemptGlobs: ["**/*"], dampenAfter: 999 } });
    expect(merged.configChecksum).toBeUndefined();

    const result = resolveImpactEvidenceConfigTrusted(merged);
    expect(result.tampered).toBe(true);
    expect(result.detail).toBe("absent");
    expect(result.config.enabled).toBe(true); // the loosening field is ignored
    expect(result.config.exemptGlobs).toEqual([]);
    expect(result.config.dampenAfter).toBe(3);
  });

  test("F11 (round 2): a mismatched configChecksum reports detail 'mismatch'", () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: true, strict: false, exemptGlobs: [], dampenAfter: 3 } });
    const sealed = { ...merged, configChecksum: computeConfigChecksum(merged) };
    const tampered = { ...sealed, impactEvidence: { ...sealed.impactEvidence!, enabled: false } };

    const result = resolveImpactEvidenceConfigTrusted(tampered);
    expect(result.tampered).toBe(true);
    expect(result.detail).toBe("mismatch");
  });

  test("F11 (round 2): resealing via renderSecurityConfig (a real, matching configChecksum) is honored, loosening fields included", () => {
    const merged = mergeSecurityConfig({ impactEvidence: { enabled: false, strict: false, exemptGlobs: ["docs/**"], dampenAfter: 5 } });
    const rendered = JSON.parse(renderSecurityConfig(merged)) as typeof merged;
    expect(rendered.configChecksum).toBeDefined();

    const result = resolveImpactEvidenceConfigTrusted(rendered);
    expect(result.tampered).toBe(false);
    expect(result.config.enabled).toBe(false);
    expect(result.config.exemptGlobs).toEqual(["docs/**"]);
    expect(result.config.dampenAfter).toBe(5);
  });
});
