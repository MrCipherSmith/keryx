// Flow 362, AC1: the intent index reads every flow and requirements package
// it can see with zero failures, orders them stably, is byte-identical on a
// second run, and reports how many entries state no intent.
//
// The corpus test comes first and never passes on zero input: the repo's own
// `.metaproject/flows/` when it is present, and the checked-in fixture set
// under `src/product/fixtures/corpus/` always.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildIntentIndex } from "./corpus";
import { extractFlowIntent, sectionOf, statementFrom } from "./extract";
import { FIXTURE_COUNTS, copyFixtureRepo } from "./fixtures/repo";
import { indexPath, serializeIndex, writeIntentIndex } from "./store";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const REAL_FLOWS = path.join(REPO_ROOT, ".metaproject", "flows");

function flowDirectories(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^\d+-/.test(entry.name)).map((entry) => entry.name) : [];
}

const realFlowCount = flowDirectories(REAL_FLOWS).length;
const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("corpus", () => {
  test("the checked-in fixture set parses with no failure and every flow is seen", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    expect(index.failures).toEqual([]);
    expect(index.counts.flows).toBe(FIXTURE_COUNTS.flows);
    expect(index.counts.docpacks).toBe(FIXTURE_COUNTS.docpacks);
    expect(index.intents.length).toBe(FIXTURE_COUNTS.intents);
    expect(index.counts.intents).toBe(FIXTURE_COUNTS.intents);
    expect(index.unusable).toBe(FIXTURE_COUNTS.unusable);
  });

  test.skipIf(realFlowCount === 0)("this repository's own flows parse with zero failures", async () => {
    const index = await buildIntentIndex(REPO_ROOT);
    expect(realFlowCount).toBeGreaterThan(0);
    expect(index.failures).toEqual([]);
    expect(index.counts.flows).toBe(realFlowCount);
    expect(index.unusable).toBeGreaterThanOrEqual(0);
    expect(index.unusable).toBeLessThanOrEqual(index.intents.length);
    for (const intent of index.intents) {
      expect(intent.title.length).toBeGreaterThan(0);
      expect(intent.id.length).toBeGreaterThan(0);
    }
  });

  test("a directory with no flow.json is a counted failure, never a throw", async () => {
    const root = await fixtureRoot();
    await Bun.write(path.join(root, ".metaproject", "flows", "006-2026-01-06-broken", "description.md"), "# Broken\n");
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual([".metaproject/flows/006-2026-01-06-broken: no flow.json"]);
    expect(index.counts.flows).toBe(FIXTURE_COUNTS.flows);
  });

  test("a flow.json that is not an object is a counted failure", async () => {
    const root = await fixtureRoot();
    await Bun.write(path.join(root, ".metaproject", "flows", "006-2026-01-06-array", "flow.json"), "[]");
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual([".metaproject/flows/006-2026-01-06-array: flow.json is not an object"]);
  });

  test("a flow.json that is not JSON gives one fixed failure line, whatever the runtime's parser says", async () => {
    const root = await fixtureRoot();
    await Bun.write(path.join(root, ".metaproject", "flows", "006-2026-01-06-garbled", "flow.json"), "{ not json,");
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual([".metaproject/flows/006-2026-01-06-garbled: flow.json is not valid JSON"]);
  });

  test("a flow source that exists but cannot be read is a fixed failure line, not a throw or a silent gap", async () => {
    const root = await fixtureRoot();
    // A directory where the file should be: readFile fails with EISDIR, not ENOENT.
    await mkdir(path.join(root, ".metaproject", "flows", "003-2026-01-03-no-criterion", "journal.md"), { recursive: true }).catch(async () => {
      await rm(path.join(root, ".metaproject", "flows", "003-2026-01-03-no-criterion", "journal.md"));
      await mkdir(path.join(root, ".metaproject", "flows", "003-2026-01-03-no-criterion", "journal.md"));
    });
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual([".metaproject/flows/003-2026-01-03-no-criterion/journal.md: cannot be read"]);
    expect(index.counts.flows).toBe(FIXTURE_COUNTS.flows - 1);
  });

  test("a requirements source that cannot be read is a fixed failure line, not a throw", async () => {
    const root = await fixtureRoot();
    const spec = path.join(root, "docs", "requirements", "alpha-package", "specification.md");
    await rm(spec);
    await mkdir(spec);
    const index = await buildIntentIndex(root);
    expect(index.failures).toEqual(["docs/requirements/alpha-package/specification.md: cannot be read"]);
    expect(index.counts.docpacks).toBe(FIXTURE_COUNTS.docpacks - 1);
  });

  test("a project with no flows and no requirements indexes to an empty index", async () => {
    const root = await fixtureRoot();
    await rm(path.join(root, ".metaproject", "flows"), { recursive: true, force: true });
    await rm(path.join(root, "docs"), { recursive: true, force: true });
    const index = await buildIntentIndex(root);
    expect(index.intents).toEqual([]);
    expect(index.counts.intents).toBe(0);
  });
});

