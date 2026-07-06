import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import type { ProjectSkillRegistryEntry } from "./project-skills";

export type ProjectSkillVerificationStatus = "fresh" | "needs-review" | "stale" | "blocked";

export type VerifyProjectSkillOptions = {
  input: string;
  dryRun?: boolean;
};

export type VerificationSignal = {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  path?: string | undefined;
};

export type ProjectSkillVerificationReport = {
  schemaVersion: 1;
  status: ProjectSkillVerificationStatus;
  module: string;
  name: string;
  target: string;
  skillPath: string;
  reportPath: string;
  verifiedAt: string;
  signals: VerificationSignal[];
  recommendations: string[];
  dryRun: boolean;
};

type SkillMetadata = {
  version?: string | undefined;
  target?: string | undefined;
  module?: string | undefined;
  status?: string | undefined;
  lastVerified?: string | undefined;
};

type MetaprojectManifest = {
  modules?: {
    gdskills?: {
      projectSkillRegistry?: ProjectSkillRegistryEntry[];
    };
  };
};

export async function verifyProjectSkill(
  projectRoot: string,
  options: VerifyProjectSkillOptions,
): Promise<ProjectSkillVerificationReport> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  if (!(await pathExists(metaprojectRoot))) {
    throw new Error("Metaproject is not initialized. Run: gd-metapro init");
  }

  const manifest = await readManifest(projectRoot);
  const registry = manifest.modules?.gdskills?.projectSkillRegistry ?? [];
  const resolved = await resolveProjectSkill(projectRoot, options.input, registry);
  if (!resolved) {
    throw new Error(`Project skill not found for: ${options.input}`);
  }

  const skillMdPath = path.join(resolved.packageRoot, "SKILL.md");
  const skillMd = await readFile(skillMdPath, "utf8");
  const metadata = parseSkillMetadata(skillMd);
  const moduleName = metadata.module ?? resolved.entry?.module ?? inferModuleFromPath(resolved.packageRoot);
  const skillName = resolved.entry?.name ?? path.basename(resolved.packageRoot);
  const target = metadata.target ?? resolved.entry?.target ?? options.input;
  const verifiedAt = new Date().toISOString();
  const signals = await collectVerificationSignals({
    projectRoot,
    packageRoot: resolved.packageRoot,
    skillMdPath,
    metadata,
    target,
    registryEntry: resolved.entry,
  });
  const status = classifyStatus(signals, metadata);
  const recommendations = recommendationsFor(signals, status);
  const reportPath = path.join(
    metaprojectRoot,
    "data",
    "gdskills",
    "reports",
    `${moduleName}-${skillName}-verification.json`,
  );
  const relativeReportPath = toPosix(path.relative(projectRoot, reportPath));
  const report: ProjectSkillVerificationReport = {
    schemaVersion: 1,
    status,
    module: moduleName,
    name: skillName,
    target,
    skillPath: toPosix(path.relative(projectRoot, resolved.packageRoot)),
    reportPath: relativeReportPath,
    verifiedAt,
    signals,
    recommendations,
    dryRun: options.dryRun === true,
  };

  if (!options.dryRun) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(path.join(resolved.packageRoot, "verification.md"), renderVerificationMarkdown(report), "utf8");
    await writeFile(skillMdPath, updateLastVerified(skillMd, verifiedAt), "utf8");
  }

  return report;
}

async function readManifest(projectRoot: string): Promise<MetaprojectManifest> {
  const manifestPath = path.join(projectRoot, ".metaproject", "metaproject.json");
  if (!(await pathExists(manifestPath))) {
    return {};
  }

  return JSON.parse(await readFile(manifestPath, "utf8")) as MetaprojectManifest;
}

async function resolveProjectSkill(
  projectRoot: string,
  input: string,
  registry: ProjectSkillRegistryEntry[],
): Promise<{ packageRoot: string; entry?: ProjectSkillRegistryEntry | undefined } | undefined> {
  const directPath = path.resolve(projectRoot, input);
  const directPackage = await normalizePackagePath(directPath);
  if (directPackage) {
    return {
      packageRoot: directPackage,
      entry: registry.find((entry) => path.resolve(projectRoot, entry.path) === directPackage),
    };
  }

  const projectSkillPath = path.join(projectRoot, ".metaproject", "project-skills", input);
  const projectSkillPackage = await normalizePackagePath(projectSkillPath);
  if (projectSkillPackage) {
    return {
      packageRoot: projectSkillPackage,
      entry: registry.find((entry) => path.resolve(projectRoot, entry.path) === projectSkillPackage),
    };
  }

  const normalizedInput = input.replace(/\/SKILL\.md$/i, "");
  const entry = registry.find((candidate) => {
    const key = `${candidate.module}/${candidate.name}`;
    return (
      key === normalizedInput ||
      candidate.name === normalizedInput ||
      candidate.path === normalizedInput ||
      candidate.path.replace(/\/SKILL\.md$/i, "") === normalizedInput ||
      candidate.target === input
    );
  });
  if (!entry) {
    return undefined;
  }

  const packageRoot = path.resolve(projectRoot, entry.path);
  if (!(await pathExists(path.join(packageRoot, "SKILL.md")))) {
    return undefined;
  }

  return { packageRoot, entry };
}

