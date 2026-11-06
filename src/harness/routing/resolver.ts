import { routingDigest, type ModelClassConfig, type NormalizedRoutingConfig, type RoutingAssignment, type RoutingCandidate } from "./config";
import type { RoutingAssignmentSource, RoutingDecision, RoutingExclusion, RoutingFallbackReason, RoutingReason } from "./decision";
import { compareModelClasses, isModelClass, modelRefKey, sameModelRef, type ModelClass, type ModelRef } from "./model-class";
import { ROUTING_CAPABILITIES, type RoutingRequest } from "./routing-request";
import { isVerifiedRoutingSnapshot, type RoutingModelFacts, type RoutingSnapshot } from "./snapshot";
import { isRoutingCategory } from "./table";

interface AssignmentResolution {
  readonly assignment: RoutingAssignment;
  readonly source: RoutingAssignmentSource;
  readonly recommendationSource: RoutingDecision["recommendationSource"];
  readonly classifierReceiptId?: string;
}

interface CandidateWithClass {
  readonly config: RoutingCandidate;
  readonly modelClass: ModelClass;
  readonly classConfig: ModelClassConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function validModelRef(value: unknown): value is ModelRef {
  return isRecord(value)
    && hasOnlyKeys(value, ["providerId", "modelId"])
    && typeof value.providerId === "string" && value.providerId.length > 0
    && typeof value.modelId === "string" && value.modelId.length > 0;
}

function validAssignment(value: unknown): value is RoutingAssignment {
  if (!isRecord(value)) return false;
  if (value.mode === "auto") return hasOnlyKeys(value, ["mode"]);
  if (value.mode === "baseline") return hasOnlyKeys(value, ["mode", "fallbackClass"]) && (value.fallbackClass === undefined || isModelClass(value.fallbackClass));
  if (value.mode === "class") return hasOnlyKeys(value, ["mode", "modelClass"]) && isModelClass(value.modelClass);
  if (value.mode === "model") return hasOnlyKeys(value, ["mode", "target", "fallbackClass"])
    && validModelRef(value.target) && (value.fallbackClass === undefined || isModelClass(value.fallbackClass));
  return false;
}

function validRequest(request: RoutingRequest): boolean {
  const capabilities = request.requirements?.capabilities;
  return typeof request.requestId === "string" && request.requestId.length > 0
    && (request.parentDecisionId === undefined || (typeof request.parentDecisionId === "string" && request.parentDecisionId.length > 0))
    && isRoutingCategory(request.category)
    && (["operator", "review", "subagent", "unattended", "native-session"] as const).includes(request.origin)
    && validModelRef(request.baseline)
    && isRecord(request.requirements)
    && Array.isArray(capabilities)
    && capabilities.every((capability) => ROUTING_CAPABILITIES.includes(capability))
    && new Set(capabilities).size === capabilities.length
    && Number.isSafeInteger(request.requirements.inputTokensRequired) && request.requirements.inputTokensRequired >= 0
    && Number.isSafeInteger(request.requirements.outputTokensReserved) && request.requirements.outputTokensReserved >= 0
    && (request.requirements.minimumClass === undefined || isModelClass(request.requirements.minimumClass))
    && (request.requirements.maxEstimatedCostUsd === undefined || (Number.isFinite(request.requirements.maxEstimatedCostUsd) && request.requirements.maxEstimatedCostUsd >= 0))
    && (request.userOverride === undefined || validAssignment(request.userOverride))
    && !(request.recommendation !== undefined && request.classification !== undefined)
    && (request.recommendation === undefined || (isRecord(request.recommendation)
      && hasOnlyKeys(request.recommendation, ["modelClass", "source", "receiptId"])
      && isModelClass(request.recommendation.modelClass)
      && (["task-signals", "agent", "classifier"] as const).includes(request.recommendation.source as "task-signals")
      && (request.recommendation.receiptId === undefined || (typeof request.recommendation.receiptId === "string" && request.recommendation.receiptId.length > 0))))
    && (request.classification === undefined || (isRecord(request.classification)
      && hasOnlyKeys(request.classification, ["status", "receiptId"])
      && request.classification.status === "failed"
      && (request.classification.receiptId === undefined || (typeof request.classification.receiptId === "string" && request.classification.receiptId.length > 0))));
}

function validFacts(facts: RoutingModelFacts): boolean {
  return validModelRef(facts.target)
    && typeof facts.connected === "boolean"
    && typeof facts.credentialsAvailable === "boolean"
    && typeof facts.policyAllowed === "boolean"
    && typeof facts.parentAllowed === "boolean"
    && (facts.availability === "available" || facts.availability === "unavailable" || facts.availability === "unknown")
    && Array.isArray(facts.capabilities)
    && facts.capabilities.every((capability) => ROUTING_CAPABILITIES.includes(capability))
    && new Set(facts.capabilities).size === facts.capabilities.length
    && (facts.contextLength === null || (Number.isSafeInteger(facts.contextLength) && facts.contextLength >= 0))
    && typeof facts.cooldown === "boolean"
    && (facts.observedLatencyMs === null || (Number.isFinite(facts.observedLatencyMs) && facts.observedLatencyMs >= 0));
}

function assignmentFor(request: RoutingRequest, config: NormalizedRoutingConfig): AssignmentResolution {
  const configured = request.userOverride ?? config.categories[request.category];
  const source = request.userOverride !== undefined ? "user-override" : config.categorySources[request.category];
  if (configured.mode !== "auto") {
    const classifierReceiptId = request.recommendation?.source === "classifier"
      ? request.recommendation.receiptId
      : request.classification?.receiptId;
    return {
      assignment: configured,
      source,
      recommendationSource: "none",
      ...(classifierReceiptId !== undefined ? { classifierReceiptId } : {}),
    };
  }
  if (request.recommendation !== undefined) {
    return {
      assignment: { mode: "class", modelClass: request.recommendation.modelClass },
      source,
      recommendationSource: request.recommendation.source,
      ...(request.recommendation.receiptId !== undefined ? { classifierReceiptId: request.recommendation.receiptId } : {}),
    };
  }
  if (request.classification?.status === "failed") {
    return {
      assignment: config.classifier.onFailure,
      source,
      recommendationSource: "classifier-fallback",
      ...(request.classification.receiptId !== undefined ? { classifierReceiptId: request.classification.receiptId } : {}),
    };
  }
  return { assignment: configured, source, recommendationSource: "none" };
}

function commonDecision(
  request: RoutingRequest,
  snapshot: RoutingSnapshot,
  config: NormalizedRoutingConfig,
  resolved: AssignmentResolution,
  exclusions: readonly RoutingExclusion[],
  requestedClass?: ModelClass,
  fallbackReason?: RoutingFallbackReason,
) {
  const snapshotDigest = typeof snapshot?.snapshotDigest === "string" && snapshot.snapshotDigest.length > 0
    ? snapshot.snapshotDigest
    : "invalid-snapshot";
  return {
    schemaVersion: 2 as const,
    decisionId: routingDigest({ request, snapshotDigest, configDigest: config.configDigest, resolved, exclusions }),
    requestId: request.requestId,
    ...(request.parentDecisionId !== undefined ? { parentDecisionId: request.parentDecisionId } : {}),
    configDigest: config.configDigest,
    snapshotDigest,
    assignmentSource: resolved.source,
    recommendationSource: resolved.recommendationSource,
    exclusions,
    ...(requestedClass !== undefined ? { requestedClass } : {}),
    ...(resolved.classifierReceiptId !== undefined ? { classifierReceiptId: resolved.classifierReceiptId } : {}),
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
  };
}

function providerAllowed(ref: ModelRef, request: RoutingRequest, config: NormalizedRoutingConfig): boolean {
  if (config.providers.scope === "all-connected") return true;
  if (config.providers.scope === "session-only") return ref.providerId === request.baseline.providerId;
  return config.providers.allowlist.includes(ref.providerId);
}

function effectiveCostLimit(request: RoutingRequest, config: NormalizedRoutingConfig): number | undefined {
  const limits = [request.requirements.maxEstimatedCostUsd, config.execution.maxEstimatedCostUsd]
    .filter((value): value is number => value !== undefined && value !== null);
  return limits.length === 0 ? undefined : Math.min(...limits);
}

function candidateRejection(
  candidate: ModelRef,
  facts: RoutingModelFacts | undefined,
  authFailedProviderIds: ReadonlySet<string>,
  request: RoutingRequest,
  config: NormalizedRoutingConfig,
): RoutingReason | undefined {
  if (!providerAllowed(candidate, request, config)) return "provider-scope-conflict";
  if (authFailedProviderIds.has(candidate.providerId)) return "auth-failed";
  if (facts === undefined || !validFacts(facts) || !facts.connected) return "candidate-unverified";
  if (!facts.policyAllowed || !facts.parentAllowed) return "policy-denied";
  if (!facts.credentialsAvailable) return "credentials-missing";
  if (facts.availability === "unavailable") return "model-unavailable";
  // Unknown availability cannot justify switching models; the baseline is the model
  // the caller already runs on (or explicitly pinned), so keeping it needs no proof.
  if (facts.availability === "unknown" && !sameModelRef(candidate, request.baseline)) return "candidate-unverified";
  if (facts.cooldown) return "cooldown";
  if (request.requirements.capabilities.some((capability) => !facts.capabilities.includes(capability))) return "capability-missing";
  const requiredContext = request.requirements.inputTokensRequired + request.requirements.outputTokensReserved;
  // An unknown context length cannot justify switching to another model, but the
  // baseline is the model the caller already runs on: keeping it needs no proof.
  if (requiredContext > 0 && (facts.contextLength === null ? !sameModelRef(candidate, request.baseline) : facts.contextLength < requiredContext)) return "context-insufficient";
  const costLimit = effectiveCostLimit(request, config);
  if (facts.estimatedCostUsd === null && (costLimit !== undefined || config.execution.unknownCost === "deny")) return "cost-unknown";
  if (facts.estimatedCostUsd !== null && (!Number.isFinite(facts.estimatedCostUsd) || facts.estimatedCostUsd < 0)) return "cost-unknown";
  if (facts.estimatedCostUsd !== null && costLimit !== undefined && facts.estimatedCostUsd > costLimit) return "budget-exceeded";
  return undefined;
}

function strongestMembership(ref: ModelRef, config: NormalizedRoutingConfig): ModelClass | undefined {
  let strongest: ModelClass | undefined;
  for (const [modelClass, classConfig] of Object.entries(config.classes) as Array<[ModelClass, ModelClassConfig]>) {
    if (!classConfig.candidates.some((candidate) => candidate.enabled && sameModelRef(candidate.target, ref))) continue;
    if (strongest === undefined || compareModelClasses(modelClass, strongest) > 0) strongest = modelClass;
  }
  return strongest;
}

function minimumClassRejection(ref: ModelRef, request: RoutingRequest, config: NormalizedRoutingConfig): RoutingReason | undefined {
  const minimum = request.requirements.minimumClass;
  if (minimum === undefined) return undefined;
  const membership = strongestMembership(ref, config);
  return membership === undefined || compareModelClasses(membership, minimum) < 0 ? "minimum-class-unproven" : undefined;
}

function compareCandidates(left: CandidateWithClass, right: CandidateWithClass, request: RoutingRequest, facts: ReadonlyMap<string, RoutingModelFacts>, preferSessionProvider: boolean): number {
  const priority = right.config.priority - left.config.priority;
  if (priority !== 0) return priority;
  if (preferSessionProvider) {
    const leftSession = left.config.target.providerId === request.baseline.providerId;
    const rightSession = right.config.target.providerId === request.baseline.providerId;
    if (leftSession !== rightSession) return leftSession ? -1 : 1;
  }
  const policy = left.classConfig.selection;
  if (policy === "cost" || policy === "latency") {
    const leftFacts = facts.get(modelRefKey(left.config.target));
    const rightFacts = facts.get(modelRefKey(right.config.target));
    const leftMetric = policy === "cost" ? leftFacts?.estimatedCostUsd : leftFacts?.observedLatencyMs;
    const rightMetric = policy === "cost" ? rightFacts?.estimatedCostUsd : rightFacts?.observedLatencyMs;
    const leftKnown = leftMetric !== undefined && leftMetric !== null && Number.isFinite(leftMetric);
    const rightKnown = rightMetric !== undefined && rightMetric !== null && Number.isFinite(rightMetric);
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    if (leftKnown && rightKnown && leftMetric !== rightMetric) return leftMetric - rightMetric;
  }
  return modelRefKey(left.config.target).localeCompare(modelRefKey(right.config.target));
}

function classCandidates(modelClass: ModelClass, config: NormalizedRoutingConfig): CandidateWithClass[] {
  const classConfig = config.classes[modelClass];
  return classConfig.candidates.map((candidate) => ({ config: candidate, modelClass, classConfig }));
}

export function resolveRoutingDecision(request: RoutingRequest, snapshot: RoutingSnapshot, config: NormalizedRoutingConfig): RoutingDecision {
  const invalidResolution: AssignmentResolution = { assignment: { mode: "baseline" }, source: "builtin", recommendationSource: "none" };
  if (!validRequest(request)) {
    return { ...commonDecision(request, snapshot, config, invalidResolution, []), status: "blocked", reason: "config-invalid" };
  }
  const resolved = assignmentFor(request, config);
  const exclusions: RoutingExclusion[] = [];
  const { configDigest, ...configBody } = config;
  if (routingDigest(configBody) !== configDigest
    || !isVerifiedRoutingSnapshot(snapshot)
    || snapshot.configDigest !== config.configDigest
    || !validModelRef(snapshot.baseline) || !sameModelRef(snapshot.baseline, request.baseline)
    || !Array.isArray(snapshot.models)) {
    return { ...commonDecision(request, snapshot, config, resolved, exclusions), status: "blocked", reason: "config-invalid" };
  }

  const facts = new Map<string, RoutingModelFacts>();
  const authFailedProviderIds = new Set(snapshot.authFailedProviderIds);
  for (const model of snapshot.models) {
    const key = modelRefKey(model.target);
    if (facts.has(key)) return { ...commonDecision(request, snapshot, config, resolved, exclusions), status: "blocked", reason: "config-invalid" };
    facts.set(key, model);
  }
  const assignment = resolved.assignment;
  const requestedClass = assignment.mode === "class" ? assignment.modelClass : undefined;
  if (requestedClass !== undefined && request.requirements.minimumClass !== undefined && compareModelClasses(requestedClass, request.requirements.minimumClass) < 0) {
    exclusions.push({ modelClass: requestedClass, reason: "class-below-minimum" });
    return { ...commonDecision(request, snapshot, config, resolved, exclusions, requestedClass), status: "blocked", reason: "class-below-minimum" };
  }

  const directTarget = assignment.mode === "baseline" ? request.baseline : assignment.mode === "model" ? assignment.target : undefined;
  let pinFallbackUsed = false;
  if (directTarget !== undefined) {
    const reason = candidateRejection(directTarget, facts.get(modelRefKey(directTarget)), authFailedProviderIds, request, config)
      ?? minimumClassRejection(directTarget, request, config);
    if (reason === undefined) {
      const fallbackReason = resolved.recommendationSource === "classifier-fallback" ? "classifier-fallback" : undefined;
      return { ...commonDecision(request, snapshot, config, resolved, exclusions, undefined, fallbackReason), status: "selected", selection: directTarget };
    }
    exclusions.push({ target: directTarget, reason });
    const fallbackClass = assignment.mode === "baseline" || assignment.mode === "model" ? assignment.fallbackClass : undefined;
    if (fallbackClass === undefined) return { ...commonDecision(request, snapshot, config, resolved, exclusions), status: "blocked", reason };
    pinFallbackUsed = true;
    if (request.requirements.minimumClass !== undefined && compareModelClasses(fallbackClass, request.requirements.minimumClass) < 0) {
      exclusions.push({ modelClass: fallbackClass, reason: "class-below-minimum" });
      return { ...commonDecision(request, snapshot, config, resolved, exclusions, fallbackClass), status: "blocked", reason: "class-below-minimum" };
    }
  }

  const firstClass = assignment.mode === "class" ? assignment.modelClass : assignment.mode === "auto" ? undefined : assignment.fallbackClass;
  if (firstClass === undefined) return { ...commonDecision(request, snapshot, config, resolved, exclusions), status: "needs-classification" };
  const classes = [firstClass, ...config.classes[firstClass].fallbackClasses];
  for (const modelClass of classes) {
    if (request.requirements.minimumClass !== undefined && compareModelClasses(modelClass, request.requirements.minimumClass) < 0) {
      exclusions.push({ modelClass, reason: "class-below-minimum" });
      continue;
    }
    const candidates = classCandidates(modelClass, config);
    if (candidates.length === 0) {
      exclusions.push({ modelClass, reason: "empty-class" });
      continue;
    }
    const accepted: CandidateWithClass[] = [];
    for (const candidate of [...candidates].sort((left, right) => modelRefKey(left.config.target).localeCompare(modelRefKey(right.config.target)))) {
      const reason: RoutingReason | undefined = !candidate.config.enabled
        ? "model-unavailable"
        : candidateRejection(candidate.config.target, facts.get(modelRefKey(candidate.config.target)), authFailedProviderIds, request, config);
      if (reason === undefined) accepted.push(candidate);
      else exclusions.push({ target: candidate.config.target, modelClass, reason });
    }
    if (accepted.length === 0) continue;
    accepted.sort((left, right) => compareCandidates(left, right, request, facts, config.providers.preferSessionProvider));
    const fallbackReason: RoutingFallbackReason | undefined = pinFallbackUsed
      ? "pin-fallback"
      : modelClass !== firstClass
        ? compareModelClasses(modelClass, firstClass) > 0 ? "class-escalated" : "class-downgraded"
        : resolved.recommendationSource === "classifier-fallback"
          ? "classifier-fallback"
          : exclusions.some((exclusion) => exclusion.modelClass === modelClass && exclusion.target !== undefined)
            ? "candidate-fallback"
            : undefined;
    return {
      ...commonDecision(request, snapshot, config, resolved, exclusions, requestedClass ?? firstClass, fallbackReason),
      status: "selected",
      selection: accepted[0]!.config.target,
      selectedClass: modelClass,
    };
  }
  const reason = exclusions.at(-1)?.reason ?? "empty-class";
  return { ...commonDecision(request, snapshot, config, resolved, exclusions, requestedClass ?? firstClass), status: "blocked", reason };
}