describe("extraction", () => {
  test("a flow yields its title, the Problem sentence, its criteria, status and closing time", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    const flow = index.intents.find((intent) => intent.id === "001");
    expect(flow?.title).toBe("Retry checkout on a stale token");
    expect(flow?.statement).toBe("Checkout fails when the session token expires mid-payment.");
    expect(flow?.flowStatus).toBe("done");
    expect(flow?.status).toBe("closed");
    expect(flow?.closedAt).toBe("2026-01-09T12:30:00.000Z");
    expect(flow?.criteria.map((record) => record.kind)).toEqual(["exec", "judged"]);
    expect(flow?.outcome.criterion).toBe(
      'Checkout error rate for expired tokens, read from the payment log a week after release | Support tickets tagged "lost cart" per week',
    );
  });

  test("the Expected Outcome sentence stands in when there is no Problem section", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    const flow = index.intents.find((intent) => intent.id === "004");
    expect(flow?.statement).toBe("An auditor can download the audit log without asking an engineer.");
    expect(flow?.status).toBe("open");
    expect(flow?.closedAt).toBeNull();
  });

  test("scaffold placeholder text is no statement", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    const flow = index.intents.find((intent) => intent.id === "005");
    expect(flow?.statement).toBeNull();
    expect(index.unusable).toBe(1);
  });

  test("a requirements package yields its statement, outcome criteria and specification criteria", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    const pack = index.intents.find((intent) => intent.id === "alpha-package");
    expect(pack?.source).toBe("docpack");
    expect(pack?.title).toBe("Alpha package");
    expect(pack?.statement).toBe("Operators cannot tell which shipped work changed anything for users.");
    expect(pack?.criteria.map((record) => record.kind)).toEqual(["exec", "invariant"]);
    expect(pack?.outcome.criterion).toContain("The count of never-checked intents falls quarter over quarter");
    expect(index.intents.find((intent) => intent.id === "beta-package")?.statement).toBe("Let a reviewer see the intent of a change next to its diff.");
  });

  test("a directory whose name starts with an underscore is not a requirements package", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    expect(index.intents.some((intent) => intent.id.startsWith("_"))).toBe(false);
  });

  test("extraction is a pure function of the text it is given", () => {
    const source = { flowJson: JSON.stringify({ id: "9", title: "T", status: "done" }), description: "## Problem\n\nIt is slow. Very.\n", criteria: null, journal: null };
    expect(extractFlowIntent(source, ".metaproject/flows/9-x")).toEqual(extractFlowIntent(source, ".metaproject/flows/9-x"));
    expect(extractFlowIntent(source, ".metaproject/flows/9-x").statement).toBe("It is slow.");
  });
});

describe("section reading is code-fence aware", () => {
  const fenced = ["## Problem", "", "```md", "## Outcome", "Not a heading.", "```", "", "Checkout fails on a stale token."].join("\n");

  test("a heading inside a fence does not start a section", () => {
    expect(sectionOf(["```", "## Outcome", "hidden", "```"].join("\n"), /^outcome$/i)).toBeNull();
    expect(statementFrom(["```", "## Problem", "Fake statement.", "```", "", "## Expected Outcome", "Real one."].join("\n"), [/^problem$/i, /^expected outcome$/i])).toBe("Real one.");
  });

  test("a heading-looking line inside a fence does not end the section around it", () => {
    expect(sectionOf(fenced, /^problem$/i)).toContain("Checkout fails on a stale token.");
    const body = sectionOf(["## Problem", "text", "~~~", "# not a heading", "~~~", "more", "## Next"].join("\n"), /^problem$/i);
    expect(body).toBe(["text", "~~~", "# not a heading", "~~~", "more"].join("\n"));
  });

  test("an unclosed fence swallows the rest, and a longer closing fence still closes", () => {
    expect(sectionOf(["## A", "````", "```", "## B", "````", "## C", "after"].join("\n"), /^c$/i)).toBe("after");
    expect(sectionOf(["## A", "```", "## B", "body"].join("\n"), /^b$/i)).toBeNull();
  });
});

describe("determinism", () => {
  test("flows come first in numeric id order, then requirements packages by name", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    expect(index.intents.map((intent) => intent.id)).toEqual(["001", "002", "003", "004", "005", "alpha-package", "beta-package", "gamma-package"]);
  });

  test("a second run writes byte-identical output", async () => {
    const root = await fixtureRoot();
    await writeIntentIndex(root, await buildIntentIndex(root));
    const first = await readFile(indexPath(root));
    await writeIntentIndex(root, await buildIntentIndex(root));
    const second = await readFile(indexPath(root));
    expect(Buffer.compare(first, second)).toBe(0);
  });

  test("the body carries no timestamp or clock reading", async () => {
    const index = await buildIntentIndex(await fixtureRoot());
    const keys: string[] = [];
    JSON.parse(serializeIndex(index), (key, value: unknown) => {
      keys.push(key);
      return value;
    });
    expect(keys.filter((key) => /generated|built|indexedAt|timestamp|createdAt/i.test(key))).toEqual([]);
    expect(Object.keys(index).sort()).toEqual(["counts", "failures", "fingerprint", "intents", "schemaVersion", "unusable"]);
  });

  test("the counts partition the closed intents", async () => {
    const { counts } = await buildIntentIndex(await fixtureRoot());
    expect(counts).toMatchObject({
      closed: FIXTURE_COUNTS.closed,
      noCriterion: FIXTURE_COUNTS.noCriterion,
      notObserved: FIXTURE_COUNTS.notObserved,
      observed: FIXTURE_COUNTS.observed,
    });
    expect(counts.noCriterion + counts.notObserved + counts.observed).toBe(counts.closed);
  });
});
