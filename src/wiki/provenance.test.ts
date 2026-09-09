// LWG-4 page provenance (flow 223, phase 0): AC8, AC9.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../gdgraph/types";
import {
  computeVerifiedScope,
  parsePageLifecycle,
  parseProvenance,
  upsertFrontmatterField,
  writeProvenance,
} from "./provenance";

const SHA = "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

const PAGE = [
  "# src/ctx",
  "Version: 1.0.0",
  "Type: component",
  "Status: accepted",
  "",
  "## Overview",
  "",
  "Prose the machine must never touch.",
  "",
].join("\n");

describe("parseProvenance", () => {
  test("reads both fields and the raw Describes list", () => {
    const content = [
      "# Page",
      "Version: 1.0.0",
      `VerifiedAt: ${SHA}`,
      `VerifiedScope: sha256:${"a".repeat(64)}`,
      "Describes:",
      "  - src/ctx/**",
      "  - `src/ctx/run.ts`",
      "",
    ].join("\n");
    const provenance = parseProvenance(content);
    expect(provenance.verifiedAt).toBe(SHA);
    expect(provenance.verifiedScope).toBe(`sha256:${"a".repeat(64)}`);
    expect(provenance.describes).toEqual(["src/ctx/**", "src/ctx/run.ts"]);
  });

  test("a malformed value reads as null rather than being passed through", () => {
    // A bad sha flowing into a `git log` range would fail far from its cause.
    const provenance = parseProvenance("VerifiedAt: not-a-sha\nVerifiedScope: md5:abc\n");
    expect(provenance.verifiedAt).toBeNull();
    expect(provenance.verifiedScope).toBeNull();
  });

  test("an unstamped page yields nulls, which is not the same as fresh", () => {
    const provenance = parseProvenance(PAGE);
    expect(provenance.verifiedAt).toBeNull();
    expect(provenance.verifiedScope).toBeNull();
    expect(provenance.describes).toEqual([]);
  });
});

describe("upsertFrontmatterField (AC8)", () => {
  test("inserting touches nothing but the added line", () => {
    const out = upsertFrontmatterField(PAGE, "VerifiedAt", SHA);
    const before = PAGE.split("\n");
    const after = out.split("\n");

    expect(after).toContain(`VerifiedAt: ${SHA}`);
    // Every original line survives, in order, once the new one is removed.
    expect(after.filter((line) => line !== `VerifiedAt: ${SHA}`)).toEqual(before);
    // And it lands inside the frontmatter block, not in the prose.
    expect(after.indexOf(`VerifiedAt: ${SHA}`)).toBeLessThan(after.indexOf("## Overview"));
  });

  test("replacing rewrites in place and changes no other byte", () => {
    const once = upsertFrontmatterField(PAGE, "VerifiedAt", SHA);
    const twice = upsertFrontmatterField(once, "VerifiedAt", "b".repeat(40));
    expect(twice.split("\n").length).toBe(once.split("\n").length);
    expect(twice).toBe(once.replace(SHA, "b".repeat(40)));
  });

  test("round-trip: parse then write back is a no-op", () => {
    const stamped = writeProvenance(PAGE, {
      verifiedAt: SHA,
      verifiedScope: `sha256:${"c".repeat(64)}`,
    });
    const parsed = parseProvenance(stamped);
    const rewritten = writeProvenance(stamped, parsed);
    expect(rewritten).toBe(stamped);
  });

  test("a page with no frontmatter at all gets the field after its heading", () => {
    const out = upsertFrontmatterField("# Bare\n\nProse.\n", "VerifiedAt", SHA);
    expect(out).toBe(`# Bare\nVerifiedAt: ${SHA}\n\nProse.\n`);
  });
});

