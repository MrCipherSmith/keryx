import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { assertP0Purity, snapshotProject } from "../memory/p0-test-utils";
import { collectContext } from "./context";

const FIXTURE = path.join(import.meta.dir, "..", "..", "fixtures", "memory-reliability-p0");

test("P0-8/P0-9: flow context uses the authority fixture and preserves as-of boundary evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-flow-p0-"));
  try {
    await cp(path.join(FIXTURE, ".metaproject"), path.join(root, ".metaproject"), { recursive: true });
    const before = await snapshotProject(root, {
      paths: [".metaproject/memory", ".metaproject/data/memory/artifacts", ".metaproject/runtime/memory"],
      includeRuntimePaths: [
        ".metaproject/data/memory/artifacts/latest.md",
        ".metaproject/data/memory/artifacts/latest.json",
      ],
    });
    const result = await collectContext({
      cwd: root,
      title: "authority boundary",
      issueRef: null,
      issueUrl: null,
      tracker: null,
      now: new Date("2026-08-10T00:00:00.000Z"),
    });
    expect(result.markdown).toContain("Accepted authority decision");
    expect(result.markdown).toContain("decisions/accepted.md");
    expect(result.markdown).not.toContain("Draft authority decision");
    expect(result.markdown).not.toContain("Conflicting authority decision");
    expect(result.markdown).not.toContain("Deprecated authority decision");
    expect(result.markdown).not.toContain("Expired authority decision");
    expect(result.markdown).not.toContain("Superseded authority decision");
    assertP0Purity(before, await snapshotProject(root, {
      paths: [".metaproject/memory", ".metaproject/data/memory/artifacts", ".metaproject/runtime/memory"],
      includeRuntimePaths: [
        ".metaproject/data/memory/artifacts/latest.md",
        ".metaproject/data/memory/artifacts/latest.json",
      ],
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
