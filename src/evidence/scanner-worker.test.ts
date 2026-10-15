import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runEvidenceScan } from "./scanner-runner";
import { createEvidenceScanner, readEvidenceFile } from "./sources";
test("deadline terminates a worker even if synchronous detector never returns", async () => {
  const worker = new Worker(new URL("./scanner-hang.fixture.ts", import.meta.url));
  const controller = new AbortController(); let exited = false;
  worker.once("exit", () => { exited = true; });
  const timer = setTimeout(() => controller.abort(), 100);
  try { expect(await runEvidenceScan(worker, controller.signal)).toEqual({ code: "blocked" }); expect(exited).toBe(true); }
  finally { clearTimeout(timer); await worker.terminate(); }
});
test("production scanner executes in worker and sanitized bytes only return", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-worker-"));
  try {
    await mkdir(path.join(root, ".metaproject")); await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, ".metaproject/metaproject.json"), JSON.stringify({ modules: { security: { enabled: true } } }));
    await writeFile(path.join(root, "docs/note"), "Ordinary evidence text.");
    const scanner = await createEvidenceScanner(root); expect(scanner).toBeDefined();
    if (!scanner) throw new Error("fixture scanner unavailable");
    const result = await readEvidenceFile({ projectRoot: root, path: "docs/note", roots: ["docs"], maxSourceBytes: 4096, scanner });
    expect(result.code).toBe("ok"); if (result.code === "ok") expect(result.text).toBe("Ordinary evidence text.");
  } finally { await rm(root, { recursive: true, force: true }); }
});
