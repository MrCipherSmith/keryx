// flow 335 (AC7): `readJevContractEnabled` — fail-closed reading of
// `review.jev.contract`, same shape `readJevRiskEnabled`/`readJevScenariosEnabled`
// use for their own sibling keys.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJevContractEnabled } from "./jev-contract-config";

let ROOT = "";

afterEach(async () => {
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function projectRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-contract-config-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  return dir;
}

describe("readJevContractEnabled", () => {
  test("no config file: false, never throws", async () => {
    ROOT = await projectRoot();
    expect(await readJevContractEnabled(ROOT)).toBe(false);
  });

  test("malformed JSON: false, never throws", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "{not json", "utf8");
    expect(await readJevContractEnabled(ROOT)).toBe(false);
  });

  test("review.jev.contract: true -> true", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { contract: true } } }), "utf8");
    expect(await readJevContractEnabled(ROOT)).toBe(true);
  });

  test("a sibling key (risk) being true does not enable contract", async () => {
    ROOT = await projectRoot();
    await writeFile(path.join(ROOT, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { risk: true } } }), "utf8");
    expect(await readJevContractEnabled(ROOT)).toBe(false);
  });
});
