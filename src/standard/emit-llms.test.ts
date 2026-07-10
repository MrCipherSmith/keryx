import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { emitLlms, renderLlms, validateLlms } from "./emit-llms";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-llms-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("renderLlms emits a valid, deterministic llms.txt", () => {
  const manifest = {
    name: "demo-metaproject",
    standardVersion: "0.1.0",
    modules: {
      gdgraph: { enabled: true, manifest: ".metaproject/modules/gdgraph.md", commands: ["build", "affected"] },
      security: { enabled: false },
    },
  };
  const a = renderLlms(manifest, ["b/artifacts/x.json", "a/artifacts/y.md"]);
  const b = renderLlms(manifest, ["b/artifacts/x.json", "a/artifacts/y.md"]);
  expect(a).toBe(b); // byte-identical re-render (F-2)
  expect(validateLlms(a)).toEqual([]);
  expect(a.startsWith("# demo-metaproject")).toBe(true);
  // Modules and artifacts are sorted for determinism.
  expect(a.indexOf("a/artifacts/y.md")).toBeLessThan(a.indexOf("b/artifacts/x.json"));
  // Disabled modules are omitted (no module link line for security).
  expect(a).not.toContain("modules/security.md");
});

test("emitLlms is deterministic across two runs over the same manifest", async () => {
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      name: "x-metaproject",
      standardVersion: "0.1.0",
      modules: { gdgraph: { enabled: true, manifest: ".metaproject/modules/gdgraph.md" } },
    }),
    "utf8",
  );
  const first = await emitLlms(root);
  const second = await emitLlms(root);
  expect(first.content).toBe(second.content);
  expect(validateLlms(first.content)).toEqual([]);
});

test("validateLlms rejects malformed content", () => {
  expect(validateLlms("no title here\n").length).toBeGreaterThan(0);
  expect(validateLlms("# Title\n> summary\n").length).toBe(0);
});
