// The end-to-end half of the artifact-identity guard.
//
// The defect: `keryx ctx` named each run's raw log and summary from a
// millisecond timestamp alone, so two runs minting in the same millisecond
// wrote the same two files and the later writer silently won. Measured on this
// checkout at 40 concurrent `ctx run -- echo MARKER-<i>` from one project root,
// two of the forty collided; both exited 0, both printed a `raw:` pointer at a
// file holding a DIFFERENT command's output, and their own output existed
// nowhere.
//
// These are real `keryx ctx run` processes against a real project root — no
// stubs, no helper called with contrived arguments. Two cases:
//
//   1. Pinned clock. Every child is told to mint in the same millisecond via
//      `KERYX_CTX_CLOCK_PIN_MS`, so the collision is GUARANTEED rather than
//      lucky. Only the timestamp is pinned; the discriminator and the exclusive
//      claim — the mechanism under test — run exactly as in production. Against
//      a deliberately reverted implementation this case failed every time.
//   2. Natural clock. The same invariant with nothing pinned at all, which is
//      the shape that found the bug in the first place.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");

/** How many real CLI processes race for an artifact name. */
const RUNS = 24;

/**
 * Every test below spawns `RUNS` (or more) REAL `bun` processes and waits for
 * every one of them to exit — not a fixed amount of work, but `RUNS` full
 * runtime start-ups competing for the scheduler. `120_000` was the previous
 * budget and it was already load-bearing, not comfortable: reproduced by
 * running this file 20-30x concurrently alongside a full `bun test` in the
 * background, "concurrent ctx runs on the real clock each keep their own
 * evidence" failed at `[120125.85ms] this test timed out after 120000ms` —
 * 125ms over a 120-SECOND budget, with the one process that had not finished
 * printing nothing (`MARKER-0 printed no raw: pointer`) once bun tore the test
 * down. The 24 real spawns were still doing real work; the budget was simply
 * too tight for the contention this file is deliberately built to survive.
 * Doubled here, not because the mechanism changed, but because the margin
 * measured was effectively zero.
 */
const REAL_PROCESS_RACE_TIMEOUT_MS = 240_000;

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(path.join(tmpdir(), "keryx-ctx-race-"));
  await mkdir(path.join(projectRoot, ".metaproject", "data", "gdctx"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { gdctx: { enabled: true } } }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function pointerFor(stdout: string, label: "raw" | "summary"): string | undefined {
  return stdout
    .split("\n")
    .find((line) => line.startsWith(`${label}: `))
    ?.slice(label.length + 2)
    .trim();
}

type Run = { marker: string; stdout: string };

/** Start `count` real `ctx run` processes at once and collect what they printed. */
async function raceCtxRuns(count: number, env?: Record<string, string>): Promise<Run[]> {
  return Promise.all(
    Array.from({ length: count }, async (_unused, index) => {
      const marker = `MARKER-${index}`;
      const proc = Bun.spawn(["bun", CLI, "ctx", "run", "--", "echo", marker], {
        cwd: projectRoot,
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return { marker, stdout };
    }),
  );
}

/**
 * The invariant that failed: every run's printed pointer leads to that run's
 * own output, no two runs share an address, and nothing is written nowhere.
 */
async function expectEveryRunKeptItsOwnEvidence(results: Run[]): Promise<void> {
  const rawDir = path.join(projectRoot, ".metaproject", "data", "gdctx", "raw");
  const artifactsDir = path.join(projectRoot, ".metaproject", "data", "gdctx", "artifacts");

  const mismatched: string[] = [];
  const pointers = new Set<string>();

  for (const { marker, stdout } of results) {
    const rawPointer = pointerFor(stdout, "raw");
    const summaryPointer = pointerFor(stdout, "summary");
    expect(rawPointer, `${marker} printed no raw: pointer`).toBeDefined();
    expect(summaryPointer, `${marker} printed no summary: pointer`).toBeDefined();
    pointers.add(rawPointer as string);

    // The two printed pointers must address the same artifact.
    expect(path.basename(rawPointer as string, ".log")).toBe(
      path.basename(summaryPointer as string, ".md"),
    );

    const contents = await readFile(path.join(projectRoot, rawPointer as string), "utf8").catch(
      () => undefined,
    );
    // Exact match, not substring: `MARKER-1` is a prefix of `MARKER-12`.
    if (contents?.trim() !== marker) {
      mismatched.push(
        `${marker}: ${rawPointer} holds ${contents === undefined ? "<missing file>" : JSON.stringify(contents.trim())}`,
      );
    }
  }

  // Pre-fix this listed the runs whose log a same-millisecond neighbour had
  // overwritten — the "one command's output presented as another's" failure.
  expect(mismatched).toEqual([]);
  expect(pointers.size).toBe(results.length);

  // And nothing vanished without a trace.
  const durable = (await readdir(rawDir)).filter(
    (name) => name.endsWith(".log") && name !== "latest.log",
  );
  expect(durable).toHaveLength(results.length);
  const bodies = await Promise.all(durable.map((n) => readFile(path.join(rawDir, n), "utf8")));
  for (const { marker } of results) {
    expect(
      bodies.filter((body) => body.trim() === marker),
      `${marker} was written nowhere`,
    ).toHaveLength(1);
  }

  // Each durable raw log has its summary beside it.
  const summaries = await readdir(artifactsDir);
  for (const name of durable) {
    expect(summaries).toContain(`${path.basename(name, ".log")}.md`);
  }
}

test(
  "concurrent ctx runs forced into one millisecond each keep their own evidence",
  async () => {
    const results = await raceCtxRuns(RUNS, {
      KERYX_CTX_CLOCK_PIN_MS: String(Date.parse("2026-09-07T21:00:21.619Z")),
    });

    // Every id really did come from the same millisecond — without this the
    // case would be no stronger than the natural one below.
    const stamps = new Set(
      results.map((r) =>
        path.basename(pointerFor(r.stdout, "raw") ?? "").slice(0, "2026-09-07T21-00-21-619Z".length),
      ),
    );
    expect([...stamps]).toEqual(["2026-09-07T21-00-21-619Z"]);

    await expectEveryRunKeptItsOwnEvidence(results);
  },
  REAL_PROCESS_RACE_TIMEOUT_MS,
);

test(
  "concurrent ctx runs on the real clock each keep their own evidence",
  async () => {
    await expectEveryRunKeptItsOwnEvidence(await raceCtxRuns(RUNS));
  },
  REAL_PROCESS_RACE_TIMEOUT_MS,
);

test(
  "ctx show latest --raw returns the log belonging to the summary latest.md holds",
  async () => {
    // `latest.*` is the one address concurrent runs share and cannot reserve
    // away, so the two files can come from different runs. The pair a reader
    // gets back still has to be one run's.
    await raceCtxRuns(12);

    const read = async (args: string[]): Promise<string> => {
      const proc = Bun.spawn(["bun", CLI, ...args], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out;
    };

    const summary = await read(["ctx", "show", "latest"]);
    const raw = await read(["ctx", "show", "latest", "--raw"]);

    const command = /Command: `echo (MARKER-\d+)`/.exec(summary)?.[1];
    expect(command, "latest.md did not name a command").toBeDefined();
    expect(raw.trim()).toBe(command as string);
  },
  REAL_PROCESS_RACE_TIMEOUT_MS,
);