describe("computeVerifiedScope (AC9)", () => {
  async function fixture(): Promise<{ cwd: string; graph: GraphData }> {
    const cwd = await mkdtemp(path.join(tmpdir(), "lwg-scope-"));
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const files: string[] = [];
    for (let index = 1; index <= 7; index += 1) {
      const rel = `src/f${index}.ts`;
      await writeFile(path.join(cwd, rel), `export const f${index} = ${index};\n`);
      files.push(rel);
    }
    return {
      cwd,
      graph: {
        nodes: files.map((file) => ({
          id: file,
          kind: "file" as const,
          path: file,
          language: "typescript" as const,
        })),
        edges: [],
      },
    };
  }

  test("the SEVENTH file changes the scope — the defect top-6 hashing has", async () => {
    const { cwd, graph } = await fixture();
    const all = graph.nodes.map((node) => node.path);

    const before = await computeVerifiedScope(cwd, all, graph);
    await writeFile(path.join(cwd, "src/f7.ts"), "export const f7 = 999;\n");
    const after = await computeVerifiedScope(cwd, all, graph);

    expect(after).not.toBe(before);
    // And confirm the premise: hashing only the first six would NOT have moved.
    const topSix = all.slice(0, 6);
    expect(await computeVerifiedScope(cwd, topSix, graph)).toBe(
      await computeVerifiedScope(cwd, topSix, graph),
    );
  });

  test("format is sha256-prefixed and order-independent", async () => {
    const { cwd, graph } = await fixture();
    const all = graph.nodes.map((node) => node.path);
    const forward = await computeVerifiedScope(cwd, all, graph);
    const reversed = await computeVerifiedScope(cwd, [...all].reverse(), graph);

    expect(forward).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reversed).toBe(forward);
  });

  test("an empty describe-set gets a stable explicit marker, not the hash of nothing", async () => {
    const { cwd, graph } = await fixture();
    const first = await computeVerifiedScope(cwd, [], graph);
    const second = await computeVerifiedScope(cwd, [], graph);
    expect(first).toBe(second);
    expect(first).not.toBe(await computeVerifiedScope(cwd, ["src/f1.ts"], graph));
  });

  test("a deleted file moves the scope rather than preserving 'unchanged'", async () => {
    const { cwd, graph } = await fixture();
    const before = await computeVerifiedScope(cwd, ["src/f1.ts"], graph);
    const after = await computeVerifiedScope(cwd, ["src/gone.ts"], graph);
    expect(after).not.toBe(before);
  });
});

// AFC-06 (flow 234): the same six input classes `src/memory/lifecycle.test.ts`
// covers on the memory surface, covered here on the wiki surface through
// `parsePageLifecycle`, which delegates to the same `computeLifecycle`.
describe("parsePageLifecycle (AFC-06 AC1)", () => {
  const NOW = new Date("2026-06-15T00:00:00.000Z");
  const page = (fields: Record<string, string>) =>
    ["# Page", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "", "## Overview", ""].join("\n");

  test("date boundary: ValidFrom == observedAt is current, ValidTo == observedAt is not (AC1 class 1)", () => {
    const atStart = parsePageLifecycle(page({ Status: "accepted", ValidFrom: "2026-06-15" }), NOW);
    expect(atStart).toMatchObject({ state: "current", current: true, historical: false });

    const atEnd = parsePageLifecycle(
      page({ Status: "accepted", ValidFrom: "2026-01-01", ValidTo: "2026-06-15" }),
      NOW,
    );
    expect(atEnd).toMatchObject({ state: "expired", current: false, historical: true });
  });

  test("future: ValidFrom later than observedAt is not current (AC1 class 2)", () => {
    const result = parsePageLifecycle(page({ Status: "accepted", ValidFrom: "2026-07-01" }), NOW);
    expect(result).toMatchObject({ state: "future", current: false, historical: true });
  });

  test("deprecated: Status: deprecated is never current (AC1 class 3)", () => {
    const result = parsePageLifecycle(page({ Status: "deprecated" }), NOW);
    expect(result).toMatchObject({ state: "deprecated", current: false, historical: true });
  });

  test("conflict: Status: conflict is never current (AC1 class 4)", () => {
    const result = parsePageLifecycle(page({ Status: "conflict" }), NOW);
    expect(result).toMatchObject({ state: "conflict", current: false, historical: true });
  });

  test("superseded: SupersededBy without a lookup is superseded (AC1 class 5)", () => {
    const result = parsePageLifecycle(
      page({ Status: "accepted", SupersededBy: "architecture/newer.md" }),
      NOW,
    );
    expect(result).toMatchObject({ state: "superseded", current: false, historical: true });
  });

  test("malformed date: an unparsable ValidFrom yields an invalid lifecycle, not silently current (AC1 class 6)", () => {
    const result = parsePageLifecycle(page({ Status: "accepted", ValidFrom: "not-a-date" }), NOW);
    expect(result).toMatchObject({ state: "invalid", current: false, historical: true });
    expect(result.reasons).toContain("malformed-valid-from");
  });

  test("a page with no Status line at all never becomes accepted", () => {
    const result = parsePageLifecycle("# Bare page\n\nNo frontmatter.\n", NOW);
    expect(result).toMatchObject({ state: "unknown", current: false, historical: true });
  });

  test("historical is exactly the complement of current, mirroring the memory surface", () => {
    const current = parsePageLifecycle(page({ Status: "accepted" }), NOW);
    const deprecated = parsePageLifecycle(page({ Status: "deprecated" }), NOW);
    expect(current.historical).toBe(false);
    expect(deprecated.historical).toBe(true);
  });
});

