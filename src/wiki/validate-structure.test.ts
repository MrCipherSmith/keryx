// LWG-14 structural validation (flow 227): AC10.

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiValidate } from "./service";

async function project(pages: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "lwg-validate-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "real.ts"), "export const real = 1;\n");
  for (const [rel, body] of Object.entries(pages)) {
    const file = path.join(cwd, ".metaproject", "wiki", rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }
  return cwd;
}

const HEAD = ["# Page", "Version: 1.0.0", "Type: component", "Status: accepted", ""].join("\n");

async function issuesOf(cwd: string, kind: string): Promise<string[]> {
  const result = await wikiValidate(cwd);
  return result.issues.filter((issue) => issue.kind === kind).map((issue) => issue.message);
}

describe("managed-block rules (AC10)", () => {
  test("a truncated block is reported", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}\n<!-- keryx:reference:begin v=1 -->\n## Reference\n\n- x\n`,
    });
    const messages = await issuesOf(cwd, "managed-block");
    expect(messages.join(" ")).toContain("opening marker with no closing marker");
  });

  test("an unknown marker version is reported rather than accepted", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}\n<!-- keryx:reference:begin v=42 -->\n## Reference\n<!-- keryx:reference:end -->\n`,
    });
    expect((await issuesOf(cwd, "managed-block")).join(" ")).toContain("unknown marker version 42");
  });

  test("a hand-edited block is surfaced, because refresh will refuse it later", async () => {
    const cwd = await project({
      "components/a.md":
        `${HEAD}\n<!-- keryx:reference:begin v=1 hash=${"0".repeat(64)} -->\n## Reference\n\n- x\n<!-- keryx:reference:end -->\n`,
    });
    // Not a defect in itself — a person may legitimately edit there — but it
    // determines what `wiki refresh` will do, so it belongs in the report
    // rather than arriving as a surprise.
    expect((await issuesOf(cwd, "managed-block")).join(" ")).toContain("edited by hand");
  });

  test("a well-formed block raises nothing", async () => {
    const body = "## Reference\n\n- x";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(body.trim()).digest("hex");
    const cwd = await project({
      "components/a.md": `${HEAD}\n<!-- keryx:reference:begin v=1 hash=${hash} -->\n${body}\n<!-- keryx:reference:end -->\n`,
    });
    expect(await issuesOf(cwd, "managed-block")).toEqual([]);
  });
});

describe("describes targets (AC10)", () => {
  test("a Describes path that does not exist is reported", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}Describes:\n  - src/gone.ts\n\n## Overview\n\nProse.\n`,
    });
    expect((await issuesOf(cwd, "describes")).join(" ")).toContain("src/gone.ts");
  });

  test("an existing path raises nothing, and a glob is not resolved here", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}Describes:\n  - src/real.ts\n  - src/**\n\n## Overview\n\nProse.\n`,
    });
    // Globs are matched against the graph, not the filesystem; checking them
    // here would report a false miss for a pattern that resolves fine.
    expect(await issuesOf(cwd, "describes")).toEqual([]);
  });
});

describe("changelog ordering (AC10)", () => {
  test("versions that are not newest-first are reported", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}\n## Changelog\n\n- 1.0.0 - older\n- 1.0.1 - newer\n`,
    });
    expect((await issuesOf(cwd, "changelog")).join(" ")).toContain("not newest-first");
  });

  test("newest-first ordering raises nothing", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}\n## Changelog\n\n- 1.0.2 - newest\n- 1.0.1 - older\n- 1.0.0 - oldest\n`,
    });
    expect(await issuesOf(cwd, "changelog")).toEqual([]);
  });

  test("equal versions are tolerated — two entries at one version is not an error", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}\n## Changelog\n\n- 1.0.1 - a\n- 1.0.1 - b\n- 1.0.0 - c\n`,
    });
    expect(await issuesOf(cwd, "changelog")).toEqual([]);
  });
});

describe("the sentinel is not a path (regression)", () => {
  test("`Describes: none` raises no describes issue", async () => {
    // It did, on the very PR that introduced the sentinel: the resolver
    // learned about it and the validator did not, so four pages were reported
    // as naming a missing path called "none" and the CI gate refused the
    // change. Pinned here so the two cannot drift apart again.
    const cwd = await project({
      "components/a.md": `${HEAD}Describes: none  # rendered from the graph, so its scope would be everything\n\n## Overview\n\nProse.\n`,
    });
    expect(await issuesOf(cwd, "describes")).toEqual([]);
  });

  test("a genuinely missing path is still reported", async () => {
    const cwd = await project({
      "components/a.md": `${HEAD}Describes:\n  - src/gone.ts\n\n## Overview\n\nProse.\n`,
    });
    expect((await issuesOf(cwd, "describes")).join(" ")).toContain("src/gone.ts");
  });
});
