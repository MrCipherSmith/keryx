import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { redactRaw } from "../security/guard";

type CtxArtifact = {
  id: string;
  kind: string;
  command: string;
  exitCode: number;
  rawPath: string;
  summaryPath: string;
  bytesIn: number;
  bytesOut: number;
  truncated: boolean;
};

type CtxConfig = {
  maxOutputLines: number;
  maxImportantLines: number;
  maxGroupItems: number;
  compactHeadLines: number;
  compactTailLines: number;
  outlineMaxEntries: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  raw: string;
  exitCode: number;
};

const DEFAULT_CONFIG: CtxConfig = {
  maxOutputLines: 120,
  maxImportantLines: 60,
  maxGroupItems: 12,
  compactHeadLines: 120,
  compactTailLines: 80,
  outlineMaxEntries: 160,
};

export async function ctxCommand(args: string[]): Promise<void> {
  const command = args[0];
  const config = await loadConfig();

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "status") {
    await printCtxStatus();
    return;
  }

  if (command === "diff") {
    await diffAndSummarize(args.slice(1), config);
    return;
  }

  if (command === "rg") {
    await rgAndSummarize(args.slice(1), config);
    return;
  }

  if (command === "read") {
    await readAndSummarize(args.slice(1), config);
    return;
  }

  if (command === "run") {
    const separatorIndex = args.indexOf("--");
    const runArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args.slice(1);
    if (runArgs.length === 0) {
      console.error("Usage: gd-metapro ctx run -- <command...>");
      process.exitCode = 1;
      return;
    }
    await runAndSummarize("run", runArgs, config);
    return;
  }

  if (command === "show") {
    await showArtifact(args.slice(1));
    return;
  }

  console.error(`Unknown ctx command: ${command}`);
  printHelp();
  process.exitCode = 1;
}

async function printCtxStatus(): Promise<void> {
  const root = path.join(process.cwd(), ".metaproject");
  const manifestPath = path.join(root, "metaproject.json");
  const configPath = path.join(root, "gdctx.config.json");
  const gdctxRoot = path.join(root, "data", "gdctx");
  const latestSummaryPath = path.join(gdctxRoot, "artifacts", "latest.md");

  console.log("# gdctx status");
  console.log("");
  console.log(`metaproject: ${(await pathExists(root)) ? "present" : "missing"}`);
  console.log(`manifest: ${(await pathExists(manifestPath)) ? "present" : "missing"}`);
  console.log(`config: ${(await pathExists(configPath)) ? ".metaproject/gdctx.config.json" : "default"}`);
  console.log(`module data: ${(await pathExists(gdctxRoot)) ? gdctxRoot : "missing"}`);
  console.log(`latest summary: ${(await pathExists(latestSummaryPath)) ? latestSummaryPath : "missing"}`);

  if (await pathExists(manifestPath)) {
    const manifest = await readJsonFileOr<{
      modules?: Record<string, { enabled?: boolean }>;
    }>(manifestPath, {});
    console.log(`gdctx enabled: ${manifest.modules?.gdctx?.enabled === true ? "yes" : "no"}`);
  }
}

async function diffAndSummarize(args: string[], config: CtxConfig): Promise<void> {
  const command = ["git", "diff", ...args];
  const result = await runCommand(command);
  const summary = summarizeDiff(command.join(" "), result, config);
  const artifact = await writeArtifact({
    kind: "diff",
    command: command.join(" "),
    raw: result.raw,
    summary,
    exitCode: result.exitCode,
  });

  printArtifactSummary(artifact, summary);
  process.exitCode = result.exitCode;
}

async function rgAndSummarize(args: string[], config: CtxConfig): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: gd-metapro ctx rg "<pattern>" [path]');
    process.exitCode = 1;
    return;
  }

  const command = ["rg", "--line-number", "--column", "--no-heading", ...args];
  const result = await runCommand(command);
  const summary = summarizeRg(command.join(" "), result, config);
  const artifact = await writeArtifact({
    kind: "rg",
    command: command.join(" "),
    raw: result.raw,
    summary,
    exitCode: result.exitCode,
  });

  printArtifactSummary(artifact, summary);
  process.exitCode = result.exitCode;
}

