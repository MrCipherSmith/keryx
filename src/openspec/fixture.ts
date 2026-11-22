import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function createOpenSpecFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-openspec-"));
  function write(relativePath: string, content: string) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  function cleanup() {
    rmSync(root, { recursive: true, force: true });
  }
  return { root, write, cleanup };
}

export const baselineMarkdown = [
  "# Review", "", "### Requirement: Exact Name", "The system reviews changes.", "",
  "#### Scenario: Successful review", "- **WHEN** a change is submitted", "- **THEN** it is reviewed", "",
  "### Requirement: exact  name", "Distinct title.", "",
].join("\n");

export const deltaMarkdown = [
  "## ADDED Requirements", "### Requirement: New behavior", "New content.", "",
  "## MODIFIED Requirements", "### Requirement: Exact Name", "Updated content.", "",
  "## REMOVED Requirements", "### Requirement: Old behavior", "- Reason: retired", "- Migration: use New behavior", "",
  "- `### Requirement: Legacy behavior`", "",
  "## RENAMED Requirements", "- FROM: `### Requirement: Previous name`", "- TO: `### Requirement: Current name`", "",
].join("\n");

export function populateOpenSpecFixture(fixture: ReturnType<typeof createOpenSpecFixture>) {
  fixture.write("openspec/specs/review/spec.md", baselineMarkdown);
  fixture.write("openspec/changes/update-review/proposal.md", "# Update review\n");
  fixture.write("openspec/changes/update-review/specs/review/spec.md", deltaMarkdown);
  fixture.write("openspec/changes/no-delta/proposal.md", "# No delta\n");
  fixture.write("openspec/changes/archive/2025-03-01-old/specs/review/spec.md", deltaMarkdown);
  fixture.write("openspec/changes/archive/undated/specs/retired/spec.md", "## REMOVED Requirements\n### Requirement: Retired\n");
}
