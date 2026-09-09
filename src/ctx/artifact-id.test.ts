// Two invocations of `keryx ctx` that mint inside the same millisecond used to
// produce the same artifact id, write the same two files, and let the later
// writer silently win. Measured on this checkout at 40 concurrent
// `ctx run -- echo MARKER-<i>`: two of forty collided, both exited 0, and the
// losers' output existed nowhere while their printed `raw:` pointer named a
// file holding another command's output.
//
// These tests cover both layers of the fix:
//
//   · reserveArtifact — forced into a genuine same-name race by pinning the
//     clock AND the discriminator, so both callers really do open the identical
//     path with `wx` and one really does get EEXIST. The seam under test is the
//     filesystem, not a stub.
//   · the real CLI — `spawn-race.test.ts` beside this file runs the actual
//     concurrent processes, which is what the pinned-input tests stand in for.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { artifactIdCandidate, latestRawTarget, reserveArtifact } from "./artifact-id";

let root: string;
let rawDir: string;
let artifactsDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-ctx-id-"));
  rawDir = path.join(root, ".metaproject", "data", "gdctx", "raw");
  artifactsDir = path.join(root, ".metaproject", "data", "gdctx", "artifacts");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A clock and a token generator that never vary — maximum collision pressure. */
const FROZEN = new Date("2026-09-07T21:00:21.619Z");
const pinned = { now: () => FROZEN, token: () => "a3f9c1" };

describe("artifactIdCandidate", () => {
  test("keeps the sortable timestamp prefix and the _<kind> suffix", () => {
    const id = artifactIdCandidate("run", FROZEN, "a3f9c1");
    expect(id).toBe("2026-09-07T21-00-21-619Z-a3f9c1_run");
    // `ctx show` resolves an address by basename + extension, so the pair still
    // addresses as `<id>.log` / `<id>.md`.
    expect(id.endsWith("_run")).toBe(true);
    expect(id.startsWith("2026-09-07T21-00-21-619Z")).toBe(true);
  });

  test("a kind carrying path separators cannot escape its directory", () => {
    const id = artifactIdCandidate("../../etc/passwd", FROZEN, "a3f9c1");
    expect(id).not.toContain("/");
    expect(path.dirname(path.join("/base", `${id}.log`))).toBe("/base");
  });
});

describe("reserveArtifact", () => {
  test("distinct runs get distinct ids even inside one pinned millisecond", async () => {
    // Only the discriminator is left free here; the clock is frozen, which is
    // exactly the condition the old id could not survive.
    const reservations = await Promise.all(
      Array.from({ length: 25 }, () =>
        reserveArtifact({ rawDir, artifactsDir, kind: "run", now: () => FROZEN }),
      ),
    );
    expect(new Set(reservations.map((r) => r.id)).size).toBe(25);
    expect(new Set(reservations.map((r) => r.rawPath)).size).toBe(25);
    expect(new Set(reservations.map((r) => r.summaryPath)).size).toBe(25);
  });

  test("a forced identical-name race is resolved, not silently shared", async () => {
    // Both callers propose byte-identical candidates. The winner keeps it; the
    // loser must NOT be handed the same path, and must NOT be dropped.
    const [first, second] = await Promise.all([
      reserveArtifact({ rawDir, artifactsDir, kind: "run", ...pinned, maxAttempts: 2 }).catch(
        (error: unknown) => error as Error,
      ),
      reserveArtifact({ rawDir, artifactsDir, kind: "run", ...pinned, maxAttempts: 2 }).catch(
        (error: unknown) => error as Error,
      ),
    ]);

    const winners = [first, second].filter((r) => !(r instanceof Error));
    const losers = [first, second].filter((r): r is Error => r instanceof Error);

    // Exactly one can hold the single candidate name these inputs allow.
    expect(winners).toHaveLength(1);
    // The other one FAILS LOUDLY rather than being given the winner's path.
    expect(losers).toHaveLength(1);
    expect(losers[0]?.message).toContain("refusing to overwrite another run's evidence");
    expect(losers[0]?.message).toContain(rawDir);
  });

  test("a reservation is exclusive: an already-taken name is never re-handed-out", async () => {
    const held = await reserveArtifact({ rawDir, artifactsDir, kind: "run", ...pinned });
    await writeFile(held.rawPath, "FIRST RUN OUTPUT", "utf8");

    // A second caller proposing the same name with room to retry gets a
    // different one, and the first run's bytes are untouched.
    const next = await reserveArtifact({
      rawDir,
      artifactsDir,
      kind: "run",
      now: () => FROZEN,
      token: (() => {
        const tokens = ["a3f9c1", "b7e204"];
        let i = 0;
        return () => tokens[Math.min(i++, tokens.length - 1)] ?? "b7e204";
      })(),
    });

    expect(next.id).not.toBe(held.id);
    expect(await readFile(held.rawPath, "utf8")).toBe("FIRST RUN OUTPUT");
  });

  test("losing the summary half releases the raw half instead of leaking it", async () => {
    // Simulate the interleaving where another process claimed the summary
    // between our two `wx` opens, by pre-creating only the summary.
    const id = artifactIdCandidate("run", FROZEN, "a3f9c1");
    await reserveArtifact({ rawDir, artifactsDir, kind: "run", ...pinned, maxAttempts: 1 }).catch(
      () => undefined,
    );
    await rm(path.join(rawDir, `${id}.log`), { force: true });
    await rm(path.join(artifactsDir, `${id}.md`), { force: true });
    await writeFile(path.join(artifactsDir, `${id}.md`), "taken", "utf8");

    await expect(
      reserveArtifact({ rawDir, artifactsDir, kind: "run", ...pinned, maxAttempts: 1 }),
    ).rejects.toThrow("refusing to overwrite another run's evidence");

    // No orphaned empty log left behind from the half-claim.
    const logs = await readdir(rawDir);
    expect(logs).not.toContain(`${id}.log`);
  });

  test("KERYX_CTX_CLOCK_PIN_MS pins the timestamp but not the discriminator", async () => {
    const previous = process.env.KERYX_CTX_CLOCK_PIN_MS;
    process.env.KERYX_CTX_CLOCK_PIN_MS = String(FROZEN.getTime());
    try {
      const reservations = await Promise.all(
        Array.from({ length: 8 }, () => reserveArtifact({ rawDir, artifactsDir, kind: "run" })),
      );
      for (const reservation of reservations) {
        expect(reservation.id.startsWith("2026-09-07T21-00-21-619Z-")).toBe(true);
      }
      // Pinning the clock must not pin the identity — that is the whole point.
      expect(new Set(reservations.map((r) => r.id)).size).toBe(8);
    } finally {
      if (previous === undefined) delete process.env.KERYX_CTX_CLOCK_PIN_MS;
      else process.env.KERYX_CTX_CLOCK_PIN_MS = previous;
    }
  });

  test("a malformed clock pin is ignored rather than obeyed", async () => {
    const previous = process.env.KERYX_CTX_CLOCK_PIN_MS;
    process.env.KERYX_CTX_CLOCK_PIN_MS = "not-a-number";
    try {
      const reservation = await reserveArtifact({ rawDir, artifactsDir, kind: "run" });
      expect(reservation.id).not.toContain("Invalid");
      expect(reservation.id).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{6}_run$/);
    } finally {
      if (previous === undefined) delete process.env.KERYX_CTX_CLOCK_PIN_MS;
      else process.env.KERYX_CTX_CLOCK_PIN_MS = previous;
    }
  });

  test("reserving creates both halves of the pair up front", async () => {
    const reservation = await reserveArtifact({ rawDir, artifactsDir, kind: "read", ...pinned });
    expect(await readFile(reservation.rawPath, "utf8")).toBe("");
    expect(await readFile(reservation.summaryPath, "utf8")).toBe("");
    expect(path.basename(reservation.rawPath)).toBe(`${reservation.id}.log`);
    expect(path.basename(reservation.summaryPath)).toBe(`${reservation.id}.md`);
  });
});

