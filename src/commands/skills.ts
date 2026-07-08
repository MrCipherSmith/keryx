import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { pathExists } from "../lib/fs";
import { readJsonFile, readJsonFileOr } from "../lib/json";
import {
  BUNDLED_GDSKILLS,
  getBundledSkillsForProfile,
  normalizeGdskillsProfile,
  renderGdskillsCatalog,
  type BundledSkill,
  type GdskillsProfile,
} from "../gdskills/catalog";
import {
  CONTRACTS,
  normalizeContractName,
  relativeContractPath,
  validateContractFile,
} from "../gdskills/contracts";
import { installGdskills } from "../gdskills/install";
import { banner, heading, note, style, symbols, nextSteps } from "../lib/ui";
import {
  applyLearningProposal,
  learnProjectSkill,
  type LearningSourceType,
} from "../gdskills/learn";
import {
  exportProjectSkill,
  normalizeSkillRuntime,
} from "../gdskills/export";
import { syncRuntimeSkills } from "../gdskills/sync";
import {
  createProjectSkill,
  normalizeProjectSkillFormat,
  type ProjectSkillRegistryEntry,
} from "../gdskills/project-skills";
import { verifyProjectSkill } from "../gdskills/verify";

type MetaprojectManifest = {
  modules?: {
    gdskills?: {
      enabled?: boolean;
      profile?: GdskillsProfile;
      skills?: string;
      catalog?: string;
      projectSkillRegistry?: ProjectSkillRegistryEntry[];
    };
  };
};

type GdskillsStatusSummary = {
  initialized: boolean;
  enabled: boolean;
  profile: GdskillsProfile;
  bundledSkillsInProfile: number;
  installedSkillsRoot: string | "missing";
  catalog: string | "missing";
  projectSkills: {
    registered: number;
    withoutVerificationReport: number;
  };
  verificationReports: {
    total: number;
    fresh: number;
    needsReview: number;
    stale: number;
    blocked: number;
    lastVerified: string | "never";
  };
  learningProposals: {
    total: number;
    pending: number;
    applied: number;
  };
};

export async function skillsCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printSkillsHelp();
    return;
  }

  if (command === "catalog") {
    const profile = normalizeGdskillsProfile(optionValue(args, "--profile"));
    console.log(renderGdskillsCatalog(profile));
    return;
  }

  if (command === "install") {
    const profile = normalizeGdskillsProfile(optionValue(args, "--profile"));
    const metaprojectRoot = path.join(process.cwd(), ".metaproject");
    banner("keryx skills install", `Profile: ${profile}`);
    if (!(await pathExists(metaprojectRoot))) {
      console.log(`  ${style.red(symbols.cross)} Metaproject is not initialized.`);
      console.log(`  ${style.cyan(symbols.arrow)} Run ${style.cyan("keryx init")} first.`);
      process.exitCode = 1;
      return;
    }

    const result = await installGdskills(metaprojectRoot, profile);
    console.log(
      `  ${style.green(symbols.ok)} Installed ${style.bold(String(result.installedSkills))} skills for profile ${style.bold(result.profile)}`,
    );
    heading("Locations");
    note(`skills   ${relativeToCwd(result.skillsRoot)}`);
    note(`catalog  ${relativeToCwd(result.catalogPath)}`);
    note(`manifest ${relativeToCwd(result.manifestPath)}`);
    nextSteps([
      `Browse the catalog: ${style.cyan("keryx skills catalog")}.`,
      `Route a request: ${style.cyan("keryx skills route <target>")}.`,
    ]);
    return;
  }

  if (command === "status") {
    await printGdskillsStatus(args);
    return;
  }

  if (command === "list") {
    await listProjectSkills(args);
    return;
  }

  if (command === "inspect") {
    await inspectProjectSkill(args);
    return;
  }

  if (command === "route") {
    await routeProjectSkills(args);
    return;
  }

  if (command === "create" || command === "generate") {
    await createSkillCommand(args);
    return;
  }

  if (command === "verify") {
    await verifySkillCommand(args);
    return;
  }

  if (command === "learn") {
    await learnSkillCommand(args);
    return;
  }

  if (command === "export") {
    await exportSkillCommand(args);
    return;
  }

  if (command === "sync") {
    await syncSkillCommand(args);
    return;
  }

  if (command === "contracts") {
    await contractsCommand(args.slice(1));
    return;
  }

  console.error(`Unknown skills command: ${command}`);
  printSkillsHelp();
  process.exitCode = 1;
}

async function listProjectSkills(args: string[]): Promise<void> {
  const registry = await readProjectSkillRegistryFromManifest();
  if (args.includes("--json")) {
    console.log(JSON.stringify(registry, null, 2));
    return;
  }

  if (registry.length === 0) {
    console.log("No project skills registered.");
    return;
  }

  console.log("| Module | Skill | Target | Path |");
  console.log("|---|---|---|---|");
  for (const entry of registry) {
    console.log(`| ${entry.module} | ${entry.name} | ${entry.target} | ${entry.path} |`);
  }
}

