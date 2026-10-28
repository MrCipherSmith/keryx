import type { Control } from "../../remote-control/protocol";
import type { ConformPrPort } from "../../review/conform-pr-port";
import type { JevCommentsFactsPort } from "../../commands/review-jev-comments";
import type { SessionCommandEffect } from "./effects";
import { commandsForMode } from "../../commands/agent-commands";
import { computeJevRiskResult } from "../../commands/review-jev-risk";
import { computeJevScenariosResult } from "../../commands/review-jev-scenarios";
import { computeJevRulesResult } from "../../commands/review-jev-rules";
import { computeJevDocsResult } from "../../commands/review-jev-docs";
import { computeJevContractResult } from "../../commands/review-jev-contract";
import { computeJevTriageResult } from "../../commands/review-jev-triage";
import { computeJevCommentsResult } from "../../commands/review-jev-comments";
import { readJevRiskEnabled } from "../../review/jev-risk-config";
import { readJevScenariosEnabled } from "../../review/jev-scenarios-config";
import { readJevRulesEnabled } from "../../review/jev-rules-config";
import { readJevDocsEnabled } from "../../review/jev-docs-config";
import { readJevContractEnabled } from "../../review/jev-contract-config";
import { readJevTriageEnabled } from "../../review/jev-triage-config";
import { readJevCommentsEnabled } from "../../review/jev-comments-config";
import { buildReviewScope } from "../../review/scope";
import { RISK_DIMENSIONS } from "../../review/jev-risk";
import { redactSensitiveText } from "../../security/service";
import { validateArguments } from "../../remote-control/protocol";
import type { NativeCommandContribution } from "./handlers";
import { loadCiTriageList, runCiTriageForItem, type CiSourceSpawn } from "../../tui/ci-triage-source";
import { loadConformSetup, runConformForTarget } from "../../tui/conform-source";
import { readConformEnabled } from "../../review/conform-report";
import { readCiTriageEnabled } from "../../review/ci-triage";
import type { ReportFindingLike } from "../../review/conform-state";
import type { ConformTargetOption } from "../../tui/conform-inspector";

export type AnalysisCommand = "ci" | "conform" | "risk" | "scenarios" | "jevrules" | "staledocs" | "opencomments" | "contract" | "triage";
/** Local constructor capability only. It is never accepted from Hub data or serialized into a result. */
export interface NativeAnalysisPort {
  enabledCommands: readonly AnalysisCommand[];
  model: string;
  env: Readonly<Record<string, string | undefined>>;
  fetchFn: typeof fetch;
  maxCalls: number;
  policyDigest: string;
  /** Fixed, locally supervised Git read. No caller-supplied argv or executable. */
  readDiff(signal: AbortSignal): Promise<string>;
  /** Existing latest-review discovery plus bounded, contained findings read, locally supplied. */
  readLatestFindings?: (signal: AbortSignal) => Promise<unknown>;
  readReference?: (relativePath: string, signal: AbortSignal) => Promise<string>;
  readReport?: (relativeDir: string, signal: AbortSignal) => Promise<{ markdown: string; findings: readonly ReportFindingLike[] }>;
  ciSpawn?: CiSourceSpawn;
  github?: { repo: string; number: number; prPort: ConformPrPort; factsPort: JevCommentsFactsPort };
}
/** Flow-free inspection reads only: the fixed GH argv validator over the native owned-read capture.
 * Carries no model, environment, fetch, budget or policy value, so no inspection can reach a provider. */
export interface NativeAnalysisReadPort {
  ciSpawn: CiSourceSpawn;
}
export interface AnalysisCommandContext {
  cwd: string;
  configDir?: string;
  effect?: SessionCommandEffect & { analysis?: NativeAnalysisPort };
}
export type AnalysisResult =
  | { ok: true; source: "native-analysis"; data: unknown; runId: string; turnId: string; analysisModel: string }
  | { ok: false; source: "native-analysis"; error: { code: "not-admitted" | "setup-required" | "implementation-gap" | "invalid-arguments" | "policy-denied" | "cancelled" | "budget-exceeded" | "analysis-failed" | "quota-exceeded"; message: string } };
export type AnalysisInspectionResult = { ok: true; source: "native-analysis"; data: unknown } | Extract<AnalysisResult, { ok: false }>;

export type AnalysisArguments = Record<string, string | number | undefined>;
export type AnalysisSchema = Control["ArgumentSchema"];

