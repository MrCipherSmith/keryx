// Round-1 finding T-005: `renderBundledSkill`'s YAML-quoting of a
// `description` containing a colon (catalog.ts:542-544) was never asserted.
// Without it, a description carrying a `NOT for: <sibling>` clause (several
// bundled skill descriptions do) renders as an invalid YAML plain scalar —
// `description: Use when X. NOT for: Y.` reads to a YAML parser as the key
// `description` mapped to a nested mapping starting at `NOT for:`, not as
// one string — and every consumer that parses `SKILL.md` frontmatter as
// YAML (not just keryx's own forgiving line-regex parsers) breaks silently.
//
// This renders every `BUNDLED_GDSKILLS` entry through the real
// `renderBundledSkill`, parses the frontmatter with `Bun.YAML.parse` — a
// real YAML parser, not `parseSkillFrontmatter`'s line-regex — and asserts
// the parsed `description` round-trips to `entry.description` exactly.
// `package.json` (`dependencies: {}`) ships no YAML library; Bun 1.3's
// built-in `Bun.YAML.parse` covers this without adding one.
import { expect, test } from "bun:test";
import { BUNDLED_GDSKILLS, renderBundledSkill } from "./catalog";

/**
 * Split a rendered `SKILL.md` into its `---`-delimited frontmatter block
 * (raw, unparsed) and the lines within it. Throws (failing the test loudly)
 * if the render doesn't even have a well-formed frontmatter block — that is
 * itself a regression this file should catch, not silently skip.
 */
function extractFrontmatter(rendered: string): { raw: string; lines: string[] } {
  if (!rendered.startsWith("---\n")) {
    throw new Error("rendered skill does not start with a --- frontmatter fence");
  }
  const end = rendered.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("rendered skill frontmatter has no closing --- fence");
  }
  const raw = rendered.slice(4, end);
  return { raw, lines: raw.split("\n") };
}

for (const entry of BUNDLED_GDSKILLS) {
  test(`rendered SKILL.md frontmatter for bundled skill "${entry.name}" is valid YAML whose description round-trips`, () => {
    const rendered = renderBundledSkill(entry);
    const { raw, lines } = extractFrontmatter(rendered);

    const descriptionLine = lines.find((line) => line.startsWith("description: "));
    expect(descriptionLine).toBeDefined();
    const rawValue = (descriptionLine as string).slice("description: ".length);

    if (entry.description.includes(":")) {
      // catalog.ts quotes any description containing a colon as a JSON
      // string (a valid YAML double-quoted scalar). Assert it actually is
      // one, and that it decodes back to the exact source description.
      let decoded: unknown;
      expect(() => {
        decoded = JSON.parse(rawValue);
      }).not.toThrow();
      expect(decoded).toBe(entry.description);
    } else {
      // No colon: rendered unquoted. An unquoted YAML plain scalar is only
      // safe from being misread as a nested mapping when it carries no
      // ": " (colon-space) sequence.
      expect(rawValue).not.toContain(": ");
    }

    // The real assertion: a real YAML parser, fed the whole frontmatter
    // block, recovers exactly the source description — proving the
    // quoting (or lack of it) round-trips through YAML, not just through
    // our own regex-based expectations above.
    const parsed = Bun.YAML.parse(raw) as { description?: unknown };
    expect(parsed.description).toBe(entry.description);
  });
}
