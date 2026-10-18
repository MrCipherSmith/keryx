import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { writeContained } from "../lib/contained-write";
import { pathExists } from "../lib/fs";
import { gateRowParts, gateText, portableOriginRef, type ImportSecurity } from "./import-skills";
import { projectRuleEntry } from "./import-rules";
import { readProjectRuleRegistry, sha256Hex, updateProjectRuleRegistry, type ProjectRuleMode, type ProjectRuleRegistryEntry } from "./project-rules";
import { assertProjectWritesContained, PROJECT_SKILLS_MANIFEST_PATH, resolveOriginPath } from "./project-skills";

export type UpdateProjectRulesOptions = {
  projectRoot: string;
  /** Update one rule, by its ref. Default: every registered rule. */
  ref?: string;
  dryRun?: boolean;
  /** Replace a copy that was edited in the project. */
  force?: boolean;
  allowFlagged?: boolean;
};

export type UpdatedProjectRuleStatus =
  | "current"
  | "updated"
  | "would-update"
  | "modified-locally"
  | "skipped"
  | "refused"
  | "would-refuse";

export type UpdatedProjectRule = {
  ref: string;
  mode: ProjectRuleMode;
  status: UpdatedProjectRuleStatus;
  /** Project-relative path of the copy, or of the slot a copy would take. */
  path: string;
  origin: string;
  /** The hash the registry recorded for the rule. */
  oldSha256: string;
  /** The hash of the origin as it is now. */
  newSha256?: string;
  reason?: string;
  security?: ImportSecurity;
};

export type UpdateProjectRulesResult = { rules: UpdatedProjectRule[]; dryRun: boolean; force: boolean };

/**
 * Re-read every rule `keryx skills import --rules` registered from the origin it
 * recorded, report drift by sha256, and bring the copy (or, for a linked rule,
 * the pin) up to the origin. The rewritten text goes through the same security
 * gate as the import. A copy edited in the project is reported, and replaced
 * only with `force`.
 */
export async function updateProjectRules(options: UpdateProjectRulesOptions): Promise<UpdateProjectRulesResult> {
  const registry = await readProjectRuleRegistry(options.projectRoot);
  const selected = options.ref === undefined ? registry : registry.filter((entry) => entry.ref === options.ref);
  if (options.ref !== undefined && selected.length === 0) {
    throw new Error(`keryx skills update --rules: no imported rule ${options.ref}. Imported: ${registry.map((entry) => entry.ref).join(", ") || "none"}.`);
  }
  await assertProjectWritesContained(options.projectRoot, [
    ...selected.filter((entry) => entry.mode === "copy").map((entry) => entry.path),
    PROJECT_SKILLS_MANIFEST_PATH,
  ]);

  const dryRun = options.dryRun === true;
  const rows: UpdatedProjectRule[] = [];
  const upsert: ProjectRuleRegistryEntry[] = [];
  for (const entry of selected) {
    const base = { ref: entry.ref, mode: entry.mode, path: entry.path, origin: entry.origin, oldSha256: entry.sha256 };
    const originPath = resolveOriginPath(entry.origin, options.projectRoot);
    const originInfo = await lstat(originPath).catch(() => undefined);
    if (originInfo === undefined || !originInfo.isFile()) {
      rows.push({ ...base, status: "skipped", reason: "origin file can no longer be read" });
      continue;
    }
    const content = await readFile(originPath, "utf8");
    const newSha256 = sha256Hex(content);
    const drifted = newSha256 !== (entry.mode === "link" ? entry.sha256 : entry.originSha256);

    let localText: string | undefined;
    if (entry.mode === "copy" && (await pathExists(path.join(options.projectRoot, entry.path)))) {
      localText = await readFile(path.join(options.projectRoot, entry.path), "utf8");
    }
    const editedLocally = localText !== undefined && sha256Hex(localText) !== entry.sha256;
    if (editedLocally && options.force !== true) {
      rows.push({ ...base, newSha256, status: "modified-locally", reason: "the project's copy was edited; left as it is, pass --force to replace it" });
      continue;
    }
    if (!drifted && !editedLocally && (entry.mode === "link" || localText !== undefined)) {
      rows.push({ ...base, newSha256, status: "current" });
      continue;
    }

    const verdict = await gateText(options.projectRoot, content, entry.path, options.allowFlagged === true);
    if (verdict.kind === "refuse") {
      rows.push({ ...base, newSha256, status: dryRun ? "would-refuse" : "refused", reason: verdict.reason, security: verdict.security });
      continue;
    }
    if (verdict.kind === "blocked") {
      rows.push({ ...base, newSha256, status: "skipped", reason: `blocked by the security gate: ${verdict.reason}` });
      continue;
    }
    const parts = gateRowParts(verdict, dryRun);
    const next = projectRuleEntry(
      {
        ref: entry.ref,
        content,
        writtenText: verdict.content,
        origin: portableOriginRef(originPath, options.projectRoot),
        originSha256: newSha256,
      },
      entry.mode,
    );
    if (!dryRun) {
      if (entry.mode === "copy") await writeContained(options.projectRoot, entry.path, verdict.content);
      upsert.push(next);
    }
    rows.push({
      ...base,
      newSha256,
      status: dryRun ? "would-update" : "updated",
      ...(parts.reason !== undefined ? { reason: parts.reason } : {}),
      ...(parts.security ? { security: parts.security } : {}),
    });
  }
  if (upsert.length > 0) await updateProjectRuleRegistry(options.projectRoot, { upsert });
  return { rules: rows, dryRun, force: options.force === true };
}

export function renderUpdateProjectRulesMarkdown(result: UpdateProjectRulesResult): string {
  const heading = result.dryRun ? "# skills update --rules (dry run)" : "# skills update --rules";
  if (result.rules.length === 0) return `${heading}\n\nNo imported rules.\n`;
  const lines = result.rules.map((row) => {
    const hashes = row.newSha256 !== undefined && row.newSha256 !== row.oldSha256 ? ` ${row.oldSha256.slice(0, 8)} → ${row.newSha256.slice(0, 8)}` : "";
    return `- ${row.status} \`${row.ref}\` (${row.mode})${hashes}${row.reason !== undefined ? ` — ${row.reason}` : ""}`;
  });
  return `${heading}\n\n${lines.join("\n")}\n`;
}

export async function runSkillsUpdateRulesCommand(args: string[]): Promise<void> {
  const ref = args.slice(1).find((arg) => !arg.startsWith("--"));
  const result = await updateProjectRules({
    projectRoot: process.cwd(),
    ...(ref !== undefined ? { ref } : {}),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    allowFlagged: args.includes("--allow-flagged"),
  });
  console.log(args.includes("--json") ? JSON.stringify(result, null, 2) : renderUpdateProjectRulesMarkdown(result));
  if (result.rules.some((row) => row.status === "refused")) process.exitCode = 1;
}