describe("latestRawTarget", () => {
  const projectRoot = "/project";
  const rawDir = "/project/.metaproject/data/gdctx/raw";

  function summaryWithRawPath(rawPath: string): string {
    return `# gdctx command summary\n\n## Metadata\n\n\`\`\`json\n${JSON.stringify({ id: "x", rawPath }, null, 2)}\n\`\`\`\n`;
  }

  let fileRoot: string;

  beforeEach(async () => {
    fileRoot = await mkdtemp(path.join(tmpdir(), "keryx-ctx-latest-"));
  });
  afterEach(async () => {
    await rm(fileRoot, { recursive: true, force: true });
  });

  test("follows the summary's own recorded rawPath, not latest.log", async () => {
    const file = path.join(fileRoot, "latest.md");
    await writeFile(
      file,
      summaryWithRawPath(".metaproject/data/gdctx/raw/2026-09-07T21-00-21-619Z-a3f9c1_run.log"),
      "utf8",
    );
    const target = await latestRawTarget({
      latestSummaryPath: file,
      rawDir,
      projectRoot,
      exists: async () => true,
    });
    expect(target).toBe(
      path.join(rawDir, "2026-09-07T21-00-21-619Z-a3f9c1_run.log"),
    );
  });

  test("refuses a rawPath that points outside the raw directory", async () => {
    const file = path.join(fileRoot, "latest.md");
    await writeFile(file, summaryWithRawPath("../../../../etc/passwd"), "utf8");
    expect(
      await latestRawTarget({
        latestSummaryPath: file,
        rawDir,
        projectRoot,
        exists: async () => true,
      }),
    ).toBeUndefined();
  });

  test("returns undefined rather than guessing when the log is gone", async () => {
    const file = path.join(fileRoot, "latest.md");
    await writeFile(file, summaryWithRawPath(".metaproject/data/gdctx/raw/gone.log"), "utf8");
    expect(
      await latestRawTarget({
        latestSummaryPath: file,
        rawDir,
        projectRoot,
        exists: async () => false,
      }),
    ).toBeUndefined();
  });

  test("returns undefined for a missing or metadata-less summary", async () => {
    expect(
      await latestRawTarget({
        latestSummaryPath: path.join(fileRoot, "absent.md"),
        rawDir,
        projectRoot,
        exists: async () => true,
      }),
    ).toBeUndefined();

    const bare = path.join(fileRoot, "bare.md");
    await writeFile(bare, "# gdctx command summary\n\nno metadata here\n", "utf8");
    expect(
      await latestRawTarget({
        latestSummaryPath: bare,
        rawDir,
        projectRoot,
        exists: async () => true,
      }),
    ).toBeUndefined();
  });
});
