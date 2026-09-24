// Flow 309 (W1, Lane A): `src/stack/service.ts` — persistence, fingerprint
// stability, and the `detectedAt`-kept-on-unchanged-content contract.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { readStackDetection, runStackDetect, serializeStackDetection, stackJsonPath } from "./service";

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-stack-service-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("stackJsonPath", () => {
  test("is .metaproject/data/stack/stack.json under the given root", () => {
    expect(stackJsonPath("/repo")).toBe(path.join("/repo", ".metaproject", "data", "stack", "stack.json"));
  });
});

describe("runStackDetect — write and read back", () => {
  test("writes a well-formed document readable by readStackDetection", async () => {
    const root = await makeTempRepo();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));

    const doc = await runStackDetect(root, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    expect(doc.schemaVersion).toBe("1.0.0");
    expect(doc.tags.react).toBe(true);
    expect(doc.detectedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(doc.inputsSha256).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = await readFile(stackJsonPath(root), "utf8");
    expect(onDisk).toBe(serializeStackDetection(doc));
    expect(onDisk.endsWith("\n")).toBe(true);

    const readBack = await readStackDetection(root);
    expect(readBack).toEqual(doc);
  });

  test("--no-write equivalent (write: false) detects without persisting", async () => {
    const root = await makeTempRepo();
    await writeFile(path.join(root, "go.mod"), "module example.com/app\n");
    const doc = await runStackDetect(root, { write: false });
    expect(doc.tags.go).toBe(true);
    const readBack = await readStackDetection(root);
    expect(readBack).toBeUndefined();
  });
});

describe("determinism: unchanged content keeps detectedAt", () => {
  test("a re-run on the same tree writes a byte-identical file with the SAME detectedAt", async () => {
    const root = await makeTempRepo();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3.0.0" } }));

    const first = await runStackDetect(root, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    const firstBytes = await readFile(stackJsonPath(root), "utf8");

    const second = await runStackDetect(root, { now: () => new Date("2099-01-01T00:00:00.000Z") });
    const secondBytes = await readFile(stackJsonPath(root), "utf8");

    expect(second.detectedAt).toBe(first.detectedAt);
    expect(second.inputsSha256).toBe(first.inputsSha256);
    expect(secondBytes).toBe(firstBytes);
  });

  test("changed content gets a new detectedAt", async () => {
    const root = await makeTempRepo();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3.0.0" } }));
    const first = await runStackDetect(root, { now: () => new Date("2026-01-01T00:00:00.000Z") });

    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));
    const second = await runStackDetect(root, { now: () => new Date("2026-02-01T00:00:00.000Z") });

    expect(second.inputsSha256).not.toBe(first.inputsSha256);
    expect(second.detectedAt).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("serializeStackDetection", () => {
  test("2-space indent, trailing newline, sorted keys", async () => {
    const root = await makeTempRepo();
    await mkdir(root, { recursive: true });
    const doc = await runStackDetect(root, { write: false, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const bytes = serializeStackDetection(doc);
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.startsWith("{\n  \"detectedAt\"")).toBe(true); // "detectedAt" sorts before "inputsSha256", "matched", "perSignal", "reason", "schemaVersion", "tags", "uncertain"
  });
});

describe("readStackDetection", () => {
  test("undefined for a missing file", async () => {
    const root = await makeTempRepo();
    expect(await readStackDetection(root)).toBeUndefined();
  });

  test("undefined for an unparseable file", async () => {
    const root = await makeTempRepo();
    await mkdir(path.dirname(stackJsonPath(root)), { recursive: true });
    await writeFile(stackJsonPath(root), "{ not json", "utf8");
    expect(await readStackDetection(root)).toBeUndefined();
  });
});
