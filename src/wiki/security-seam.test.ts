import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { wikiCollect } from "./service";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

// A workspace whose testing context embeds a secret, so the collected
// "testing-map" draft page carries the secret through the wiki write seam.
async function scaffold(opts: { security?: boolean; mode?: string }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-wiki-seam-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (opts.security !== undefined) {
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: opts.security } } }),
      "utf8",
    );
  }
  if (opts.mode) {
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ mode: opts.mode }),
      "utf8",
    );
  }
  const testingDir = path.join(root, ".metaproject", "data", "testing");
  await mkdir(testingDir, { recursive: true });
  await writeFile(
    path.join(testingDir, "context.md"),
    `# Testing Context\n\nRunner exported aws_key = ${AWS_KEY}\n\n## Patterns\n\n- colocated tests\n`,
    "utf8",
  );
  return root;
}

const TESTING_MAP = path.join(".metaproject", "wiki", "architecture", "testing-map.md");

test("advisory wiki collect writes the draft page unchanged vs security-off", async () => {
  const off = await scaffold({ security: false });
  const advisory = await scaffold({ security: true, mode: "advisory" });
  try {
    const offResult = await wikiCollect({ cwd: off });
    const advResult = await wikiCollect({ cwd: advisory });

    expect(offResult.created).toBe(1);
    expect(advResult.created).toBe(1);
    expect(await pathExists(path.join(advisory, TESTING_MAP))).toBe(true);
    expect(advResult.pages.every((p) => p.securityReason === undefined)).toBe(true);
  } finally {
    await rm(off, { recursive: true, force: true });
    await rm(advisory, { recursive: true, force: true });
  }
});

test("enforced wiki collect suppresses a draft page containing a secret", async () => {
  const root = await scaffold({ security: true, mode: "enforced" });
  try {
    const result = await wikiCollect({ cwd: root });
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    const page = result.pages.find((p) => p.path.endsWith("testing-map.md"));
    expect(page?.action).toBe("skipped");
    expect(page?.securityReason).toBeDefined();
    expect(page?.securityReason).not.toContain(AWS_KEY);
    // The page was never written to disk.
    expect(await pathExists(path.join(root, TESTING_MAP))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
