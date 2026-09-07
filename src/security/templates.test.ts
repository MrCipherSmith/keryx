import { expect, test } from "bun:test";
import { renderSecurityCoreReadme, renderSecurityManifest, securityCapabilities } from "./templates";

// T68 regression (T62 F-004): this text is written into the operator's own
// project by `keryx init`/`update` (`renderSecurityManifest` ->
// `.metaproject/modules/security.md`, `renderSecurityCoreReadme` ->
// `.metaproject/core/README.md`) and is read by an agent as fact. Since T61
// (`isBlockingMode`) and T65 (`exitCodeFor`/`reportExitCode`), `gateway`
// blocks identically to `enforced`/`ci` at the write seam, the flow gate, and
// every command exit code -- so any enumeration of which modes block must
// name it too, or the shipped guidance tells an agent a blocking mode is
// permissive.

test("renderSecurityManifest names gateway alongside enforced/ci as a blocking pre-push mode", () => {
  const manifest = renderSecurityManifest();
  expect(manifest).toContain("`enforced`/`ci`/`gateway` block the push");
  // The old, incomplete enumeration must not still be present anywhere else
  // in the doc (would indicate a second, unfixed copy of the same sentence).
  expect(manifest).not.toContain("`enforced`/`ci` block the push");
});

test("renderSecurityCoreReadme names gateway alongside enforced/ci as a mode where check() must stop the write", () => {
  const readme = renderSecurityCoreReadme();
  expect(readme).toContain("`enforced`/`ci`/`gateway` mode a");
  expect(readme).not.toContain("`enforced`/`ci` mode a");
});

// T70 F-003 regression: only the checksum arm in `self-protect.ts` pushes a
// `SecurityFinding` (`findings.push(`, one occurrence in the whole module);
// the mode-downgrade and disabled-policy arms each push a warning + an
// incident and no finding, so `analyze()`'s `selfProtection.findings` fold
// never moves the gate or an exit code for either. The shipped manifest must
// say so, not claim a mode downgrade is "always surfaced as a finding".
test("renderSecurityManifest's §14 sentence matches self-protect.ts: only a checksum mismatch is a finding", () => {
  const manifest = renderSecurityManifest();
  const normalized = manifest.replace(/\s+/g, " ");
  expect(normalized).toContain(
    "A `configChecksum` mismatch is surfaced as a finding plus an incident entry; a mode downgrade or a disabled policy is surfaced as a warning plus an incident entry",
  );
  expect(normalized).not.toContain(
    "A `configChecksum` mismatch or a mode downgrade is always surfaced as a finding",
  );
});

// T76 F-004 regression: `resolve.ts:132-161`'s `computeGate` blocks (`fail`)
// on any category's `block` action or any category at/above the configured
// severity, and produces `needs-approval` (which also exits non-zero in a
// blocking mode) on any category's `require-approval` action -- not only a
// "secret/critical" finding. The manifest's Hooks section must not narrow
// the trigger set to that phrase.
test("renderSecurityManifest does not narrow the pre-push block condition to secret/critical", () => {
  const manifest = renderSecurityManifest();
  expect(manifest).not.toContain("secret/critical finding");
  expect(manifest).toContain("failing or needs-approval gate");
  // The gateway-naming correction (T68) must still hold alongside this fix.
  expect(manifest).toContain("`enforced`/`ci`/`gateway` block the push");
});

test("renderSecurityManifest is non-empty prose documenting the module commands", () => {
  const manifest = renderSecurityManifest();
  expect(manifest.length).toBeGreaterThan(0);
  expect(manifest).toContain("keryx security scan");
});

test("securityCapabilities returns the canonical capability list", () => {
  expect(securityCapabilities()).toEqual([
    "security.secrets",
    "security.pii",
    "security.prompt-injection",
    "security.egress-control",
  ]);
});
