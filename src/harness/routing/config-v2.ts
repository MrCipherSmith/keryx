import { createHash } from "node:crypto";
import { MODEL_CLASSES, isModelClass, modelRefKey, type ModelClass, type ModelRef } from "./model-class";
import { ROUTING_CATEGORIES, isRoutingCategory, type RoutingCategory } from "./table";

export type RoutingSelectionPolicy = "priority" | "cost" | "latency";
export type ProviderScopeV2 = "all-connected" | "session-only" | "allowlist";

export type RoutingAssignmentV2 =
  | { readonly mode: "auto" }
  | { readonly mode: "baseline"; readonly fallbackClass?: ModelClass }
  | { readonly mode: "class"; readonly modelClass: ModelClass }
  | { readonly mode: "model"; readonly target: ModelRef; readonly fallbackClass?: ModelClass };

export type RoutingFallbackAssignmentV2 = Exclude<RoutingAssignmentV2, { readonly mode: "auto" }>;

export interface RoutingCandidateV2 {
  readonly target: ModelRef;
  readonly enabled: boolean;
  readonly priority: number;
}

export interface ModelClassConfigV2 {
  readonly candidates: readonly RoutingCandidateV2[];
  readonly selection: RoutingSelectionPolicy;
  readonly fallbackClasses: readonly ModelClass[];
}

export interface ProviderRoutingConfigV2 {
  readonly scope: ProviderScopeV2;
  readonly allowlist: readonly string[];
  readonly preferSessionProvider: boolean;
}

export interface ClassifierEntryV2 {
  readonly adapterId: string;
  readonly target?: ModelRef;
}

export interface ClassifierConfigV2 {
  readonly chain: readonly ClassifierEntryV2[];
  readonly timeoutMs: number;
  readonly minConfidence: number;
  readonly onFailure: RoutingFallbackAssignmentV2;
}

export interface RoutingExecutionConfigV2 {
  readonly maxAttempts: number;
  readonly selectionTimeoutMs: number;
  readonly maxEstimatedCostUsd: number | null;
  readonly unknownCost: "allow" | "deny";
}

export interface RoutingV2ConfigLayer {
  readonly schemaVersion: 2;
  readonly classes?: Partial<Record<ModelClass, ModelClassConfigV2>>;
  readonly categories?: Partial<Record<RoutingCategory, RoutingAssignmentV2>>;
  readonly providers?: ProviderRoutingConfigV2;
  readonly classifier?: ClassifierConfigV2;
  readonly execution?: RoutingExecutionConfigV2;
}

export interface RoutingV2ConfigLayers {
  readonly user?: RoutingV2ConfigLayer;
  readonly project?: RoutingV2ConfigLayer;
}
export interface RoutingV2NormalizationOptions {
  /** Must be the same adapter registry execution will resolve against. */
  readonly classifierAdapters?: { has(adapterId: string): boolean };
}

export interface NormalizedRoutingV2Config {
  readonly schemaVersion: 2;
  readonly classes: Readonly<Record<ModelClass, ModelClassConfigV2>>;
  readonly categories: Readonly<Record<RoutingCategory, RoutingAssignmentV2>>;
  readonly categorySources: Readonly<Record<RoutingCategory, "project" | "user" | "builtin">>;
  readonly providers: ProviderRoutingConfigV2;
  readonly classifier: ClassifierConfigV2;
  readonly execution: RoutingExecutionConfigV2;
  readonly configDigest: string;
}

export interface RoutingV2ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const EMPTY_CLASS: ModelClassConfigV2 = { candidates: [], selection: "priority", fallbackClasses: [] };
const BASELINE_ASSIGNMENT: RoutingAssignmentV2 = { mode: "baseline" };
const DEFAULT_PROVIDERS: ProviderRoutingConfigV2 = { scope: "all-connected", allowlist: [], preferSessionProvider: false };
const DEFAULT_CLASSIFIER: ClassifierConfigV2 = {
  chain: [],
  timeoutMs: 3_000,
  minConfidence: 0.7,
  onFailure: BASELINE_ASSIGNMENT,
};
const DEFAULT_EXECUTION: RoutingExecutionConfigV2 = {
  maxAttempts: 3,
  selectionTimeoutMs: 3_000,
  maxEstimatedCostUsd: null,
  unknownCost: "allow",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) errors.push(`${path}.${key} is not allowed`);
}

