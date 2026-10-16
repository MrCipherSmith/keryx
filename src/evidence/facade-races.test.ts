import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidenceService } from "./service";
import { readEvidenceFile } from "./sources";
const clean = async (text: string) => ({ code: "ok" as const, text, redaction: "not-needed" as const });
test("facade pins original project identity", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "erl-owner-")), root = path.join(parent, "project");
  try {
    await mkdir(path.join(root, "docs"), { recursive: true }); await writeFile(path.join(root, "docs/note"), "original");
    const result = await createEvidenceService({ projectRoot: root, config: { schemaVersion: 1, enabled: true, roots: ["docs"] }, scannerFactory: async () => clean });
    if (!result.ok) throw Error("construction");
    await rename(root, path.join(parent, "old")); await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs/note"), "foreign");
    expect((await result.service.readSourceFile("docs/note")).code).toBe("source-unavailable");
  } finally { await rm(parent, { recursive: true, force: true }); }
});
for (const mutation of ["rewrite", "delete", "replace-parent"]) test(`file revalidates after scan: ${mutation}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-file-"));
  try {
    await mkdir(path.join(root, "docs")); await writeFile(path.join(root, "docs/note"), "original");
    const result = await readEvidenceFile({ projectRoot: root, path: "docs/note", roots: ["docs"], maxSourceBytes: 4096, scanner: async text => {
      if (mutation === "rewrite") await writeFile(path.join(root, "docs/note"), "changed");
      if (mutation === "delete") await rm(path.join(root, "docs/note"));
      if (mutation === "replace-parent") { await rename(path.join(root, "docs"), path.join(root, "old")); await mkdir(path.join(root, "docs")); await writeFile(path.join(root, "docs/note"), text); }
      return clean(text);
    } }); expect(result.code).toBe("source-unavailable"); expect("text" in result).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("hanging scanner initialization is bounded", async () => {
  const result = await createEvidenceService({ projectRoot: tmpdir(), config: { schemaVersion: 1, enabled: true, timeoutMs: 20 }, scannerFactory: () => new Promise(() => {}) });
  if (!result.ok) throw Error("construction"); expect((await Promise.race([result.service.readSourceFile("docs/note"), new Promise<{ code: string }>(resolve => setTimeout(() => resolve({ code: "hung" }), 200))])).code).toBe("timeout");
});
test("pre-cancelled facade performs no scanner initialization", async () => {
  let calls = 0;
  const result = await createEvidenceService({ projectRoot: tmpdir(), config: { schemaVersion: 1, enabled: true }, scannerFactory: async () => { calls++; return clean; } });
  if (!result.ok) throw Error("construction");
  const controller = new AbortController(); controller.abort();
  const answer = await result.service.readSourceFile("docs/note", controller.signal);
  expect(answer.code).toBe("timeout"); expect("text" in answer).toBe(false); expect(calls).toBe(0);
});
test("cancellation aborts pending factory and withholds its late success", async () => {
  let factorySignal: AbortSignal | undefined;
  let release!: (scanner: typeof clean) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const result = await createEvidenceService({ projectRoot: tmpdir(), config: { schemaVersion: 1, enabled: true }, scannerFactory: async (_root, signal) => {
    factorySignal = signal; started(); return new Promise<typeof clean>(resolve => { release = resolve; });
  } });
  if (!result.ok) throw Error("construction");
  const controller = new AbortController();
  const pending = result.service.readSourceFile("docs/note", controller.signal);
  await ready; controller.abort();
  const answer = await pending;
  expect(answer.code).toBe("timeout"); expect("text" in answer).toBe(false); expect(factorySignal?.aborted).toBe(true);
  release(clean); await Promise.resolve();
  expect(answer.code).toBe("timeout");
});
test("cancellation aborts pending scanner and never returns late text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "erl-cancel-"));
  try {
    await mkdir(path.join(root, "docs")); await writeFile(path.join(root, "docs/note"), "private evidence");
    let scannerSignal: AbortSignal | undefined;
    let release!: (value: Awaited<ReturnType<typeof clean>>) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const result = await createEvidenceService({ projectRoot: root, config: { schemaVersion: 1, enabled: true, roots: ["docs"] }, scannerFactory: async () => async (_text, signal) => {
      scannerSignal = signal; started(); return new Promise<Awaited<ReturnType<typeof clean>>>(resolve => { release = resolve; });
    } });
    if (!result.ok) throw Error("construction");
    const controller = new AbortController();
    const pending = result.service.readSourceFile("docs/note", controller.signal);
    await ready; controller.abort();
    const answer = await pending;
    expect(answer.code).toBe("timeout"); expect("text" in answer).toBe(false); expect(scannerSignal?.aborted).toBe(true);
    release(await clean("private evidence")); await Promise.resolve();
    expect("text" in answer).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
