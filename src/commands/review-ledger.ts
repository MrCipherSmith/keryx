import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { optionValue } from "../lib/args";
import { writeFileAtomic } from "../lib/fs";
import { DISPATCH_KNOWN_ROLES, skipLine, type ReviewerSkip, packageChangedLines, packageRoundDepth, packageHasBlastRadius, packageHasPrContext, packageScopeFiles, projectRootOfPackage, requiredReviewers, type ReviewMode } from "../review/coverage";
import { SLICE_MANIFEST_COPY } from "../review/coverage-complete";
import { readToolLog } from "../review/layers-usage";
import { pendingMutants } from "../review/mutate";
import { type Disposition, type LedgerGap, type RawFile, buildLedger, followUpsOf, isEmptyOutput, isReviewerResult, ledgerBlockers, parseReviewResult, sha } from "../review/ledger";
import { type RetryState, applyEscalations, emptyRetryState, escalationsFor, readSliceIds, scopeFingerprint } from "../review/retry-plan";
import { narrowedSlices, packageRoutingRefusal, routingRefusal, sliceTextReader } from "../review/routing-check";
import { type SliceManifest, manifestSizeProblem } from "../review/slice";
import { packagePlanGate } from "../review/estimate";

export const LEDGER_FLAGS = ["--package", "--mode", "--findings", "--dispositions", "--out", "--skip", "--reason", "--dry-run", "--json", "--help", "-h"] as const;
const VALUE_FLAGS = new Set(["--package", "--mode", "--findings", "--dispositions", "--out", "--skip", "--reason"]);

export function printLedgerHelp(): void {
  console.log(`keryx review ledger build — usage:

  keryx review ledger build [<input-dir>] [--package <review-dir>] [--mode all|diff]
                            [--findings <findings.json>] [--dispositions <file>]
                            [--out <research.json>] [--skip <reviewer> --reason "<why>"]...
                            [--dry-run] [--json]

Builds the research ledger \`keryx review ingest --research\` and \`complete\` demand, from
files only. <input-dir> holds raw/*.txt (reviewer replies), drivers/*.json and
slices/manifest.json, and defaults to --package (each review keeps its own raw/ and drivers/; the
shared .metaproject/data/review is read only when named); --package (default: <input-dir> when it holds scope-files.json) holds
scope-files.json, findings.json and retry-state.json. Writes research.json there (--out).

Per required reviewer: the latest raw result decides. DONE / DONE_WITH_CONCERNS with no open
needs_context and every slice its path gate requires covered by its dispatched payloads is a
complete run (source-only, executionRequired false); anything else — NEEDS_CONTEXT, BLOCKED,
INCOMPLETE, missing slices, no result — stays incomplete or not-run, never declared complete.
Each raw finding becomes an obligation, closed only by a matching canonical finding or a
valid --dispositions entry ({id, status finding|refuted|out-of-scope|narrowed, evidence, reason,
finding?, remains? — required for narrowed: what of the finding still stands}; default: the obligations already in research.json). scopeReviewed and rawReconciled
are true only when established.

--skip <reviewer> --reason "<why>" (repeatable, each --skip followed by its --reason) records a
required reviewer the operator deliberately did not run: it leaves the dispatch selection, is
written to dispatch.skipped and as \`Not run: <reviewer> — <why>\` to dispatch.notRun and the
report, and the reviewer-set gate accepts it with that line on the record. A skip with no
reason, or of a reviewer the round does not require, is refused.

Slices are dispatched in waves bounded by the manifest's wave budget; a reviewer that covered
new slices is not penalised for the rest (retry-state.json keeps what it covered).

Prints READY, or NOT READY with each gap and its next step (the exact retry-plan command,
the uncovered slices and how many waves remain, or the disposition to add). Exit 1 when NOT READY, so
\`ledger build && ingest --research\` stops. The gate's own validators decide READY.
`);
}

function positional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

type DriverFile = { reviewer?: unknown; slices?: unknown; definition?: unknown; skill_path?: unknown; payload?: unknown; result?: unknown; toolLog?: unknown };

/** Where a driver file names the reviewer's rule file: a top-level `definition` or `skill_path`, or the same keys inside the dispatch `payload`. */
export function definitionCandidates(driver: DriverFile): string[] {
  const payload = driver.payload !== null && typeof driver.payload === "object" ? (driver.payload as DriverFile) : {};
  return [driver.definition, driver.skill_path, payload.definition, payload.skill_path].filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

async function jsonFiles(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).filter((n) => n.endsWith(".json")).sort().map((n) => path.join(dir, n)) : [];
}

