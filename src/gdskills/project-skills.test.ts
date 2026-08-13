import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectSkill } from "./project-skills";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

async function makeProjectRoot(opts: { security?: boolean; mode?: "advisory" | "enforced" | "ci" } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-project-skills-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (opts.security !== undefined) {
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: opts.security } } }),
      "utf8",
    );
  }
  if (opts.mode) {
    await writeFile(path.join(root, ".metaproject", "security.config.json"), JSON.stringify({ mode: opts.mode }), "utf8");
  }
  return root;
}

describe("createProjectSkill security guard", () => {
  test("writes a real SKILL.md when the security module is not enabled (default)", async () => {
    const root = await makeProjectRoot();
    try {
      const result = await createProjectSkill(root, { target: "src/example.ts", module: "example", name: "widget" });
      expect(result.dryRun).toBe(false);
      const written = await readFile(path.join(root, result.skillPath, "SKILL.md"), "utf8");
      expect(written).toContain("Target: src/example.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to write a skill whose rendered content trips the security gate in enforced mode", async () => {
    const root = await makeProjectRoot({ security: true, mode: "enforced" });
    try {
      await expect(
        createProjectSkill(root, { target: `aws_key = ${AWS_KEY}`, module: "example", name: "leaky" }),
      ).rejects.toThrow(/security gate/);
      // Nothing should have been written — the guard runs before any mkdir/write.
      const exists = await readFile(path.join(root, ".metaproject", "project-skills", "example", "leaky", "SKILL.md"), "utf8").then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the same content is allowed when the security module is enabled but advisory (report-only)", async () => {
    const root = await makeProjectRoot({ security: true, mode: "advisory" });
    try {
      const result = await createProjectSkill(root, { target: `aws_key = ${AWS_KEY}`, module: "example", name: "leaky-advisory" });
      expect(result.dryRun).toBe(false);
      const written = await readFile(path.join(root, result.skillPath, "SKILL.md"), "utf8");
      expect(written).toContain(AWS_KEY);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