async function inspectProjectSkill(args: string[]): Promise<void> {
  const target = args[1];
  if (!target || target === "--help" || target === "-h") {
    printInspectHelp();
    if (!target) {
      process.exitCode = 1;
    }
    return;
  }

  const registry = await readProjectSkillRegistryFromManifest();
  const entry = resolveProjectSkillRegistryEntry(registry, target);
  if (!entry) {
    console.error(`Project skill not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  const skillRoot = path.resolve(process.cwd(), entry.path);
  const skillMdPath = path.join(skillRoot, "SKILL.md");
  const verificationPath = path.join(skillRoot, "verification.md");
  const changelogPath = path.join(skillRoot, "skill-changelog.md");
  const reportPath = path.join(
    process.cwd(),
    ".metaproject",
    "data",
    "gdskills",
    "reports",
    `${entry.module}-${entry.name}-verification.json`,
  );
  const metadata = (await pathExists(skillMdPath))
    ? parseProjectSkillMetadata(await readFile(skillMdPath, "utf8"))
    : {};
  const inspection = {
    module: entry.module,
    name: entry.name,
    target: entry.target,
    path: entry.path,
    version: metadata.version ?? entry.version,
    status: metadata.status ?? entry.status,
    lastVerified: metadata.lastVerified ?? "never",
    files: {
      skill: (await pathExists(skillMdPath)) ? relativeToCwd(skillMdPath) : "missing",
      verification: (await pathExists(verificationPath)) ? relativeToCwd(verificationPath) : "missing",
      changelog: (await pathExists(changelogPath)) ? relativeToCwd(changelogPath) : "missing",
      latestReport: (await pathExists(reportPath)) ? relativeToCwd(reportPath) : "missing",
    },
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }

  console.log(`Project skill: ${inspection.module}/${inspection.name}`);
  console.log(`Target: ${inspection.target}`);
  console.log(`Path: ${inspection.path}`);
  console.log(`Version: ${inspection.version}`);
  console.log(`Status: ${inspection.status}`);
  console.log(`Last verified: ${inspection.lastVerified}`);
  console.log("Files:");
  console.log(`- SKILL.md: ${inspection.files.skill}`);
  console.log(`- verification.md: ${inspection.files.verification}`);
  console.log(`- skill-changelog.md: ${inspection.files.changelog}`);
  console.log(`- latest report: ${inspection.files.latestReport}`);
}

async function readProjectSkillRegistryFromManifest(): Promise<ProjectSkillRegistryEntry[]> {
  const manifestPath = path.join(process.cwd(), ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return [];
  }

  const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
  return manifest.modules?.gdskills?.projectSkillRegistry ?? [];
}

function resolveProjectSkillRegistryEntry(
  registry: ProjectSkillRegistryEntry[],
  input: string,
): ProjectSkillRegistryEntry | undefined {
  const normalized = input.replace(/\/SKILL\.md$/i, "");
  return registry.find((entry) => {
    const key = `${entry.module}/${entry.name}`;
    return (
      key === normalized ||
      entry.name === normalized ||
      entry.path === normalized ||
      entry.path.replace(/\/SKILL\.md$/i, "") === normalized ||
      entry.target === input
    );
  });
}

function parseProjectSkillMetadata(content: string): {
  version?: string | undefined;
  status?: string | undefined;
  lastVerified?: string | undefined;
} {
  return {
    version: content.match(/^Version:\s*(.+)$/m)?.[1]?.trim(),
    status: content.match(/^Status:\s*(.+)$/m)?.[1]?.trim(),
    lastVerified: content.match(/^Last Verified:\s*(.+)$/m)?.[1]?.trim(),
  };
}

async function routeProjectSkills(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printRouteHelp();
    return;
  }

  const query = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim();
  if (!query) {
    printRouteHelp();
    process.exitCode = 1;
    return;
  }

  // Bundled catalog skills (planning/orchestration/review/…): what an agent
  // should load for a natural-language intent like "prepare a docs package".
  const catalogMatches = BUNDLED_GDSKILLS.map((entry) => scoreBundledSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .map((match) => ({
      source: "catalog" as const,
      module: match.entry.category,
      name: match.entry.name,
      target: "-",
      path: `.metaproject/skills/gdskills/${match.entry.category}/${match.entry.name}/SKILL.md`,
      score: match.score,
      reasons: match.reasons,
      next: `Load .metaproject/skills/gdskills/${match.entry.category}/${match.entry.name}/SKILL.md`,
    }));

  // Project-skills: per-module skills auto-created for concrete code targets.
  const registry = await readProjectSkillRegistryFromManifest();
  const projectMatches = registry
    .map((entry) => scoreProjectSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .map((match) => ({
      source: "project" as const,
      module: match.entry.module,
      name: match.entry.name,
      target: match.entry.target,
      path: match.entry.path,
      score: match.score,
      reasons: match.reasons,
      next: `keryx skills inspect ${match.entry.module}/${match.entry.name}`,
    }));

  const matches = [...catalogMatches, ...projectMatches].sort(
    (a, b) =>
      b.score - a.score ||
      a.source.localeCompare(b.source) ||
      `${a.module}/${a.name}`.localeCompare(`${b.module}/${b.name}`),
  );

  const result = { query, matches };

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (matches.length === 0) {
    console.log(`No skills matched: ${query}`);
    console.log("Next: read .metaproject/skills/catalog.md, or keryx skills create <target> --module <module> --name <skill-name>");
    return;
  }

  console.log(`Skill route for: ${query}`);
  console.log("| Score | Source | Skill | Where | Reasons |");
  console.log("|---:|---|---|---|---|");
  for (const match of matches.slice(0, 10)) {
    const where = match.source === "catalog" ? `${match.module}/` : match.target;
    console.log(`| ${match.score} | ${match.source} | ${match.name} | ${where} | ${match.reasons.join(", ")} |`);
  }
  console.log(`Next: ${matches[0]?.next}`);
}

export function scoreBundledSkillRoute(
  entry: BundledSkill,
  query: string,
): { entry: BundledSkill; score: number; reasons: string[] } {
  const normalizedQuery = normalizeRouteText(query);
  if (!normalizedQuery) {
    return { entry, score: 0, reasons: [] };
  }

  const name = normalizeRouteText(entry.name);
  const triggers = entry.triggers.map((trigger) => normalizeRouteText(trigger)).filter(Boolean);
  const haystack = normalizeRouteText(
    [
      entry.name,
      entry.category,
      entry.description,
      entry.purpose,
      entry.triggers.join(" "),
      entry.workflow.join(" "),
    ].join(" "),
  );

  const queryTokens = routeTokens(normalizedQuery, true);

  let score = 0;
  const reasons: string[] = [];

  if (normalizedQuery === name) {
    score += 100;
    reasons.push("exact skill");
  }
  // A trigger fires when the query contains it verbatim, or when every
  // meaningful token of the trigger is present in the query (order-free) — so
  // "requirements package" still matches "prepare requirements documentation
  // package". Triggers carry both EN and RU phrasings.
  const triggerHit = triggers.some((trigger) => {
    if (normalizedQuery.includes(trigger)) {
      return true;
    }
    const triggerTokens = [...routeTokens(trigger)];
    return triggerTokens.length > 0 && triggerTokens.every((token) => queryTokens.has(token));
  });
  if (triggerHit) {
    score += 55;
    reasons.push("trigger");
  }
  if (name && normalizedQuery.includes(name)) {
    score += 30;
    reasons.push("skill name");
  }

  const haystackTokens = routeTokens(haystack);
  const overlap = [...queryTokens].filter((token) => haystackTokens.has(token));
  if (overlap.length > 0) {
    score += overlap.length * 10;
    reasons.push(`tokens:${overlap.slice(0, 4).join("+")}`);
  }

  return { entry, score, reasons: [...new Set(reasons)] };
}

function scoreProjectSkillRoute(
  entry: ProjectSkillRegistryEntry,
  query: string,
): { entry: ProjectSkillRegistryEntry; score: number; reasons: string[] } {
  const normalizedQuery = normalizeRouteText(query);
  if (!normalizedQuery) {
    // Guard the `.includes("")` trap: an empty query used to match every entry.
    return { entry, score: 0, reasons: [] };
  }
  const key = `${entry.module}/${entry.name}`;
  const targetBase = path.basename(entry.target).replace(/\.[^.]+$/, "");
  const fields = {
    key: normalizeRouteText(key),
    module: normalizeRouteText(entry.module),
    name: normalizeRouteText(entry.name),
    target: normalizeRouteText(entry.target),
    targetBase: normalizeRouteText(targetBase),
    path: normalizeRouteText(entry.path),
  };
  let score = 0;
  const reasons: string[] = [];

  if (normalizedQuery === fields.key || normalizedQuery === fields.name) {
    score += 100;
    reasons.push("exact skill");
  }
  if (fields.target.includes(normalizedQuery) || normalizedQuery.includes(fields.target)) {
    score += 80;
    reasons.push("target");
  }
  if (fields.path.includes(normalizedQuery) || normalizedQuery.includes(fields.path)) {
    score += 70;
    reasons.push("path");
  }
  if (fields.targetBase && normalizedQuery.includes(fields.targetBase)) {
    score += 60;
    reasons.push("target basename");
  }
  if (fields.module && normalizedQuery.includes(fields.module)) {
    score += 30;
    reasons.push("module");
  }
  if (fields.name && normalizedQuery.includes(fields.name)) {
    score += 30;
    reasons.push("skill name");
  }

  const queryTokens = routeTokens(normalizedQuery, true);
  const candidateTokens = routeTokens(`${fields.key} ${fields.target} ${fields.path}`);
  const overlap = [...queryTokens].filter((token) => candidateTokens.has(token));
  if (overlap.length > 0) {
    score += overlap.length * 10;
    reasons.push(`tokens:${overlap.join("+")}`);
  }

  return { entry, score, reasons: [...new Set(reasons)] };
}

// Short, high-frequency words carry no routing signal; excluding them stops
// "для"/"the" from creating spurious matches. Kept small on purpose.
const ROUTE_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "your", "are", "from", "into",
  "out", "run", "use", "used", "make", "get", "can", "please", "help", "want",
  "для", "при", "что", "как", "это", "под", "над", "или", "все", "мне", "нам",
  "нужно", "надо", "мой", "моя", "мои", "чтобы", "его", "them",
]);

// Bundled skills carry mostly English metadata, so a Russian intent would never
// reach them by token overlap. Map Russian intent stems to the English tokens
// the catalog uses. Prefix match (not exact) absorbs Russian inflection
// (задача/задачу/задачи → task). Applied to the QUERY only.
const RU_SYNONYM_PREFIXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["ревью", ["review"]],
  ["ревьюер", ["review", "reviewer"]],
  ["проверк", ["review", "verify", "check"]],
  ["реализ", ["implement"]],
  ["имплемент", ["implement"]],
  ["внедр", ["implement"]],
  ["задач", ["task", "tasks"]],
  ["тикет", ["issue", "ticket"]],
  ["тест", ["test", "tests", "testing"]],
  ["верифи", ["verify", "verification"]],
  ["качеств", ["quality"]],
  ["документ", ["documentation", "docs", "document"]],
  ["требован", ["requirements"]],
  ["пакет", ["package"]],
  ["спецификац", ["specification", "spec"]],
  ["безопас", ["security"]],
  ["секьюр", ["security"]],
  ["утечк", ["security", "exfiltration", "leak"]],
  ["уязвим", ["security", "vulnerability"]],
  ["контекст", ["context"]],
  ["план", ["plan", "planning"]],
  ["роадмап", ["roadmap"]],
  ["дорожн", ["roadmap"]],
  ["рефактор", ["refactor"]],
  ["миграц", ["migration", "migrate"]],
  ["производитель", ["performance"]],
  ["перформанс", ["performance"]],
  ["здоров", ["health"]],
  ["хотспот", ["hotspot"]],
  ["мертв", ["dead"]],
  ["мёртв", ["dead"]],
  ["граф", ["graph"]],
  ["вики", ["wiki"]],
  ["память", ["memory"]],
  ["скил", ["skill"]],
  ["созда", ["create"]],
  ["деплой", ["deploy"]],
  ["разверт", ["deploy"]],
  ["зависим", ["dependency", "dependencies"]],
  ["интервью", ["interview"]],
  ["опрос", ["interview"]],
  ["брейншторм", ["brainstorm"]],
  ["идеи", ["brainstorm", "idea"]],
  ["продукт", ["product", "prd"]],
  ["фло", ["flow"]],
  ["оркестр", ["orchestrator", "orchestrate"]],
  ["анализ", ["analyze", "analysis"]],
  ["ревьюир", ["review"]],
];

function routeTokens(normalized: string, expand = false): Set<string> {
  const tokens = new Set(
    normalized
      .split(" ")
      .filter((token) => token.length >= 3 && !ROUTE_STOPWORDS.has(token)),
  );
  if (expand) {
    for (const token of [...tokens]) {
      for (const [prefix, synonyms] of RU_SYNONYM_PREFIXES) {
        if (token.startsWith(prefix)) {
          for (const synonym of synonyms) {
            tokens.add(synonym);
          }
        }
      }
    }
  }
  return tokens;
}

export function normalizeRouteText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    // Keep any Unicode letter/number (Cyrillic included); collapse the rest to
    // spaces. Stripping to [a-z0-9] used to erase non-Latin queries entirely,
    // which then matched every entry via `.includes("")`.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function syncSkillCommand(args: string[]): Promise<void> {
  const runtime = normalizeSkillRuntime(optionValue(args, "--runtime"));
  const target = optionValue(args, "--target");
  if (args.includes("--help") || args.includes("-h")) {
    printSyncHelp();
    return;
  }

  if (!runtime || !target) {
    printSyncHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const result = await syncRuntimeSkills(process.cwd(), {
      runtime,
      target,
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${result.dryRun ? "Would sync" : "Synced"} runtime skills: ${result.runtime}`);
    console.log(`Source: ${result.sourceRoot}`);
    console.log(`Target: ${result.targetRoot}`);
    console.log(`Skills: ${result.syncedSkills.join(", ")}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log("Files:");
    for (const filePath of result.files) {
      console.log(`- ${filePath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function exportSkillCommand(args: string[]): Promise<void> {
  const target = args[1];
  const runtime = normalizeSkillRuntime(optionValue(args, "--runtime"));
  if (target === "--help" || target === "-h" || args.includes("--help") || args.includes("-h")) {
    printExportHelp();
    return;
  }

  if (!target || !runtime) {
    printExportHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const result = await exportProjectSkill(process.cwd(), {
      input: target,
      runtime,
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${result.dryRun ? "Would export" : "Exported"} project skill: ${result.module}/${result.name}`);
    console.log(`Runtime: ${result.runtime}`);
    console.log(`Source: ${result.sourcePath}`);
    console.log(`Output: ${result.outputPath}`);
    console.log("Files:");
    for (const filePath of result.files) {
      console.log(`- ${filePath}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}


async function learnSkillCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printLearnHelp();
    return;
  }

  if (args[1] === "apply") {
    await applyLearningProposalCommand(args);
    return;
  }

  const source = getLearningSource(args);
  if (!source) {
    console.error("Usage: keryx skills learn --from-review <path> --skill <module>/<skill>");
    printLearnHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const proposal = await learnProjectSkill(process.cwd(), {
      sourceType: source.type,
      sourcePath: source.path,
      skill: optionValue(args, "--skill"),
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(proposal, null, 2));
      return;
    }

    console.log(`${proposal.dryRun ? "Would create" : "Created"} learning proposal: ${proposal.proposalId}`);
    console.log(`Skill: ${proposal.skill.module}/${proposal.skill.name}`);
    console.log(`Source: ${proposal.sourcePath}`);
    console.log(`Confidence: ${proposal.confidence}`);
    console.log(`Proposal: ${proposal.proposalPath}`);
    console.log("Lessons:");
    if (proposal.lessons.length === 0) {
      console.log("- No concrete lessons extracted. Review source manually.");
    } else {
      for (const lesson of proposal.lessons) {
        console.log(`- ${lesson}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function applyLearningProposalCommand(args: string[]): Promise<void> {
  const proposalPath = args[2];
  if (!proposalPath) {
    console.error("Usage: keryx skills learn apply <proposal.json> [--dry-run] [--json]");
    process.exitCode = 1;
    return;
  }

  try {
    const result = await applyLearningProposal(process.cwd(), proposalPath, {
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${result.dryRun ? "Would apply" : "Applied"} learning proposal: ${result.proposalId}`);
    console.log(`Skill: ${result.skillPath}`);
    console.log(`Version: ${result.previousVersion} -> ${result.nextVersion}`);
    console.log(`Changed sections: ${result.changedSections.join(", ")}`);
    console.log(`Audit: ${result.appliedReportPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function getLearningSource(args: string[]): { type: LearningSourceType; path: string } | undefined {
  const sources: Array<{ flag: string; type: LearningSourceType }> = [
    { flag: "--from-review", type: "review" },
    { flag: "--from-test", type: "test" },
    { flag: "--from-failure", type: "failure" },
    { flag: "--from-health", type: "health" },
    { flag: "--from-memory", type: "memory" },
  ];

  for (const source of sources) {
    const value = optionValue(args, source.flag);
    if (value) {
      return { type: source.type, path: value };
    }
  }

  return undefined;
}

async function verifySkillCommand(args: string[]): Promise<void> {
  const target = args[1];
  if (target === "--all" || args.includes("--all")) {
    await verifyAllProjectSkills(args);
    return;
  }

  if (!target || target === "--help" || target === "-h") {
    printVerifyHelp();
    if (!target) {
      process.exitCode = 1;
    }
    return;
  }

  try {
    const report = await verifyProjectSkill(process.cwd(), {
      input: target,
      dryRun: args.includes("--dry-run"),
    });

    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`${report.dryRun ? "Would verify" : "Verified"} project skill: ${report.module}/${report.name}`);
    console.log(`Status: ${report.status}`);
    console.log(`Target: ${report.target}`);
    console.log(`Report: ${report.reportPath}`);
    console.log("Signals:");
    for (const signal of report.signals) {
      console.log(`- ${signal.status}: ${signal.name} - ${signal.message}`);
    }
    if (report.recommendations.length > 0) {
      console.log("Recommendations:");
      for (const recommendation of report.recommendations) {
        console.log(`- ${recommendation}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function verifyAllProjectSkills(args: string[]): Promise<void> {
  const manifestPath = path.join(process.cwd(), ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    console.error("Metaproject is not initialized. Run: keryx init");
    process.exitCode = 1;
    return;
  }

  let manifest: MetaprojectManifest;
  try {
    manifest = await readJsonFile<MetaprojectManifest>(manifestPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const registry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  if (registry.length === 0) {
    if (args.includes("--json")) {
      console.log("[]");
    } else {
      console.log("No project skills registered.");
    }
    return;
  }

  const reports = [];
  for (const entry of registry) {
    reports.push(await verifyProjectSkill(process.cwd(), {
      input: `${entry.module}/${entry.name}`,
      dryRun: args.includes("--dry-run"),
    }));
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  console.log(`${args.includes("--dry-run") ? "Would verify" : "Verified"} project skills: ${reports.length}`);
  for (const report of reports) {
    console.log(`- ${report.status}: ${report.module}/${report.name} -> ${report.reportPath}`);
  }
}

export async function skillVerifySkillCommand(args: string[]): Promise<void> {
  await verifySkillCommand(["verify", ...args]);
}

async function createSkillCommand(args: string[]): Promise<void> {
  const command = args[0];
  const target = args[1];
  if (!target || target === "--help" || target === "-h") {
    printCreateHelp(command === "generate" ? "generate" : "create");
    if (!target) {
      process.exitCode = 1;
    }
    return;
  }

  try {
    const result = await createProjectSkill(process.cwd(), {
      target,
      module: optionValue(args, "--module"),
      name: optionValue(args, "--name"),
      format: normalizeProjectSkillFormat(optionValue(args, "--format")),
      dryRun: args.includes("--dry-run"),
    });

    console.log(`${result.dryRun ? "Would create" : "Created"} project skill: ${result.module}/${result.name}`);
    console.log(`Target: ${result.target}`);
    console.log(`Path: ${result.skillPath}`);
    if (result.files.length > 0) {
      console.log("Files:");
      for (const filePath of result.files) {
        console.log(`- ${filePath}`);
      }
    }
    if (result.warnings.length > 0) {
      console.log("Warnings:");
      for (const warning of result.warnings) {
        console.log(`- ${warning}`);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function contractsCommand(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    printContractsHelp();
    return;
  }

  if (command === "list") {
    for (const contract of CONTRACTS) {
      console.log(`${contract.name}\t${relativeContractPath(contract.fileName)}\t${contract.description}`);
    }
    return;
  }

  if (command === "validate") {
    const filePath = args[1];
    const schemaName = normalizeContractName(optionValue(args, "--schema"));
    if (!filePath || !schemaName) {
      console.error("Usage: keryx skills contracts validate <file> --schema <name>");
      printContractsHelp();
      process.exitCode = 1;
      return;
    }

    try {
      const result = await validateContractFile(path.resolve(filePath), schemaName);
      if (result.valid) {
        console.log(`valid: ${result.file}`);
        console.log(`schema: ${result.schema}`);
        return;
      }

      console.error(`invalid: ${result.file}`);
      console.error(`schema: ${result.schema}`);
      for (const error of result.errors) {
        console.error(`- ${error.path}: ${error.message}`);
      }
      process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Unknown contracts command: ${command}`);
  printContractsHelp();
  process.exitCode = 1;
}

async function printGdskillsStatus(args: string[]): Promise<void> {
  const summary = await getGdskillsStatusSummary();

  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (!summary.initialized) {
    console.log("gdskills: not initialized");
    console.log("Run: keryx init");
    return;
  }

  console.log(`gdskills: ${summary.enabled ? "enabled" : "not enabled in manifest"}`);
  console.log(`profile: ${summary.profile}`);
  console.log(`bundled skills in profile: ${summary.bundledSkillsInProfile}`);
  console.log(`installed skills root: ${summary.installedSkillsRoot}`);
  console.log(`catalog: ${summary.catalog}`);
  console.log(`project skills registered: ${summary.projectSkills.registered}`);
  console.log(`project skills without verification report: ${summary.projectSkills.withoutVerificationReport}`);
  console.log(
    `verification reports: ${summary.verificationReports.total} ` +
      `(fresh ${summary.verificationReports.fresh}, needs-review ${summary.verificationReports.needsReview}, ` +
      `stale ${summary.verificationReports.stale}, blocked ${summary.verificationReports.blocked})`,
  );
  console.log(`last verified: ${summary.verificationReports.lastVerified}`);
  console.log(
    `learning proposals: ${summary.learningProposals.total} ` +
      `(pending ${summary.learningProposals.pending}, applied ${summary.learningProposals.applied})`,
  );
}

async function getGdskillsStatusSummary(): Promise<GdskillsStatusSummary> {
  const root = path.join(process.cwd(), ".metaproject");
  const manifestPath = path.join(root, "metaproject.json");
  const catalogPath = path.join(root, "skills", "catalog.md");
  const skillsRoot = path.join(root, "skills", "gdskills");

  if (!(await pathExists(root))) {
    return {
      initialized: false,
      enabled: false,
      profile: "recommended",
      bundledSkillsInProfile: getBundledSkillsForProfile("recommended").length,
      installedSkillsRoot: "missing",
      catalog: "missing",
      projectSkills: {
        registered: 0,
        withoutVerificationReport: 0,
      },
      verificationReports: {
        total: 0,
        fresh: 0,
        needsReview: 0,
        stale: 0,
        blocked: 0,
        lastVerified: "never",
      },
      learningProposals: {
        total: 0,
        pending: 0,
        applied: 0,
      },
    };
  }

  let profile: GdskillsProfile = "recommended";
  let enabled = false;
  let projectSkillRegistry: ProjectSkillRegistryEntry[] = [];
  if (await pathExists(manifestPath)) {
    const manifest = await readJsonFileOr<MetaprojectManifest>(manifestPath, {});
    enabled = manifest.modules?.gdskills?.enabled === true;
    profile = normalizeGdskillsProfile(manifest.modules?.gdskills?.profile);
    projectSkillRegistry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  }

  const reports = await readVerificationReports(path.join(root, "data", "gdskills", "reports"));
  const reportKeys = new Set(reports.map((report) => `${report.module}/${report.name}`));
  const proposals = await readProposalFiles(path.join(root, "data", "gdskills", "proposals"));
  const statusCounts = countVerificationStatuses(reports);

  return {
    initialized: true,
    enabled,
    profile,
    bundledSkillsInProfile: getBundledSkillsForProfile(profile).length,
    installedSkillsRoot: (await pathExists(skillsRoot)) ? relativeToCwd(skillsRoot) : "missing",
    catalog: (await pathExists(catalogPath)) ? relativeToCwd(catalogPath) : "missing",
    projectSkills: {
      registered: projectSkillRegistry.length,
      withoutVerificationReport: projectSkillRegistry.filter((entry) => !reportKeys.has(`${entry.module}/${entry.name}`)).length,
    },
    verificationReports: {
      total: reports.length,
      fresh: statusCounts.fresh,
      needsReview: statusCounts["needs-review"],
      stale: statusCounts.stale,
      blocked: statusCounts.blocked,
      lastVerified: latest(reports.map((report) => report.verifiedAt)),
    },
    learningProposals: proposals,
  };
}

type VerificationReportSummary = {
  module: string;
  name: string;
  status: "fresh" | "needs-review" | "stale" | "blocked";
  verifiedAt: string;
};

async function readVerificationReports(reportsRoot: string): Promise<VerificationReportSummary[]> {
  const files = await listJsonFiles(reportsRoot);
  const reports: VerificationReportSummary[] = [];
  for (const filePath of files) {
    try {
      const report = await readJsonFileOr<Partial<VerificationReportSummary>>(filePath, {});
      if (report.module && report.name && report.status && report.verifiedAt) {
        reports.push({
          module: report.module,
          name: report.name,
          status: report.status,
          verifiedAt: report.verifiedAt,
        });
      }
    } catch {
      // Ignore malformed reports in summary mode; verifier will surface details when run directly.
    }
  }

  return reports;
}

async function readProposalFiles(proposalsRoot: string): Promise<GdskillsStatusSummary["learningProposals"]> {
  const files = await listJsonFiles(proposalsRoot);
  const appliedIds = new Set(
    files
      .filter((filePath) => filePath.endsWith(".applied.json"))
      .map((filePath) => path.basename(filePath).replace(/\.applied\.json$/, "")),
  );
  const proposalIds = files
    .filter((filePath) => !filePath.endsWith(".applied.json"))
    .map((filePath) => path.basename(filePath).replace(/\.json$/, ""));

  return {
    total: proposalIds.length,
    pending: proposalIds.filter((id) => !appliedIds.has(id)).length,
    applied: appliedIds.size,
  };
}

async function listJsonFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(root, entry.name));
}

function countVerificationStatuses(
  reports: VerificationReportSummary[],
): Record<VerificationReportSummary["status"], number> {
  return reports.reduce(
    (acc, report) => {
      acc[report.status] += 1;
      return acc;
    },
    {
      fresh: 0,
      "needs-review": 0,
      stale: 0,
      blocked: 0,
    },
  );
}

function latest(values: string[]): string | "never" {
  const sorted = values.filter(Boolean).sort();
  return sorted.at(-1) ?? "never";
}

function relativeToCwd(filePath: string): string {
  return path.relative(process.cwd(), filePath) || ".";
}

function printSkillsHelp(): void {
  console.log(`keryx skills

Usage:
  keryx skills status
  keryx skills status --json
  keryx skills list
  keryx skills inspect <project-skill>
  keryx skills route <query-or-target>
  keryx skills catalog [--profile minimal|recommended|full|custom]
  keryx skills install [--profile minimal|recommended|full|custom]
  keryx skills create <target> --module <module> --name <skill-name>
  keryx skills generate <target> --module <module> --name <skill-name>
  keryx skills verify <skill-or-target>
  keryx skills verify --all
  keryx skills learn --from-review <path> --skill <module>/<skill>
  keryx skills learn apply <proposal.json>
  keryx skills export <project-skill> --runtime codex|claude
  keryx skills sync --runtime codex|claude --target <dir>
  keryx skills contracts list
  keryx skills contracts validate <file> --schema <name>

Commands:
  status    Show local gdskills installation status
  list      List registered project skills
  inspect   Inspect one registered project skill
  route     Route a query or target to matching project skills
  catalog   Print bundled gdskills catalog for a profile
  install   Install bundled gdskills into .metaproject
  create    Create a canonical project skill package
  generate  Alias for create
  verify    Verify a canonical project skill against current evidence
  learn     Create or apply auditable learning proposals
  export    Export a canonical project skill to a runtime artifact
  sync      Sync exported runtime skills to an explicit target directory
  contracts List and validate gdskills JSON contracts
`);
}

function printRouteHelp(): void {
  console.log(`keryx skills route

Routes a query across BOTH bundled catalog skills (planning/orchestration/
review/…) and per-module project-skills. Matches by name, description, triggers,
and workflow — English or Russian.

Usage:
  keryx skills route <query-or-target> [--json]

Examples:
  keryx skills route src/pipelines/PipelineStepStore.ts
  keryx skills route "подготовь пакет документации"
  keryx skills route "change pipeline step store behavior" --json
`);
}

function printInspectHelp(): void {
  console.log(`keryx skills inspect

Usage:
  keryx skills inspect <project-skill> [--json]

Examples:
  keryx skills inspect pipelines/pipeline-step-store
  keryx skills inspect .metaproject/project-skills/pipelines/pipeline-step-store --json
`);
}

function printCreateHelp(command: "create" | "generate"): void {
  console.log(`keryx skills ${command}

Usage:
  keryx skills ${command} <target> --module <module> --name <skill-name> [--format auto|single|package] [--dry-run]

Examples:
  keryx skills ${command} src/pipelines --module pipelines --name pipelines-module
  keryx skills ${command} PipelineStepStore --module pipelines --name pipeline-step-store --dry-run
`);
}

function printVerifyHelp(): void {
  console.log(`keryx skills verify

Usage:
  keryx skills verify <skill-or-target> [--dry-run] [--json]
  keryx skills verify --all [--dry-run] [--json]

Aliases:
  keryx skill-verify-skill <skill-or-target>

Examples:
  keryx skills verify pipelines/pipeline-step-store
  keryx skills verify .metaproject/project-skills/pipelines/pipeline-step-store --json
`);
}

function printLearnHelp(): void {
  console.log(`keryx skills learn

Usage:
  keryx skills learn --from-review <path> --skill <module>/<skill> [--dry-run] [--json]
  keryx skills learn --from-test <path> --skill <module>/<skill>
  keryx skills learn --from-failure <path> --skill <module>/<skill>
  keryx skills learn --from-health <path> --skill <module>/<skill>
  keryx skills learn --from-memory <path> --skill <module>/<skill>
  keryx skills learn apply <proposal.json> [--dry-run] [--json]

Notes:
  Proposal creation does not mutate SKILL.md. The explicit apply command updates SKILL.md and skill-changelog.md.
`);
}

function printExportHelp(): void {
  console.log(`keryx skills export

Usage:
  keryx skills export <project-skill> --runtime codex [--dry-run] [--json]
  keryx skills export <project-skill> --runtime claude [--dry-run] [--json]
  keryx skills export <project-skill> --runtime plugin [--dry-run] [--json]

Examples:
  keryx skills export pipelines/pipeline-step-store --runtime codex
  keryx skills export .metaproject/project-skills/pipelines/pipeline-step-store --runtime claude --dry-run
  keryx skills export pipelines/pipeline-step-store --runtime plugin
`);
}

function printSyncHelp(): void {
  console.log(`keryx skills sync

Usage:
  keryx skills sync --runtime codex --target <dir> [--dry-run] [--json]
  keryx skills sync --runtime claude --target <dir> [--dry-run] [--json]

Notes:
  Sync is explicit-target only in this implementation slice. It does not auto-write to global runtime folders.

Examples:
  keryx skills sync --runtime codex --target .metaproject/runtime/synced/codex
  keryx skills sync --runtime claude --target /tmp/metaproject-claude-skills --dry-run
`);
}

function printContractsHelp(): void {
  const schemas = CONTRACTS.map((contract) => `  ${contract.name}`).join("\n");

  console.log(`keryx skills contracts

Usage:
  keryx skills contracts list
  keryx skills contracts validate <file> --schema <name>

Schemas:
${schemas}
`);
}
