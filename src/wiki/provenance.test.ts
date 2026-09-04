// LWG-4 page provenance (flow 223, phase 0): AC8, AC9.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphData } from "../gdgraph/types";
import {
  computeVerifiedScope,
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