async function readAndSummarize(args: string[], config: CtxConfig): Promise<void> {
  const file = args[0];
  if (!file) {
    console.error("Usage: gd-metapro ctx read <file> [--mode outline|compact|full]");
    process.exitCode = 1;
    return;
  }

  const mode = optionValue(args, "--mode") ?? "compact";
  if (!["outline", "compact", "full"].includes(mode)) {
    console.error(`Unsupported read mode: ${mode}`);
    console.error("Supported modes: outline, compact, full");
    process.exitCode = 1;
    return;
  }

  const absolutePath = path.resolve(process.cwd(), file);
  const rawContent = await readFile(absolutePath, "utf8");
  // Redact any detected secret before it is summarized/persisted into a gdctx
  // artifact. No-op (byte-identical) when security is disabled or nothing is
  // detected.
  const content = (
    await redactRaw({ cwd: process.cwd(), content: rawContent, source: "trusted-project" })
  ).content;
  const lines = content.split("\n");
  const summary =
    mode === "full"
      ? summarizeFullFile(file, lines)
      : mode === "outline"
        ? summarizeOutline(file, lines, config)
        : summarizeCompact(file, lines, config);

  const artifact = await writeArtifact({
    kind: "read",
    command: `read ${file} --mode ${mode}`,
    raw: content,
    summary,
    exitCode: 0,
  });

  printArtifactSummary(artifact, summary);
}

async function runAndSummarize(
  kind: string,
  command: string[],
  config: CtxConfig,
): Promise<void> {
  const result = await runCommand(command);
  const summary = summarizeCommandOutput(command.join(" "), result, config);
  const artifact = await writeArtifact({
    kind,
    command: command.join(" "),
    raw: result.raw,
    summary,
    exitCode: result.exitCode,
  });

  printArtifactSummary(artifact, summary);
  process.exitCode = result.exitCode;
}

