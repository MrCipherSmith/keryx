import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ingestMemory } from "./ingest";
import { DEFAULT_MEMORY_CONFIG } from "./config";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_LESSON = `Never hardcode aws_key = ${AWS_KEY} in the config loader`;

async function scaffold(opts: { security?: boolean; mode?: string }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-mem-seam-"));
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
  await writeFile(
    path.join(root, "lessons.json"),
    JSON.stringify({ findings: [{ message: SECRET_LESSON }] }),
    "utf8",
  );
  return root;
}

async function createdFiles(root: string): Promise<string[]> {
  const dir = path.join(root, ".metaproject", "memory", "lessons");
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

test("advisory memory ingest writes the entry unchanged vs security-off", async () => {
  const off = await scaffold({ security: false });
  const advisory = await scaffold({ security: true, mode: "advisory" });
  try {
    const offResult = await ingestMemory(off, "review", "lessons.json", DEFAULT_MEMORY_CONFIG, new Date("2026-07-07"));
    const advResult = await ingestMemory(advisory, "review", "lessons.json", DEFAULT_MEMORY_CONFIG, new Date("2026-07-07"));

    // Advisory writes exactly what security-off writes.
    expect(offResult.created.length).toBe(1);
    expect(advResult.created).toEqual(offResult.created);
    expect((await createdFiles(advisory)).length).toBe(1);
    // Advisory must never block.
    expect(advResult.securitySkipped).toBeUndefined();
    // But it may surface a leak-safe warning.
    expect(advResult.securityWarnings?.some((w) => w.includes("secret"))).toBe(true);
    expect(JSON.stringify(advResult)).not.toContain(AWS_KEY);
  } finally {
    await rm(off, { recursive: true, force: true });
    await rm(advisory, { recursive: true, force: true });
  }
});

test("enforced memory ingest suppresses the entry containing a secret", async () => {
  const root = await scaffold({ security: true, mode: "enforced" });
  try {
    const result = await ingestMemory(root, "review", "lessons.json", DEFAULT_MEMORY_CONFIG, new Date("2026-07-07"));
    expect(result.created.length).toBe(0);
    expect(result.securitySkipped?.length).toBe(1);
    expect(result.securitySkipped?.[0]?.reason).not.toContain(AWS_KEY);
    // Nothing was written to disk.
    expect((await createdFiles(root)).length).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
