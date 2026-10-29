import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest, catalogueDigest, validateControl, type Control } from "../../remote-control/protocol";
import { commandsForMode } from "../../commands/agent-commands";
import { createCommandCatalogue } from "./catalogue";

export interface NativeCoverageSource { path: string; sha256: string; anchor: string }
export interface NativeCoverageCommand { commandName: string; audited: boolean; expectedVariants: string[]; sources: NativeCoverageSource[] }
export interface NativeCoverageVariant {
  id: string; commandName: string; handlerName: string | null;
  classification: "required" | "local-security" | "presentation" | "external-vendor" | "scope-boundary";
  status: "implemented" | "unimplemented" | "unaudited" | "boundary";
  reason: string;
  inputSchema: Control["ArgumentSchema"] | null; resultSchema: Control["ArgumentSchema"] | null;
  busyPolicy: Control["CommandCatalogueEntry"]["busyPolicy"] | null;
  confirmation: Control["CommandCatalogueEntry"]["confirmation"] | null;
  proofIds: string[];
  scopeReference?: NativeCoverageSource;
}
export interface NativeCoverageInventory { schema: 1; registryDigest: string; commands: NativeCoverageCommand[]; variants: NativeCoverageVariant[] }
/** One executed outcome, normalized so the local and headless paths are comparable: no operation, confirmation or per-host identity. */
export interface NativeNormalizedOutcome { status: string; errorCode: string | null; confirmation: boolean; resultDigest: string | null }
/** A behavioral receipt: the SAME variant executed through the local terminal adapter and the headless native host
 * of an exact source/catalogue subject. Produced by `scripts/verify-native-coverage.ts`; a test filename, count or hash is not one. */
export interface NativeParityReceipt {
  schema: 1; id: string; variantId: string; commandName: string; handlerName: string | null;
  catalogueDigest: string; sources: NativeCoverageSource[];
  local: { line: string; outcome: NativeNormalizedOutcome };
  /** `arguments: null` means no typed native request expresses this parsed action; nothing was sent headlessly.
   * `operation` names the frozen protocol operation sent instead of a CommandInvoke (queue edit/remove are QueueEdit/QueueRemove, not catalogue commands). */
  headless: { arguments: { [key: string]: Control["BoundedJson"] } | null; outcome: NativeNormalizedOutcome | null; operation?: "remove-queue" | "edit-queue" };
  receiptDigest: string;
}
export interface NativeCoverageBlocker { code: string; subject: string; detail: string }
export interface NativeCoverageResult { ready: boolean; registeredCommands: number; auditedVariants: number; blockers: NativeCoverageBlocker[] }
const ADMITTED = new Set(["applied", "confirmation-required", "queued", "admitted"]);
export function parityReceiptId(variantId: string): string { return `native-parity:${variantId}`; }
export function nativeParityReceiptDigest(receipt: Omit<NativeParityReceipt, "receiptDigest">): string {
  const { schema, id, variantId, commandName, handlerName, catalogueDigest: digest, sources, local, headless } = receipt;
  return canonicalDigest({ schema, id, variantId, commandName, handlerName, catalogueDigest: digest, sources, local, headless });
}
/** Parity holds only when both paths actually ran and produced the same normalized outcome; `admitted` additionally requires the handler to accept it. */
export function receiptParity(receipt: NativeParityReceipt): { matched: boolean; admitted: boolean } {
  const headless = receipt.headless.outcome;
  const matched = headless !== null && canonicalDigest(receipt.local.outcome) === canonicalDigest(headless);
  return { matched, admitted: matched && ADMITTED.has(headless.status) && headless.errorCode === null };
}
/** Production entry derives the registry from the shipped command definitions; callers cannot omit a registered command. */
export function checkRegisteredNativeCommandCoverage(options: Omit<Parameters<typeof checkNativeCommandCoverage>[0], "registryNames">): Promise<NativeCoverageResult> {
  return checkNativeCommandCoverage({ ...options, registryNames: registeredNativeCommandNames() });
}
export function registeredNativeCommandNames(): string[] { return [...new Set(commandsForMode("agent").map(command => command.name.slice(1)))].sort(); }
const presentation = new Set(["think", "expand", "copy", "theme", "rendering", "game"]);
const standing = new Set(["schedule", "schedules", "intake", "remote-policy"]);
const vendors = new Set(["delegate", "external-agents", "external-diff"]);
/**
 * Owner decision 2026-10-29 (ownerDecisionStage1bTo3): these variants execute Jev analysis, which needs explicit local Jev setup and
 * consent (specification.md 3.1 security-local setup). Owner decision 2026-10-29 (ownerDecisionStage4) adds the conform wizard steps:
 * picking a reference or a target starts that Jev run, and a clause detail renders its in-memory result. Exactly these, and only with
 * the frozen spec reference checked below.
 */
