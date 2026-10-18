import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  MAX_BYTES_CEILING,
  MAX_BYTES_FLOOR,
  readProjectContextConfig,
  resolveMaxBytes,
  writeProjectContextEnforcement,
  writeProjectContextMaxBytes,
} from "./project-context-config";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(config?: unknown | string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-project-context-config-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (config !== undefined) {
    await writeFile(path.join(root, ".metaproject/tasks.config.json"), typeof config === "string" ? config : JSON.stringify(config), "utf8");
  }
  return root;
}

test("a project with no config file reads the defaults and writes nothing", async () => {
  const root = await project();
  const config = await readProjectContextConfig(root);
  expect(config).toEqual({ enforcement: "warn", enforcementSource: "default", maxBytes: DEFAULT_MAX_BYTES, maxBytesSource: "default", warnings: [] });
  expect(DEFAULT_MAX_BYTES).toBe(131072);
});

test("enforcement reads warn and block; an unknown value reads as warn and warns", async () => {
  const block = await readProjectContextConfig(await project({ gdskills: { projectContext: { enforcement: "block" } } }));
  expect(block.enforcement).toBe("block");
  expect(block.enforcementSource).toBe("config");

  const unknown = await readProjectContextConfig(await project({ gdskills: { projectContext: { enforcement: "strict" } } }));
  expect(unknown.enforcement).toBe("warn");
  expect(unknown.enforcementSource).toBe("default");
  expect(unknown.warnings.join("\n")).toContain("enforcement");
});

test("maxBytes accepts the bounds and rejects everything outside them", async () => {
  for (const ok of [MAX_BYTES_FLOOR, 40960, MAX_BYTES_CEILING]) {
    const config = await readProjectContextConfig(await project({ gdskills: { projectContext: { maxBytes: ok } } }));
    expect(config.maxBytes).toBe(ok);
    expect(config.maxBytesSource).toBe("config");
    expect(config.warnings).toEqual([]);
  }
  for (const bad of [MAX_BYTES_FLOOR - 1, MAX_BYTES_CEILING + 1, 0, -5, 1.5, "65536", null, Number.NaN]) {
    const config = await readProjectContextConfig(await project({ gdskills: { projectContext: { maxBytes: bad } } }));
    expect(config.maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(config.maxBytesSource).toBe("default");
    expect(config.warnings.join("\n")).toContain("maxBytes");
  }
});

test("an unreadable or non-object config reads as the defaults without throwing", async () => {
  for (const content of ["{not json", "[]", "null", '{"gdskills": 3}', '{"gdskills": {"projectContext": []}}']) {
    const config = await readProjectContextConfig(await project(content));
    expect(config.enforcement).toBe("warn");
    expect(config.maxBytes).toBe(DEFAULT_MAX_BYTES);
  }
});

test("resolveMaxBytes lets the flag win, then the config, then the default, and names the source", async () => {
  const root = await project({ gdskills: { projectContext: { maxBytes: 65536 } } });
  expect(await resolveMaxBytes(root, 8192)).toEqual({ limitBytes: 8192, limitSource: "flag", warnings: [] });
  expect(await resolveMaxBytes(root, undefined)).toEqual({ limitBytes: 65536, limitSource: "config", warnings: [] });
  const bare = await project();
  expect(await resolveMaxBytes(bare, undefined)).toEqual({ limitBytes: DEFAULT_MAX_BYTES, limitSource: "default", warnings: [] });
});

test("an invalid --max-bytes flag falls back to the configured cap and warns", async () => {
  const root = await project({ gdskills: { projectContext: { maxBytes: 65536 } } });
  for (const flag of [100, 5_000_000, 2.5]) {
    const result = await resolveMaxBytes(root, flag);
    expect(result.limitBytes).toBe(65536);
    expect(result.limitSource).toBe("config");
    expect(result.warnings.join("\n")).toContain("--max-bytes");
  }
});

test("writes keep every other key and create the block when it is missing", async () => {
  const root = await project({ review: { jev: { edit_guard: true } }, gdskills: { other: 1 } });
  await writeProjectContextEnforcement(root, "block");
  await writeProjectContextMaxBytes(root, 65536);
  const written = JSON.parse(await readFile(path.join(root, ".metaproject/tasks.config.json"), "utf8"));
  expect(written.review.jev.edit_guard).toBe(true);
  expect(written.gdskills.other).toBe(1);
  expect(written.gdskills.projectContext).toEqual({ enforcement: "block", maxBytes: 65536 });
  expect((await readProjectContextConfig(root)).enforcement).toBe("block");
});

test("a write creates the file when there is none", async () => {
  const root = await project();
  await writeProjectContextEnforcement(root, "block");
  expect((await readProjectContextConfig(root)).enforcement).toBe("block");
});

test("a write refuses to overwrite a config file that is not valid JSON", async () => {
  const root = await project("{broken");
  await expect(writeProjectContextEnforcement(root, "block")).rejects.toThrow("not valid JSON");
  expect(await readFile(path.join(root, ".metaproject/tasks.config.json"), "utf8")).toBe("{broken");
});

test("a write refuses an out-of-range cap", async () => {
  const root = await project();
  await expect(writeProjectContextMaxBytes(root, 100)).rejects.toThrow("4096");
});
