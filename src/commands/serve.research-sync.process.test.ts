// Flow 404 (AC8): `keryx serve` really starts the daily Part 1 materials sync, and stops it when it drains.
//
// The job and its composition root are tested with a fake clock in `scheduler/research-sync-job.test.ts`. What those
// cannot see is the line in `serve.ts` that constructs and starts the job: delete it and every one of them stays
// green. So this file runs a real `keryx serve` in a throwaway repository that opted in, and waits for the one thing
// only the started job can cause: its notice line and its record of the day.
//
// The repository holds the catalog directory and nothing else, so the real sync fails at once ("run from the
// repository root") and writes its reason into `sync-status.md`. No python is needed and no counts are produced.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultServeConfig, saveServeConfig } from "../lib/serve-config";
import { issueServeToken } from "../lib/serve-credential";
import { readResearchSyncFired, researchSyncFiredPath, scheduleResearchSync } from "../scheduler/research-sync-job";
import { CATALOG_DIR, STATUS_FILE } from "./research-sync";

const exec = promisify(execFile);
const CLI = path.join(import.meta.dir, "..", "cli.ts");

let xdgRoot = "";
let project = "";

beforeEach(() => {
  xdgRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-serve-research-xdg-")));
  mkdirSync(path.join(xdgRoot, "keryx"), { recursive: true });
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-serve-research-proj-")));
});

afterEach(() => {
  rmSync(xdgRoot, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

/** Read the process output until `pattern` shows up in it, or fail with what was printed. */
async function readUntil(stdout: ReadableStream<Uint8Array>, pattern: RegExp, ms = 45_000): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<undefined>((resolve) => setTimeout(resolve, 1_000))]);
      if (next === undefined) continue;
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      if (pattern.test(buffer)) return buffer;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error(`never saw ${String(pattern)}; output was:\n${buffer}`);
}

describe("keryx serve starts the research sync job", () => {
  test("a real serve in an opted-in repository runs the day's sync, reports the failure, and drains cleanly", async () => {
    await exec("git", ["init", "-q"], { cwd: project });
    mkdirSync(path.join(project, CATALOG_DIR), { recursive: true });
    await scheduleResearchSync(project);

    const configDir = path.join(xdgRoot, "keryx");
    const issued = issueServeToken(configDir);
    if (!issued.ok) throw new Error("fixture credential could not be issued");
    saveServeConfig(defaultServeConfig(issued.record.id), configDir);

    const proc = Bun.spawn(["bun", "run", CLI, "serve", "--port", "0"], {
      cwd: project,
      env: { ...process.env, XDG_DATA_HOME: xdgRoot, APPDATA: xdgRoot } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // Only the started job can print this: it is the sync's failure, reported through serve's notice line.
      const seen = await readUntil(proc.stdout, /research sync could not run: run from the repository root/);
      expect(seen).toContain("listening on http://");

      // The notice is printed after the day is recorded, but poll briefly rather than assume the order.
      for (let i = 0; i < 20 && (await readResearchSyncFired(project)) === null; i += 1) await Bun.sleep(250);
      const fired = await readResearchSyncFired(project);
      expect(fired).toMatchObject({ ok: false });
      expect(fired?.day).toBe(new Date().toISOString().slice(0, 10));
      expect(existsSync(researchSyncFiredPath(project))).toBe(true);
      expect(readFileSync(path.join(project, CATALOG_DIR, STATUS_FILE), "utf8")).toContain("Состояние (status): ошибка (failed)");
    } finally {
      proc.kill("SIGTERM");
    }
    expect(await proc.exited).toBe(0);
  }, 90_000);

  test("serve.ts constructs the job, starts it, and stops it in the drain", () => {
    // The drain is the half a running serve cannot show from outside: the job must be stopped (and its pass awaited)
    // before the listener is drained, or a hung sync could hold serve's exit.
    const source = readFileSync(path.join(import.meta.dir, "serve.ts"), "utf8");
    expect(source).toMatch(/const researchSync = createServeResearchSync\(/);
    expect(source).toMatch(/researchSync\.start\(\)/);
    expect(source).toMatch(/Promise\.all\(\[[^\]]*researchSync\.stop\(\)[^\]]*\]\)/);
  });
});
