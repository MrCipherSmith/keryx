import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const moduleName = "./service";
test("disabled facade needs no project I/O or scanner", async () => {
  const { createEvidenceService } = await import(moduleName);
  const result = await createEvidenceService({ projectRoot: "/nonexistent-erl-project", scannerFactory: async () => { throw Error("scanner must not run"); } });
  expect(result.ok).toBe(true);
  expect(await result.service.readFile("docs/note")).toEqual({ code: "disabled", diagnostics: ["disabled"] });
  expect(await result.service.readArchive("session")).toEqual({ code: "disabled", diagnostics: ["disabled"] });
});
test("config loading is fail-closed and scope is a private snapshot", async () => {
  const { createEvidenceService, loadEvidenceService } = await import(moduleName);
  const root = await mkdtemp(path.join(tmpdir(), "erl-facade-"));
  try {
    await mkdir(path.join(root, ".metaproject")); await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs/note"), "safe evidence");
    const absent = await loadEvidenceService({ projectRoot: root });
    expect((await absent.service.readFile("docs/note")).code).toBe("disabled");
    await writeFile(path.join(root, ".metaproject/evidence.json"), "{malformed");
    expect((await loadEvidenceService({ projectRoot: root })).ok).toBe(false);
    const config = { schemaVersion: 1, enabled: true, roots: ["docs"] };
    const result = await createEvidenceService({ projectRoot: root, config, scannerFactory: async () => async (text: string) => ({ code: "ok", text, redaction: "not-needed" }) });
    config.roots.push("private");
    expect((await result.service.readFile("private/note")).code).toBe("source-unavailable");
    expect((await result.service.readFile("docs/note")).text).toBe("safe evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});
