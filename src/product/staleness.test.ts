// Flow 362, AC3: `product open` will not answer from a missing index or one that
// no longer matches the flows and requirements it was read from. Staleness is a
// content fingerprint, not a clock: modification times are set explicitly here to
// show they play no part in either direction.

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { productCommand } from "../commands/product";
import { buildIntentIndex, corpusFingerprint } from "./corpus";
import { copyFixtureRepo } from "./fixtures/repo";
import { loadOpenReport } from "./service";
import { indexPath, writeIntentIndex } from "./store";

const roots: string[] = [];
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

const OLD = new Date("2026-01-01T00:00:00Z");
const NEW = new Date("2026-03-01T00:00:00Z");

async function project(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

function flowFile(root: string, dir: string, file: string): string {
  return path.join(root, ".metaproject", "flows", dir, file);
}

const JOURNAL = "003-2026-01-03-no-criterion";

async function indexed(root: string): Promise<void> {
  await writeIntentIndex(root, await buildIntentIndex(root));
}

async function refusal(root: string): Promise<string | null> {
  const loaded = await loadOpenReport(root);
  return loaded.ok ? null : loaded.message;
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the staleness guard", () => {
  test("a missing index is refused and names `keryx product index`", async () => {
    const loaded = await loadOpenReport(await project());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.message).toContain("keryx product index");
  });

  test("an untouched tree is not stale", async () => {
    const root = await project();
    await indexed(root);
    expect((await loadOpenReport(root)).ok).toBe(true);
  });

  test("the index stores the fingerprint the tree gives before any edit", async () => {
    const root = await project();
    const index = await buildIntentIndex(root);
    expect(index.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(index.fingerprint).toBe(await corpusFingerprint(root));
  });

  test("a same-size content change with an OLDER mtime is stale", async () => {
    const root = await project();
    const journal = flowFile(root, JOURNAL, "journal.md");
    await indexed(root);
    await utimes(indexPath(root), NEW, NEW);
    const before = await readFile(journal, "utf8");
    const after = `${before.slice(0, -1)}${before.endsWith("x") ? "y" : "x"}`;
    expect(after.length).toBe(before.length);
    await writeFile(journal, after);
    await utimes(journal, OLD, OLD);
    const message = await refusal(root);
    expect(message).toContain("out of date");
    expect(message).toContain("changed after the index was built");
    expect(message).toContain("keryx product index");
  });

  test("a renamed flow directory with the same count is stale", async () => {
    const root = await project();
    await indexed(root);
    await utimes(indexPath(root), NEW, NEW);
    const flows = path.join(root, ".metaproject", "flows");
    await rename(path.join(flows, JOURNAL), path.join(flows, "003-2026-01-03-renamed"));
    const message = await refusal(root);
    expect(message).toContain("out of date");
    expect(message).toContain("keryx product index");
  });

  test("a bare `touch` with the same content is NOT stale", async () => {
    const root = await project();
    await indexed(root);
    await utimes(flowFile(root, JOURNAL, "journal.md"), NEW, NEW);
    await utimes(flowFile(root, "001-2026-01-01-stated-outcome", "flow.json"), NEW, NEW);
    expect(await refusal(root)).toBeNull();
  });

  test("an edit to a requirements package is stale", async () => {
    const root = await project();
    await indexed(root);
    const spec = path.join(root, "docs", "requirements", "alpha-package", "specification.md");
    await writeFile(spec, `${await readFile(spec, "utf8")}\n- AC9: One more\n`);
    await utimes(spec, OLD, OLD);
    expect(await refusal(root)).toContain("out of date");
  });

  test("a flow added after the index was written is refused, and the count is named", async () => {
    const root = await project();
    await indexed(root);
    await Bun.write(flowFile(root, "006-2026-01-06-late", "flow.json"), JSON.stringify({ id: "006", title: "Late", status: "ready" }));
    await utimes(flowFile(root, "006-2026-01-06-late", "flow.json"), OLD, OLD);
    const message = await refusal(root);
    expect(message).toContain("the index holds 5 flows, the tree 6");
    expect(message).toContain("keryx product index");
  });

  test("an unreadable index is refused and names the rebuild command", async () => {
    const root = await project();
    await Bun.write(indexPath(root), "{ not json");
    const loaded = await loadOpenReport(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.message).toContain("unreadable");
      expect(loaded.message).toContain("keryx product index");
    }
  });

  test("rebuilding the index clears the refusal", async () => {
    const root = await project();
    await indexed(root);
    await writeFile(flowFile(root, JOURNAL, "journal.md"), "changed\n");
    expect(await refusal(root)).not.toBeNull();
    await indexed(root);
    expect(await refusal(root)).toBeNull();
  });

  test("the command exits non-zero with the message on stderr, and prints no list", async () => {
    const root = await project();
    process.chdir(root);
    const out: string[] = [];
    const err: string[] = [];
    console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
    await productCommand(["open"]);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("keryx product index");
    expect(out).toEqual([]);
  });
});

