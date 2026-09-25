// flow 332 (AC5): `readJevRiskEnabled` — fail-closed reading of
// `review.jev.risk`, same shape `readJevScenariosEnabled`/flow 330's
// `readJevRulesEnabled` use for their own sibling keys.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJevRiskEnabled } from "./jev-risk-config";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function projectRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-risk-config-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  return dir;
}

describe("readJevRiskEnabled", () => {
  test("no config file: false, never throws", async () => {
    ROOT = await projectRoot();
    expect(await readJevRiskEnabled(ROOT)).toBe(false);
  });

  test("malformed JSON: false, never throws", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "{not json", "utf8");
    expect(await readJevRiskEnabled(ROOT)).toBe(false);
  });

  test("review.jev.risk: true -> true", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { risk: true } } }), "utf8");
    expect(await readJevRiskEnabled(ROOT)).toBe(true);
  });

  test("a sibling key (scenarios) being true does not enable risk", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { scenarios: true } } }), "utf8");
    expect(await readJevRiskEnabled(ROOT)).toBe(false);
  });
});
