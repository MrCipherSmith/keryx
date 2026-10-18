import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { assertGitRevision } from "../lib/git-revision";
import { resolveProjectRoot } from "../lib/contained-path";
import { requiredReviewers } from "../review/coverage";
import { evaluatePlans, parseGroundTruth, renderPlanEval } from "../review/plan-eval";

export const PLAN_EVAL_FLAGS = ["--diff", "--findings", "--roles", "--max-bytes", "--wave-bytes", "--head", "--old-chunks", "--new-chunks", "--reach", "--jev-scores", "--json", "--help", "-h"] as const;

export function printPlanEvalHelp(): void {
  console.log(`keryx review plan-eval — usage:

  keryx review plan-eval --diff <file|base..head> [--findings <canonical.json|findings.json|report.md>]
                         [--roles a,b,c] [--max-bytes <n>] [--wave-bytes <n>] [--head <sha>]
                         [--old-chunks <n>] [--new-chunks <n>] [--reach <file.json>] [--jev-scores <file.json>] [--json]

Offline and model-free: cuts the diff into slices once, then costs the OLD plan (every role
owns every slice its path gate allows) and the NEW plan (slices routed by content, deep by
risk, an audit sample deep) with the estimate a round prints: slices, assignments,
dispatches, minutes, deep/light/audit counts. --old-chunks / --new-chunks add the blast-radius
chunk passes of each plan (computed by the radius, not here). --roles is the round's roster
(default: what \`keryx review required --mode all\` selects for this project and diff).

With --findings, each ground-truth finding (file, optional line, reviewer or category) is
placed on the slices that hold it; it lands when one of them is owned by its reviewer or is
deep. Blocker/major findings that land under each plan are counted.
`);
}

async function readDiff(source: string): Promise<string> {
  if (existsSync(source)) return readFile(source, "utf8");
  const range = /^([^.\s]+)\.\.\.?([^.\s]+)$/.exec(source);
  if (range === null) throw new Error(`--diff ${source} is neither a file nor a base..head range`);
  assertGitRevision(range[1]!);
  assertGitRevision(range[2]!);
  const proc = Bun.spawn(["git", "diff", "--no-color", "--end-of-options", `${range[1]}...${range[2]}`], { stdout: "pipe", stderr: "pipe", maxBuffer: 64 * 1024 * 1024 });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git diff ${source} failed: ${err.trim()}`);
  return out;
}

async function readNumberMap(file: string | undefined): Promise<Record<string, number> | undefined> {
  if (file === undefined) return undefined;
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must be a JSON object of key -> number`);
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

function numberFlag(args: string[], flag: string): number | undefined {
  const raw = optionValue(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} needs a non-negative number, got ${raw}`);
  return value;
}

export async function runPlanEval(args: string[], deps: { rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void }): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) return printPlanEvalHelp();
  deps.rejectUnknownFlags(args, PLAN_EVAL_FLAGS, "plan-eval");
  const source = optionValue(args, "--diff");
  if (source === undefined) throw new Error("plan-eval needs --diff <file|base..head>. See `keryx review plan-eval --help`.");
  const diff = await readDiff(source);
  const findingsFile = optionValue(args, "--findings");
  const findings = findingsFile === undefined ? undefined : parseGroundTruth(await readFile(path.resolve(findingsFile), "utf8"));
  const rolesFlag = optionValue(args, "--roles");
  let roles = rolesFlag?.split(",").map((role) => role.trim()).filter(Boolean);
  if (roles === undefined) {
    const files = [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]!))];
    roles = (await requiredReviewers(resolveProjectRoot(process.cwd()), "all", files)).required;
  }
  const result = evaluatePlans({
    diff,
    roles,
    findings,
    maxBytes: numberFlag(args, "--max-bytes"),
    waveBytes: numberFlag(args, "--wave-bytes"),
    head: optionValue(args, "--head"),
    oldChunks: numberFlag(args, "--old-chunks"),
    newChunks: numberFlag(args, "--new-chunks"),
    reach: await readNumberMap(optionValue(args, "--reach")),
    jevScores: await readNumberMap(optionValue(args, "--jev-scores")),
  });
  console.log(args.includes("--json") ? JSON.stringify({ roles, ...result }, null, 2) : `roles (${roles.length}): ${roles.join(", ")}\n${renderPlanEval(result)}`);
}