export const JEV_SETUP_BOUNDARIES: ReadonlySet<string> = new Set(["risk.working-diff", "scenarios.working-diff", "jevrules.working-diff", "staledocs.working-diff",
  "contract.working-diff", "opencomments.repo-pr", "triage.latest-review", "ci.triage", "ci.retry", "conform.run",
  "conform.reference-select", "conform.target-diff", "conform.target-pr", "conform.target-report", "conform.clause-detail"]);
/**
 * Owner decision 2026-10-29 (ownerDecisionStage4), each variant in exactly its decided class and only with the frozen spec reference:
 * running a trigger spawns an unbounded `keryx trigger run` child whose tracked writes would fence the owned checkout (scope); the
 * measured turn-guard details exist only in the TUI process memory (presentation); a CI run detail needs GitHub data (external vendor).
 */
export const STAGE4_DECIDED_BOUNDARIES: ReadonlyMap<string, NativeCoverageVariant["classification"]> = new Map([
  ["triggers.run", "scope-boundary"], ["triggers.confirm-run", "scope-boundary"], ["guard.measured-details", "presentation"], ["ci.detail", "external-vendor"]]);
/** Owner decision 2026-10-29: queue actions no frozen queue operation expresses (spec 3.1 names queue edit/remove; protocol QueueEdit/QueueRemove). */
export const QUEUE_SCOPE_BOUNDARIES: ReadonlySet<string> = new Set(["queue.force", "queue.force-N", "queue.edit"]);
function needsFrozenSpecReference(row: NativeCoverageVariant): boolean {
  return row.classification === "scope-boundary" || row.commandName === "remote-control" || JEV_SETUP_BOUNDARIES.has(row.id) || STAGE4_DECIDED_BOUNDARIES.has(row.id);
}
function boundaryAllowed(row: NativeCoverageVariant): boolean {
  if (row.status !== "boundary" || row.reason.length < 30 || /TUI.only|panel.unavailable|callback.missing|not.yet/i.test(row.reason)) return false;
  const decided = STAGE4_DECIDED_BOUNDARIES.get(row.id);
  if (decided !== undefined) return row.classification === decided;
  if (row.classification === "presentation") return presentation.has(row.commandName) || /\.(?:navigate|scroll|close|resize|focus)$/.test(row.id);
  // Telegram remote control (owner decision 2026-10-28): every variant is the unimplemented delegated-principal vendor adapter, and only with the frozen spec reference checked below.
  if (row.classification === "external-vendor") return (vendors.has(row.commandName) && !/\.(status|list|read)$/.test(row.id)) || row.commandName === "remote-control";
  if (row.classification === "scope-boundary") return QUEUE_SCOPE_BOUNDARIES.has(row.id) || /^(review|reviews|governance)\.(proposal\.(accept|accept-acknowledged|decline)|refresh-layers|prepare-missing-chunks|check|complete|rerun)$/.test(row.id);
  if (row.classification !== "local-security") return false;
  if (JEV_SETUP_BOUNDARIES.has(row.id)) return true;
  if (/(?:^|\.)(status|list|read|inspect|default)$/.test(row.id) && row.commandName !== "integrate") return false;
  if (standing.has(row.commandName)) return true;
  if (row.commandName === "connect") return /\.(add-key|device-login|disconnect|configure)$/.test(row.id);
  if (row.commandName === "search-provider") return /\.(configure|credential|test-configuration)$/.test(row.id);
  if (row.commandName === "mcp") return /\.connect$/.test(row.id);
  if (row.commandName === "setup") return /\.execute-(init|refresh|repair)$/.test(row.id);
  if (row.commandName === "integrate") return true;
  if (row.commandName === "permissions") return /\.remove$/.test(row.id);
  if (row.commandName === "mode") return /\.(trust|auto|save|clear)$/.test(row.id);
  if (row.commandName === "routing") return /\.trust-project-file$/.test(row.id);
  return ["guard", "editguard", "external", "jevprofile"].includes(row.commandName) && /\.(on|off|toggle|apply-recommended)$/.test(row.id);
}
/** Release quality gate. It fails closed on source/parser drift, omitted nested actions, unsupported handlers and stale, tampered or failing parity receipts. */
export async function checkNativeCommandCoverage(options: {
  cwd: string; registryNames: readonly string[]; catalogue: Control["CommandCatalogue"];
  inventory: NativeCoverageInventory; receipts: readonly NativeParityReceipt[];
}): Promise<NativeCoverageResult> {
  const blockers: NativeCoverageBlocker[] = [];
  const add = (code: string, subject: string, detail: string) => { blockers.push({ code, subject, detail }); };
  const { inventory, catalogue } = options;
  const registry = [...new Set(options.registryNames)].sort();
  if (inventory.schema !== 1) add("invalid-inventory", "schema", "Unsupported inventory schema.");
  if (inventory.registryDigest !== canonicalDigest(registry)) add("registry-drift", "registry", "Actual registered commands differ from the audited registry subject.");
  if (!validateControl("CommandCatalogue", catalogue).ok || catalogue.catalogueDigest !== catalogueDigest(catalogue.entries)) add("invalid-catalogue", "catalogue", "The current catalogue is invalid or has a mismatched digest.");
  const commandMap = new Map<string, NativeCoverageCommand>();
  for (const command of inventory.commands) {
    if (commandMap.has(command.commandName)) add("duplicate-command-audit", command.commandName, "Command audit occurs more than once.");
    commandMap.set(command.commandName, command);
    if (!registry.includes(command.commandName)) add("unknown-command-audit", command.commandName, "Inventory contains an unregistered command.");
  }
  const variants = new Map<string, NativeCoverageVariant>();
  for (const row of inventory.variants) {
    if (variants.has(row.id)) add("duplicate-variant", row.id, "Variant identifiers must be unique.");
    variants.set(row.id, row);
    if (!commandMap.get(row.commandName)?.expectedVariants.includes(row.id)) add("unscoped-variant", row.id, "Variant is absent from its parser audit.");
  }
  for (const entry of catalogue.entries) {
    if (!registry.includes(entry.commandName) && !inventory.variants.some(row => row.handlerName === entry.commandName)) {
      add("uncovered-catalogue-command", entry.commandName, "An advertised native API/subcommand has no explicit coverage row.");
    }
  }
  const sourceCache = new Map<string, Promise<string | undefined>>();
  const source = (reference: NativeCoverageSource) => {
    const key = `${reference.path}:${reference.sha256}:${reference.anchor}`;
    let pending = sourceCache.get(key);
    if (pending === undefined) { pending = readVerifiedSource(options.cwd, reference); sourceCache.set(key, pending); }
    return pending;
  };
  for (const name of registry) {
    const command = commandMap.get(name);
    if (command === undefined) { add("missing-command-audit", name, "The actual command has no parser/action audit."); continue; }
    if (!command.audited) add("unaudited-command", name, "The parser or panel action audit is incomplete.");
    if (command.expectedVariants.length === 0) add("missing-variant", name, "Every command needs an audited default or named variant.");
    if (command.sources.length === 0) add("missing-source", name, "Parser/action audit has no source subject.");
    for (const reference of command.sources) if (await source(reference) === undefined) add("source-drift", `${name}:${reference.path}`, "The source hash or declared anchor no longer matches the audit.");
    for (const id of new Set(command.expectedVariants)) {
      const row = variants.get(id);
      if (row === undefined) { add("missing-variant", id, "A parsed subcommand or panel action has no coverage row."); continue; }
      if (row.commandName !== name) { add("variant-command-mismatch", id, "The variant belongs to another command."); continue; }
      if (row.classification !== "required") {
        if (!boundaryAllowed(row)) add("invalid-boundary", id, "This source-specific security or presentation boundary cannot waive a native domain operation.");
        const exposed = catalogue.entries.find(entry => entry.commandName === row.handlerName);
        if (exposed?.availability === "available" && exposed.mutationClass !== "read") add("boundary-handler-advertised", id, "A boundary cannot hide a mutating handler that is advertised as remotely available.");
        if (needsFrozenSpecReference(row) && (row.scopeReference?.path !== "docs/requirements/hub-remote-sessions/specification.md"
          || row.scopeReference.sha256 !== "7827a1827565992e61b85d43e5e73763303b3aa9590973e6484b8c0edb1834e2"
          || await source(row.scopeReference) === undefined)) add("invalid-scope-reference", id, "A scope boundary needs the exact frozen normative source subject.");
        continue;
      }
      if (row.status !== "implemented") { add("required-implementation-gap", id, row.reason); continue; }
      const handler = catalogue.entries.find(entry => entry.commandName === row.handlerName);
      if (handler === undefined || handler.availability !== "available") add("handler-unavailable", id, "The exact required native handler is unavailable.");
      if (handler !== undefined && (canonicalDigest(handler.inputSchema) !== canonicalDigest(row.inputSchema) || canonicalDigest(handler.resultSchema) !== canonicalDigest(row.resultSchema)
        || handler.busyPolicy !== row.busyPolicy || handler.confirmation !== row.confirmation)) add("schema-drift", id, "Typed input/result or busy/confirmation contract differs from the audited subject.");
      const receipt = options.receipts.find(entry => entry.variantId === id && row.proofIds.includes(entry.id));
      if (receipt === undefined) { add("missing-current-evidence", id, "No behavioral receipt from both execution paths covers this variant."); continue; }
      const { receiptDigest, ...body } = receipt;
      if (receipt.schema !== 1 || receiptDigest !== nativeParityReceiptDigest(body) || receipt.handlerName !== row.handlerName || receipt.commandName !== name) { add("tampered-receipt", id, "The receipt does not hash to its own recorded body or names another handler."); continue; }
      const sameSubject = receipt.sources.length === command.sources.length && command.sources.every(expected => receipt.sources.some(actual => actual.path === expected.path && actual.sha256 === expected.sha256));
      if (receipt.catalogueDigest !== catalogue.catalogueDigest || !sameSubject || !(await Promise.all(receipt.sources.map(source))).every(value => value !== undefined)) {
        add("stale-receipt", id, "The receipt was produced for another source or catalogue subject."); continue;
      }
      const parity = receiptParity(receipt);
      if (!parity.matched) add("parity-failure", id, "The local terminal and headless host outcomes differ for the same variant.");
      else if (!parity.admitted) add("required-behaviour-refused", id, "Both execution paths refuse this required variant.");
    }
  }
  return { ready: blockers.length === 0, registeredCommands: registry.length, auditedVariants: variants.size, blockers };
}
async function readVerifiedSource(cwd: string, reference: NativeCoverageSource): Promise<string | undefined> {
  if ((!/^src\/.+\.(?:ts|tsx)$/.test(reference.path) && reference.path !== "docs/requirements/hub-remote-sessions/specification.md") || reference.path.includes("\\") || reference.path.split("/").some(part => part === ".." || part === "." || part === "") || !/^[a-f0-9]{64}$/.test(reference.sha256)) return undefined;
  try {
    const root = await realpath(cwd); let candidate = root;
    for (const part of reference.path.split("/")) { candidate = path.join(candidate, part); if ((await lstat(candidate)).isSymbolicLink()) return undefined; }
    const info = await lstat(candidate); if (!info.isFile() || info.size > 2 * 1024 * 1024) return undefined;
    const text = await readFile(candidate, "utf8");
    if (createHash("sha256").update(text).digest("hex") !== reference.sha256) return undefined;
    const line = /^line:(\d+)$/.exec(reference.anchor);
    return line !== null ? Number(line[1]) > 0 && Number(line[1]) <= text.split("\n").length ? text : undefined : reference.anchor.length > 0 && text.includes(reference.anchor) ? text : undefined;
  } catch { return undefined; }
}

