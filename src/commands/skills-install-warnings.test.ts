// Flow 252, T6b (AC2 at the command boundary). `installGdskills` reports a
// retired-rule-kept-modified notice via `InstallGdskillsResult.warnings`
// (src/gdskills/install.ts), and `src/gdskills/install.test.ts` proves the
// function computes it correctly. This file proves the COMMAND actually
// prints it: `keryx skills install` is the cheapest of the three
// `installGdskills` call sites (skills.ts / update.ts / init.ts) to drive
// directly — it only needs an existing `.metaproject/` directory, not a full
// `keryx init` scaffold. Round-1 finding T-001: this file does NOT stand in
// for the other two call sites — each prints through its own code path
// (`heading`/`note` in update.ts and init.ts, vs the literal
// `console.log("Warnings:")` + `- ${warning}` lines here in skills.ts),
// so a regression in either print survives a green run of only this file.
// See src/commands/update.test.ts and src/commands/init.test.ts for the
// other two call sites, each exercised directly.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { RETIRED_RULES } from "../gdskills/retired-rules";
import { withCwd } from "../lib/test-cwd";
import { skillsCommand } from "./skills";

const retiredFixturesRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "gdskills",
  "__fixtures__",
  "retired-rules",
);

/** Patches `console.log` to capture every call's stringified arguments. */
function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function retiredEntryOrThrow() {
  const retiredEntry = RETIRED_RULES[0];
  if (!retiredEntry) {
    throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
  }
  return retiredEntry;
}

test("keryx skills install: an unmodified retired rule is removed with no Warnings printed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-install-warnings-"));
  try {
    const retiredEntry = retiredEntryOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName));
    // Sanity check on the fixture: if this fails, the fixture no longer
    // matches a version this project actually shipped, and the scenario
    // below would not be the "unmodified" case it claims to be.
    const fixtureHash = createHash("sha256").update(unmodifiedContent).digest("hex");
    expect(retiredEntry.shippedSha256).toContain(fixtureHash);
    await writeFile(path.join(rulesCore, retiredEntry.fileName), unmodifiedContent);

    const { logs, restore } = captureConsoleLog();
    try {
      await withCwd(root, async () => {
        await skillsCommand(["install"]);
      });
    } finally {
      restore();
    }

    expect(existsSync(path.join(rulesCore, retiredEntry.fileName))).toBe(false);
    expect(logs.some((line) => line.includes("Warnings:"))).toBe(false);
    expect(logs.some((line) => line.includes("is no longer shipped by keryx"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keryx skills install: a modified retired rule is kept and prints a Warnings line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-install-warnings-"));
  try {
    const retiredEntry = retiredEntryOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName), "utf8");
    const modifiedContent = `${unmodifiedContent}\n<!-- project-local note added after install -->\n`;
    await writeFile(path.join(rulesCore, retiredEntry.fileName), modifiedContent, "utf8");

    const { logs, restore } = captureConsoleLog();
    try {
      await withCwd(root, async () => {
        await skillsCommand(["install"]);
      });
    } finally {
      restore();
    }

    expect(await readFile(path.join(rulesCore, retiredEntry.fileName), "utf8")).toBe(modifiedContent);
    expect(logs).toContain("Warnings:");
    expect(logs).toContain(
      `- ${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it differs from every shipped version — delete it, or rename it if you still rely on it`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
