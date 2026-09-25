// flow 333, AC5: `readJevCommentsEnabled` — absent/unparsable reads false, never throws.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJevCommentsEnabled } from "./jev-comments-config";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

describe("AC5: readJevCommentsEnabled", () => {
  test("no config file: false", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-comments-config-"));
    expect(await readJevCommentsEnabled(ROOT)).toBe(false);
  });

  test("review.jev.comments: true reads true", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-comments-config-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { comments: true } } }), "utf8");
    expect(await readJevCommentsEnabled(ROOT)).toBe(true);
  });

  test("a sibling key (review.jev.docs) does not enable comments", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-comments-config-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { docs: true } } }), "utf8");
    expect(await readJevCommentsEnabled(ROOT)).toBe(false);
  });

  test("unparsable JSON reads false, never throws", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-comments-config-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "{not json", "utf8");
    expect(await readJevCommentsEnabled(ROOT)).toBe(false);
  });
});
