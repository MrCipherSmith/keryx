import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { pathExists } from "./fs";
import {
  applyInstallPlan,
  buildInstallPlan,
  formatInstallPlan,
  InstallCrashSignal,
  INSTALL_JOURNAL_RELATIVE_PATH,
  readInstallJournal,
  type InstallStep,
} from "./install-plan";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-install-plan-"));
  return path.join(root, ".metaproject");
}

function steps(metaprojectRoot: string, routing = "ROUTING v1"): InstallStep[] {
  return [
    {
      id: "rules:readme",
      path: path.join(metaprojectRoot, "rules", "README.md"),
      content: "RULES\n",
      mode: "create-if-absent",
    },
    {
      id: "routing:full",
      path: path.join(metaprojectRoot, "routing.md"),
      content: `${routing}\n`,
      mode: "managed",
    },
    {
      id: "routing:index",
      path: path.join(metaprojectRoot, "index.md"),
      content: "INDEX\n",
      mode: "managed",
    },
  ];
}

// AC2 clause 1: a caller can see create/update/conflict/skip with expected base
// digests without changing anything.
test("a plan reports create/update/skip with expected base digests and writes nothing", async () => {
  const metaprojectRoot = await fixture();
  try {
    await writeFile(
      await ensureDir(path.join(metaprojectRoot, "index.md")),
      "INDEX\n",
      "utf8",
    );
    await writeFile(
      await ensureDir(path.join(metaprojectRoot, "routing.md")),
      "ROUTING v0\n",
      "utf8",
    );

    const plan = await buildInstallPlan({
      metaprojectRoot,
      intent: "init",
      steps: steps(metaprojectRoot),
      writerVersion: "9.9.9",
    });

    const byId = new Map(plan.steps.map((step) => [step.id, step]));
    expect(byId.get("rules:readme")?.outcome).toBe("create");
    expect(byId.get("rules:readme")?.expectedBaseDigest).toBeNull();
    expect(byId.get("routing:full")?.outcome).toBe("update");
    expect(byId.get("routing:full")?.expectedBaseDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(byId.get("routing:index")?.outcome).toBe("skip");
    expect(byId.get("routing:index")?.reason).toBe("already-current");

    const rendered = formatInstallPlan(plan);
    expect(rendered).toContain("writes nothing");
    expect(rendered).toContain("rules:readme");
    expect(rendered).toContain(byId.get("routing:full")?.expectedBaseDigest ?? "MISSING");

    // The plan itself is read-only: no journal, no new files.
    expect(await pathExists(path.join(metaprojectRoot, INSTALL_JOURNAL_RELATIVE_PATH))).toBe(false);
    expect(await pathExists(path.join(metaprojectRoot, "rules", "README.md"))).toBe(false);
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe("ROUTING v0\n");
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
});

// AC2 clause 3: a crash after a step leaves a partial state and a safe
// continuation. The record that a step BEGAN must be durable before the step,
// or a restart cannot tell "never started" from "already applied".
test("a crash mid-step leaves a durable begun record that a rerun reports and continues", async () => {
  const metaprojectRoot = await fixture();
  try {
    let crashed = false;
    await expect(
      (async () => {
        const plan = await buildInstallPlan({
          metaprojectRoot,
          intent: "init",
          steps: steps(metaprojectRoot),
          writerVersion: "9.9.9",
        });
        await applyInstallPlan({
          plan,
          beforeStepMutation: (id) => {
            if (id === "routing:full") {
              crashed = true;
              throw new InstallCrashSignal("simulated power loss");
            }
          },
        });
      })(),
    ).rejects.toThrow(InstallCrashSignal);
    expect(crashed).toBe(true);

    const journal = await readInstallJournal(metaprojectRoot);
    expect(journal?.steps["rules:readme"]?.status).toBe("completed");
    expect(journal?.steps["routing:full"]?.status).toBe("begun");
    expect(journal?.steps["routing:index"]).toBeUndefined();
    // The crashed step never reached its target.
    expect(await pathExists(path.join(metaprojectRoot, "routing.md"))).toBe(false);

    const resumed = await buildInstallPlan({
      metaprojectRoot,
      intent: "init",
      steps: steps(metaprojectRoot),
      writerVersion: "9.9.9",
    });
    expect(resumed.carriedOver).toEqual(["routing:full"]);
    const resumedById = new Map(resumed.steps.map((step) => [step.id, step]));
    expect(resumedById.get("rules:readme")?.outcome).toBe("skip");
    expect(resumedById.get("rules:readme")?.reason).toBe("already-current");
    expect(resumedById.get("routing:full")?.previouslyBegun).toBe(true);
    expect(formatInstallPlan(resumed)).toContain("not rolled back");

    const report = await applyInstallPlan({ plan: resumed });
    expect(report.completed).toEqual(["routing:full", "routing:index"]);
    expect(report.skipped).toEqual(["rules:readme"]);
    expect(report.carriedOver).toEqual(["routing:full"]);
    expect(report.notices.join("\n")).toContain("not rolled back");
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe("ROUTING v1\n");
    expect(await readFile(path.join(metaprojectRoot, "index.md"), "utf8")).toBe("INDEX\n");
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
});

// AC2 clause 2: bytes on disk written by a different version, which that
// version's own record can no longer account for, are a conflict that names
// both versions and a resolution — never a silent overwrite.
test("bytes a different version wrote and cannot account for are a named conflict with resolutions", async () => {
  const metaprojectRoot = await fixture();
  try {
    const first = await buildInstallPlan({
      metaprojectRoot,
      intent: "init",
      steps: steps(metaprojectRoot, "ROUTING old"),
      writerVersion: "0.0.1",
    });
    await applyInstallPlan({ plan: first });

    // A third party edits what 0.0.1 published; 9.9.9 now runs.
    await writeFile(path.join(metaprojectRoot, "routing.md"), "ROUTING hand-edited\n", "utf8");

    const plan = await buildInstallPlan({
      metaprojectRoot,
      intent: "update",
      steps: steps(metaprojectRoot, "ROUTING new"),
      writerVersion: "9.9.9",
    });
    const conflicted = plan.steps.find((step) => step.id === "routing:full");
    expect(conflicted?.outcome).toBe("conflict");
    expect(conflicted?.reason).toBe("version-divergence");
    expect(conflicted?.recordedWriterVersion).toBe("0.0.1");
    expect(conflicted?.versionTransition).toEqual({ from: "0.0.1", to: "9.9.9" });

    const rendered = formatInstallPlan(plan);
    expect(rendered).toContain("0.0.1");
    expect(rendered).toContain("9.9.9");
    expect(rendered).toContain("--accept-version");
    expect(rendered).toContain("--keep-existing");

    // No resolution: nothing is published at all, so the pair cannot go half-new.
    const blocked = await applyInstallPlan({ plan });
    expect(blocked.blocked.map((entry) => entry.id)).toEqual(["routing:full"]);
    expect(blocked.completed).toEqual([]);
    expect(blocked.pending).toContain("routing:index");
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe("ROUTING hand-edited\n");

    // keep-existing leaves the divergent bytes and says so.
    const kept = await applyInstallPlan({ plan, resolution: "keep-existing" });
    expect(kept.kept).toEqual(["routing:full"]);
    expect(kept.skipped).toContain("routing:index");
    expect(kept.blocked).toEqual([]);
    expect(kept.notices.join("\n")).toContain("kept");
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe("ROUTING hand-edited\n");

    // accept-version replaces them and reports whose bytes were replaced.
    const accepted = await applyInstallPlan({ plan, resolution: "accept-version" });
    expect(accepted.completed).toContain("routing:full");
    expect(accepted.notices.join("\n")).toContain("0.0.1");
    expect(await readFile(path.join(metaprojectRoot, "routing.md"), "utf8")).toBe("ROUTING new\n");

    const journal = await readInstallJournal(metaprojectRoot);
    expect(journal?.steps["routing:full"]?.writerVersion).toBe("9.9.9");
  } finally {
    await rm(path.dirname(metaprojectRoot), { recursive: true, force: true });
  }
});

async function ensureDir(filePath: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(filePath), { recursive: true });
  return filePath;
}
