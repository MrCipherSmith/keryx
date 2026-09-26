// flow 344: `keryx review jev-profile`, driven through the real CLI
// dispatcher. Hermetic: no network, no git — only reads/writes
// `.metaproject/tasks.config.json` under a temp project root.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-jev-profile-cli-"));
}

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

describe("keryx review jev-profile show", () => {
  test("prints the current (empty) state and writes nothing when no config exists", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);

    await reviewCommand(["jev-profile", "show", "--json"]);

    const parsed = JSON.parse(output()) as { current: Record<string, unknown>; applied: boolean };
    expect(parsed.applied).toBe(false);
    expect(parsed.current).toEqual({});
    await expect(readFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "utf8")).rejects.toThrow();
  });

  test("bare `jev-profile` (no args) behaves like show", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await reviewCommand(["jev-profile", "--json"]);
    const parsed = JSON.parse(output()) as { applied: boolean };
    expect(parsed.applied).toBe(false);
  });
});

describe("keryx review jev-profile --apply recommended", () => {
  test("writes the recommended keys and preserves unrelated existing config", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jev-profile-cli-"));
    await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(ROOT, ".metaproject", "tasks.config.json"),
      JSON.stringify({ completion: { require_clean_round: true }, review: { jev: { risk: true, select_skip_below: 0.3 } } }, null, 2),
      "utf8",
    );
    process.chdir(ROOT);

    await reviewCommand(["jev-profile", "--apply", "recommended", "--json"]);

    const parsed = JSON.parse(output()) as { current: Record<string, unknown>; applied: boolean };
    expect(parsed.applied).toBe(true);
    expect(parsed.current.select).toBe(true);
    expect(parsed.current.ci_triage).toBe(true);
    expect(parsed.current.edit_guard).toBe(true);
    expect(parsed.current.risk).toBe(false);

    const onDisk = JSON.parse(await readFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "utf8")) as {
      completion: unknown;
      review: { jev: { select_skip_below: number } };
    };
    expect(onDisk.completion).toEqual({ require_clean_round: true });
    expect(onDisk.review.jev.select_skip_below).toBe(0.3);
  });
});

describe("keryx review jev-profile — usage", () => {
  test("rejects an unrecognized --apply value", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await expect(reviewCommand(["jev-profile", "--apply", "bogus"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Usage: keryx review jev-profile");
  });

  test("rejects an unknown flag", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await reviewCommand(["jev-profile", "--bogus"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Unknown option");
  });
});
