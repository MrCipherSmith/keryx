import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SELECT_SKIP_BELOW, readJevSelectEnabled, readJevSelectEnabledDetailed, readJevSelectSkipBelow } from "./jev-select-config";

let ROOT = "";

async function projectRoot(config?: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-select-config-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  if (config !== undefined) {
    await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify(config), "utf8");
  }
  return dir;
}

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

describe("readJevSelectEnabled", () => {
  test("false when the config file is absent", async () => {
    ROOT = await projectRoot();
    expect(await readJevSelectEnabled(ROOT)).toBe(false);
  });

  test("false when review.jev.select is absent or not exactly true", async () => {
    ROOT = await projectRoot({ review: { jev: { select: "true" } } });
    expect(await readJevSelectEnabled(ROOT)).toBe(false);
  });

  test("true when review.jev.select is exactly true", async () => {
    ROOT = await projectRoot({ review: { jev: { select: true } } });
    expect(await readJevSelectEnabled(ROOT)).toBe(true);
  });

  test("false, never throws, on malformed JSON", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-select-config-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "{not json", "utf8");
    expect(await readJevSelectEnabled(ROOT)).toBe(false);
  });
});

describe("Flow 346: select default-on through the shared resolveJevProfileFlag", () => {
  let cfgDir = "";
  afterEach(async () => {
    if (cfgDir) {
      await rm(cfgDir, { recursive: true, force: true });
      cfgDir = "";
    }
  });

  test("unset + external on (default) + a Jev credential available -> defaults to true", async () => {
    ROOT = await projectRoot(undefined);
    cfgDir = await mkdtemp(path.join(tmpdir(), "keryx-jev-select-default-on-cfg-"));
    const result = await readJevSelectEnabledDetailed(ROOT, { jevAvailable: true, configDir: cfgDir });
    expect(result).toEqual({ value: true, source: "default-because-jev-available" });
    expect(await readJevSelectEnabled(ROOT, { jevAvailable: true, configDir: cfgDir })).toBe(true);
  });

  test("unset + external on + NO credential available -> stays false", async () => {
    ROOT = await projectRoot(undefined);
    cfgDir = await mkdtemp(path.join(tmpdir(), "keryx-jev-select-default-on-cfg-"));
    const result = await readJevSelectEnabledDetailed(ROOT, { jevAvailable: false, configDir: cfgDir });
    expect(result).toEqual({ value: false, source: "off" });
  });

  test("the project's own external: \"off\" always wins, even with a credential available", async () => {
    ROOT = await projectRoot({ external: "off" });
    cfgDir = await mkdtemp(path.join(tmpdir(), "keryx-jev-select-default-on-cfg-"));
    const result = await readJevSelectEnabledDetailed(ROOT, { jevAvailable: true, configDir: cfgDir });
    expect(result).toEqual({ value: false, source: "off-by-external" });
  });
});

describe("readJevSelectSkipBelow", () => {
  test("default when absent", async () => {
    ROOT = await projectRoot({ review: { jev: { select: true } } });
    expect(await readJevSelectSkipBelow(ROOT)).toBe(DEFAULT_SELECT_SKIP_BELOW);
  });

  test("reads a configured value in range", async () => {
    ROOT = await projectRoot({ review: { jev: { select: true, select_skip_below: 0.3 } } });
    expect(await readJevSelectSkipBelow(ROOT)).toBe(0.3);
  });

  test("falls back to the default when out of range", async () => {
    ROOT = await projectRoot({ review: { jev: { select_skip_below: 1.5 } } });
    expect(await readJevSelectSkipBelow(ROOT)).toBe(DEFAULT_SELECT_SKIP_BELOW);
  });

  test("falls back to the default when not a number", async () => {
    ROOT = await projectRoot({ review: { jev: { select_skip_below: "0.3" } } });
    expect(await readJevSelectSkipBelow(ROOT)).toBe(DEFAULT_SELECT_SKIP_BELOW);
  });
});
