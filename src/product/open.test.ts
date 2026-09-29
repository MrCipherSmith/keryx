// Flow 362, AC4-AC5: `product open` lists the intents closed in code with no
// observation, each with its flow and outcome criterion or the literal
// `not measured — no instrument stated`, under a header that splits the
// never-checked count three ways.

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { productCommand } from "../commands/product";
import { buildIntentIndex } from "./corpus";
import { FIXTURE_COUNTS, copyFixtureRepo } from "./fixtures/repo";
import { NO_INSTRUMENT, buildOpenReport, loadOpenReport, openHeaderLines, renderOpen } from "./service";
import { writeIntentIndex } from "./store";

const roots: string[] = [];
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

async function indexedRoot(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  await writeIntentIndex(root, await buildIntentIndex(root));
  return root;
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the open list", () => {
  test("holds the closed intents with no observation, newest closing first", async () => {
    const report = buildOpenReport(await buildIntentIndex(await indexedRoot()));
    expect(report.entries.map((entry) => entry.id)).toEqual(["005", "003", "001"]);
    expect(report.neverChecked).toBe(3);
    expect(report.closed).toBe(FIXTURE_COUNTS.closed);
  });

  test("an open flow, a requirements package and an observed flow are not on it", async () => {
    const report = buildOpenReport(await buildIntentIndex(await indexedRoot()));
    const ids = report.entries.map((entry) => entry.id);
    expect(ids).not.toContain("004");
    expect(ids).not.toContain("002");
    expect(ids).not.toContain("alpha-package");
  });

  test("each entry names its outcome criterion, or says none is stated", async () => {
    const report = buildOpenReport(await buildIntentIndex(await indexedRoot()));
    const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
    expect(byId.get("001")?.outcome).toContain("Checkout error rate for expired tokens");
    expect(byId.get("001")?.hasCriterion).toBe(true);
    expect(byId.get("003")?.outcome).toBe("not measured — no instrument stated");
    expect(byId.get("003")?.outcome).toBe(NO_INSTRUMENT);
    expect(byId.get("003")?.hasCriterion).toBe(false);
  });

  test("the header states the never-checked count and its three-way breakdown", async () => {
    const report = buildOpenReport(await buildIntentIndex(await indexedRoot()));
    expect(openHeaderLines(report)).toEqual([
      "intents closed in code, never checked for effect: 3 of 4",
      "  no outcome criterion stated: 2",
      "  criterion stated, never observed: 1",
      "  observed: 1",
    ]);
    expect(report.noCriterion + report.notObserved + report.observed).toBe(report.closed);
  });

  test("the rendered list carries the header, each flow and its outcome", async () => {
    const text = renderOpen(buildOpenReport(await buildIntentIndex(await indexedRoot())));
    const lines = text.split("\n");
    expect(lines[0]).toBe("intents closed in code, never checked for effect: 3 of 4");
    expect(text).toContain("flow 003  Rename the export button");
    expect(text).toContain("outcome: not measured — no instrument stated");
    expect(text).toContain("closed 2026-01-13");
  });

  test("an empty tree prints a zero header and no rows", async () => {
    const root = await copyFixtureRepo();
    roots.push(root);
    await rm(path.join(root, ".metaproject", "flows"), { recursive: true, force: true });
    await writeIntentIndex(root, await buildIntentIndex(root));
    const loaded = await loadOpenReport(root);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.report.neverChecked).toBe(0);
      expect(renderOpen(loaded.report).split("\n")).toHaveLength(4);
    }
  });
});

describe("the command", () => {
  test("`product open --json` prints the report as JSON", async () => {
    const root = await indexedRoot();
    process.chdir(root);
    const logs: string[] = [];
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    await productCommand(["open", "--json"]);
    const parsed = JSON.parse(logs.join("\n")) as { neverChecked: number; entries: unknown[] };
    expect(parsed.neverChecked).toBe(3);
    expect(parsed.entries).toHaveLength(3);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("`product index` reports the count of entries with no intent statement", async () => {
    const root = await copyFixtureRepo();
    roots.push(root);
    process.chdir(root);
    const logs: string[] = [];
    console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    await productCommand(["index"]);
    const output = logs.join("\n");
    expect(output).toContain("Indexed 7 intents (5 flows, 2 requirements packages).");
    expect(output).toContain("entries with no extractable intent statement: 1");
    expect(output).toContain("parse failures: 0");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("an unknown option or an extra argument is refused", async () => {
    const root = await indexedRoot();
    process.chdir(root);
    await expect(productCommand(["open", "--verbose"])).rejects.toThrow("Unknown option");
    await expect(productCommand(["index", "now"])).rejects.toThrow("takes no arguments");
  });
});