async function showArtifact(args: string[]): Promise<void> {
  const target = args[0] ?? "latest";
  const raw = args.includes("--raw");
  const root = path.join(process.cwd(), ".metaproject", "data", "gdctx");
  const filePath =
    target === "latest"
      ? path.join(root, raw ? "raw" : "artifacts", raw ? "latest.log" : "latest.md")
      : path.join(root, raw ? "raw" : "artifacts", target);

  if (!(await pathExists(filePath))) {
    console.error(`Artifact not found: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  console.log(await readFile(filePath, "utf8"));
}

async function runCommand(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const raw = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");

  return redactCommandResult({ stdout, stderr, raw, exitCode });
}

// Security seam (§11): redact detected secrets from raw command output before it
// is summarized or persisted, so a secret in raw output never lands in a gdctx
// artifact. `redactRaw` is a zero-cost no-op (byte-identical) whenever security
// is disabled or nothing sensitive is detected, so existing behavior is
// preserved on the common path.
async function redactCommandResult(result: CommandResult): Promise<CommandResult> {
  const cwd = process.cwd();
  const [raw, stdout, stderr] = await Promise.all([
    redactRaw({ cwd, content: result.raw, source: "tool-output" }),
    redactRaw({ cwd, content: result.stdout, source: "tool-output" }),
    redactRaw({ cwd, content: result.stderr, source: "tool-output" }),
  ]);
  return {
    raw: raw.content,
    stdout: stdout.content,
    stderr: stderr.content,
    exitCode: result.exitCode,
  };
}

async function writeArtifact({
  kind,
  command,
  raw,
  summary,
  exitCode,
}: {
  kind: string;
  command: string;
  raw: string;
  summary: string;
  exitCode: number;
}): Promise<CtxArtifact> {
  const root = path.join(process.cwd(), ".metaproject", "data", "gdctx");
  const rawRoot = path.join(root, "raw");
  const artifactsRoot = path.join(root, "artifacts");
  await mkdir(rawRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}_${kind}`;
  const rawPath = path.join(rawRoot, `${id}.log`);
  const summaryPath = path.join(artifactsRoot, `${id}.md`);
  const latestRawPath = path.join(rawRoot, "latest.log");
  const latestSummaryPath = path.join(artifactsRoot, "latest.md");
  const bytesIn = Buffer.byteLength(raw);
  const bytesOut = Buffer.byteLength(summary);

  const artifact: CtxArtifact = {
    id,
    kind,
    command,
    exitCode,
    rawPath: path.relative(process.cwd(), rawPath),
    summaryPath: path.relative(process.cwd(), summaryPath),
    bytesIn,
    bytesOut,
    truncated: bytesOut < bytesIn,
  };
  const summaryWithMeta = `${summary.trimEnd()}

## Metadata

\`\`\`json
${JSON.stringify(artifact, null, 2)}
\`\`\`
`;

  await writeFile(rawPath, raw, "utf8");
  await writeFile(summaryPath, summaryWithMeta, "utf8");
  await writeFile(latestRawPath, raw, "utf8");
  await writeFile(latestSummaryPath, summaryWithMeta, "utf8");

  return artifact;
}

function summarizeDiff(
  command: string,
  result: CommandResult,
  config: CtxConfig,
): string {
  const lines = nonEmptyLines(result.raw);
  const files = parseDiffFiles(lines);
  const risky = files.filter((file) =>
    /(^|\/)(package\.json|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|tsconfig.*\.json|\.github\/|scripts\/|src\/cli\.ts|src\/commands\/)/.test(file.path),
  );
  const hunks = lines.filter((line) => line.startsWith("@@")).slice(0, config.maxOutputLines);
  const errors = importantLines(lines, config);

  return `# gdctx diff summary

Command: \`${command}\`
Exit code: \`${result.exitCode}\`
Changed files: \`${files.length}\`
Raw lines: \`${lines.length}\`

## Files

${renderDiffFiles(files, config)}

## Risk Hints

${risky.length > 0 ? risky.map((file) => `- ${file.path}`).join("\n") : "- none"}

## Hunks

\`\`\`text
${hunks.length > 0 ? hunks.join("\n") : "(no hunk headers)"}
\`\`\`

${errors.length > 0 ? renderTextSection("Errors / Warnings", errors) : ""}
`;
}

function summarizeRg(
  command: string,
  result: CommandResult,
  config: CtxConfig,
): string {
  const lines = nonEmptyLines(result.raw);
  const matches = parseRgMatches(lines);
  const grouped = groupBy(matches, (match) => match.file);
  const files = [...grouped.entries()]
    .map(([file, fileMatches]) => ({ file, matches: fileMatches }))
    .sort((a, b) => b.matches.length - a.matches.length);

  return `# gdctx rg summary

Command: \`${command}\`
Exit code: \`${result.exitCode}\`
Matches: \`${matches.length}\`
Files: \`${files.length}\`
Raw lines: \`${lines.length}\`

## Top Files

${files.length > 0 ? files.slice(0, config.maxGroupItems).map((item) => `- ${item.file}: ${item.matches.length}`).join("\n") : "- none"}

## Matches

${renderRgMatches(files, config)}

${result.stderr.trim() ? renderTextSection("stderr", result.stderr.split("\n").slice(0, config.maxImportantLines)) : ""}
`;
}

function summarizeCommandOutput(
  command: string,
  result: CommandResult,
  config: CtxConfig,
): string {
  const lines = nonEmptyLines(result.raw);
  const important = importantLines(lines, config);
  const selected = compactLines(lines, config.maxOutputLines);

  return `# gdctx command summary

Command: \`${command}\`
Exit code: \`${result.exitCode}\`
Raw lines: \`${lines.length}\`
stdout bytes: \`${Buffer.byteLength(result.stdout)}\`
stderr bytes: \`${Buffer.byteLength(result.stderr)}\`

${important.length > 0 ? renderTextSection("Errors / Warnings", important) : ""}
## Output

\`\`\`text
${selected.join("\n") || "(no output)"}
\`\`\`
`;
}

function summarizeFullFile(file: string, lines: string[]): string {
  return `# gdctx full file

File: \`${file}\`
Lines: \`${lines.length}\`

\`\`\`text
${lines.join("\n")}
\`\`\`
`;
}

function summarizeOutline(file: string, lines: string[], config: CtxConfig): string {
  const imports = outlineEntries(lines, /^\s*import\b/, config);
  const exports = outlineEntries(lines, /^\s*export\b/, config);
  const declarations = outlineEntries(
    lines,
    /^\s*(export\s+)?(abstract\s+)?(class|interface|type|enum|function|async function|const|let|var)\b/,
    config,
  );
  const todos = outlineEntries(lines, /\b(TODO|FIXME|HACK)\b/i, config);

  return `# gdctx file outline

File: \`${file}\`
Lines: \`${lines.length}\`

## Imports

\`\`\`text
${imports.join("\n") || "(none)"}
\`\`\`

## Exports / Declarations

\`\`\`text
${dedupe([...exports, ...declarations]).join("\n") || "(none)"}
\`\`\`

## TODO / FIXME

\`\`\`text
${todos.join("\n") || "(none)"}
\`\`\`
`;
}

function summarizeCompact(file: string, lines: string[], config: CtxConfig): string {
  const selected =
    lines.length > config.compactHeadLines + config.compactTailLines
      ? [
          ...lines.slice(0, config.compactHeadLines),
          `... omitted ${lines.length - config.compactHeadLines - config.compactTailLines} lines ...`,
          ...lines.slice(-config.compactTailLines),
        ]
      : lines;

  return `# gdctx compact file

File: \`${file}\`
Lines: \`${lines.length}\`

\`\`\`text
${selected.join("\n")}
\`\`\`
`;
}

function parseDiffFiles(lines: string[]): Array<{ path: string; added: number; removed: number }> {
  const files = new Map<string, { path: string; added: number; removed: number }>();
  let current: { path: string; added: number; removed: number } | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const filePath = line.match(/ b\/(.+)$/)?.[1] ?? line.split(" ").at(-1)?.replace(/^b\//, "") ?? "unknown";
      current = files.get(filePath) ?? { path: filePath, added: 0, removed: 0 };
      files.set(filePath, current);
      continue;
    }

    if (!current || line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+")) {
      current.added += 1;
    } else if (line.startsWith("-")) {
      current.removed += 1;
    }
  }

  return [...files.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed));
}

