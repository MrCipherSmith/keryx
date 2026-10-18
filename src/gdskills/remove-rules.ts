import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { removeContained, rmdirIfEmptyContained } from "../lib/contained-write";
import { optionValue } from "../lib/args";
import { assertProjectWritesContained, PROJECT_SKILLS_MANIFEST_PATH } from "./project-skills";
import { PROJECT_RULES_DIR, projectRulePathFor, readProjectRuleRegistry, updateProjectRuleRegistry } from "./project-rules";

const LABEL = "keryx skills remove --rule";

export type RemoveProjectRuleOptions = { ref: string; dryRun?: boolean };

export type RemovedRulePart = {
  part: "rule-file" | "rule-directory" | "registry";
  /** Project-relative, posix. */
  path: string;
  status: "removed" | "would-remove" | "absent";
};

export type RemoveProjectRuleResult = {
  ref: string;
  mode: "copy" | "link";
  dryRun: boolean;
  parts: RemovedRulePart[];
};

function safeRef(ref: string): void {
  const segments = ref.split("/");
  if (ref === "" || path.isAbsolute(ref) || ref.includes("\\") || segments.some((s) => s === ".." || s === "." || s === "" || s === ".git")) {
    throw new Error(`${LABEL}: ${ref === "" ? "a ref is required" : `${ref} is not a path below ${PROJECT_RULES_DIR}/`}. Nothing was removed.`);
  }
}

/**
 * Remove a rule `keryx skills import --rules` registered: its copy under
 * `.metaproject/rules/project/` (copy mode), the directories that leaves empty
 * below `rules/project/`, and its registry entry. A linked rule has no copy, and
 * its origin file is never touched. A file under `rules/project/` that was not
 * imported, and anything under `rules/core/`, is outside this command's reach.
 */
export async function removeProjectRule(projectRoot: string, options: RemoveProjectRuleOptions): Promise<RemoveProjectRuleResult> {
  safeRef(options.ref);
  const entry = (await readProjectRuleRegistry(projectRoot)).find((candidate) => candidate.ref === options.ref);
  if (entry === undefined) {
    throw new Error(`${LABEL}: ${options.ref} is not a rule imported with \`keryx skills import --rules\`; nothing was removed.`);
  }
  if (entry.path !== projectRulePathFor(entry.ref)) {
    throw new Error(
      `${LABEL}: the registry's path for ${entry.ref} is ${entry.path}, not ${projectRulePathFor(entry.ref)}. Refusing to remove anything for it; fix the entry in ${PROJECT_SKILLS_MANIFEST_PATH} by hand.`,
    );
  }
  await assertProjectWritesContained(projectRoot, [entry.path, PROJECT_SKILLS_MANIFEST_PATH]);

  const dryRun = options.dryRun === true;
  const parts: RemovedRulePart[] = [];
  const target = path.join(projectRoot, entry.path);

  if (entry.mode === "copy") {
    const info = await lstat(target).catch(() => undefined);
    if (info !== undefined && !info.isFile()) {
      throw new Error(`${LABEL}: ${entry.path} is not a regular file; nothing was removed.`);
    }
    if (!dryRun && info !== undefined) await removeContained(projectRoot, entry.path);
    parts.push({ part: "rule-file", path: entry.path, status: info === undefined ? "absent" : dryRun ? "would-remove" : "removed" });

    let child = path.posix.dirname(entry.path);
    let childName = path.posix.basename(entry.path);
    while (child !== PROJECT_RULES_DIR && child.startsWith(`${PROJECT_RULES_DIR}/`)) {
      const siblings = await readdir(path.join(projectRoot, child)).catch(() => undefined);
      const emptied = siblings !== undefined && (dryRun ? siblings.every((name) => name === childName) : siblings.length === 0);
      if (!emptied) break;
      if (!dryRun) await rmdirIfEmptyContained(projectRoot, child);
      parts.push({ part: "rule-directory", path: child, status: dryRun ? "would-remove" : "removed" });
      childName = path.posix.basename(child);
      child = path.posix.dirname(child);
    }
  }

  if (!dryRun) await updateProjectRuleRegistry(projectRoot, { remove: [entry.ref] });
  parts.push({ part: "registry", path: PROJECT_SKILLS_MANIFEST_PATH, status: dryRun ? "would-remove" : "removed" });
  return { ref: entry.ref, mode: entry.mode, dryRun, parts };
}

export function renderRemoveProjectRule(result: RemoveProjectRuleResult): string {
  const heading = result.dryRun ? `# skills remove --rule ${result.ref} (dry run)` : `# skills remove --rule ${result.ref}`;
  const lines = result.parts.map((part) => `- ${part.status} ${part.part}: ${part.path}`);
  const note = result.mode === "link" ? "\nA linked rule has no copy; its origin file was not touched.\n" : "";
  return `${heading}\n\n${lines.join("\n")}\n${note}`;
}

export async function runSkillsRemoveRuleCommand(args: string[]): Promise<void> {
  const ref = optionValue(args, "--rule");
  if (ref === undefined || ref === "") {
    throw new Error(`Usage: keryx skills remove --rule <ref> [--dry-run] [--json]`);
  }
  const result = await removeProjectRule(process.cwd(), { ref, dryRun: args.includes("--dry-run") });
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderRemoveProjectRule(result));
}
