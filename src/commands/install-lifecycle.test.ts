import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { pathExists } from "../lib/fs";
import { withCwd } from "../lib/test-cwd";
import { initCommand } from "./init";
import { updateCommand } from "./update";

const MINIMAL_INIT = [
  "--yes",
  "--no-gdgraph",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security-hook",
  "--no-security-agent-hook",
  "--no-mcp",
  "--no-sac",
];

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

// AC2 clause 1, at the command surface: a caller can see what would change
// without changing it.
test("init --preview lists the lifecycle plan and writes nothing at all", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-preview-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\nKeep this.\n", "utf8");
    const before = await readFile(path.join(root, "AGENTS.md"), "utf8");

    const output = await capture(async () => {
      await withCwd(root, async () => {
        await initCommand([...MINIMAL_INIT, "--preview"]);
      });
    });

    expect(output).toContain("preview");
    expect(output).toContain("routing:index");
    expect(output).toContain("writes nothing");
    expect(output).toContain("create");
    expect(await pathExists(path.join(root, ".metaproject"))).toBe(false);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update --preview reports skip for an already-current pair and writes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-preview-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\nKeep this.\n", "utf8");
    await capture(async () => {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT);
      });
    });
    const indexBefore = await readFile(path.join(root, ".metaproject", "index.md"), "utf8");
    const routingBefore = await readFile(path.join(root, ".metaproject", "routing.md"), "utf8");

    const output = await capture(async () => {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks", "--preview"]);
      });
    });

    expect(output).toContain("preview");
    expect(output).toContain("skip");
    expect(output).toContain("writes nothing");
    expect(await readFile(path.join(root, ".metaproject", "index.md"), "utf8")).toBe(indexBefore);
    expect(await readFile(path.join(root, ".metaproject", "routing.md"), "utf8")).toBe(routingBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// AC2 clause 3 at the command surface: a rerun after an interrupted run tells
// the operator what was already begun and continues, rather than restarting
// silently or refusing.
test("update resumes an interrupted lifecycle and says the begun step was not rolled back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-resume-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\nKeep this.\n", "utf8");
    await capture(async () => {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT);
      });
    });
    const indexPath = path.join(root, ".metaproject", "index.md");
    const expected = await readFile(indexPath, "utf8");

    // Exactly the state a crash between the durable `begun` record and the
    // write leaves behind: the marker says "started", the target is not there.
    await rm(indexPath, { force: true });
    await writeJournal(root, {
      "routing:index": {
        status: "begun",
        writerVersion: await runningWriterVersion(),
        planId: "update:interrupted",
        intent: "update",
        startedAt: "2026-09-07T00:00:00.000Z",
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        baseDigest: null,
      },
    });

    const output = await capture(async () => {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks"]);
      });
    });

    expect(output).toContain("routing:index");
    expect(output).toContain("not rolled back");
    expect(await readFile(indexPath, "utf8")).toBe(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// AC2 clause 2 at the command surface.
test("update blocks and names both versions when another version left divergent bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-divergence-"));
  const previousExitCode = process.exitCode;
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\nKeep this.\n", "utf8");
    await capture(async () => {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT);
      });
    });
    const routingPath = path.join(root, ".metaproject", "routing.md");
    await writeFile(routingPath, "# hand edited by someone else\n", "utf8");
    await writeJournal(root, {
      "routing:full": {
        status: "completed",
        writerVersion: "0.0.1-previous",
        planId: "init:previous",
        intent: "init",
        startedAt: "2026-09-06T00:00:00.000Z",
        completedAt: "2026-09-06T00:00:01.000Z",
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        baseDigest: null,
      },
    });

    const output = await capture(async () => {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks"]);
      });
    });

    expect(output).toContain("0.0.1-previous");
    expect(output).toContain("--accept-version");
    expect(output).toContain("--keep-existing");
    expect(process.exitCode).toBe(1);
    expect(await readFile(routingPath, "utf8")).toBe("# hand edited by someone else\n");

    // The offered resolution actually resolves it.
    const resolved = await capture(async () => {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks", "--accept-version"]);
      });
    });
    expect(resolved).toContain("0.0.1-previous");
    expect(await readFile(routingPath, "utf8")).not.toBe("# hand edited by someone else\n");
  } finally {
    process.exitCode = previousExitCode;
    await rm(root, { recursive: true, force: true });
  }
});

async function runningWriterVersion(): Promise<string> {
  const { currentWriterVersion } = await import("../lib/install-plan");
  return currentWriterVersion();
}

async function writeJournal(
  projectRoot: string,
  steps: Record<string, Record<string, unknown>>,
): Promise<void> {
  const { INSTALL_JOURNAL_RELATIVE_PATH } = await import("../lib/install-plan");
  const journalPath = path.join(projectRoot, ".metaproject", INSTALL_JOURNAL_RELATIVE_PATH);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(journalPath), { recursive: true });
  await writeFile(
    journalPath,
    `${JSON.stringify(
      {
        schemaVersion: "1.0",
        writerVersion: await runningWriterVersion(),
        intent: "update",
        planId: "seeded",
        inputFingerprint: "sha256:seeded",
        startedAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:00:00.000Z",
        steps,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
