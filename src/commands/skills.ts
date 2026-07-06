import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import {
  getBundledSkillsForProfile,
  normalizeGdskillsProfile,
  renderGdskillsCatalog,
  type GdskillsProfile,
} from "../gdskills/catalog";
import {
  CONTRACTS,
  normalizeContractName,
  relativeContractPath,
  validateContractFile,
} from "../gdskills/contracts";
import { installGdskills } from "../gdskills/install";
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
    const profile = normalizeGdskillsProfile(getOption(args, "--profile"));
    console.log(renderGdskillsCatalog(profile));
    return;
  }

  if (command === "install") {
    const profile = normalizeGdskillsProfile(getOption(args, "--profile"));
    const metaprojectRoot = path.join(process.cwd(), ".metaproject");
    if (!(await pathExists(metaprojectRoot))) {
      console.error("Metaproject is not initialized. Run: gd-metapro init");
      process.exitCode = 1;
      return;
    }

    const result = await installGdskills(metaprojectRoot, profile);
    console.log(`Installed gdskills profile: ${result.profile}`);
    console.log(`Installed skills: ${result.installedSkills}`);
    console.log(`Skills root: ${relativeToCwd(result.skillsRoot)}`);
    console.log(`Catalog: ${relativeToCwd(result.catalogPath)}`);
    console.log(`Manifest: ${relativeToCwd(result.manifestPath)}`);
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

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
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
  version?: string;
  status?: string;
  lastVerified?: string;
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

  const registry = await readProjectSkillRegistryFromManifest();
  const matches = registry
    .map((entry) => scoreProjectSkillRoute(entry, query))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || `${a.entry.module}/${a.entry.name}`.localeCompare(`${b.entry.module}/${b.entry.name}`));

  const result = {
    query,
    matches: matches.map((match) => ({
      module: match.entry.module,
      name: match.entry.name,
      target: match.entry.target,
      path: match.entry.path,
      score: match.score,
      reasons: match.reasons,
      commands: {
        inspect: `gd-metapro skills inspect ${match.entry.module}/${match.entry.name}`,
        verify: `gd-metapro skills verify ${match.entry.module}/${match.entry.name}`,
      },
    })),
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (matches.length === 0) {
    console.log(`No project skills matched: ${query}`);
    console.log("Next: gd-metapro skills create <target> --module <module> --name <skill-name>");
    return;
  }

  console.log(`Project skill route for: ${query}`);
  console.log("| Score | Module | Skill | Target | Reasons |");
  console.log("|---:|---|---|---|---|");
  for (const match of matches) {
    console.log(`| ${match.score} | ${match.entry.module} | ${match.entry.name} | ${match.entry.target} | ${match.reasons.join(", ")} |`);
  }
  console.log(`Next: ${result.matches[0]?.commands.inspect}`);
}

function scoreProjectSkillRoute(
  entry: ProjectSkillRegistryEntry,
  query: string,
): { entry: ProjectSkillRegistryEntry; score: number; reasons: string[] } {
  const normalizedQuery = normalizeRouteText(query);
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

  const queryTokens = new Set(normalizedQuery.split(" ").filter((token) => token.length >= 3));
  const candidateTokens = new Set(
    `${fields.key} ${fields.target} ${fields.path}`.split(" ").filter((token) => token.length >= 3),
  );
  const overlap = [...queryTokens].filter((token) => candidateTokens.has(token));
  if (overlap.length > 0) {
    score += overlap.length * 10;
    reasons.push(`tokens:${overlap.join("+")}`);
  }

  return { entry, score, reasons: [...new Set(reasons)] };
}