async function normalizePackagePath(candidate: string): Promise<string | undefined> {
  if (await pathExists(path.join(candidate, "SKILL.md"))) {
    return candidate;
  }

  if (path.basename(candidate) === "SKILL.md" && await pathExists(candidate)) {
    return path.dirname(candidate);
  }

  return undefined;
}

async function collectVerificationSignals({
  projectRoot,
  packageRoot,
  skillMdPath,
  metadata,
  target,
  registryEntry,
}: {
  projectRoot: string;
  packageRoot: string;
  skillMdPath: string;
  metadata: SkillMetadata;
  target: string;
  registryEntry?: ProjectSkillRegistryEntry | undefined;
}): Promise<VerificationSignal[]> {
  const signals: VerificationSignal[] = [];
  const requiredFiles = [
    "SKILL.md",
    "skill-changelog.md",
  ];
  for (const requiredFile of requiredFiles) {
    const filePath = path.join(packageRoot, requiredFile);
    signals.push({
      name: `required:${requiredFile}`,
      status: (await pathExists(filePath)) ? "pass" : "fail",
      message: (await pathExists(filePath)) ? "Required package file exists." : "Required package file is missing.",
      path: toPosix(path.relative(projectRoot, filePath)),
    });
  }

  signals.push({
    name: "metadata:version",
    status: metadata.version ? "pass" : "fail",
    message: metadata.version ? `Version ${metadata.version}` : "SKILL.md is missing Version metadata.",
    path: toPosix(path.relative(projectRoot, skillMdPath)),
  });
  signals.push({
    name: "metadata:target",
    status: metadata.target ? "pass" : "fail",
    message: metadata.target ? `Target ${metadata.target}` : "SKILL.md is missing Target metadata.",
    path: toPosix(path.relative(projectRoot, skillMdPath)),
  });
  signals.push({
    name: "metadata:last-verified",
    status: metadata.lastVerified && metadata.lastVerified !== "never" ? "pass" : "warn",
    message: metadata.lastVerified && metadata.lastVerified !== "never"
      ? `Last verified at ${metadata.lastVerified}`
      : "Skill has not been verified before.",
    path: toPosix(path.relative(projectRoot, skillMdPath)),
  });

  signals.push({
    name: "registry",
    status: registryEntry ? "pass" : "warn",
    message: registryEntry ? "Skill is registered in metaproject manifest." : "Skill package is not registered in metaproject manifest.",
    path: ".metaproject/metaproject.json",
  });

  const targetPath = path.resolve(projectRoot, target);
  const targetLooksLikePath = target.includes("/") || target.includes(".") || target.startsWith(".");
  const targetExists = targetLooksLikePath && await pathExists(targetPath);
  signals.push({
    name: "target",
    status: !targetLooksLikePath || targetExists ? "pass" : "fail",
    message: targetLooksLikePath
      ? targetExists
        ? "Target path exists."
        : "Target path is missing."
      : "Target is treated as a symbol or concept.",
    path: targetLooksLikePath ? toPosix(path.relative(projectRoot, targetPath)) : undefined,
  });

  await pushArtifactSignal(projectRoot, signals, "gdgraph", [
    ".metaproject/data/gdgraph/artifacts/summary.md",
    ".metaproject/data/gdgraph/artifacts/module-map.json",
  ]);
  await pushArtifactSignal(projectRoot, signals, "gdctx", [
    ".metaproject/data/gdctx/artifacts/latest.md",
  ]);
  await pushArtifactSignal(projectRoot, signals, "gdwiki", [
    ".metaproject/wiki/index.md",
  ]);
  await pushArtifactSignal(projectRoot, signals, "code-health", [
    ".metaproject/data/health/artifacts/latest.json",
    ".metaproject/data/health/artifacts/latest.md",
  ]);
  await pushArtifactSignal(projectRoot, signals, "documentation-memory", [
    ".metaproject/data/memory/artifacts/latest.json",
    ".metaproject/data/memory/artifacts/latest.md",
  ]);

  return signals;
}

