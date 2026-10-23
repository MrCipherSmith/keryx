import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { writeContained } from "../lib/contained-write";
import {
  gateRowParts,
  gateText,
  onlyMatcher,
  onlyOption,
  portableOriginRef,
  type ImportSecurity,
} from "./import-skills";
import {
  projectRulePathFor,
  readProjectRuleRegistry,
  sha256Hex,
  updateProjectRuleRegistry,
  type ProjectRuleMode,
  type ProjectRuleRegistryEntry,
} from "./project-rules";
import { assertProjectWritesContained, PROJECT_SKILLS_MANIFEST_PATH, resolveOriginPath } from "./project-skills";
import { undeclaredCitationHint } from "./references-check";
import { parseRuleFrontmatter } from "./rule-frontmatter";

export type ImportProjectRulesOptions = {
  projectRoot: string;
  /** The directory of rules to import. */
  from: string;
  /** Globs (`*`, `?`) matched against a rule's relative path or its file name. */
  only?: string[];
  dryRun?: boolean;
  force?: boolean;
  allowFlagged?: boolean;
  /** Register the rules where they are instead of copying them. */
  link?: boolean;
};

export type ImportedProjectRuleStatus =
  | "imported"
  | "would-import"
  | "overwritten"
  | "would-overwrite"
  | "unchanged"
  | "differs"
  | "linked"
  | "would-link"
  | "skipped"
  | "refused"
  | "would-refuse";

export type ImportedProjectRule = {
  /** Path below the source directory, posix; the same below `rules/project/`. */
  ref: string;
  status: ImportedProjectRuleStatus;
  /** Project-relative path of the copy, or of the slot a copy would take. */
  path: string;
  origin: string;
  sha256?: string;
  reason?: string;
  security?: ImportSecurity;
};

export type ImportProjectRulesResult = {
  from: string;
  only: string[];
  link: boolean;
  rules: ImportedProjectRule[];
  dryRun: boolean;
  force: boolean;
};

const RULE_EXTENSIONS = new Set([".mdc", ".md"]);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

type Candidate = { ref: string; absolute: string; symlink: boolean };

async function collectRules(root: string, relative = ""): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const ref = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) found.push(...(await collectRules(root, ref)));
      continue;
    }
    if (!RULE_EXTENSIONS.has(path.extname(entry.name))) continue;
    if (entry.isSymbolicLink()) found.push({ ref, absolute: path.join(root, ref), symlink: true });
    else if (entry.isFile()) found.push({ ref, absolute: path.join(root, ref), symlink: false });
  }
  return found.sort((a, b) => a.ref.localeCompare(b.ref));
}

async function existingText(projectRoot: string, rel: string): Promise<{ text?: string; notRegular?: true }> {
  const absolute = path.join(projectRoot, rel);
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) return { notRegular: true };
    return { text: await readFile(absolute, "utf8") };
  } catch {
    return {};
  }
}

