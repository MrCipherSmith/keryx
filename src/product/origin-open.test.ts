// Flow 390, AC3 — the origin of a flow (agent-finding, agent-proposal, human-request)
// is carried by the product index and shown by `product open`; a flow without one
// reads unknown, and an index written before the field existed stays valid.

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

async function setOrigin(root: string, dir: string, origin: unknown): Promise<void> {
  const file = path.join(root, ".metaproject", "flows", dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  raw["origin"] = origin;
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

const STATED = "001-2026-01-01-stated-outcome";
const NO_CRITERION = "003-2026-01-03-no-criterion";
const QUOTE = "каждый раз, когда создаётся flow, агент определяет «откуда он»";

describe("the origin on an intent", () => {
  test("a flow without the field reads unknown and its intent carries no origin key", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    for (const intent of index.intents.filter((entry) => entry.source === "flow")) {
      expect(intent.origin).toBeUndefined();
      expect("origin" in intent).toBe(false);
    }
  });

  test("a flow that records an origin is indexed with kind, quote and source", async () => {
    const root = await fixtureRoot();
    await setOrigin(root, STATED, { kind: "human-request", quote: QUOTE, source: "chat 7" });
    await setOrigin(root, NO_CRITERION, { kind: "agent-finding", source: "review-pr" });
    const index = await buildIntentIndex(root);
    const byId = new Map(index.intents.map((intent) => [intent.id, intent]));
    expect(byId.get("001")?.origin).toEqual({ kind: "human-request", quote: QUOTE, source: "chat 7" });
    expect(byId.get("003")?.origin).toEqual({ kind: "agent-finding", source: "review-pr" });
    expect(byId.get("002")?.origin).toBeUndefined();
  });

  test("a malformed origin in flow.json reads unknown and does not fail the flow", async () => {
    const root = await fixtureRoot();
    await setOrigin(root, STATED, { kind: "robot" });
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual([]);
    expect(index.intents.find((intent) => intent.id === "001")?.origin).toBeUndefined();
  });
});

describe("the fingerprint covers the origin", () => {
  test("changing a flow's origin after indexing makes the index stale", async () => {
    const root = await fixtureRoot();
    const index = await buildIntentIndex(root);
    await writeIntentIndex(root, index);
    expect(await checkStaleness(root, index)).toEqual({ stale: false });
    await setOrigin(root, STATED, { kind: "agent-proposal", source: "design talk" });
    expect((await checkStaleness(root, index)).stale).toBe(true);
  });
});

describe("an index written before the field existed", () => {
  test("stays valid and reads unknown", async () => {
    const root = await fixtureRoot();
    await writeIntentIndex(root, await buildIntentIndex(root));
    const read = await readIntentIndex(root);
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    for (const entry of buildOpenReport(read.index).entries) expect(entry.origin).toBe("unknown");
  });

  test("an origin kind that is not one of the three makes the index malformed", async () => {
    const root = await fixtureRoot();
    await writeIntentIndex(root, await buildIntentIndex(root));
    const parsed = JSON.parse(await readFile(indexPath(root), "utf8")) as { intents: Record<string, unknown>[] };
    const first = parsed.intents[0];
    if (first === undefined) throw new Error("fixture index holds no intents");
    first["origin"] = { kind: "robot" };
    await writeFile(indexPath(root), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    expect((await readIntentIndex(root)).state).toBe("malformed");
  });
});

describe("product open shows the origin", () => {
  test.each([
    ["agent-finding", { kind: "agent-finding", source: "lint run 12" }, "origin: agent-finding", "source: lint run 12"],
    ["agent-proposal", { kind: "agent-proposal", source: "design talk" }, "origin: agent-proposal", "source: design talk"],
  ] as const)("an entry with %s prints its kind and source", async (_label, origin, kindLine, sourceLine) => {
    const root = await fixtureRoot();
    await setOrigin(root, STATED, origin);
    const report = buildOpenReport(await buildIntentIndex(root));
    const entry = report.entries.find((candidate) => candidate.id === "001");
    if (entry === undefined) throw new Error("flow 001 is not on the open list");
    expect(entry.origin).toBe(origin.kind);
    const text = openEntryLines(entry).join("\n");
    expect(text).toContain(kindLine);
    expect(text).toContain(sourceLine);
    expect(renderOpen(report)).toContain(kindLine);
  });

  test("a human-request prints the verbatim quote, and a flow without one prints origin: unknown", async () => {
    const root = await fixtureRoot();
    await setOrigin(root, STATED, { kind: "human-request", quote: QUOTE, source: "chat 7" });
    const report = buildOpenReport(await buildIntentIndex(root));
    const rendered = renderOpen(report);
    expect(rendered).toContain("origin: human-request");
    expect(rendered).toContain(`«${QUOTE}»`);
    expect(rendered).toContain("source: chat 7");
    expect(rendered).toContain("origin: unknown");
  });

  test("the origin changes neither the list nor the counts", async () => {
    const root = await fixtureRoot();
    const before = buildOpenReport(await buildIntentIndex(root));
    await setOrigin(root, STATED, { kind: "agent-finding", source: "ci" });
    const after = buildOpenReport(await buildIntentIndex(root));
    expect(after.entries.map((entry) => entry.id)).toEqual(before.entries.map((entry) => entry.id));
    const strip = (report: typeof after) => ({ ...report, entries: [], g1a: undefined });
    expect(strip(after)).toEqual(strip(before));
  });
});
