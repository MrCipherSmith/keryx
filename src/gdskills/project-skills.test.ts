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

  test("advisory mode allows the write but persists only the redacted representation", async () => {
    const root = await makeProjectRoot({ security: true, mode: "advisory" });
    try {
      const result = await createProjectSkill(root, { target: `aws_key = ${AWS_KEY}`, module: "example", name: "leaky-advisory" });
      expect(result.dryRun).toBe(false);
      const written = await readFile(path.join(root, result.skillPath, "SKILL.md"), "utf8");
      expect(written).not.toContain(AWS_KEY);
      expect(written).toContain("[REDACTED:secret]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("createProjectSkill refuses a prose target on the CLI path, not only the wrap-up path", () => {
  // The routable-target guard was added after two prose-target skills reached
  // `main`, and wired into `skill-owner-writer` alone. `keryx skills create` —
  // the path `reviewer-skill-creator` tells agents to use — never called it, so
  // the entry point most likely to be handed a sentence was the unguarded one.
  //
  // `--dry-run` is asserted too: the refusal must come BEFORE any inference or
  // write, otherwise a rejected target could still leave a slug derived from
  // prose behind.
  return (async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-prose-target-"));
    await mkdir(path.join(root, ".metaproject"), { recursive: true });

    const prose = "This is a wrap-up summary, not a target.";
    await expect(createProjectSkill(root, { target: prose, module: "review", name: "prose-test" }))
      .rejects.toThrow(/reads as prose, not a routing key/);
    await expect(createProjectSkill(root, { target: prose, module: "review", name: "prose-test", dryRun: true }))
      .rejects.toThrow(/reads as prose, not a routing key/);

    // And the shapes a target legitimately takes still pass: a concept, a symbol
    // and a path. A guard that rejected these would be excepted on first honest
    // use and then deleted.
    for (const target of ["auth flow", "IResultDqReport", "src/dq/components/DqScoreCard.tsx"]) {
      const result = await createProjectSkill(root, { target, module: "review", name: `ok-${target.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, dryRun: true });
      expect(result).toBeTruthy();
    }
  })();
});