/** A raw file is a reviewer reply when a driver names it or it is named after a dispatched or required reviewer; anything else without a REVIEW_RESULT block is set aside. */
export type ReplyNames = { files: ReadonlySet<string>; reviewers: readonly string[] };

export function isReviewerReply(name: string, body: string, replies: ReplyNames): boolean {
  if (/REVIEW_RESULT/i.test(body) || replies.files.has(name)) return true;
  const stem = name.replace(/\.txt$/, "");
  return replies.reviewers.some((reviewer) => stem === reviewer || stem.startsWith(`${reviewer}-`) || stem.startsWith(`${reviewer}.`));
}

export async function loadRaws(inputDir: string, replies: ReplyNames): Promise<{ raws: RawFile[]; ignored: string[]; setAside: string[] }> {
  const raws: RawFile[] = [];
  const ignored: string[] = [];
  const setAside: string[] = [];
  const dir = path.join(inputDir, "raw");
  for (const name of (await readdir(dir)).filter((n) => n.endsWith(".txt")).sort()) {
    const file = path.join(dir, name);
    const body = await readFile(file, "utf8");
    const result = isEmptyOutput(body) ? undefined : parseReviewResult(body);
    if (result === undefined && !isEmptyOutput(body) && !isReviewerReply(name, body, replies)) {
      ignored.push(`raw/${name} (set aside: not a reviewer reply — no REVIEW_RESULT block, no driver names it as its result and its name is not a dispatched or required reviewer's; the file is left in place)`);
      setAside.push(`raw/${name}`);
      continue;
    }
    // A ```REVIEW_RESULT fence keeps the status-only rule in parseReviewResult; such a result names no reviewer and cannot be attributed, so it is ignored here.
    if (result !== undefined && !isReviewerResult(result)) {
      ignored.push(`raw/${name}`);
      continue;
    }
    // `Parent follow-up:` lines below the block join the result's own `follow_ups`; a result with neither is left as parsed.
    const followUps = result === undefined ? [] : followUpsOf(result, body);
    const merged = result === undefined || followUps.length === 0 ? result : { ...result, follow_ups: followUps };
    raws.push({ name: `raw/${name}`, hash: sha(body), mtimeMs: (await stat(file)).mtimeMs, empty: isEmptyOutput(body), ...(merged === undefined ? {} : { result: merged }) });
  }
  return { raws, ignored, setAside };
}

async function loadRetry(fingerprint: string | undefined, ...files: string[]): Promise<RetryState> {
  const merged = emptyRetryState();
  for (const file of files) {
    const state = await readJson<RetryState>(file);
    if (fingerprint === undefined || state?.scopeFingerprint !== fingerprint) continue;
    merged.scopeFingerprint = fingerprint;
    for (const [reviewer, entry] of Object.entries(state?.reviewers ?? {})) {
      const known = merged.reviewers[reviewer];
      const covered = [...new Set([...(known?.covered ?? []), ...(entry.covered ?? [])])].sort();
      const stalls = Math.max(known?.stalls ?? known?.attempt ?? 0, entry.stalls ?? entry.attempt);
      merged.reviewers[reviewer] = { attempt: Math.max(known?.attempt ?? 0, entry.attempt), status: entry.status, notRun: known?.notRun === true || entry.notRun === true, stalls, covered };
    }
  }
  return merged;
}

export type DriverRecords = {
  payloadSlices: Record<string, string[]>;
  payloadDispatchCounts: Record<string, number>;
  ruleFiles: Record<string, string>;
  /** Reviewer → the tool-call log path its driver names. */
  toolLogs: Record<string, string>;
  assignments: Map<string, string[][]>;
  replies: ReplyNames;
  /** Drivers whose `slices` held an entry with no usable id: that dispatch's slices are not counted as handed out. */
  dropped: Array<{ file: string; reviewer: string; unusable: number }>;
};

