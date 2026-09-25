// flow 333, AC5: `readJevDocsEnabled` — absent/unparsable reads false, never throws.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJevDocsEnabled } from "./jev-docs-config";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

describe("AC5: readJevDocsEnabled", () => {
  test("no config file: false", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-docs-config-"));
    expect(await readJevDocsEnabled(ROOT)).toBe(false);
  });

  test("review.jev.docs: true reads true", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-docs-config-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { docs: true } } }), "utf8");
    expect(await readJevDocsEnabled(ROOT)).toBe(true);
  });

  test("a sibling key (review.jev.rules) does not enable docs", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-docs-config-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { rules: true } } }), "utf8");
    expect(await readJevDocsEnabled(ROOT)).toBe(false);
  });

  test("unparsable JSON reads false, never throws", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-docs-config-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "{not json", "utf8");
    expect(await readJevDocsEnabled(ROOT)).toBe(false);
  });
});
