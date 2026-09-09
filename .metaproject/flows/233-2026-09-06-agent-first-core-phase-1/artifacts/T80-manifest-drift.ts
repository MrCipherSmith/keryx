// T80 probe: does .metaproject/modules/security.md (this repo's own checked-in,
// self-hosted copy -- mechanism 5 in T79's enumeration) match what its own
// generator (renderSecurityManifest()) currently produces? T79/T76's own
// keyword sweeps ("advisory|enforced|gateway|mode-gated|secret/critical|
// needs-approval") never checked this file byte-for-byte against the
// generator, only for specific substrings -- so a drift outside that keyword
// family would not be caught. This does the full-content comparison directly.
import { readFile } from "node:fs/promises";
import { renderSecurityManifest, renderSecurityCoreReadme } from "../../../../src/security/templates";

const manifestOnDisk = await readFile(".metaproject/modules/security.md", "utf8");
const readmeOnDisk = await readFile(".metaproject/core/security/README.md", "utf8");
const manifestGenerated = renderSecurityManifest();
const readmeGenerated = renderSecurityCoreReadme();

function firstDiffLine(a: string, b: string): { line: number; gen: string | undefined; disk: string | undefined } | null {
  const ga = a.split("\n");
  const gb = b.split("\n");
  const max = Math.max(ga.length, gb.length);
  for (let i = 0; i < max; i++) {
    if (ga[i] !== gb[i]) return { line: i, gen: ga[i], disk: gb[i] };
  }
  return null;
}

console.log(JSON.stringify({
  "manifest identical to generator": manifestGenerated === manifestOnDisk,
  "manifest first diff (0-indexed line within the string)": firstDiffLine(manifestGenerated, manifestOnDisk),
  "readme identical to generator": readmeGenerated === readmeOnDisk,
  "manifest still contains the stale pre-T75 §14 sentence": manifestOnDisk.includes(
    "A `configChecksum` mismatch or a mode downgrade is always surfaced\n  as a finding plus an incident entry",
  ) || manifestOnDisk.replace(/\s+/g, " ").includes(
    "A `configChecksum` mismatch or a mode downgrade is always surfaced as a finding plus an incident entry",
  ),
  "generator's own §14 sentence is the corrected one": manifestGenerated.replace(/\s+/g, " ").includes(
    "A `configChecksum` mismatch is surfaced as a finding plus an incident entry; a mode downgrade or a disabled policy is surfaced as a warning plus an incident entry",
  ),
}, null, 2));
