// Flow 365, AC4: the index carries who wrote each flow's outcome criterion. It is read from
// flow.json through the flow facade, covered by the fingerprint, optional in index.json (an index
// written before the field existed stays valid), and shown by `product open`.

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildIntentIndex } from "./corpus";
import { copyFixtureRepo } from "./fixtures/repo";
import { buildOpenReport, checkStaleness, indexPath, openEntryLines, readIntentIndex, renderOpen, writeIntentIndex } from "./service";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixtureRoot(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

async function setAuthor(root: string, dir: string, author: string): Promise<void> {
  const file = path.join(root, ".metaproject", "flows", dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw["outcomeAuthor"] = author;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

const STATED = "001-2026-01-01-stated-outcome";
const NO_CRITERION = "003-2026-01-03-no-criterion";

describe("the author on an intent", () => {
  test("a flow without the field reads unknown; a requirements package carries none", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    for (const intent of index.intents.filter((entry) => entry.source === "flow")) {
      expect(intent.outcomeAuthor).toBe("unknown");
    }
    for (const intent of index.intents.filter((entry) => entry.source === "docpack")) {
      expect(intent.outcomeAuthor).toBeUndefined();
    }
  });

  test("a flow that records agent or human is indexed with that value", async () => {
    const root = await fixtureRoot();
    await setAuthor(root, STATED, "human");
    await setAuthor(root, NO_CRITERION, "agent");
    const index = await buildIntentIndex(root);
    const byId = new Map(index.intents.map((intent) => [intent.id, intent]));
    expect(byId.get("001")?.outcomeAuthor).toBe("human");
    expect(byId.get("003")?.outcomeAuthor).toBe("agent");
    expect(byId.get("002")?.outcomeAuthor).toBe("unknown");
  });

  test("a malformed value in flow.json reads unknown and does not fail the flow", async () => {
    const root = await fixtureRoot();
    await setAuthor(root, STATED, "robot");
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual([]);
    expect(index.intents.find((intent) => intent.id === "001")?.outcomeAuthor).toBe("unknown");
  });
});

describe("the fingerprint covers the author", () => {
  test("changing a flow's author after indexing makes the index stale", async () => {
    const root = await fixtureRoot();
    const index = await buildIntentIndex(root);
    await writeIntentIndex(root, index);
    expect(await checkStaleness(root, index)).toEqual({ stale: false });
    await setAuthor(root, STATED, "human");
    expect((await checkStaleness(root, index)).stale).toBe(true);
  });
});

describe("an index written before the field existed", () => {
  test("stays valid and reads unknown", async () => {
    const root = await fixtureRoot();
    await writeIntentIndex(root, await buildIntentIndex(root));
    const parsed = JSON.parse(await readFile(indexPath(root), "utf8")) as { intents: Record<string, unknown>[] };
    for (const intent of parsed.intents) delete intent["outcomeAuthor"];
    await writeFile(indexPath(root), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const read = await readIntentIndex(root);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    const report = buildOpenReport(read.index);
    expect(report.entries.length).toBeGreaterThan(0);
    for (const entry of report.entries) expect(entry.outcomeAuthor).toBe("unknown");
  });

  test("a value that is not agent, human or unknown makes the index malformed", async () => {
    const root = await fixtureRoot();
    await writeIntentIndex(root, await buildIntentIndex(root));
    const parsed = JSON.parse(await readFile(indexPath(root), "utf8")) as { intents: Record<string, unknown>[] };
    const first = parsed.intents[0];
    if (first === undefined) throw new Error("fixture index holds no intents");
    first["outcomeAuthor"] = "robot";
    await writeFile(indexPath(root), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    const read = await readIntentIndex(root);
    expect(read.state).toBe("malformed");
    if (read.state === "malformed") expect(read.reason).toContain("outcome author");
  });
});

describe("product open shows the author", () => {
  test("each entry carries the author and prints it on its own line", async () => {
    const root = await fixtureRoot();
    await setAuthor(root, STATED, "human");
    const report = buildOpenReport(await buildIntentIndex(root));
    const byId = new Map(report.entries.map((entry) => [entry.id, entry]));
    const human = byId.get("001");
    if (human === undefined) throw new Error("flow 001 is not on the open list");
    expect(human.outcomeAuthor).toBe("human");
    expect(byId.get("003")?.outcomeAuthor).toBe("unknown");
    expect(openEntryLines(human).join("\n")).toContain("outcome author: human");
    expect(renderOpen(report)).toContain("outcome author: unknown");
  });

  test("the author changes neither the list nor the counts", async () => {
    const root = await fixtureRoot();
    const before = buildOpenReport(await buildIntentIndex(root));
    await setAuthor(root, STATED, "human");
    await setAuthor(root, NO_CRITERION, "agent");
    const after = buildOpenReport(await buildIntentIndex(root));
    expect(after.entries.map((entry) => entry.id)).toEqual(before.entries.map((entry) => entry.id));
    expect({ ...after, entries: [] }).toEqual({ ...before, entries: [] });
  });
});
