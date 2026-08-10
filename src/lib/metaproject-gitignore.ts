import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs";

export const LEGACY_MEMORY_ARTIFACT_PATHS = [
  ".metaproject/data/memory/artifacts/latest.md",
  ".metaproject/data/memory/artifacts/latest.json",
] as const;

export type LegacyMemoryArtifact = {
  path: (typeof LEGACY_MEMORY_ARTIFACT_PATHS)[number];
  tracked: boolean;
};

export async function syncMetaprojectGitignore(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const blockStart = "# keryx:begin";
  const blockEnd = "# keryx:end";
  const metaprojectIgnoreBlock = renderMetaprojectGitignoreBlock().trim();
  const managedBlock = `${blockStart}\n${metaprojectIgnoreBlock}\n${blockEnd}`;
  const existing = (await pathExists(gitignorePath))
    ? await readFile(gitignorePath, "utf8")
    : "";
  const blockPattern = new RegExp(
    `${escapeRegExp(blockStart)}[\\s\\S]*?${escapeRegExp(blockEnd)}`,
  );
  const metaprojectIgnoreLines = new Set(metaprojectIgnoreBlock.split("\n"));
  const withoutExistingManagedBlock = existing.replace(blockPattern, "");
  const withoutLegacyMetaprojectIgnore = withoutExistingManagedBlock
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== ".metaproject/" && !metaprojectIgnoreLines.has(trimmed);
    })
    .join("\n");
  const next = `${withoutLegacyMetaprojectIgnore.trimEnd()}\n\n${managedBlock}\n`;
  if (existing !== next) {
    await writeFile(gitignorePath, next, "utf8");
  }
}

export async function findLegacyMemoryArtifacts(projectRoot: string): Promise<LegacyMemoryArtifact[]> {
  const found: LegacyMemoryArtifact[] = [];
  for (const relativePath of LEGACY_MEMORY_ARTIFACT_PATHS) {
    if (!(await pathExists(path.join(projectRoot, relativePath)))) continue;
    let tracked = false;
    try {
      tracked = (await Bun.spawn(
        ["git", "ls-files", "--error-unmatch", "--", relativePath],
        { cwd: projectRoot, stdout: "ignore", stderr: "ignore" },
      ).exited) === 0;
    } catch {
      // A project without Git still receives a useful untracked-path advisory.
    }
    found.push({ path: relativePath, tracked });
  }
  return found;
}

export function formatLegacyMemoryMigrationAdvisory(artifacts: LegacyMemoryArtifact[]): string {
  const tracked = artifacts.filter((artifact) => artifact.tracked).map((artifact) => artifact.path);
  const untracked = artifacts.filter((artifact) => !artifact.tracked).map((artifact) => artifact.path);
  const details = [
    tracked.length > 0 ? `tracked legacy reports: ${tracked.join(", ")}` : "",
    untracked.length > 0 ? `existing legacy reports: ${untracked.join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `Memory migration advisory: ${details}. Keryx no longer writes these paths. Preserve canonical .metaproject/memory entries; a maintainer may optionally untrack legacy reports with git rm --cached, but init/update never delete files or mutate the Git index.`;
}

export function renderMetaprojectGitignoreBlock(): string {
  return `# Metaproject: keep agent-facing context versioned, ignore executable/generated internals.
.metaproject/runtime/
.metaproject/core/**/*.ts
.metaproject/data/**/storage/
.metaproject/data/**/raw/
.metaproject/data/**/queries/
.metaproject/data/**/summaries/
.metaproject/data/gdctx/artifacts/
.metaproject/data/gdwiki/artifacts/
.metaproject/data/gdwiki/link-check/
.metaproject/data/health/history/
.metaproject/data/health/artifacts/latest.md
.metaproject/data/health/artifacts/latest.json
.metaproject/data/testing/history/
.metaproject/data/testing/logs/
.metaproject/data/testing/artifacts/latest.md
.metaproject/data/testing/artifacts/latest.json
.metaproject/data/tasks/runtime/
.metaproject/data/tasks/logs/
.metaproject/flows/.flow-init.lock/
.metaproject/flows/.flow-lock-*/
# Memory generated views, caches, reports, and atomic staging are disposable.
.metaproject/data/memory/index/
.metaproject/data/memory/embeddings/
.metaproject/data/memory/artifacts/
.metaproject/runtime/memory/
# Security: local-only HMAC key, self-protect state, and local hash report must never be committed.
.metaproject/data/security/raw/
.metaproject/data/security/raw/**
.metaproject/data/security/artifacts/latest.md
.metaproject/data/security/artifacts/latest.json
.metaproject/reports/
`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\[\]\\]/g, "\\$&");
}