function renderDiffFiles(
  files: Array<{ path: string; added: number; removed: number }>,
  config: CtxConfig,
): string {
  if (files.length === 0) {
    return "- none";
  }

  return files
    .slice(0, config.maxGroupItems)
    .map((file) => `- ${file.path}: +${file.added} -${file.removed}`)
    .join("\n");
}

function parseRgMatches(lines: string[]): Array<{ file: string; line: string; column: string; text: string }> {
  return lines.map((line) => {
    const match = line.match(/^(.+?):(\d+):(\d+):(.*)$/);
    if (!match) {
      return { file: "(unknown)", line: "0", column: "0", text: line };
    }
    const [, file = "(unknown)", lineNumber = "0", column = "0", text = ""] = match;
    return { file, line: lineNumber, column, text: text.trim() };
  });
}

function renderRgMatches(
  files: Array<{ file: string; matches: Array<{ line: string; column: string; text: string }> }>,
  config: CtxConfig,
): string {
  if (files.length === 0) {
    return "- none";
  }

  return files
    .slice(0, config.maxGroupItems)
    .map((item) => {
      const examples = item.matches
        .slice(0, 4)
        .map((match) => `  - ${match.line}:${match.column} ${truncate(match.text, 180)}`)
        .join("\n");
      return `- ${item.file}\n${examples}`;
    })
    .join("\n");
}

function outlineEntries(lines: string[], pattern: RegExp, config: CtxConfig): string[] {
  return lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => pattern.test(line))
    .slice(0, config.outlineMaxEntries)
    .map(({ line, number }) => `${number}: ${line.trimEnd()}`);
}

async function loadConfig(): Promise<CtxConfig> {
  const configPath = path.join(process.cwd(), ".metaproject", "gdctx.config.json");
  if (!(await pathExists(configPath))) {
    return DEFAULT_CONFIG;
  }

  const parsed = await readJsonFileOr<Partial<CtxConfig>>(configPath, {});
  return {
    maxOutputLines: parsed.maxOutputLines ?? DEFAULT_CONFIG.maxOutputLines,
    maxImportantLines: parsed.maxImportantLines ?? DEFAULT_CONFIG.maxImportantLines,
    maxGroupItems: parsed.maxGroupItems ?? DEFAULT_CONFIG.maxGroupItems,
    compactHeadLines: parsed.compactHeadLines ?? DEFAULT_CONFIG.compactHeadLines,
    compactTailLines: parsed.compactTailLines ?? DEFAULT_CONFIG.compactTailLines,
    outlineMaxEntries: parsed.outlineMaxEntries ?? DEFAULT_CONFIG.outlineMaxEntries,
  };
}

function importantLines(lines: string[], config: CtxConfig): string[] {
  return dedupe(
    lines.filter((line) =>
      /error|failed|failure|exception|traceback|warning|warn|fatal|cannot|not found|permission denied/i.test(line),
    ),
  ).slice(0, config.maxImportantLines);
}

function compactLines(lines: string[], limit: number): string[] {
  if (lines.length <= limit) {
    return lines;
  }

  const head = Math.ceil(limit * 0.45);
  const tail = Math.floor(limit * 0.45);
  const important = lines.filter((line) =>
    /error|failed|failure|exception|traceback|warning|warn|fatal/i.test(line),
  );

  return dedupe([
    ...lines.slice(0, head),
    ...important.slice(0, limit - head - tail),
    `... omitted ${Math.max(0, lines.length - limit)} lines ...`,
    ...lines.slice(-tail),
  ]).slice(0, limit + 1);
}

function nonEmptyLines(value: string): string[] {
  return value.split("\n").filter((line) => line.trim().length > 0);
}

function renderTextSection(title: string, lines: string[]): string {
  return `## ${title}

\`\`\`text
${lines.join("\n") || "(none)"}
\`\`\`
`;
}

function groupBy<T>(items: T[], getKey: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function printArtifactSummary(artifact: CtxArtifact, summary: string): void {
  console.log(summary.trimEnd());
  console.log("");
  console.log(`raw: ${artifact.rawPath}`);
  console.log(`summary: ${artifact.summaryPath}`);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function printHelp(): void {
  console.log(`gd-metapro ctx

Usage:
  gd-metapro ctx status
  gd-metapro ctx diff [--staged|--stat]
  gd-metapro ctx rg "<pattern>"
  gd-metapro ctx read <file> [--mode outline|compact|full]
  gd-metapro ctx run -- <command...>
  gd-metapro ctx show latest [--raw]
`);
}