export function projectRuleEntry(
  rule: { ref: string; content: string; writtenText: string; origin: string; originSha256: string },
  mode: ProjectRuleMode,
): ProjectRuleRegistryEntry {
  const front = parseRuleFrontmatter(rule.content);
  return {
    kind: "rule",
    ref: rule.ref,
    path: projectRulePathFor(rule.ref),
    mode,
    origin: rule.origin,
    sha256: mode === "link" ? rule.originSha256 : sha256Hex(rule.writtenText),
    originSha256: rule.originSha256,
    description: front.description,
    globs: front.globs,
    alwaysApply: front.alwaysApply,
    ...(front.taskTypes.length > 0 ? { taskTypes: front.taskTypes } : {}),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Import a directory of project rules into `.metaproject/rules/project/`, or
 * register them in place with `link`. Each file goes through the security gate
 * `SKILL.md` goes through; every destination is checked for a symlink out of the
 * project before anything is written, a dry run included.
 */
export async function importProjectRules(options: ImportProjectRulesOptions): Promise<ImportProjectRulesResult> {
  const label = "keryx skills import --rules";
  const only = options.only ?? [];
  if (only.some((glob) => glob.trim() === "")) {
    throw new Error(`${label}: --only needs a glob; an empty value selects nothing.`);
  }
  const root = resolveOriginPath(options.from, options.projectRoot);
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    throw new Error(`${label}: ${options.from} does not exist (resolved to ${root})`);
  }
  if (!rootInfo.isDirectory()) throw new Error(`${label}: ${options.from} is not a directory`);

  const matchers = only.map(onlyMatcher);
  const selected = (await collectRules(root)).filter(
    (candidate) =>
      matchers.length === 0 ||
      matchers.some((matches) => matches(candidate.ref) || matches(path.posix.basename(candidate.ref))),
  );

  const link = options.link === true;
  const targets = link ? [] : selected.filter((c) => !c.symlink).map((c) => projectRulePathFor(c.ref));
  await assertProjectWritesContained(options.projectRoot, [...targets, PROJECT_SKILLS_MANIFEST_PATH]);

  const registry = new Map((await readProjectRuleRegistry(options.projectRoot)).map((entry) => [entry.ref, entry]));
  const rows: ImportedProjectRule[] = [];
  const upsert: ProjectRuleRegistryEntry[] = [];
  const dryRun = options.dryRun === true;

  for (const candidate of selected) {
    const target = projectRulePathFor(candidate.ref);
    const origin = portableOriginRef(candidate.absolute, options.projectRoot);
    const base = { ref: candidate.ref, path: target, origin };
    if (candidate.symlink) {
      rows.push({ ...base, status: "skipped", reason: "a symlink is not followed; import the file it points at" });
      continue;
    }
    const content = await readFile(candidate.absolute, "utf8");
    const verdict = await gateText(options.projectRoot, content, target, options.allowFlagged === true);
    if (verdict.kind === "refuse") {
      rows.push({
        ...base,
        status: dryRun ? "would-refuse" : "refused",
        reason: verdict.reason,
        security: verdict.security,
      });
      continue;
    }
    if (verdict.kind === "blocked") {
      rows.push({ ...base, status: "skipped", reason: `blocked by the security gate: ${verdict.reason}` });
      continue;
    }
    const parts = gateRowParts(verdict, dryRun);
    const gateNote = { ...(parts.reason !== undefined ? { reason: parts.reason } : {}), ...(parts.security ? { security: parts.security } : {}) };
    const originSha256 = sha256Hex(content);
    const entry = projectRuleEntry({ ref: candidate.ref, content, writtenText: verdict.content, origin, originSha256 }, link ? "link" : "copy");
    const existing = await existingText(options.projectRoot, target);

    if (existing.notRegular) {
      rows.push({ ...base, status: "skipped", reason: `${target} is not a regular file; nothing was written there` });
      continue;
    }

    if (link) {
      if (existing.text !== undefined || registry.get(candidate.ref)?.mode === "copy") {
        rows.push({ ...base, status: "skipped", reason: "a copy of this rule exists and wins; the link was not registered" });
        continue;
      }
      rows.push({ ...base, status: dryRun ? "would-link" : "linked", sha256: entry.sha256, ...gateNote });
      upsert.push(entry);
      continue;
    }

    if (existing.text === verdict.content) {
      rows.push({ ...base, status: "unchanged", sha256: entry.sha256, ...gateNote });
      upsert.push(entry);
      continue;
    }
    if (existing.text !== undefined && options.force !== true) {
      rows.push({
        ...base,
        status: "differs",
        sha256: sha256Hex(existing.text),
        reason: "the project's copy is another file; left as it is, pass --force to replace it",
      });
      continue;
    }
    const replaced = existing.text !== undefined;
    if (!dryRun) await writeContained(options.projectRoot, target, verdict.content);
    rows.push({
      ...base,
      status: replaced ? (dryRun ? "would-overwrite" : "overwritten") : dryRun ? "would-import" : "imported",
      sha256: entry.sha256,
      ...gateNote,
    });
    upsert.push(entry);
  }

  if (!dryRun && upsert.length > 0) await updateProjectRuleRegistry(options.projectRoot, { upsert });

  return { from: options.from, only, link, rules: rows, dryRun, force: options.force === true };
}

export function renderImportProjectRulesMarkdown(result: ImportProjectRulesResult): string {
  const heading = result.dryRun ? "# skills import --rules (dry run)" : "# skills import --rules";
  if (result.rules.length === 0) return `${heading}\n\nNo rules matched in ${result.from}.\n`;
  const counts = new Map<string, number>();
  for (const row of result.rules) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${status}: ${count}`).join(" · ");
  const lines = result.rules.map(
    (row) => `- ${row.status} \`${row.ref}\` → ${row.path}${row.reason !== undefined ? ` — ${row.reason}` : ""}`,
  );
  const refused = result.rules.some((row) => row.status === "refused" || row.status === "would-refuse");
  const note = refused ? "\nA refused file was not written. A prompt-injection refusal can be overridden after you read the file: run the command again with --allow-flagged.\n" : "";
  return `${heading}\n\n${summary}\n\n${lines.join("\n")}\n${note}`;
}

export function exitNonZeroOnRuleRefusal(result: ImportProjectRulesResult): void {
  if (result.rules.some((row) => row.status === "refused")) process.exitCode = 1;
}

export async function runSkillsImportRulesCommand(args: string[]): Promise<void> {
  const from = optionValue(args, "--rules");
  if (from === undefined || from === "") {
    throw new Error(
      "Usage: keryx skills import --rules <dir> [--only <glob>]... [--link] [--dry-run] [--force] [--allow-flagged] [--json]",
    );
  }
  const result = await importProjectRules({
    projectRoot: process.cwd(),
    from,
    only: onlyOption(args, "keryx skills import --rules"),
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    allowFlagged: args.includes("--allow-flagged"),
    link: args.includes("--link"),
  });
  const json = args.includes("--json");
  console.log(json ? JSON.stringify(result, null, 2) : renderImportProjectRulesMarkdown(result));
  // Documents the imported rules cite but nothing declares: say how many, and how to start (flow 462).
  // Text output only, so --json stays one parseable document.
  if (!json) {
    const hint = await undeclaredCitationHint(process.cwd());
    if (hint.length > 0) console.log(`\n${hint.join("\n")}`);
  }
  exitNonZeroOnRuleRefusal(result);
}
