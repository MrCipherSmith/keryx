import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SELECT_SKIP_BELOW, readJevSelectEnabled, readJevSelectSkipBelow } from "./jev-select-config";

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
