import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findLegacyMemoryArtifacts,
  formatLegacyMemoryMigrationAdvisory,
} from "./metaproject-gitignore";

test("legacy memory migration diagnostics classify paths without mutating them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-memory-migration-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "config", "user.email", "test@example.invalid"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    const artifactRoot = path.join(root, ".metaproject", "data", "memory", "artifacts");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(path.join(artifactRoot, "latest.md"), "user report\n", "utf8");
    await writeFile(path.join(artifactRoot, "latest.json"), "{}\n", "utf8");
    Bun.spawnSync(["git", "add", "--", ".metaproject/data/memory/artifacts/latest.md"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync(["git", "commit", "-qm", "legacy"], { cwd: root, stdout: "ignore", stderr: "ignore" });

    const artifacts = await findLegacyMemoryArtifacts(root);
    expect(artifacts).toEqual([
      { path: ".metaproject/data/memory/artifacts/latest.md", tracked: true },
      { path: ".metaproject/data/memory/artifacts/latest.json", tracked: false },
    ]);
    const advisory = formatLegacyMemoryMigrationAdvisory(artifacts);
    expect(advisory).toContain("tracked legacy reports");
    expect(advisory).toContain("existing legacy reports");
    expect(advisory).toContain("never delete files or mutate the Git index");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