/** The typed command contract a runtime can recompute from shipped code alone: availability depends on local setup and is excluded. */
export function nativeCoverageContractDigest(catalogue: Control["CommandCatalogue"]): string {
  return canonicalDigest([...catalogue.entries].sort((left, right) => left.commandName.localeCompare(right.commandName, "en")).map(entry => ({
    commandName: entry.commandName, handlerId: entry.handlerId, inputSchema: entry.inputSchema, resultSchema: entry.resultSchema,
    mutationClass: entry.mutationClass, states: entry.states, busyPolicy: entry.busyPolicy, confirmation: entry.confirmation })));
}
/** The subject a shipped runtime checks its embedded descriptor against: shipped registry and static catalogue contract, no source or output files. */
export function currentNativeCoverageSubject(): { registryNames: string[]; catalogue: Control["CommandCatalogue"] } {
  return { registryNames: registeredNativeCommandNames(), catalogue: createCommandCatalogue("0".repeat(64)) };
}
export interface NativeCoverageGap { variantId: string; code: string; detail: string }
export interface NativeCoverageDescriptor {
  schema: 1; generator: "scripts/verify-native-coverage.ts";
  registryDigest: string; contractDigest: string; subjectCatalogueDigest: string; inventoryDigest: string;
  releaseReady: boolean;
  counts: { registeredCommands: number; variants: number; required: number; earned: number; requiredGaps: number; boundaries: number; otherBlockers: number };
  earned: string[]; requiredGaps: NativeCoverageGap[]; boundaries: string[]; otherBlockers: { code: string; subject: string }[];
  descriptorDigest: string;
}
export type NativeCoverageDescriptorCheck =
  | { ok: true; releaseReady: boolean; descriptor: NativeCoverageDescriptor }
  | { ok: false; code: "descriptor-missing" | "descriptor-invalid" | "descriptor-tampered" | "descriptor-inconsistent" | "registry-drift" | "catalogue-drift" };