describe("the fingerprint", () => {
  test("it changes with a file's content, a package name, and a package added or removed", async () => {
    const root = await project();
    const base = await corpusFingerprint(root);
    expect(await corpusFingerprint(root)).toBe(base);
    await writeFile(flowFile(root, JOURNAL, "description.md"), "different\n");
    const edited = await corpusFingerprint(root);
    expect(edited).not.toBe(base);
    await rm(path.join(root, "docs", "requirements", "beta-package"), { recursive: true });
    expect(await corpusFingerprint(root)).not.toBe(edited);
  });

  test("an index without a matching fingerprint is stale even when every count agrees", async () => {
    const root = await project();
    const index = await buildIntentIndex(root);
    await writeIntentIndex(root, { ...index, fingerprint: "0".repeat(64) });
    expect(await refusal(root)).toContain("out of date");
  });
});

describe("a malformed index is refused, never thrown", () => {
  async function malformedMessage(mutate: (index: Record<string, unknown>) => void): Promise<string> {
    const root = await project();
    const index = JSON.parse(JSON.stringify(await buildIntentIndex(root))) as Record<string, unknown>;
    mutate(index);
    await Bun.write(indexPath(root), JSON.stringify(index));
    const message = await refusal(root);
    expect(message).not.toBeNull();
    return message ?? "";
  }

  const shapes: Array<[string, (index: Record<string, unknown>) => void]> = [
    ["missing failures", (index) => void delete index.failures],
    ["failures of numbers", (index) => void (index.failures = [1])],
    ["empty counts", (index) => void (index.counts = {})],
    ["missing fingerprint", (index) => void delete index.fingerprint],
    ["missing unusable", (index) => void delete index.unusable],
    ["an intent with no outcome", (index) => void delete (index.intents as Array<Record<string, unknown>>)[0]?.outcome],
    ["an intent with a numeric title", (index) => void ((index.intents as Array<Record<string, unknown>>)[0]!.title = 4)],
    ["an intent with an unknown source", (index) => void ((index.intents as Array<Record<string, unknown>>)[0]!.source = "other")],
    ["an intent with an unknown status", (index) => void ((index.intents as Array<Record<string, unknown>>)[0]!.status = "half")],
    ["an outcome that is not observed-boolean", (index) => void ((index.intents as Array<{ outcome: Record<string, unknown> }>)[0]!.outcome.observed = "yes")],
    ["a null in the intents list", (index) => void (index.intents = [null])],
  ];

  for (const [name, mutate] of shapes) {
    test(`${name} names \`keryx product index\``, async () => {
      const message = await malformedMessage(mutate);
      expect(message).toContain("unreadable");
      expect(message).toContain("keryx product index");
    });
  }

  test("the command exits non-zero naming `keryx product index` for a hand-edited index, without throwing", async () => {
    const root = await project();
    const index = JSON.parse(JSON.stringify(await buildIntentIndex(root))) as Record<string, unknown>;
    index.counts = {};
    delete index.failures;
    await Bun.write(indexPath(root), JSON.stringify(index));
    process.chdir(root);
    const out: string[] = [];
    const err: string[] = [];
    console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
    await productCommand(["open"]);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("keryx product index");
    expect(out).toEqual([]);
  });
});

