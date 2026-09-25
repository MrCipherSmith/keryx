// Flow 312 T14 — a deterministic, in-process rehearsal of the same
// observe -> extract -> accept -> apply path the real e2e CLI run (scratchpad
// `e2e-312.md`, produced by a separate-process run of `keryx learn` against a
// temp project) exercises. This file calls the `src/learning/` service
// functions directly rather than `learnCommand` (`src/commands/learn.ts`):
// `src/commands/` is an ADAPTER and `src/learning/` is `core` —
// `src/lib/import-zones.ts` says core can never import client or adapter, no
// exception — so staying on the service layer keeps this file inside the
// zone its own directory belongs to. `src/commands/learn.test.ts` already
// covers the CLI layer's flag parsing and TTY refusals over these same
// service functions.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptPattern } from "./accept";
import { applyLearnedPattern } from "./apply";
import { runExtract } from "./extract";
import { observeHostHookPayload } from "./observe";
import { observationFilePath } from "./paths";

async function withProject<T>(fn: (root: string, homeDir: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-learning-e2e-root-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "keryx-learning-e2e-home-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  try {
    return await fn(root, homeDir);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function seedSkill(root: string, module: string, name: string): Promise<void> {
  const skillRoot = path.join(root, ".metaproject", "project-skills", module, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    [
      `# ${module} ${name}`,
      "",
      "Version: 0.1.0",
      `Module: ${module}`,
      `Target: src/${module}`,
      "",
      "## Review Lessons",
      "",
      "- No review lessons recorded yet.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(skillRoot, "skill-changelog.md"), "# Changelog\n", "utf8");
}

async function seedRegistry(root: string, entries: Array<{ module: string; name: string }>): Promise<void> {
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      modules: {
        gdskills: {
          projectSkillRegistry: entries.map((entry) => ({
            module: entry.module,
            name: entry.name,
            target: `src/${entry.module}`,
            path: `.metaproject/project-skills/${entry.module}/${entry.name}`,
            version: "0.1.0",
            status: "active",
            updatedAt: "2026-09-24T00:00:00.000Z",
          })),
        },
      },
    }),
    "utf8",
  );
}

describe("learning e2e: observe (Claude hook) -> extract -> accept -> apply", () => {
  test("a failing-then-passing bun test pair observed via observeHostHookPayload becomes one candidate, is accepted, and applies into a fixture project skill", async () => {
    await withProject(async (root, homeDir) => {
      const storeOptions = { homeDir };
      const now = () => new Date("2026-09-24T00:00:00.000Z");

      // (a) observe: a Claude-shaped PostToolUseFailure then a matching PostToolUse, same test command.
      await observeHostHookPayload(
        root,
        "claude",
        {
          hook_event_name: "PostToolUseFailure",
          session_id: "sess-e2e",
          tool_name: "Bash",
          tool_use_id: "tu-1",
          cwd: root,
          tool_input: { command: "bun test src/foo.test.ts" },
          tool_response: { stdout: "1 fail\n0 pass" },
        },
        { ...storeOptions, now: () => "2026-09-24T00:00:01.000Z" },
      );
      await observeHostHookPayload(
        root,
        "claude",
        {
          hook_event_name: "PostToolUse",
          session_id: "sess-e2e",
          tool_name: "Bash",
          tool_use_id: "tu-2",
          cwd: root,
          tool_input: { command: "bun test src/foo.test.ts" },
          tool_response: { stdout: "0 fail\n5 pass" },
        },
        { ...storeOptions, now: () => "2026-09-24T00:00:02.000Z" },
      );

      // The observation file is dated from the mocked `now` passed to
      // `observeHostHookPayload` above (2026-09-24), never the real wall
      // clock -- deriving `today` from `new Date()` drifts one day off (and
      // the read then 404s) the moment the real calendar date moves past
      // the hardcoded one, which is exactly what happened here.
      const today = "2026-09-24";
      const observationsRaw = await readFile(observationFilePath(root, today), "utf8");
      const observationLines = observationsRaw.split("\n").filter((line) => line.length > 0);
      expect(observationLines).toHaveLength(2);
      // O-1: no absolute project path or home dir survives into a stored preview.
      for (const line of observationLines) {
        expect(line).not.toContain(root);
        expect(line).not.toContain(homeDir);
      }

      // (b) extract: exactly one candidate, from failing-to-passing-test.
      const report = await runExtract(root, { now: now(), ...storeOptions });
      expect(report.created).toHaveLength(1);
      expect(report.signals["failing-to-passing-test"]).toBe(1);
      const id = report.created[0] as string;
      expect(id).toStartWith("testing.");

      // (d) accept, with `isTerminal` injected true — the same seam
      // `src/commands/learn.ts`'s `runAccept` feeds from `resolveTerminal`,
      // exercised here without a real TTY.
      const accepted = await acceptPattern(root, id, { isTerminal: true, now, ...storeOptions });
      expect(accepted.status).toBe("accepted");
      expect(accepted.scope).toBe("project");
      expect(accepted.indexUpdated).toBe(true);

      // (e) apply: dry-run writes nothing durable, then a real apply updates
      // only the target project skill via `applyLearningProposal`.
      await seedRegistry(root, [{ module: "demo", name: "e2e" }]);
      await seedSkill(root, "demo", "e2e");

      const proposalsDir = path.join(root, ".metaproject", "data", "gdskills", "proposals");
      const dryRun = await applyLearnedPattern(root, id, { skill: "demo/e2e", dryRun: true, ...storeOptions });
      expect(dryRun.applied.dryRun).toBe(true);
      await expect(readFile(proposalsDir, "utf8")).rejects.toThrow(); // directory does not exist yet: nothing was written

      const applied = await applyLearnedPattern(root, id, { skill: "demo/e2e", ...storeOptions });
      expect(applied.applied.dryRun).toBe(false);
      expect(applied.applied.previousVersion).toBe("0.1.0");
      expect(applied.applied.nextVersion).not.toBe("0.1.0");

      const updatedSkill = await readFile(path.join(root, ".metaproject", "project-skills", "demo", "e2e", "SKILL.md"), "utf8");
      expect(updatedSkill).toContain("Testing Rules");
      expect(updatedSkill).toContain('When the test command "bun test src/foo.test.ts" fails in this project');
    });
  });
});
