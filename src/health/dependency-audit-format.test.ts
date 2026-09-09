import { expect, test } from "bun:test";
import { dependencyAuditAdapter } from "./sources/dependency-audit";
import type { HealthContext, RawSourceResult } from "./types";

const ctx = { cwd: "/synthetic-project" } as HealthContext;

function raw(content: unknown, exitCode: number): RawSourceResult {
  return {
    source: "dependencyAudit",
    command: "synthetic-audit --json",
    toolVersion: "0.0.0-synthetic",
    exitCode,
    rawPath: ".metaproject/data/health/raw/dependencyAudit/synthetic.log",
    content: JSON.stringify(content),
    imported: false,
  };
}

test("synthetic Bun package arrays and npm modern and legacy reports preserve unique advisory identity and severity", () => {
  const bun = raw(
    {
      "synthetic-bun-package": [
        { id: "SYNTH-BUN-1001", title: "Synthetic high issue", severity: "high" },
        { id: "SYNTH-BUN-1002", title: "Synthetic moderate issue", severity: "moderate" },
      ],
    },
    1,
  );
  const npmModern = raw(
    {
      auditReportVersion: 2,
      vulnerabilities: {
        "synthetic-modern-package": {
          name: "synthetic-modern-package",
          severity: "critical",
          via: [
            {
              source: 2001,
              name: "synthetic-modern-package",
              dependency: "synthetic-modern-package",
              title: "Synthetic modern advisory",
              severity: "critical",
              range: "<3.0.0",
            },
          ],
          effects: [],
          range: "<3.0.0",
          nodes: ["node_modules/synthetic-modern-package"],
          fixAvailable: true,
        },
      },
      metadata: { vulnerabilities: { critical: 1, total: 1 } },
    },
    1,
  );
  const npmLegacy = raw(
    {
      advisories: {
        "3001": {
          module_name: "synthetic-legacy-package",
          title: "Synthetic legacy advisory",
          severity: "moderate",
        },
      },
      metadata: { vulnerabilities: { moderate: 1, total: 1 } },
    },
    1,
  );

  const bunFindings = dependencyAuditAdapter.parse(bun, ctx);
  const bunAgain = dependencyAuditAdapter.parse(bun, ctx);
  const modernFindings = dependencyAuditAdapter.parse(npmModern, ctx);
  const legacyFindings = dependencyAuditAdapter.parse(npmLegacy, ctx);

  expect(bunFindings).toHaveLength(2);
  expect(bunFindings.map((finding) => finding.priority)).toEqual(["P0", "P1"]);
  expect(new Set(bunFindings.map((finding) => finding.id)).size).toBe(2);
  expect(bunAgain.map((finding) => finding.id)).toEqual(bunFindings.map((finding) => finding.id));
  expect(bunFindings.map((finding) => finding.id).join("\n")).toContain("synth-bun-1001");
  expect(bunFindings.map((finding) => finding.id).join("\n")).toContain("synth-bun-1002");

  expect(modernFindings).toHaveLength(1);
  expect(modernFindings[0]?.priority).toBe("P0");
  expect(modernFindings[0]?.message).toContain("Synthetic modern advisory");
  expect(modernFindings[0]?.id).toContain("2001");

  expect(legacyFindings).toHaveLength(1);
  expect(legacyFindings[0]?.priority).toBe("P1");
  expect(legacyFindings[0]?.id).toContain("3001");
});

test("audit validation distinguishes empty supported payloads from invalid and unknown JSON", () => {
  expect(dependencyAuditAdapter.validate?.(raw({}, 0))).toMatchObject({ valid: true });
  expect(dependencyAuditAdapter.validate?.(raw({ auditReportVersion: 2, vulnerabilities: {} }, 0))).toMatchObject({ valid: true });
  expect(dependencyAuditAdapter.validate?.(raw({ advisories: {} }, 0))).toMatchObject({ valid: true });
  expect(dependencyAuditAdapter.validate?.({ ...raw({}, 0), content: "not-json" })).toMatchObject({ valid: false });
  expect(dependencyAuditAdapter.validate?.(raw({ arbitrary: "shape" }, 0))).toMatchObject({ valid: false });
});

test("recognized audit containers reject malformed nested entries and unknown severity", () => {
  for (const payload of [
    { vulnerabilities: [] },
    { advisories: [] },
    { vulnerabilities: { pkg: "malformed" } },
    { advisories: { "1": "malformed" } },
    { vulnerabilities: { pkg: { severity: "high", via: [null] } } },
    { vulnerabilities: { pkg: { severity: "high", via: "malformed" } } },
    { advisories: { "1": { severity: "unrecognized" } } },
    { pkg: [{ severity: "unrecognized" }] },
  ]) {
    expect(dependencyAuditAdapter.validate?.(raw(payload, 0))).toMatchObject({ valid: false });
  }
});

test("valid advisories survive other malformed entries in the same audit output", () => {
  for (const payload of [
    { vulnerabilities: { broken: null, good: { severity: "high", via: [] } } },
    { advisories: { broken: null, good: { module_name: "good", title: "Synthetic issue", severity: "high" } } },
    { good: [null, { id: "synthetic", title: "Synthetic issue", severity: "high" }] },
  ]) {
    const result = raw(payload, 0);
    expect(dependencyAuditAdapter.validate?.(result)).toMatchObject({ valid: false });
    expect(dependencyAuditAdapter.parse(result, ctx)).toMatchObject([{ priority: "P0" }]);
  }
});