/** Reads `<input-dir>/drivers/*.json`: what each dispatch handed a reviewer, the file its reply goes to, and the rule file it ran under. */
export async function readDrivers(inputDir: string, root: string): Promise<DriverRecords> {
  const payloadSlices: Record<string, string[]> = {};
  const payloadDispatchCounts: Record<string, number> = {};
  const ruleFiles: Record<string, string> = {};
  const toolLogs: Record<string, string> = {};
  const assignments = new Map<string, string[][]>();
  const replyFiles = new Set<string>();
  const replyReviewers = new Set<string>();
  const dropped: DriverRecords["dropped"] = [];
  for (const file of await jsonFiles(path.join(inputDir, "drivers"))) {
    const driver = await readJson<DriverFile>(file);
    if (typeof driver?.reviewer !== "string") continue;
    payloadDispatchCounts[driver.reviewer] = (payloadDispatchCounts[driver.reviewer] ?? 0) + 1;
    replyReviewers.add(driver.reviewer);
    const slices = readSliceIds(driver.slices, "assigned");
    const complete = Array.isArray(driver.slices) && slices.unusable === 0;
    if (slices.unusable > 0) dropped.push({ file: path.basename(file), reviewer: driver.reviewer, unusable: slices.unusable });
    if (complete) (payloadSlices[driver.reviewer] ??= []).push(...slices.ids);
    if (typeof driver.result === "string") {
      replyFiles.add(path.basename(driver.result));
      if (complete) {
        const key = `${driver.reviewer}\0${driver.result}`;
        const matches = assignments.get(key) ?? [];
        matches.push(slices.ids);
        assignments.set(key, matches);
      }
    }
    if (typeof driver.toolLog === "string" && driver.toolLog.trim() !== "") toolLogs[driver.reviewer] = driver.toolLog;
    for (const candidate of definitionCandidates(driver)) {
      const definition = path.resolve(root, candidate);
      if (existsSync(definition)) { ruleFiles[driver.reviewer] = path.relative(root, definition); break; }
    }
  }
  return { payloadSlices, payloadDispatchCounts, ruleFiles, toolLogs, assignments, replies: { files: replyFiles, reviewers: [...replyReviewers] }, dropped };
}

/**
 * The `dispatch.roles` stamp for a rebuild. A rebuild does not know what dispatched the package, so it never invents the
 * stamp: it keeps one the ledger on disk already has, and adds a known role only when a driver shows that role was dispatched.
 * A package in flight from before a role existed is therefore still grandfathered after a rebuild.
 */
async function knownDispatchRoles(ledgerFile: string, driverReviewers: readonly string[]): Promise<string[] | undefined> {
  const prior = (await readJson<{ dispatch?: { roles?: unknown } }>(ledgerFile))?.dispatch?.roles;
  const kept = Array.isArray(prior) ? prior.filter((role): role is string => typeof role === "string") : [];
  const dispatched = DISPATCH_KNOWN_ROLES.filter((role) => driverReviewers.includes(role));
  const roles = [...new Set([...kept, ...dispatched])];
  return roles.length === 0 ? undefined : roles;
}

/**
 * `--skip <reviewer> --reason "<why>"` pairs, in order. Each `--skip` takes the next `--reason`; a `--reason` with no
 * `--skip` before it, a `--skip` left without one, an empty value, or one reviewer skipped twice is refused.
 */
export function parseSkips(args: readonly string[]): ReviewerSkip[] {
  const skips: Array<{ reviewer: string; reason?: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg !== "--skip" && arg !== "--reason") {
      if (VALUE_FLAGS.has(arg)) i++;
      continue;
    }
    const value = args[i + 1];
    if (value === undefined || value.trim() === "" || value.startsWith("--")) throw new Error(`${arg} needs a value: --skip <reviewer> --reason "<why>"`);
    i++;
    if (arg === "--skip") {
      const open = skips.find((skip) => skip.reason === undefined);
      if (open !== undefined) throw new Error(`--skip ${open.reviewer} has no --reason; give each --skip its own --reason before the next --skip`);
      if (skips.some((skip) => skip.reviewer === value.trim())) throw new Error(`--skip ${value.trim()} is given twice`);
      skips.push({ reviewer: value.trim() });
    } else {
      const open = skips.find((skip) => skip.reason === undefined);
      if (open === undefined) throw new Error("--reason must follow the --skip <reviewer> it explains");
      open.reason = value.trim();
    }
  }
  const unexplained = skips.find((skip) => skip.reason === undefined);
  if (unexplained !== undefined) throw new Error(`--skip ${unexplained.reviewer} needs --reason "<why>": a skip without a reason is a silent pass`);
  return skips as ReviewerSkip[];
}

export function renderLedgerReport(ready: boolean, gaps: LedgerGap[], blockers: string[], out: string, ignored: string[], dryRun = false, notRun: readonly string[] = []): string {
  const verb = dryRun ? "would be written" : "written";
  const lines = [ready ? `READY: ${out} ${verb} and satisfies the completion gate.` : `NOT READY: ${out} ${verb}, but the completion gate would refuse it.`];
  for (const line of notRun) lines.push(`- ${line}`);
  for (const gap of gaps) lines.push(`- gap${gap.reviewer ? ` [${gap.reviewer}]` : ""}: ${gap.detail}\n    next: ${gap.next}`);
  const waves = gaps.filter((gap) => gap.reviewer !== undefined && gap.waves !== undefined && gap.waves > 0);
  if (waves.length > 0) lines.push(`remaining waves: ${waves.map((gap) => `${gap.reviewer} ${gap.waves}`).join(", ")}`);
  if (!ready) for (const blocker of blockers.slice(0, 10)) lines.push(`- gate: ${blocker}`);
  if (blockers.length > 10) lines.push(`- gate: … and ${blockers.length - 10} more`);
  if (ignored.length > 0) lines.push(`ignored (not reviewer results): ${ignored.join(", ")}`);
  return lines.join("\n");
}

