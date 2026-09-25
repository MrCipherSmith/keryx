// flow 332 (AC5): `readJevScenariosEnabled` — fail-closed reading of
// `review.jev.scenarios`, same shape `readJevRiskEnabled` uses for its own
// sibling key.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJevScenariosEnabled } from "./jev-scenarios-config";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function projectRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-scenarios-config-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  return dir;
}

describe("readJevScenariosEnabled", () => {
  test("no config file: false, never throws", async () => {
    ROOT = await projectRoot();
    expect(await readJevScenariosEnabled(ROOT)).toBe(false);
  });

  test("malformed JSON: false, never throws", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "{not json", "utf8");
    expect(await readJevScenariosEnabled(ROOT)).toBe(false);
  });

  test("review.jev.scenarios: true -> true", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { scenarios: true } } }), "utf8");
    expect(await readJevScenariosEnabled(ROOT)).toBe(true);
  });

  test("a sibling key (risk) being true does not enable scenarios", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { risk: true } } }), "utf8");
    expect(await readJevScenariosEnabled(ROOT)).toBe(false);
  });
});