const commands: readonly AnalysisCommand[] = ["ci", "conform", "risk", "scenarios", "jevrules", "staledocs", "opencomments", "contract", "triage"];
const implemented = new Set<AnalysisCommand>(commands);
const empty: AnalysisSchema = { type: "object", properties: {}, additionalProperties: false, required: [] };
const schemas: Record<AnalysisCommand, AnalysisSchema> = Object.fromEntries(commands.map((command) => [command, empty])) as Record<AnalysisCommand, AnalysisSchema>;
schemas.contract = { type: "object", properties: { description: { type: "string", maxLength: 24000 } }, additionalProperties: false, required: [] };
schemas.ci = { type: "object", properties: { runId: { type: "string", maxLength: 30 }, jobName: { type: "string", maxLength: 200 } }, additionalProperties: false, required: ["runId", "jobName"] };
schemas.conform = { type: "object", properties: { referencePath: { type: "string", maxLength: 300 }, targetKind: { type: "string", maxLength: 10, enum: ["diff", "pr", "report"] }, targetId: { type: "string", maxLength: 300 } }, additionalProperties: false, required: ["referencePath", "targetKind"] };
const enabled: Partial<Record<AnalysisCommand, (cwd: string) => Promise<boolean>>> = {
  risk: readJevRiskEnabled, scenarios: readJevScenariosEnabled, jevrules: readJevRulesEnabled, staledocs: readJevDocsEnabled,
  opencomments: readJevCommentsEnabled, contract: readJevContractEnabled, triage: readJevTriageEnabled,
  conform: readConformEnabled, ci: (cwd) => readCiTriageEnabled(cwd, { jevAvailable: true }),
};
function failure(code: Extract<AnalysisResult, { ok: false }>["error"]["code"], message: string): Extract<AnalysisResult, { ok: false }> {
  return { ok: false, source: "native-analysis", error: { code, message } };
}

/** Real service dispatch. Admission and local consent are mandatory even for a no-findings outcome. */
export async function executeAnalysisCommand(context: AnalysisCommandContext, command: AnalysisCommand, input: unknown): Promise<AnalysisResult> {
  if (!validateArguments(schemas[command], input).ok) return failure("invalid-arguments", "Arguments do not match the selected analysis command.");
  const effect = context.effect;
  if (effect === undefined || !effect.runId || !effect.turnId) return failure("not-admitted", "Analysis requires an admitted execution turn.");
  const port = effect.analysis;
  if (port === undefined || !port.enabledCommands.includes(command) || !port.env.OPENROUTER_API_KEY?.trim()) return failure("setup-required", "No locally consented analysis provider is configured for this command.");
  if (port.policyDigest !== effect.policy.fingerprint || !Number.isSafeInteger(port.maxCalls) || port.maxCalls <= 0 || port.maxCalls > effect.policy.maxToolCalls) return failure("policy-denied", "Analysis does not match the admitted local policy and budget.");
  if (!implemented.has(command)) return failure("setup-required", "This analysis service is not yet connected to the admitted execution boundary.");
  let networkCalls = 0; let exhausted = false;
  const fetchFn: typeof fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    effect.signal.throwIfAborted(); await effect.beforeAction({ kind: "model", signal: effect.signal });
    if (++networkCalls > port.maxCalls) { exhausted = true; return new Response('{"error":"native-analysis-budget-exhausted"}', { status: 403 }); }
    return port.fetchFn(url, { ...init, signal: AbortSignal.any([effect.signal, ...(init?.signal === undefined || init.signal === null ? [] : [init.signal])]) });
  }, { preconnect() {} });
  try {
    effect.signal.throwIfAborted();
    if (!(await enabled[command]?.(context.cwd))) return failure("policy-denied", "This analysis command is not enabled in the current project.");
    await effect.beforeAction({ kind: "tool", toolName: "read_file", signal: effect.signal });
    effect.progress(`Running ${command} using the locally approved analysis model ${port.model}.`);
    const data = await runService(context, command, input as AnalysisArguments, port, fetchFn);
    effect.signal.throwIfAborted();
    if (exhausted) return failure("budget-exceeded", "The analysis request budget was exhausted; the result is incomplete.");
    let encoded = JSON.stringify(data).replaceAll(context.cwd, ".");
    if (context.configDir !== undefined) encoded = encoded.replaceAll(context.configDir, "[local-config]");
    const safe = JSON.parse(redactSensitiveText(encoded));
    if (Buffer.byteLength(JSON.stringify(safe), "utf8") > 30000) return failure("quota-exceeded", "The analysis result exceeds the remote result limit.");
    if (typeof data === "object" && data !== null && "tokens" in data && typeof data.tokens === "object" && data.tokens !== null) {
      const tokens = data.tokens;
      if ("inputTokens" in tokens && typeof tokens.inputTokens === "number" && "outputTokens" in tokens && typeof tokens.outputTokens === "number") {
        effect.usage({ inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens });
      }
    }
    return { ok: true, source: "native-analysis", data: safe, runId: effect.runId, turnId: effect.turnId, analysisModel: port.model };
  } catch (error) {
    return effect.signal.aborted ? failure("cancelled", "The admitted analysis was cancelled.")
      : exhausted ? failure("budget-exceeded", "The analysis request budget was exhausted; the result is incomplete.")
      : error instanceof AnalysisSetupError ? failure("setup-required", "A required locally approved analysis capability is unavailable.")
      : error instanceof AnalysisQuotaError ? failure("quota-exceeded", "The analysis input exceeds its bounded local scope.")
      : failure("analysis-failed", "The admitted analysis service failed. No passing result is asserted.");
  }
}