function normalizeRouteText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function syncSkillCommand(args: string[]): Promise<void> {
  const runtime = normalizeSkillRuntime(getOption(args, "--runtime"));
  const target = getOption(args, "--target");
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
  const runtime = normalizeSkillRuntime(getOption(args, "--runtime"));
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
    console.error("Usage: gd-metapro skills learn --from-review <path> --skill <module>/<skill>");
    printLearnHelp();
    process.exitCode = 1;
    return;
  }

  try {
    const proposal = await learnProjectSkill(process.cwd(), {
      sourceType: source.type,
      sourcePath: source.path,
      skill: getOption(args, "--skill"),
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
    console.error("Usage: gd-metapro skills learn apply <proposal.json> [--dry-run] [--json]");
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
    const value = getOption(args, source.flag);
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
    console.error("Metaproject is not initialized. Run: gd-metapro init");
    process.exitCode = 1;
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
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
      module: getOption(args, "--module"),
      name: getOption(args, "--name"),
      format: normalizeProjectSkillFormat(getOption(args, "--format")),
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
    const schemaName = normalizeContractName(getOption(args, "--schema"));
    if (!filePath || !schemaName) {
      console.error("Usage: gd-metapro skills contracts validate <file> --schema <name>");
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
    console.log("Run: gd-metapro init");
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
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
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
      const report = JSON.parse(await readFile(filePath, "utf8")) as Partial<VerificationReportSummary>;
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

function getOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function relativeToCwd(filePath: string): string {
  return path.relative(process.cwd(), filePath) || ".";
}

function printSkillsHelp(): void {
  console.log(`gd-metapro skills

Usage:
  gd-metapro skills status
  gd-metapro skills status --json
  gd-metapro skills list
  gd-metapro skills inspect <project-skill>
  gd-metapro skills route <query-or-target>
  gd-metapro skills catalog [--profile minimal|recommended|full|custom]
  gd-metapro skills install [--profile minimal|recommended|full|custom]
  gd-metapro skills create <target> --module <module> --name <skill-name>
  gd-metapro skills generate <target> --module <module> --name <skill-name>
  gd-metapro skills verify <skill-or-target>
  gd-metapro skills verify --all
  gd-metapro skills learn --from-review <path> --skill <module>/<skill>
  gd-metapro skills learn apply <proposal.json>
  gd-metapro skills export <project-skill> --runtime codex|claude
  gd-metapro skills sync --runtime codex|claude --target <dir>
  gd-metapro skills contracts list
  gd-metapro skills contracts validate <file> --schema <name>

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
  console.log(`gd-metapro skills route

Usage:
  gd-metapro skills route <query-or-target> [--json]

Examples:
  gd-metapro skills route src/pipelines/PipelineStepStore.ts
  gd-metapro skills route "change pipeline step store behavior" --json
`);
}

function printInspectHelp(): void {
  console.log(`gd-metapro skills inspect

Usage:
  gd-metapro skills inspect <project-skill> [--json]

Examples:
  gd-metapro skills inspect pipelines/pipeline-step-store
  gd-metapro skills inspect .metaproject/project-skills/pipelines/pipeline-step-store --json
`);
}

function printCreateHelp(command: "create" | "generate"): void {
  console.log(`gd-metapro skills ${command}

Usage:
  gd-metapro skills ${command} <target> --module <module> --name <skill-name> [--format auto|single|package] [--dry-run]

Examples:
  gd-metapro skills ${command} src/pipelines --module pipelines --name pipelines-module
  gd-metapro skills ${command} PipelineStepStore --module pipelines --name pipeline-step-store --dry-run
`);
}

function printVerifyHelp(): void {
  console.log(`gd-metapro skills verify

Usage:
  gd-metapro skills verify <skill-or-target> [--dry-run] [--json]
  gd-metapro skills verify --all [--dry-run] [--json]

Aliases:
  gd-metapro skill-verify-skill <skill-or-target>

Examples:
  gd-metapro skills verify pipelines/pipeline-step-store
  gd-metapro skills verify .metaproject/project-skills/pipelines/pipeline-step-store --json
`);
}

function printLearnHelp(): void {
  console.log(`gd-metapro skills learn

Usage:
  gd-metapro skills learn --from-review <path> --skill <module>/<skill> [--dry-run] [--json]
  gd-metapro skills learn --from-test <path> --skill <module>/<skill>
  gd-metapro skills learn --from-failure <path> --skill <module>/<skill>
  gd-metapro skills learn --from-health <path> --skill <module>/<skill>
  gd-metapro skills learn --from-memory <path> --skill <module>/<skill>
  gd-metapro skills learn apply <proposal.json> [--dry-run] [--json]

Notes:
  Proposal creation does not mutate SKILL.md. The explicit apply command updates SKILL.md and skill-changelog.md.
`);
}

function printExportHelp(): void {
  console.log(`gd-metapro skills export

Usage:
  gd-metapro skills export <project-skill> --runtime codex [--dry-run] [--json]
  gd-metapro skills export <project-skill> --runtime claude [--dry-run] [--json]

Examples:
  gd-metapro skills export pipelines/pipeline-step-store --runtime codex
  gd-metapro skills export .metaproject/project-skills/pipelines/pipeline-step-store --runtime claude --dry-run
`);
}

function printSyncHelp(): void {
  console.log(`gd-metapro skills sync

Usage:
  gd-metapro skills sync --runtime codex --target <dir> [--dry-run] [--json]
  gd-metapro skills sync --runtime claude --target <dir> [--dry-run] [--json]

Notes:
  Sync is explicit-target only in this implementation slice. It does not auto-write to global runtime folders.

Examples:
  gd-metapro skills sync --runtime codex --target .metaproject/runtime/synced/codex
  gd-metapro skills sync --runtime claude --target /tmp/metaproject-claude-skills --dry-run
`);
}

function printContractsHelp(): void {
  const schemas = CONTRACTS.map((contract) => `  ${contract.name}`).join("\n");

  console.log(`gd-metapro skills contracts

Usage:
  gd-metapro skills contracts list
  gd-metapro skills contracts validate <file> --schema <name>

Schemas:
${schemas}
`);
}