// AFC-06 (flow 234), T18 item 3: memory frontmatter spells these fields
// hyphenated (`Valid-From`/`Valid-To`/`Superseded-By`, `src/memory/store.ts`);
// wiki frontmatter documents the unhyphenated form (`ValidFrom`/`ValidTo`/
// `SupersededBy`, `src/wiki/collect.ts`). Verified directly against both
// parsers before this fix (see the task report). Without accepting both
// spellings, an author who copies a working entry from one surface to the
// other silently gets a field that parses to nothing and a page that is
// admitted when it should be rejected -- the exact silent trap AC1 forbids.
describe("parsePageLifecycle accepts the memory-frontmatter (hyphenated) field spelling", () => {
  const NOW = new Date("2026-06-15T00:00:00.000Z");

  test("a hyphenated Valid-From in the future is rejected, not silently admitted", () => {
    const content = ["# Page", "Status: accepted", "Valid-From: 2999-01-01", "", "## Overview", ""].join("\n");
    const result = parsePageLifecycle(content, NOW);
    expect(result).toMatchObject({ state: "future", current: false, historical: true });
  });

  test("a hyphenated Valid-To boundary behaves identically to the unhyphenated spelling", () => {
    const hyphenated = parsePageLifecycle(
      ["# Page", "Status: accepted", "Valid-From: 2026-01-01", "Valid-To: 2026-06-15", "", "## Overview", ""].join(
        "\n",
      ),
      NOW,
    );
    const unhyphenated = parsePageLifecycle(
      ["# Page", "Status: accepted", "ValidFrom: 2026-01-01", "ValidTo: 2026-06-15", "", "## Overview", ""].join(
        "\n",
      ),
      NOW,
    );
    expect(hyphenated).toMatchObject({ state: "expired", current: false, historical: true });
    expect(hyphenated.state).toBe(unhyphenated.state);
  });

  test("a hyphenated Superseded-By is admitted/rejected the same as SupersededBy", () => {
    const hyphenated = parsePageLifecycle(
      ["# Page", "Status: accepted", "Superseded-By: architecture/newer.md", "", "## Overview", ""].join("\n"),
      NOW,
    );
    expect(hyphenated).toMatchObject({ state: "superseded", current: false, historical: true });
  });

  test("when both spellings are present, the wiki (unhyphenated) spelling wins", () => {
    // Valid-From (hyphenated) says "still future"; ValidFrom (unhyphenated,
    // what this module documents as canonical) says "already valid". The
    // unhyphenated value must be the one that decides the verdict.
    const result = parsePageLifecycle(
      ["# Page", "Status: accepted", "Valid-From: 2999-01-01", "ValidFrom: 2026-01-01", "", "## Overview", ""].join(
        "\n",
      ),
      NOW,
    );
    expect(result).toMatchObject({ state: "current", current: true, historical: false });
  });
});
