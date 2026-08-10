import { test, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { relevantAcceptedMemory } from "./relevant";
import { uniqueTestRoot } from "../lib/test-tmp";

function entryMd(
  title: string,
  type: string,
  status: string,
  moduleName: string,
  temporal: { validFrom?: string; validTo?: string; supersededBy?: string } = {},
): string {
  return `# ${title}

Version: 0.1.0
Type: ${type}
Status: ${status}
Confidence: high
Valid-From: ${temporal.validFrom ?? ""}
Valid-To: ${temporal.validTo ?? ""}
Superseded-By: ${temporal.supersededBy ?? ""}

## Summary

${title} summary.

## Related Scopes

- Module: ${moduleName}

## Tags

- ${moduleName}
`;
}

test("returns accepted decisions/constraints for the module; ignores drafts, lessons, and other modules", async () => {
  const root = uniqueTestRoot(path.join(import.meta.dir, "..", ".."), ".tmp-relevant-test");
  await rm(root, { recursive: true, force: true });
  const mem = path.join(root, ".metaproject", "memory");
  await mkdir(path.join(mem, "decisions"), { recursive: true });
  await mkdir(path.join(mem, "constraints"), { recursive: true });
  await mkdir(path.join(mem, "lessons"), { recursive: true });

  await writeFile(path.join(mem, "decisions", "d1.md"), entryMd("Use adapters", "decision", "accepted", "pipelines"), "utf8");
  await writeFile(path.join(mem, "constraints", "c1.md"), entryMd("No sync IO", "constraint", "accepted", "pipelines"), "utf8");
  await writeFile(path.join(mem, "decisions", "d2.md"), entryMd("Draft idea", "decision", "draft", "pipelines"), "utf8");
  await writeFile(path.join(mem, "lessons", "l1.md"), entryMd("A lesson", "lesson", "accepted", "pipelines"), "utf8");
  await writeFile(path.join(mem, "decisions", "d3.md"), entryMd("Other decision", "decision", "accepted", "billing"), "utf8");

  try {
    const relevant = await relevantAcceptedMemory(root, { module: "pipelines", target: "http-step", files: [] });
    expect(relevant.map((e) => e.relativePath).sort()).toEqual([
      "constraints/c1.md",
      "decisions/d1.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("P3: authoritative recall excludes expired, boundary-closed, future, and superseded accepted entries", async () => {
  const root = path.join(import.meta.dir, "..", "..", ".tmp-relevant-current-test");
  await rm(root, { recursive: true, force: true });
  const decisions = path.join(root, ".metaproject", "memory", "decisions");
  await mkdir(decisions, { recursive: true });
  await writeFile(path.join(decisions, "current.md"), entryMd("Current", "decision", "accepted", "pipelines"), "utf8");
  await writeFile(path.join(decisions, "expired.md"), entryMd("Expired", "decision", "accepted", "pipelines", { validTo: "2026-08-09" }), "utf8");
  await writeFile(path.join(decisions, "boundary.md"), entryMd("Boundary", "decision", "accepted", "pipelines", { validTo: "2026-08-10" }), "utf8");
  await writeFile(path.join(decisions, "future.md"), entryMd("Future", "decision", "accepted", "pipelines", { validFrom: "2026-08-11" }), "utf8");
  await writeFile(path.join(decisions, "superseded.md"), entryMd("Superseded", "decision", "accepted", "pipelines", { supersededBy: "decisions/current.md" }), "utf8");

  try {
    const relevant = await relevantAcceptedMemory(
      root,
      { module: "pipelines", target: "http-step", files: [] },
      99,
      new Date("2026-08-10T00:00:00.000Z"),
    );
    expect(relevant.map((entry) => entry.relativePath)).toEqual(["decisions/current.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
