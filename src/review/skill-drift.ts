// Installed host copies of the review skills that are older than the ones keryx bundles (flow 457, T7, audit row 2).
//
// Claude Code and Codex read skills from their own directories (`<project>/.claude/skills`, `~/.claude/skills`,
// `~/.codex/skills`, `~/.agents/skills`). A copy installed by an older keryx keeps the old orchestration — on one
// machine a global review-orchestrator 1.6.0 ran beside a bundled 1.11.0 — and nothing told the operator. This
// compares the `version` in each installed SKILL.md with the bundled one and names the command that refreshes it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type SkillDrift = {
  skill: string;
  /** The installed SKILL.md that is older. */
  file: string;
  installed: string;
  bundled: string;
  /** The command that refreshes it. */
  refresh: string;
};

/** `version` from a SKILL.md frontmatter: a top-level `version:` or `metadata.version`. */
export function skillVersion(text: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return undefined;
  const line = /^\s*version:\s*["']?([0-9][\w.+-]*)["']?\s*$/m.exec(match[1]!);
  return line?.[1];
}

/** -1, 0 or 1 by numeric dotted comparison; a non-numeric part compares as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const order = Number.isFinite(nx) && Number.isFinite(ny) ? Math.sign(nx - ny) : x.localeCompare(y);
    if (order !== 0) return order;
  }
  return 0;
}

/** Bundled review skills: name -> version, from `<bundledRoot>/<name>/SKILL.md`. */
export function bundledReviewSkills(bundledRoot: string): Map<string, string> {
  const found = new Map<string, string>();
  if (!existsSync(bundledRoot)) return found;
  for (const name of readdirSync(bundledRoot)) {
    const file = path.join(bundledRoot, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const version = skillVersion(readFileSync(file, "utf8"));
    if (version !== undefined) found.set(name, version);
  }
  return found;
}

/** The directories a host reads skills from, with the command that refreshes a copy there. */
export function hostSkillDirs(projectRoot: string, home: string = homedir()): Array<{ dir: string; refresh: (skill: string, source: string) => string }> {
  const copy = (target: string) => (skill: string, source: string) => `rm -rf ${path.join(target, skill)} && cp -R ${source} ${path.join(target, skill)}`;
  return [
    { dir: path.join(projectRoot, ".claude", "skills"), refresh: () => "keryx skills install --target claude" },
    { dir: path.join(home, ".claude", "skills"), refresh: copy(path.join(home, ".claude", "skills")) },
    { dir: path.join(home, ".codex", "skills"), refresh: copy(path.join(home, ".codex", "skills")) },
    { dir: path.join(home, ".agents", "skills"), refresh: copy(path.join(home, ".agents", "skills")) },
  ];
}

/** Every installed review skill older than its bundled version. Never throws: an unreadable copy is skipped. */
export function reviewSkillDrift(input: { projectRoot: string; bundledRoot: string; home?: string | undefined }): SkillDrift[] {
  const bundled = bundledReviewSkills(input.bundledRoot);
  const drift: SkillDrift[] = [];
  for (const host of hostSkillDirs(input.projectRoot, input.home)) {
    for (const [skill, version] of bundled) {
      const file = path.join(host.dir, skill, "SKILL.md");
      try {
        if (!existsSync(file)) continue;
        const installed = skillVersion(readFileSync(file, "utf8"));
        if (installed === undefined || compareVersions(installed, version) >= 0) continue;
        drift.push({ skill, file, installed, bundled: version, refresh: host.refresh(skill, path.join(input.bundledRoot, skill)) });
      } catch {
        // an unreadable copy is not this check's to judge
      }
    }
  }
  return drift;
}

/** The bundled review skills shipped with this keryx. */
export function defaultBundledReviewRoot(): string {
  return path.resolve(import.meta.dir, "..", "gdskills", "bundled", "skills", "review");
}

export function renderSkillDrift(drift: readonly SkillDrift[]): string[] {
  return drift.map((d) => `warning: ${d.file} is ${d.skill} ${d.installed}, older than the bundled ${d.bundled}; the host runs the old copy. Refresh it: ${d.refresh}`);
}
