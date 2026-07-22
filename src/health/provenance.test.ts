import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { runHealth } from "./run";
import { uniqueTestRoot } from "../lib/test-tmp";

// Write a hermetic no-op `tsc` into <root>/node_modules/.bin so the health
// runner resolves a compiler deterministically, independent of whether the host
// has TypeScript on PATH. Exits 0 with no output → zero findings → "available".
async function stubLocalBin(root: string, name: string): Promise<void> {
  const binDir = path.join(root, "node_modules", ".bin");
  await mkdir(binDir, { recursive: true });
  const binPath = path.join(binDir, name);
  await writeFile(binPath, "#!/bin/sh\nexit 0\n");
  await chmod(binPath, 0o755);
}

test("runHealth writes immutable provenance-aware evidence and latest pointer", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-provenance-run");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });

  await runHealth({ cwd: root, sources: [], runId: "run-health-provenance" });

  const record = JSON.parse(await readFile(
    path.join(root, ".metaproject", "data", "health", "artifacts", "runs", "run-health-provenance.json"),
    "utf8",
  ));
  const latest = JSON.parse(await readFile(
    path.join(root, ".metaproject", "data", "health", "artifacts", "latest.json"),
    "utf8",
  ));
  expect(record.runId).toBe("run-health-provenance");
  expect(record.provenance).toBeDefined();
  expect(latest.run_id).toBe("run-health-provenance");
  expect(latest.record).toContain("runs/run-health-provenance.json");
});

test("strict health runs an available compiler instead of treating missing import format as missing source", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-health-strict-typescript");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ["src/**/*.ts"] }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "ok.ts"), "export const ok: number = 1;\n");
  await stubLocalBin(root, "tsc");

  const result = await runHealth({ cwd: root, strict: true, sources: ["typescript"] });
  const source = result.report.sources.find((item) => item.source === "typescript");
  expect(source?.status).toBe("available");
  expect(source?.command).toContain("tsc");
});
