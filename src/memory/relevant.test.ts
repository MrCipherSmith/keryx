import { test, expect } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { relevantAcceptedMemory } from "./relevant";
import { uniqueTestRoot } from "../lib/test-tmp";

function entryMd(title: string, type: string, status: string, moduleName: string): string {
  return `# ${title}

Version: 0.1.0
Type: ${type}
Status: ${status}
Confidence: high

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
