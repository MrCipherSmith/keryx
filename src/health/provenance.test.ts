import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { runHealth } from "./run";

test("runHealth writes immutable provenance-aware evidence and latest pointer", async () => {
  const root = path.join(tmpdir(), "keryx-health-provenance-run");
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
  const root = path.join(tmpdir(), "keryx-health-strict-typescript");
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: ["src/**/*.ts"] }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "ok.ts"), "export const ok: number = 1;\n");

  const result = await runHealth({ cwd: root, strict: true, sources: ["typescript"] });
  const source = result.report.sources.find((item) => item.source === "typescript");
  expect(source?.status).toBe("available");
  expect(source?.command).toContain("tsc");
});