async function pushArtifactSignal(
  projectRoot: string,
  signals: VerificationSignal[],
  name: string,
  candidates: string[],
): Promise<void> {
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(projectRoot, candidate))) {
      existing.push(candidate);
    }
  }

  signals.push({
    name: `evidence:${name}`,
    status: existing.length > 0 ? "pass" : "warn",
    message: existing.length > 0
      ? `Evidence available: ${existing.join(", ")}`
      : `No ${name} evidence artifact found.`,
    path: existing[0],
  });
}

function classifyStatus(
  signals: VerificationSignal[],
  metadata: SkillMetadata,
): ProjectSkillVerificationStatus {
  if (signals.some((signal) => signal.status === "fail" && signal.name.startsWith("required:"))) {
    return "blocked";
  }

  if (signals.some((signal) => signal.status === "fail")) {
    return "stale";
  }

  const evidencePasses = signals.filter((signal) => signal.name.startsWith("evidence:") && signal.status === "pass");
  if (evidencePasses.length === 0 || !metadata.lastVerified || metadata.lastVerified === "never") {
    return "needs-review";
  }

  return "fresh";
}

function recommendationsFor(
  signals: VerificationSignal[],
  status: ProjectSkillVerificationStatus,
): string[] {
  const recommendations: string[] = [];
  if (status === "blocked") {
    recommendations.push("Restore missing required project-skill files before using this skill.");
  }
  if (signals.some((signal) => signal.name === "target" && signal.status === "fail")) {
    recommendations.push("Update the skill target or recreate the project skill for the current file/entity.");
  }
  if (signals.some((signal) => signal.name === "registry" && signal.status === "warn")) {
    recommendations.push("Re-run gd-metapro skills create for this skill to restore manifest registration.");
  }
  if (signals.some((signal) => signal.name === "evidence:gdgraph" && signal.status === "warn")) {
    recommendations.push("Run gd-metapro gdgraph build to refresh structural evidence.");
  }
  if (signals.some((signal) => signal.name === "evidence:gdctx" && signal.status === "warn")) {
    recommendations.push("Use gd-metapro ctx commands when compact file or command context is needed.");
  }
  if (signals.some((signal) => signal.name === "evidence:gdwiki" && signal.status === "warn")) {
    recommendations.push("Add or refresh gdwiki pages for domain and architecture evidence.");
  }
  if (signals.some((signal) => signal.name === "evidence:code-health" && signal.status === "warn")) {
    recommendations.push("Run Code Health when quality metrics should influence skill freshness.");
  }
  if (signals.some((signal) => signal.name === "evidence:documentation-memory" && signal.status === "warn")) {
    recommendations.push("Search Documentation Memory before learning from repeated decisions or mistakes.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Skill evidence is sufficient for the current first-slice verifier.");
  }

  return recommendations;
}

function renderVerificationMarkdown(report: ProjectSkillVerificationReport): string {
  const signalRows = report.signals
    .map((signal) => `| ${signal.name} | ${signal.status} | ${signal.message} | ${signal.path ?? "-"} |`)
    .join("\n");
  const recommendations = report.recommendations.map((item) => `- ${item}`).join("\n");

  return `# ${report.name} Verification

Version: 0.1.0

Status: ${report.status}
Module: ${report.module}
Skill: ${report.name}
Target: ${report.target}
Last Verified: ${report.verifiedAt}
Report: ${report.reportPath}

## Signals

| Signal | Status | Message | Path |
|---|---|---|---|
${signalRows}

## Recommendations

${recommendations}
`;
}

function parseSkillMetadata(skillMd: string): SkillMetadata {
  return {
    version: readMetadataLine(skillMd, "Version"),
    target: readMetadataLine(skillMd, "Target"),
    module: readMetadataLine(skillMd, "Module"),
    status: readMetadataLine(skillMd, "Status"),
    lastVerified: readMetadataLine(skillMd, "Last Verified"),
  };
}

function readMetadataLine(content: string, label: string): string | undefined {
  const match = content.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function updateLastVerified(skillMd: string, verifiedAt: string): string {
  if (/^Last Verified:/m.test(skillMd)) {
    return skillMd.replace(/^Last Verified:.*$/m, `Last Verified: ${verifiedAt}`);
  }

  if (/^Status:.*$/m.test(skillMd)) {
    return skillMd.replace(/^Status:.*$/m, (line) => `${line}\nLast Verified: ${verifiedAt}`);
  }

  return skillMd;
}

function inferModuleFromPath(packageRoot: string): string {
  const parts = toPosix(packageRoot).split("/");
  const index = parts.indexOf("project-skills");
  const next = parts[index + 1];
  return index >= 0 && next ? next : "general";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