async function runService(context: AnalysisCommandContext, command: AnalysisCommand, args: AnalysisArguments, port: NativeAnalysisPort, fetchFn: typeof fetch): Promise<unknown> {
  const effect = context.effect!;
  const options = { cwd: context.cwd, ...(context.configDir !== undefined ? { dir: context.configDir } : {}), env: port.env,
    signal: effect.signal, fetchFn, model: port.model, maxCalls: port.maxCalls, targetLabel: "admitted working diff",
    mutate: <T>(paths: readonly string[], write: () => Promise<T>) => effect.mutate("analysis-cache", paths, write) };
  if (command === "ci") {
    if (port.ciSpawn === undefined || !/^\d+$/.test(String(args.runId))) throw new AnalysisSetupError();
    const read = await loadCiTriageList(context.cwd, port.ciSpawn, options);
    const selected = read.items.find((item) => item.runId === args.runId && item.jobName === args.jobName);
    if (selected === undefined) throw new AnalysisSetupError();
    const result = await runCiTriageForItem(context.cwd, selected, port.ciSpawn, fetchFn, effect.signal, options);
    if (!result.ok) throw new AnalysisSetupError(); return result;
  }
  if (command === "conform") {
    if (port.readReference === undefined || !safeRelative(String(args.referencePath)) || !String(args.referencePath).endsWith(".md")) throw new AnalysisSetupError();
    const kind = args.targetKind as ConformTargetOption["kind"];
    if (kind === "pr" && (port.github === undefined || !/^\d+$/.test(String(args.targetId)))) throw new AnalysisSetupError();
    if (kind === "report" && (port.readReport === undefined || !safeRelative(String(args.targetId)) || !String(args.targetId).startsWith(".metaproject/flows/"))) throw new AnalysisSetupError();
    const target: ConformTargetOption = { id: kind === "diff" ? "diff:working" : `${kind}:${args.targetId}`, kind, label: `admitted ${kind}` };
    const result = await runConformForTarget(context.cwd, String(args.referencePath), target, effect.signal, { ...options,
      readDiff: () => port.readDiff(effect.signal), readReference: (relativePath) => port.readReference!(relativePath, effect.signal),
      ...(port.github === undefined ? {} : { prPort: port.github.prPort }),
      ...(port.readReport === undefined ? {} : { readReport: (dir: string) => port.readReport!(dir, effect.signal) }) });
    if (!result.ok) throw new AnalysisSetupError(); return result;
  }
  if (command === "triage") {
    if (port.readLatestFindings === undefined) throw new AnalysisSetupError();
    return computeJevTriageResult({ ...options, findingsRaw: await port.readLatestFindings(effect.signal), maxItems: port.maxCalls });
  }
  if (command === "opencomments") {
    if (port.github === undefined) throw new AnalysisSetupError();
    return computeJevCommentsResult({ ...options, repo: port.github.repo, number: port.github.number, prPort: port.github.prPort, factsPort: port.github.factsPort });
  }
  const diffText = await port.readDiff(effect.signal);
  if (Buffer.byteLength(diffText, "utf8") > 512 * 1024) throw new AnalysisQuotaError();
  effect.signal.throwIfAborted(); const scope = buildReviewScope(diffText);
  const services: Partial<Record<AnalysisCommand, () => Promise<unknown>>> = {
    risk: () => computeJevRiskResult({ ...options, maxCalls: port.maxCalls * RISK_DIMENSIONS.length, regions: scope.regions, allChangedFiles: scope.files }),
    scenarios: () => computeJevScenariosResult({ ...options, regions: scope.regions, allChangedFiles: scope.files }),
    jevrules: () => computeJevRulesResult({ ...options, regions: scope.regions }),
    staledocs: () => computeJevDocsResult({ ...options, regions: scope.regions }),
    contract: () => computeJevContractResult({ ...options, diffText, description: args.description === undefined ? "" : String(args.description) }),
  };
  const service = services[command]; if (service === undefined) throw new AnalysisSetupError(); return service();
}
class AnalysisSetupError extends Error { readonly code = "setup-required"; }
class AnalysisQuotaError extends Error { readonly code = "quota-exceeded"; }

