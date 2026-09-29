// Flow 362, AC6: `product open` will not answer from a missing index or one
// older than the newest flow. It exits non-zero and names `keryx product index`.
// Modification times are set explicitly so the test never depends on the clock.

import { afterEach, describe, expect, test } from "bun:test";
import { rm, utimes } from "node:fs/promises";
import path from "node:path";
import { productCommand } from "../commands/product";
import { buildIntentIndex } from "./corpus";
import { copyFixtureRepo } from "./fixtures/repo";
import { loadOpenReport } from "./service";
import { indexPath, writeIntentIndex } from "./store";

const roots: string[] = [];
const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

const OLD = new Date("2026-01-01T00:00:00Z");
const MIDDLE = new Date("2026-02-01T00:00:00Z");
const NEW = new Date("2026-03-01T00:00:00Z");

async function project(): Promise<string> {
  const root = await copyFixtureRepo();
  roots.push(root);
  return root;
}

async function stampFlowFiles(root: string, when: Date): Promise<void> {
  const flows = path.join(root, ".metaproject", "flows");
  for (const dir of ["001-2026-01-01-stated-outcome", "002-2026-01-02-observed", "003-2026-01-03-no-criterion", "004-2026-01-04-in-progress", "005-2026-01-05-no-statement"]) {
    for (const file of ["flow.json", "description.md", "acceptance-criteria.md", "journal.md"]) {
      await utimes(path.join(flows, dir, file), when, when).catch(() => {});
    }
  }
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

  test("an index newer than every flow is accepted", async () => {
    const root = await project();
    await stampFlowFiles(root, OLD);
    await writeIntentIndex(root, await buildIntentIndex(root));
    await utimes(indexPath(root), NEW, NEW);
    expect((await loadOpenReport(root)).ok).toBe(true);
  });

  test("an index older than the newest flow file is refused", async () => {
    const root = await project();
    await stampFlowFiles(root, OLD);
    await writeIntentIndex(root, await buildIntentIndex(root));
    await utimes(indexPath(root), MIDDLE, MIDDLE);
    await utimes(path.join(root, ".metaproject", "flows", "003-2026-01-03-no-criterion", "journal.md"), NEW, NEW);
    const loaded = await loadOpenReport(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.message).toContain("out of date");
      expect(loaded.message).toContain("keryx product index");
    }
  });

  test("a flow added after the index was written is refused", async () => {
    const root = await project();
    await stampFlowFiles(root, OLD);
    await writeIntentIndex(root, await buildIntentIndex(root));
    await utimes(indexPath(root), NEW, NEW);
    await Bun.write(
      path.join(root, ".metaproject", "flows", "006-2026-01-06-late", "flow.json"),
      JSON.stringify({ id: "006", title: "Late", status: "ready" }),
    );
    await utimes(path.join(root, ".metaproject", "flows", "006-2026-01-06-late", "flow.json"), OLD, OLD);
    const loaded = await loadOpenReport(root);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.message).toContain("keryx product index");
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
    await stampFlowFiles(root, NEW);
    await writeIntentIndex(root, await buildIntentIndex(root));
    await utimes(indexPath(root), OLD, OLD);
    expect((await loadOpenReport(root)).ok).toBe(false);
    await writeIntentIndex(root, await buildIntentIndex(root));
    await utimes(indexPath(root), new Date(NEW.getTime() + 1000), new Date(NEW.getTime() + 1000));
    expect((await loadOpenReport(root)).ok).toBe(true);
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