function validateModelRef(value: unknown, path: string, errors: string[]): value is ModelRef {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  unknownKeys(value, ["providerId", "modelId"], path, errors);
  if (typeof value.providerId !== "string" || value.providerId.length === 0) errors.push(`${path}.providerId must be a non-empty string`);
  if (typeof value.modelId !== "string" || value.modelId.length === 0) errors.push(`${path}.modelId must be a non-empty string`);
  return typeof value.providerId === "string" && value.providerId.length > 0 && typeof value.modelId === "string" && value.modelId.length > 0;
}

function validateAssignment(value: unknown, path: string, errors: string[], allowAuto = true): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an assignment object`);
    return;
  }
  if (value.mode === "auto") {
    unknownKeys(value, ["mode"], path, errors);
    if (!allowAuto) errors.push(`${path}.mode auto is not allowed`);
    return;
  }
  if (value.mode === "baseline") {
    unknownKeys(value, ["mode", "fallbackClass"], path, errors);
    if (value.fallbackClass !== undefined && !isModelClass(value.fallbackClass)) errors.push(`${path}.fallbackClass is invalid`);
    return;
  }
  if (value.mode === "class") {
    unknownKeys(value, ["mode", "modelClass"], path, errors);
    if (!isModelClass(value.modelClass)) errors.push(`${path}.modelClass is invalid`);
    return;
  }
  if (value.mode === "model") {
    unknownKeys(value, ["mode", "target", "fallbackClass"], path, errors);
    validateModelRef(value.target, `${path}.target`, errors);
    if (value.fallbackClass !== undefined && !isModelClass(value.fallbackClass)) errors.push(`${path}.fallbackClass is invalid`);
    return;
  }
  errors.push(`${path}.mode is invalid`);
}

function secretPaths(value: unknown, at = "config"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => secretPaths(entry, `${at}[${index}]`));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = `${at}.${key}`;
    return /api.?key|token|password|secret|credential/i.test(key) ? [path] : secretPaths(entry, path);
  });
}

export function validateRoutingV2ConfigLayer(raw: unknown, options: RoutingV2NormalizationOptions = {}): RoutingV2ValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["routing v2 config must be an object"] };
  unknownKeys(raw, ["schemaVersion", "classes", "categories", "providers", "classifier", "execution"], "config", errors);
  if (raw.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  errors.push(...secretPaths(raw).map((path) => `${path} must not contain credentials`));

  if (raw.categories !== undefined) {
    if (!isRecord(raw.categories)) errors.push("categories must be an object");
    else for (const [category, assignment] of Object.entries(raw.categories)) {
      if (!isRoutingCategory(category)) errors.push(`categories.${category} is not allowed`);
      validateAssignment(assignment, `categories.${category}`, errors);
    }
  }

  if (raw.classes !== undefined) {
    if (!isRecord(raw.classes)) errors.push("classes must be an object");
    else for (const [modelClass, config] of Object.entries(raw.classes)) {
      if (!isModelClass(modelClass)) errors.push(`classes.${modelClass} is not allowed`);
      if (!isRecord(config)) {
        errors.push(`classes.${modelClass} must be an object`);
        continue;
      }
      unknownKeys(config, ["candidates", "selection", "fallbackClasses"], `classes.${modelClass}`, errors);
      if (!Array.isArray(config.candidates)) errors.push(`classes.${modelClass}.candidates must be an array`);
      else {
        const targets = new Set<string>();
        for (const [index, candidate] of config.candidates.entries()) {
          const path = `classes.${modelClass}.candidates[${index}]`;
          if (!isRecord(candidate)) {
            errors.push(`${path} must be an object`);
            continue;
          }
          unknownKeys(candidate, ["target", "enabled", "priority"], path, errors);
          if (validateModelRef(candidate.target, `${path}.target`, errors)) {
            const key = modelRefKey(candidate.target);
            if (targets.has(key)) errors.push(`${path}.target is duplicated`);
            targets.add(key);
          }
          if (typeof candidate.enabled !== "boolean") errors.push(`${path}.enabled must be a boolean`);
          if (!Number.isSafeInteger(candidate.priority)) errors.push(`${path}.priority must be an integer`);
        }
      }
      if (!(["priority", "cost", "latency"] as const).includes(config.selection as RoutingSelectionPolicy)) errors.push(`classes.${modelClass}.selection is invalid`);
      if (!Array.isArray(config.fallbackClasses)) errors.push(`classes.${modelClass}.fallbackClasses must be an array`);
      else {
        if (config.fallbackClasses.length > 3) errors.push(`classes.${modelClass}.fallbackClasses must contain at most 3 items`);
        const seen = new Set<ModelClass>();
        for (const [index, fallback] of config.fallbackClasses.entries()) {
          if (!isModelClass(fallback)) errors.push(`classes.${modelClass}.fallbackClasses[${index}] is invalid`);
          else {
            if (fallback === modelClass) errors.push(`classes.${modelClass} cannot fall back to itself`);
            if (seen.has(fallback)) errors.push(`classes.${modelClass}.fallbackClasses contains duplicate ${fallback}`);
            seen.add(fallback);
          }
        }
      }
    }
  }

  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) errors.push("providers must be an object");
    else {
      unknownKeys(raw.providers, ["scope", "allowlist", "preferSessionProvider"], "providers", errors);
      if (!(raw.providers.scope === "all-connected" || raw.providers.scope === "session-only" || raw.providers.scope === "allowlist")) errors.push("providers.scope is invalid");
      if (!Array.isArray(raw.providers.allowlist)) errors.push("providers.allowlist must be an array");
      else {
        if (!raw.providers.allowlist.every((entry) => typeof entry === "string" && entry.length > 0)) errors.push("providers.allowlist must contain non-empty strings");
        if (new Set(raw.providers.allowlist).size !== raw.providers.allowlist.length) errors.push("providers.allowlist must contain unique items");
        if (raw.providers.scope === "allowlist" && raw.providers.allowlist.length === 0) errors.push("providers.allowlist must not be empty when scope is allowlist");
      }
      if (typeof raw.providers.preferSessionProvider !== "boolean") errors.push("providers.preferSessionProvider must be a boolean");
    }
  }

  if (raw.classifier !== undefined) {
    if (!isRecord(raw.classifier)) errors.push("classifier must be an object");
    else {
      unknownKeys(raw.classifier, ["chain", "timeoutMs", "minConfidence", "onFailure"], "classifier", errors);
      if (!Array.isArray(raw.classifier.chain)) errors.push("classifier.chain must be an array");
      else {
        if (raw.classifier.chain.length > 3) errors.push("classifier.chain must contain at most 3 items");
        if (raw.classifier.chain.length > 0 && options.classifierAdapters === undefined) errors.push("classifier adapter registry is required for a non-empty classifier chain");
        const adapterIds = new Set<string>();
        for (const [index, entry] of raw.classifier.chain.entries()) {
          const path = `classifier.chain[${index}]`;
          if (!isRecord(entry)) {
            errors.push(`${path} must be an object`);
            continue;
          }
          unknownKeys(entry, ["adapterId", "target"], path, errors);
          if (typeof entry.adapterId !== "string" || entry.adapterId.length === 0) errors.push(`${path}.adapterId must be a non-empty string`);
          else {
            if (adapterIds.has(entry.adapterId)) errors.push(`${path}.adapterId is duplicated`);
            adapterIds.add(entry.adapterId);
            if (options.classifierAdapters?.has(entry.adapterId) !== true) errors.push(`${path}.adapterId is not registered`);
            if (entry.adapterId === "model" && entry.target === undefined) errors.push(`${path}.target is required for model adapter`);
          }
          if (entry.target !== undefined) validateModelRef(entry.target, `${path}.target`, errors);
        }
      }
      if (!Number.isSafeInteger(raw.classifier.timeoutMs) || (raw.classifier.timeoutMs as number) < 1 || (raw.classifier.timeoutMs as number) > 30_000) errors.push("classifier.timeoutMs must be an integer between 1 and 30000");
      if (typeof raw.classifier.minConfidence !== "number" || !Number.isFinite(raw.classifier.minConfidence) || raw.classifier.minConfidence < 0 || raw.classifier.minConfidence > 1) errors.push("classifier.minConfidence must be between 0 and 1");
      validateAssignment(raw.classifier.onFailure, "classifier.onFailure", errors, false);
    }
  }

  if (raw.execution !== undefined) {
    if (!isRecord(raw.execution)) errors.push("execution must be an object");
    else {
      unknownKeys(raw.execution, ["maxAttempts", "selectionTimeoutMs", "maxEstimatedCostUsd", "unknownCost"], "execution", errors);
      if (!Number.isSafeInteger(raw.execution.maxAttempts) || (raw.execution.maxAttempts as number) < 1 || (raw.execution.maxAttempts as number) > 10) errors.push("execution.maxAttempts must be an integer between 1 and 10");
      if (!Number.isSafeInteger(raw.execution.selectionTimeoutMs) || (raw.execution.selectionTimeoutMs as number) < 1 || (raw.execution.selectionTimeoutMs as number) > 30_000) errors.push("execution.selectionTimeoutMs must be an integer between 1 and 30000");
      if (raw.execution.maxEstimatedCostUsd !== null && (typeof raw.execution.maxEstimatedCostUsd !== "number" || !Number.isFinite(raw.execution.maxEstimatedCostUsd) || raw.execution.maxEstimatedCostUsd < 0)) errors.push("execution.maxEstimatedCostUsd must be null or a non-negative finite number");
      if (!(raw.execution.unknownCost === "allow" || raw.execution.unknownCost === "deny")) errors.push("execution.unknownCost is invalid");
    }
  }
  const rawClasses = raw.classes;
  if (errors.length === 0 && isRecord(rawClasses)) {
    const semanticClasses = Object.fromEntries(MODEL_CLASSES.map((modelClass) => [
      modelClass,
      rawClasses[modelClass] ?? EMPTY_CLASS,
    ])) as Record<ModelClass, ModelClassConfigV2>;
    try { assertAcyclicFallbacks(semanticClasses); } catch (error) {
      errors.push(error instanceof Error ? error.message : "routing class fallback cycle");
    }
  }
  return { ok: errors.length === 0, errors };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function routingV2Digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function assertClassConfig(modelClass: ModelClass, config: ModelClassConfigV2): void {
  const candidates = new Set<string>();
  for (const candidate of config.candidates) {
    if (!candidate.target.providerId || !candidate.target.modelId) throw new Error(`${modelClass} contains an invalid model target`);
    const key = modelRefKey(candidate.target);
    if (candidates.has(key)) throw new Error(`${modelClass} contains duplicate candidate ${candidate.target.providerId}/${candidate.target.modelId}`);
    candidates.add(key);
    if (!Number.isSafeInteger(candidate.priority)) throw new Error(`${modelClass} candidate priority must be an integer`);
  }
  const fallbacks = new Set<ModelClass>();
  for (const fallback of config.fallbackClasses) {
    if (fallback === modelClass) throw new Error(`${modelClass} cannot fall back to itself`);
    if (fallbacks.has(fallback)) throw new Error(`${modelClass} contains duplicate fallback ${fallback}`);
    fallbacks.add(fallback);
  }
}
function assertAcyclicFallbacks(classes: Readonly<Record<ModelClass, ModelClassConfigV2>>): void {
  const visiting = new Set<ModelClass>();
  const visited = new Set<ModelClass>();
  const visit = (modelClass: ModelClass, path: readonly ModelClass[]): void => {
    if (visiting.has(modelClass)) {
      const cycleStart = path.indexOf(modelClass);
      const cycle = [...path.slice(cycleStart), modelClass];
      throw new Error(`routing class fallback cycle: ${cycle.join(" -> ")}`);
    }
    if (visited.has(modelClass)) return;
    visiting.add(modelClass);
    for (const fallback of classes[modelClass].fallbackClasses) visit(fallback, [...path, modelClass]);
    visiting.delete(modelClass);
    visited.add(modelClass);
  };
  for (const modelClass of MODEL_CLASSES) visit(modelClass, []);
}

function copyModelRef(ref: ModelRef): ModelRef {
  return Object.freeze({ providerId: ref.providerId, modelId: ref.modelId });
}

function copyAssignment(assignment: RoutingAssignmentV2): RoutingAssignmentV2 {
  if (assignment.mode === "auto") return Object.freeze({ mode: "auto" });
  if (assignment.mode === "class") return Object.freeze({ mode: "class", modelClass: assignment.modelClass });
  if (assignment.mode === "baseline") {
    return Object.freeze({ mode: "baseline", ...(assignment.fallbackClass !== undefined ? { fallbackClass: assignment.fallbackClass } : {}) });
  }
  return Object.freeze({
    mode: "model",
    target: copyModelRef(assignment.target),
    ...(assignment.fallbackClass !== undefined ? { fallbackClass: assignment.fallbackClass } : {}),
  });
}

function copyClassConfig(config: ModelClassConfigV2): ModelClassConfigV2 {
  return Object.freeze({
    candidates: Object.freeze(config.candidates.map((candidate) => Object.freeze({
      target: copyModelRef(candidate.target),
      enabled: candidate.enabled,
      priority: candidate.priority,
    }))),
    selection: config.selection,
    fallbackClasses: Object.freeze([...config.fallbackClasses]),
  });
}

function copyProviders(config: ProviderRoutingConfigV2): ProviderRoutingConfigV2 {
  return Object.freeze({ scope: config.scope, allowlist: Object.freeze([...config.allowlist]), preferSessionProvider: config.preferSessionProvider });
}

function copyClassifier(config: ClassifierConfigV2): ClassifierConfigV2 {
  return Object.freeze({
    chain: Object.freeze(config.chain.map((entry) => Object.freeze({
      adapterId: entry.adapterId,
      ...(entry.target !== undefined ? { target: copyModelRef(entry.target) } : {}),
    }))),
    timeoutMs: config.timeoutMs,
    minConfidence: config.minConfidence,
    onFailure: copyAssignment(config.onFailure) as RoutingFallbackAssignmentV2,
  });
}

function copyExecution(config: RoutingExecutionConfigV2): RoutingExecutionConfigV2 {
  return Object.freeze({
    maxAttempts: config.maxAttempts,
    selectionTimeoutMs: config.selectionTimeoutMs,
    maxEstimatedCostUsd: config.maxEstimatedCostUsd,
    unknownCost: config.unknownCost,
  });
}

export function normalizeRoutingV2Config(layers: RoutingV2ConfigLayers, options: RoutingV2NormalizationOptions = {}): NormalizedRoutingV2Config {
  for (const [name, layer] of Object.entries(layers)) {
    if (layer === undefined) continue;
    const validation = validateRoutingV2ConfigLayer(layer, options);
    if (!validation.ok) throw new Error(`invalid ${name} routing v2 config: ${validation.errors.join("; ")}`);
  }

  const classes = Object.fromEntries(MODEL_CLASSES.map((modelClass) => {
    const config = layers.project?.classes?.[modelClass] ?? layers.user?.classes?.[modelClass] ?? EMPTY_CLASS;
    assertClassConfig(modelClass, config);
    return [modelClass, copyClassConfig(config)];
  })) as Record<ModelClass, ModelClassConfigV2>;
  assertAcyclicFallbacks(classes);

  const categories = {} as Record<RoutingCategory, RoutingAssignmentV2>;
  const categorySources = {} as Record<RoutingCategory, "project" | "user" | "builtin">;
  for (const category of ROUTING_CATEGORIES) {
    if (layers.project?.categories?.[category] !== undefined) {
      categories[category] = copyAssignment(layers.project.categories[category]);
      categorySources[category] = "project";
    } else if (layers.user?.categories?.[category] !== undefined) {
      categories[category] = copyAssignment(layers.user.categories[category]);
      categorySources[category] = "user";
    } else {
      categories[category] = copyAssignment(BASELINE_ASSIGNMENT);
      categorySources[category] = "builtin";
    }
  }

  const providers = copyProviders(layers.project?.providers ?? layers.user?.providers ?? DEFAULT_PROVIDERS);
  const classifier = copyClassifier(layers.project?.classifier ?? layers.user?.classifier ?? DEFAULT_CLASSIFIER);
  if (classifier.chain.length > 0 && options.classifierAdapters === undefined) {
    throw new Error("classifier adapter registry is required for a non-empty classifier chain");
  }
  for (const entry of classifier.chain) {
    if (options.classifierAdapters?.has(entry.adapterId) !== true) throw new Error(`unregistered classifier adapter ${JSON.stringify(entry.adapterId)}`);
    if (entry.adapterId === "model" && entry.target === undefined) throw new Error("classifier adapter \"model\" requires an explicit target");
  }
  const execution = copyExecution(layers.project?.execution ?? layers.user?.execution ?? DEFAULT_EXECUTION);
  const normalized = Object.freeze({
    schemaVersion: 2 as const,
    classes: Object.freeze(classes),
    categories: Object.freeze(categories),
    categorySources: Object.freeze(categorySources),
    providers,
    classifier,
    execution,
  });
  return Object.freeze({ ...normalized, configDigest: routingV2Digest(normalized) });
}
