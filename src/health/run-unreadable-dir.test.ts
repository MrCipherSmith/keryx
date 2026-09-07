import { expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHealth } from "./run";
import { uniqueTestRoot } from "../lib/test-tmp";

// Flow 234 T26 end-to-end: before the fix, `runHealth()` over a project tree
// containing an unreadable subdirectory threw an uncaught EACCES and no
// report was produced at all (reproduced for real via the CLI entry point --
// see the flow 234 T26 task report). After the fix the run must both survive
// AND refuse to report clean coverage over the subtree it could not see: a
// P0 finding names the unreadable path and the gate fails, the same
// convention `src/health/sources/tests.ts`'s `tests-context-incomplete`
// finding already uses for the identical problem one layer over.
test("a project-wide health run over an unreadable subdirectory reports a blocking finding instead of a clean pass", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-run-unreadable");
  await mkdir(path.join(root, "src", "locked"), { recursive: true });
  await writeFile(path.join(root, "src", "visible.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "src", "locked", "hidden.ts"), "export const y = 1;\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  await chmod(path.join(root, "src", "locked"), 0o000);

  try {
    const { report } = await runHealth({ cwd: root, scope: { kind: "project" } });

    const incomplete = report.findings.find((f) => f.id.includes("source-files-incomplete"));
    expect(incomplete).toBeDefined();
    expect(incomplete?.priority).toBe("P0");
    expect(incomplete?.severity).toBe("error");
    expect(incomplete?.message).toContain("src/locked");
    expect(report.gate.status).toBe("fail");
  } finally {
    await chmod(path.join(root, "src", "locked"), 0o755);
    await rm(root, { recursive: true, force: true });
  }
});