function safeRelative(value: string): boolean { return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "." || part.length === 0); }

/** Ordinary setup/CI inspection stays Flow-free and never invokes a provider: it needs only the owned read port, never
 * the optional Jev execution service. The shared sources keep their own project gate; the process environment is not
 * consulted, so only an explicit project opt-in or the session's saved local credential presence can enable the list. */
export async function executeAnalysisInspection(context: Pick<AnalysisCommandContext, "cwd" | "configDir"> & { signal?: AbortSignal }, port: NativeAnalysisReadPort | undefined, command: "ci" | "conform"): Promise<AnalysisInspectionResult> {
  if (port === undefined) return failure("implementation-gap", "The native owned read port is not attached to this session.");
  const signal = context.signal ?? new AbortController().signal;
  const cancelled = () => failure("cancelled", "The inspection was cancelled; no result is asserted.");
  if (signal.aborted) return cancelled();
  try {
    const data = command === "ci" ? await loadCiTriageList(context.cwd, port.ciSpawn, { env: {}, signal, ...(context.configDir === undefined ? {} : { dir: context.configDir }) })
      : await loadConformSetup(context.cwd, { spawn: port.ciSpawn, signal });
    if (signal.aborted) return cancelled();
    let encoded = JSON.stringify(data).replaceAll(context.cwd, ".");
    if (context.configDir !== undefined) encoded = encoded.replaceAll(context.configDir, "[local-config]");
    return Buffer.byteLength(encoded) > 30000 ? failure("quota-exceeded", "The inspection result exceeds its remote limit.") : { ok: true, source: "native-analysis", data: JSON.parse(redactSensitiveText(encoded)) };
  } catch { return signal.aborted ? cancelled() : failure("analysis-failed", "The local analysis setup could not be inspected; no result is asserted."); }
}

/** `readInspection` declares that the native owner attached its owned read port; absent, inspection is an implementation gap. */
export function analysisCommands(options: { availableCommands?: readonly AnalysisCommand[]; readInspection?: boolean } = {}): NativeCommandContribution[] {
  const actual = commandsForMode("agent");
  const entries: NativeCommandContribution[] = commands.map((commandName) => ({
    entry: { commandName, summary: actual.find((command) => command.name === `/${commandName}`)?.description ?? commandName,
      handlerId: `native.analysis.${commandName}`, inputSchema: schemas[commandName], resultSchema: { type: "string", maxLength: 32768 },
      mutationClass: "workspace", states: ["idle"], busyPolicy: "reject", confirmation: "human",
      availability: options.availableCommands?.includes(commandName) ? implemented.has(commandName) ? "available" : "implementation-gap" : "setup-required",
      reason: !options.availableCommands?.includes(commandName) ? "missing-local-analysis-setup" : implemented.has(commandName) ? "shared-existing-analysis-service" : "admitted-analysis-service-extraction-pending" },
    execute: (context, request) => executeAnalysisCommand(context, commandName, request.arguments),
  }));
  for (const command of ["ci", "conform"] as const) {
    const execution = entries.find((item) => item.entry.commandName === command)!;
    execution.entry.commandName = command === "ci" ? "ci.triage" : "conform.run";
    entries.push({ entry: { ...execution.entry, commandName: command, handlerId: `native.analysis.${command}.inspect`, inputSchema: empty, mutationClass: "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only", confirmation: "none",
      availability: options.readInspection === true ? "available" : "implementation-gap", reason: options.readInspection === true ? "shared-native-owned-read-source" : "native-owned-read-port-not-attached" },
      execute: (context, request) => validateArguments(empty, request.arguments).ok ? executeAnalysisInspection({ cwd: context.cwd, ...(context.configDir === undefined ? {} : { configDir: context.configDir }), ...(context.inspection === undefined ? {} : { signal: context.inspection.signal }) }, context.inspection?.analysisRead, command)
        : Promise.resolve(failure("invalid-arguments", "Inspection takes no arguments.")) });
  }
  return entries;
}