/** Ambiguous raw-to-dispatch references never contribute implicit coverage. */
export function assignRawDispatch(raws: RawFile[], assignments: ReadonlyMap<string, readonly string[][]>): void {
  for (const raw of raws) {
    const matches = assignments.get(`${raw.result?.reviewer}\0${raw.name}`);
    if (matches !== undefined) raw.assignedSlices = matches.length === 1 ? [...matches[0]!] : [];
  }
}

export async function runLedger(args: string[], deps: { rejectUnknownFlags: (args: readonly string[], allowed: readonly string[], usage: string) => void }): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args[0] === undefined) return printLedgerHelp();
  if (args[0] !== "build") throw new Error(`Unknown ledger subcommand "${args[0]}". See \`keryx review ledger --help\`.`);
  const rest = args.slice(1);
  deps.rejectUnknownFlags(rest, LEDGER_FLAGS, "ledger build");
  // Flow 457 (T7, audit row 11): the input directory defaults to the package itself (<package>/raw, drivers, slices),
  // so one review never reads another's replies; the shared .metaproject/data/review is used only when named.
  const target = positional(rest) ?? optionValue(rest, "--package");
  if (target === undefined) throw new Error("Missing <input-dir> (or --package <review-dir>, whose raw/ is then the input). See `keryx review ledger --help`.");
  const inputDir = path.resolve(target);
  if (!existsSync(path.join(inputDir, "raw"))) throw new Error(`${inputDir} has no raw/ directory; pass the review input directory.`);
  const packageArg = optionValue(rest, "--package");
  const packageDir = path.resolve(packageArg ?? inputDir);
  if (packageArg === undefined && !existsSync(path.join(inputDir, "scope-files.json"))) throw new Error("Pass --package <review-dir> (the managed package with scope-files.json and findings.json).");
  const mode = (optionValue(rest, "--mode") ?? "all") as ReviewMode;
  if (mode !== "all" && mode !== "diff") throw new Error('--mode must be "all" or "diff".');

  const root = projectRootOfPackage(packageDir);
  const files = await packageScopeFiles(packageDir);
  const manifestPath = path.join(inputDir, "slices", "manifest.json");
  let manifest = await readJson<SliceManifest>(manifestPath);
  const manifestLabel = path.relative(process.cwd(), manifestPath) || manifestPath;
  if (manifest !== undefined) {
    const unsized = manifestSizeProblem(manifest);
    if (unsized !== undefined) throw new Error(`${manifestLabel}: ${unsized}`);
    // Security review M3: the recorded routing may only be wider than what each slice's own text needs.
    const routing = narrowedSlices(manifest, sliceTextReader(path.dirname(manifestPath)));
    const narrowed = routingRefusal(manifestLabel, routing.narrowed);
    if (narrowed !== undefined) throw new Error(`ledger build refused: ${narrowed}`);
  }
  // Round-2 m3: the package's own slice manifest is checked too, not only the input directory's.
  if (inputDir !== packageDir || manifest === undefined) {
    const ownRouting = packageRoutingRefusal(packageDir, root);
    if (ownRouting !== undefined) throw new Error(`ledger build refused: ${ownRouting}`);
  }
  if (manifest !== undefined) for (const entry of manifest.slices) {
    const hash = await readFile(path.resolve(path.dirname(manifestPath), entry.path))
      .then((body) => createHash("sha256").update(body).digest("hex")).catch(() => undefined);
    if (hash === undefined) delete entry.contentHash;
    else entry.contentHash = hash;
  }
  const canonical = (await readJson<Array<Record<string, unknown>>>(path.resolve(optionValue(rest, "--findings") ?? path.join(packageDir, "findings.json")))) ?? [];
  const out = path.resolve(optionValue(rest, "--out") ?? path.join(packageDir, "research.json"));
  const dispositionSource = optionValue(rest, "--dispositions");
  const given = await readJson<Disposition[] | { obligations?: Disposition[] }>(path.resolve(dispositionSource ?? out));
  const dispositions = (Array.isArray(given) ? given : given?.obligations) ?? [];

  const blastRadius = await packageHasBlastRadius(packageDir);
  const recordedDepth = await packageRoundDepth(packageDir);
  if (recordedDepth?.stale !== undefined) console.error(`round-depth.json ignored (${recordedDepth.stale}); building the full round. Re-run \`keryx review required --package\` to decide again.`);
  const depth = recordedDepth?.depth;
  const required = await requiredReviewers(root, mode, files, { blastRadius, prContext: packageHasPrContext(packageDir), depth });
  const skipped = parseSkips(rest);
  const notRequired = skipped.filter((skip) => !required.required.includes(skip.reviewer));
  if (notRequired.length > 0) throw new Error(`--skip ${notRequired.map((skip) => skip.reviewer).join(", ")}: not a reviewer this round requires (required: ${required.required.join(", ") || "none"}); nothing to skip`);
  const { payloadSlices, payloadDispatchCounts, ruleFiles, toolLogs: toolLogPaths, assignments, replies, dropped } = await readDrivers(inputDir, root);
  const { raws, ignored, setAside } = await loadRaws(inputDir, { files: replies.files, reviewers: [...new Set([...replies.reviewers, ...required.required])] });

  assignRawDispatch(raws, assignments);
  // Security review M5: a major-or-worse finding on a light slice re-opens it deep here too, not only through
  // `retry-plan --result`: a result collected late, or never handed to retry-plan, still escalates its slice.
  if (manifest !== undefined) {
    const escalations = raws.flatMap((raw) => (raw.result?.reviewer === undefined ? [] : escalationsFor(manifest!, raw.result.reviewer, raw.result.findings, raw.assignedSlices ?? [])));
    const unique = [...new Map(escalations.map((entry) => [entry.slice, entry])).values()];
    if (unique.length > 0) {
      manifest = applyEscalations(manifest, unique);
      for (const item of unique) console.error(`escalate ${item.slice}: ${item.severity} finding ${item.finding} from ${item.by} on a light slice; it is re-opened deep and every core role now owns it`);
      if (!rest.includes("--dry-run")) await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  // The plan the round ran: over the operator threshold it needs a recorded confirmation before it can be closed. With
  // no manifest in the input directory the package's own (or the shared one it was sliced into) is estimated.
  const plan = await packagePlanGate(packageDir, manifest === undefined ? {} : { manifest: manifestPath, manifestValue: manifest });
  if (plan.refusal !== undefined) throw new Error(`ledger build refused: ${plan.refusal}`);
  const toolLogs: Record<string, string | undefined> = {};
  for (const reviewer of required.required) toolLogs[reviewer] = await readToolLog(inputDir, reviewer, toolLogPaths[reviewer]);
  const { ledger, gaps } = buildLedger({
    dispatchRoles: await knownDispatchRoles(out, replies.reviewers),
    mode,
    depth,
    selected: required.required,
    manifest,
    payloadSlices,
    payloadDispatchCounts,
    ruleFiles,
    raws,
    toolLogs,
    retry: await loadRetry(manifest === undefined ? undefined : scopeFingerprint(manifest), path.join(inputDir, "slices", "retry-state.json"), path.join(packageDir, "retry-state.json")),
    canonical,
    dispositions,
    manifestPath: path.relative(process.cwd(), manifestPath),
    skipped,
  });
  for (const driver of dropped) {
    gaps.push({ reviewer: driver.reviewer, detail: `drivers/${driver.file}: ${driver.unusable} slice entr${driver.unusable === 1 ? "y" : "ies"} without a usable id; none of this dispatch's slices counts as handed to ${driver.reviewer}`, next: `give every entry in drivers/${driver.file} an id string, or an object with an id` });
  }
  if (setAside.length > 0) ledger.setAside = setAside;
  const blockers = await ledgerBlockers(ledger, canonical, { root, packageDir, files, changedLines: await packageChangedLines(packageDir), blastRadius, pendingMutants: (await pendingMutants(packageDir)).length });
  const ready = blockers.length === 0;
  if (!rest.includes("--dry-run")) {
    await writeFileAtomic(out, `${JSON.stringify(ledger, null, 2)}\n`);
    if (manifest !== undefined && path.resolve(packageDir) !== inputDir) await writeFileAtomic(path.join(packageDir, SLICE_MANIFEST_COPY), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(rest.includes("--json") ? JSON.stringify({ ready, out, gaps, blockers, ignored, ledger }, null, 2) : renderLedgerReport(ready, gaps, blockers, path.relative(process.cwd(), out) || out, ignored, rest.includes("--dry-run"), skipped.map(skipLine)));
  if (!ready) process.exitCode = 1;
}
