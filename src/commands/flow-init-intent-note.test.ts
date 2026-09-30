// `flow init` says, in one informational line, when the description it just
// wrote states no intent the product index can read. The line never changes an
// exit code and never blocks.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { INIT_INTENT_NOTE, initIntentNote, intentNoteForNewFlow } from "../flow/description-intent";
import { renderDescription } from "../flow/templates";
import { uniqueTestRoot } from "../lib/test-tmp";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function keryx(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, output: `${out}${err}` };
}

describe("the intent note", () => {
  test("a title-only description states no intent, so the note is offered", () => {
    expect(initIntentNote(renderDescription("A title", "user description"))).toBe(INIT_INTENT_NOTE);
    expect(INIT_INTENT_NOTE).toContain("no intent statement extractable from description.md");
    expect(INIT_INTENT_NOTE.includes("\n")).toBe(false);
  });

  test("a description with a Problem or an Expected Outcome sentence gets no note", () => {
    expect(initIntentNote("# T\n\n## Problem\n\nCheckout fails on a stale token.\n")).toBeNull();
    expect(initIntentNote("# T\n\n## Expected Outcome\n\nAn auditor can download the log.\n")).toBeNull();
  });

  test("it asks the index's own extraction", async () => {
    const { flowStatementFrom } = await import("../flow/description-intent");
    const { extractFlowIntent } = await import("../product/extract");
    for (const description of [renderDescription("T", "s"), "# T\n\n## Problem\n\nIt is slow.\n", ""]) {
      const statement = extractFlowIntent({ flowJson: "{}", description, criteria: null, journal: null }, ".metaproject/flows/1-x").statement;
      expect(flowStatementFrom(description)).toBe(statement);
      expect(initIntentNote(description) === null).toBe(statement !== null);
    }
  });

  test("a description that cannot be read gets no note, and no throw", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-intent-note");
    roots.push(root);
    await mkdir(root, { recursive: true });
    expect(await intentNoteForNewFlow(root, ".metaproject/flows/001-x")).toBeNull();
    await mkdir(path.join(root, "flow"), { recursive: true });
    await writeFile(path.join(root, "flow", "description.md"), renderDescription("T", "s"));
    expect(await intentNoteForNewFlow(root, "flow")).toBe(INIT_INTENT_NOTE);
  });
});

describe("`keryx flow init`", () => {
  test("with a title only, prints the note once, and still exits zero", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-intent-note-init");
    roots.push(root);
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const init = await keryx(root, ["flow", "init", "--title", "Speed up checkout"]);
    expect(init.code).toBe(0);
    expect(init.output).toContain("Created flow");
    expect(init.output.split(INIT_INTENT_NOTE)).toHaveLength(2);
    expect(init.output.split("\n").filter((line) => line.includes("no intent statement extractable"))).toHaveLength(1);
  }, 30_000);
});
