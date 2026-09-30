// Flow 361 T9, AC11: `keryx standard doctor` reads the entrypoint the
// manifest names for each runtime — the local target or the shared team file
// — so a repository migrated to local scope raises no
// `entrypoint-missing-index-link` and keeps the `agent` profile, while a
// shared-scope team file without the link is still an error.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { initCommand } from "../commands/init";
import { withCwd } from "../lib/test-cwd";
import { evaluateProfiles } from "./profiles";
import type { MetaprojectManifest } from "./types";
import { validateWorkspace } from "./validate";

const BLOCK = "<!-- keryx:index -->\nRead .metaproject/index.md first.\n<!-- /keryx:index -->\n";
const LOCAL_CLAUDE = { runtime: "claude", path: "CLAUDE.local.md", scope: "local" };
const LOCAL_CODEX = { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" };
const SHARED_CLAUDE = { runtime: "claude", path: "CLAUDE.md", scope: "shared" };
const SHARED_CODEX = { runtime: "codex", path: "AGENTS.md", scope: "shared" };
const LOCAL_SETTINGS = { path: ".claude/settings.local.json", scope: "local" };

/** The smallest workspace `validateWorkspace` accepts, with an agent module enabled and `agentEntrypoints` as given. */
async function workspace(agentEntrypoints: unknown, files: Record<string, string>): Promise<{ root: string; manifest: MetaprojectManifest }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-standard-entrypoints-"));
  for (const dir of ["modules", "rules", "skills", "data"]) await mkdir(path.join(root, ".metaproject", dir), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "index.md"), "# Index\n", "utf8");
  await writeFile(path.join(root, ".metaproject", "README.md"), "# Readme\n", "utf8");
  // Only the entrypoint issues and the profile evaluation are asserted on, so
  // the manifest carries just what those two read.
  const manifest = {
    standardVersion: "0.1.0",
    profiles: ["minimal", "agent"],
    modules: { gdctx: { enabled: true, manifest: ".metaproject/modules/gdctx.md" } },
    agentEntrypoints,
  } as unknown as MetaprojectManifest;
  await writeFile(path.join(root, ".metaproject", "modules", "gdctx.md"), "# gdctx\n", "utf8");
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const [rel, content] of Object.entries(files)) await writeFile(path.join(root, rel), content, "utf8");
  return { root, manifest };
}

function entrypointIssues(result: Awaited<ReturnType<typeof validateWorkspace>>): string[] {
  return result.errors.filter((issue) => issue.code === "entrypoint-missing-index-link").map((issue) => issue.message);
}

describe("standard: the entrypoint the manifest names links the index (flow 361)", () => {
  test("a migrated repository — team files without the block, local targets with it — raises no entrypoint error and keeps agent", async () => {
    const { root, manifest } = await workspace(
      { root: [LOCAL_CLAUDE, LOCAL_CODEX], claudeSettings: LOCAL_SETTINGS },
      { "AGENTS.md": "# Team\n", "CLAUDE.md": "# Claude\n", "CLAUDE.local.md": `# Local\n\n${BLOCK}`, "AGENTS.override.md": `# Team\n\n${BLOCK}` },
    );
    try {
      expect(entrypointIssues(await validateWorkspace(root))).toEqual([]);
      expect((await evaluateProfiles(root, manifest)).satisfied).toContain("agent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a shared-scope team file without the link is still an error", async () => {
    const { root, manifest } = await workspace(
      { root: [SHARED_CLAUDE, SHARED_CODEX], claudeSettings: LOCAL_SETTINGS },
      { "AGENTS.md": "# Team\n", "CLAUDE.md": `# Claude\n\n${BLOCK}` },
    );
    try {
      expect(entrypointIssues(await validateWorkspace(root))).toEqual(["Root entrypoint AGENTS.md does not link .metaproject/index.md"]);
      // CLAUDE.md, the other named target, does link it.
      expect((await evaluateProfiles(root, manifest)).satisfied).toContain("agent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a legacy manifest keeps the old reading: the team files are the targets", async () => {
    const { root } = await workspace({ root: ["AGENTS.md", "CLAUDE.md"] }, { "AGENTS.md": "# Team\n" });
    try {
      expect(entrypointIssues(await validateWorkspace(root))).toEqual(["Root entrypoint AGENTS.md does not link .metaproject/index.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a local target that exists without the link is an error naming keryx update", async () => {
    const { root } = await workspace(
      { root: [LOCAL_CLAUDE, LOCAL_CODEX], claudeSettings: LOCAL_SETTINGS },
      { "AGENTS.md": "# Team\n", "CLAUDE.local.md": "# Local notes\n" },
    );
    try {
      const result = await validateWorkspace(root);
      expect(entrypointIssues(result)).toEqual(["Root entrypoint CLAUDE.local.md does not link .metaproject/index.md"]);
      expect(result.errors.find((issue) => issue.code === "entrypoint-missing-index-link")?.fix).toContain("keryx update");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("local targets missing in this checkout are no error, but the agent profile needs one of them present", async () => {
    const { root, manifest } = await workspace({ root: [LOCAL_CLAUDE, LOCAL_CODEX], claudeSettings: LOCAL_SETTINGS }, { "AGENTS.md": "# Team\n" });
    try {
      expect(entrypointIssues(await validateWorkspace(root))).toEqual([]);
      expect((await evaluateProfiles(root, manifest)).satisfied).not.toContain("agent");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keryx init over a repository with a team AGENTS.md: no entrypoint error, agent and full kept", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-standard-entrypoints-init-"));
    try {
      Bun.spawnSync(["git", "init", "-q"], { cwd: root });
      await writeFile(path.join(root, "AGENTS.md"), "# Team\n\nUse the team rules.\n", "utf8");
      await withCwd(root, async () => {
        await initCommand(["--yes"]);
      });
      const result = await validateWorkspace(root);
      expect(entrypointIssues(result)).toEqual([]);
      expect(result.warnings.filter((issue) => issue.code === "profile-not-satisfied")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