function descriptorBody(descriptor: Omit<NativeCoverageDescriptor, "descriptorDigest">): Omit<NativeCoverageDescriptor, "descriptorDigest"> {
  const { schema, generator, registryDigest, contractDigest, subjectCatalogueDigest, inventoryDigest, releaseReady, counts, earned, requiredGaps, boundaries, otherBlockers } = descriptor;
  return { schema, generator, registryDigest, contractDigest, subjectCatalogueDigest, inventoryDigest, releaseReady, counts, earned, requiredGaps, boundaries, otherBlockers };
}
/** Build-time only: derives the release descriptor from a guard result over an executed subject. */
export function buildNativeCoverageDescriptor(input: { registryNames: readonly string[]; catalogue: Control["CommandCatalogue"]; contractCatalogue: Control["CommandCatalogue"];
  inventory: NativeCoverageInventory; result: NativeCoverageResult }): NativeCoverageDescriptor {
  const { inventory, result } = input;
  const required = inventory.variants.filter(row => row.classification === "required").map(row => row.id).sort();
  const gapMap = new Map<string, NativeCoverageGap>();
  const otherBlockers: { code: string; subject: string }[] = [];
  for (const blocker of result.blockers) {
    if (required.includes(blocker.subject)) { if (!gapMap.has(blocker.subject)) gapMap.set(blocker.subject, { variantId: blocker.subject, code: blocker.code, detail: blocker.detail.slice(0, 400) }); }
    else otherBlockers.push({ code: blocker.code, subject: blocker.subject });
  }
  const requiredGaps = [...gapMap.values()].sort((left, right) => left.variantId.localeCompare(right.variantId, "en"));
  const earned = required.filter(id => !gapMap.has(id));
  const boundaries = inventory.variants.filter(row => row.classification !== "required").map(row => row.id).sort();
  otherBlockers.sort((left, right) => `${left.code}:${left.subject}`.localeCompare(`${right.code}:${right.subject}`, "en"));
  const body: Omit<NativeCoverageDescriptor, "descriptorDigest"> = { schema: 1, generator: "scripts/verify-native-coverage.ts",
    registryDigest: canonicalDigest([...new Set(input.registryNames)].sort()), contractDigest: nativeCoverageContractDigest(input.contractCatalogue),
    subjectCatalogueDigest: input.catalogue.catalogueDigest, inventoryDigest: canonicalDigest(inventory), releaseReady: result.ready && requiredGaps.length === 0 && otherBlockers.length === 0,
    counts: { registeredCommands: result.registeredCommands, variants: inventory.variants.length, required: required.length, earned: earned.length, requiredGaps: requiredGaps.length, boundaries: boundaries.length, otherBlockers: otherBlockers.length },
    earned, requiredGaps, boundaries, otherBlockers };
  return { ...body, descriptorDigest: canonicalDigest(body) };
}
const descriptorKeys = ["schema", "generator", "registryDigest", "contractDigest", "subjectCatalogueDigest", "inventoryDigest", "releaseReady", "counts", "earned", "requiredGaps", "boundaries", "otherBlockers", "descriptorDigest"];
const countKeys = ["registeredCommands", "variants", "required", "earned", "requiredGaps", "boundaries", "otherBlockers"];
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string"); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key); }
/** Runtime readiness: validates the embedded build-time descriptor against the shipped registry and catalogue contract. Missing, malformed, tampered or stale fails closed. */
export function validateNativeCoverageDescriptor(value: unknown, current: { registryNames: readonly string[]; catalogue: Control["CommandCatalogue"] }): NativeCoverageDescriptorCheck {
  if (value === undefined || value === null) return { ok: false, code: "descriptor-missing" };
  if (!record(value) || !exactKeys(value, descriptorKeys) || value.schema !== 1 || value.generator !== "scripts/verify-native-coverage.ts" || typeof value.releaseReady !== "boolean"
    || !["registryDigest", "contractDigest", "subjectCatalogueDigest", "inventoryDigest", "descriptorDigest"].every(key => typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(value[key] as string))
    || !record(value.counts) || !exactKeys(value.counts, countKeys) || !countKeys.every(key => Number.isSafeInteger((value.counts as Record<string, unknown>)[key]))
    || !strings(value.earned) || !strings(value.boundaries)
    || !Array.isArray(value.requiredGaps) || !value.requiredGaps.every(gap => record(gap) && exactKeys(gap, ["variantId", "code", "detail"]) && typeof gap.variantId === "string" && typeof gap.code === "string" && typeof gap.detail === "string")
    || !Array.isArray(value.otherBlockers) || !value.otherBlockers.every(row => record(row) && exactKeys(row, ["code", "subject"]) && typeof row.code === "string" && typeof row.subject === "string")) return { ok: false, code: "descriptor-invalid" };
  const descriptor = value as unknown as NativeCoverageDescriptor;
  if (canonicalDigest(descriptorBody(descriptor)) !== descriptor.descriptorDigest) return { ok: false, code: "descriptor-tampered" };
  const counts = descriptor.counts; const gapIds = new Set(descriptor.requiredGaps.map(gap => gap.variantId));
  if (counts.earned !== descriptor.earned.length || counts.requiredGaps !== descriptor.requiredGaps.length || gapIds.size !== descriptor.requiredGaps.length
    || counts.boundaries !== descriptor.boundaries.length || counts.otherBlockers !== descriptor.otherBlockers.length || counts.required !== counts.earned + counts.requiredGaps
    || counts.variants !== counts.required + counts.boundaries || descriptor.earned.some(id => gapIds.has(id))
    || descriptor.releaseReady !== (descriptor.requiredGaps.length === 0 && descriptor.otherBlockers.length === 0)) return { ok: false, code: "descriptor-inconsistent" };
  if (descriptor.registryDigest !== canonicalDigest([...new Set(current.registryNames)].sort()) || counts.registeredCommands !== new Set(current.registryNames).size) return { ok: false, code: "registry-drift" };
  if (descriptor.contractDigest !== nativeCoverageContractDigest(current.catalogue)) return { ok: false, code: "catalogue-drift" };
  return { ok: true, releaseReady: descriptor.releaseReady, descriptor: structuredClone(descriptor) };
}
