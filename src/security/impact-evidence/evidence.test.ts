// Flow 308 (W8, Lane B, T6): `computeImpactEvidence`/`renderEvidenceBlock` —
// AC9 (importers verbatim from `buildAffectedReport`), AC11 (not-indexed
// wording), and the memory-caveat composition.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeImpactEvidence, renderEvidenceBlock } from "./evidence";

const CAVEAT_ENTRY = `# A caveat on src/a.ts

Version: 0.1.0
Type: lesson
Status: accepted
Confidence: high
Caveat: This only held under the old retry policy.

## Summary

Short summary.

## Details

Some detail.

## Provenance

- Source: review

## Related Scopes

- Files:
  - \`src/a.ts\`

## Tags

- test
`;

describe("computeImpactEvidence", () => {
  let root = "";
  let cwd = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-impact-evidence-compute-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      [
        '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}',
        '{"id":"src/b.ts","kind":"file","path":"src/b.ts","language":"typescript"}',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl"),
      '{"id":"e1","from":"src/b.ts","to":"src/a.ts","kind":"imports","specifier":"./a"}\n',
      "utf8",
    );

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    await mkdir(path.join(root, ".metaproject", "memory", "lessons"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "memory", "lessons", "caveat.md"), CAVEAT_ENTRY, "utf8");
  });

  afterEach(async () => {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  test("AC9: importers section is verbatim `buildAffectedReport` JSON", async () => {
    const { buildAffectedReport } = await import("../../gdgraph/affected-report");
    const direct = await buildAffectedReport(root, "src/a.ts");

    const evidence = await computeImpactEvidence(root, "src/a.ts");
    expect(evidence.importers.json).toBe(JSON.stringify(direct.json, null, 2));
    expect(evidence.importers.status).toBe("ok");
  });

  // F22 (review round 1, info): AC9's own test above compares
  // `computeImpactEvidence` against a direct `buildAffectedReport` call —
  // both sides of `evidence.ts`'s OWN import, so it cannot catch the
  // provider's importers section drifting from what the actual `keryx
  // gdgraph affected --json` COMMAND prints (a bug in `runAffected`'s own
  // wiring, e.g. a stale re-export, would not show up there). This spies on
  // `console.log` around the real `gdgraphCommand` entry point instead.
  test("F22: importers section matches the actual `keryx gdgraph affected --json` command's stdout, not just the shared builder", async () => {
    const { gdgraphCommand } = await import("../../commands/gdgraph");
    const loggedOut: string[] = [];
    const originalLog = console.log;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    const originalExitCode = process.exitCode;
    try {
      await gdgraphCommand(["affected", "src/a.ts", "--json"]);
    } finally {
      console.log = originalLog;
      process.exitCode = originalExitCode;
    }

    const evidence = await computeImpactEvidence(root, "src/a.ts");
    expect(evidence.importers.json).toBe(loggedOut.join("\n"));
  });

  test("picks up a memory caveat scoped to the file", async () => {
    const evidence = await computeImpactEvidence(root, "src/a.ts");
    expect(evidence.memoryCaveats).toHaveLength(1);
    expect(evidence.memoryCaveats[0]?.caveat).toBe("This only held under the old retry policy.");
    expect(evidence.memoryCaveats[0]?.entry).toBe("lessons/caveat.md");
  });

  test("AC11: an unindexed file reports not-indexed, and the rendered block says 'not indexed'", async () => {
    const evidence = await computeImpactEvidence(root, "src/does-not-exist.ts");
    expect(evidence.importers.status).toBe("not-indexed");

    const block = renderEvidenceBlock([evidence], ["src/does-not-exist.ts"]);
    expect(block).toContain("not indexed");
    expect(block.toLowerCase()).not.toContain("no importers found");
  });
});
