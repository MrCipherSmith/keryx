import { createHash, randomBytes } from "node:crypto";
import type {
  ReviewAgentAdapter,
  ReviewAgentAdapterCapabilities,
  ReviewAgentAdapterRequest,
  ReviewAgentAdapterResult,
  ReviewAgentSpawnInput,
} from "./types";

export type ExternalBridgeOperation = "spawn" | "status" | "wait" | "result" | "cancel";

export type ExternalBridgeRequest =
  | { readonly operation: "spawn"; readonly input: ReviewAgentSpawnInput }
  | { readonly operation: "status" | "wait" | "result"; readonly dispatchId: string }
  | { readonly operation: "cancel"; readonly dispatchId: string; readonly reason: string };

export interface ExternalBridgeControllerPort {
  readonly spawn: (parentDispatchId: string, input: ReviewAgentSpawnInput) => Promise<unknown>;
  /** Recheck ownership even when spawn returns an idempotently reused dispatch. */
  readonly isDescendant: (parentDispatchId: string, dispatchId: string) => boolean | Promise<boolean>;
  /** Terminal children are retained as evidence and never sent a redundant cancel. */
  readonly isTerminal: (dispatchId: string) => boolean | Promise<boolean>;
  readonly status: (dispatchId: string) => Promise<unknown>;
  readonly wait: (dispatchId: string) => Promise<unknown>;
  readonly result: (dispatchId: string) => Promise<unknown>;
  readonly cancel: (dispatchId: string, reason: string) => Promise<unknown>;
}

export interface ExternalBridgeAuthorityRequest {
  readonly operation: ExternalBridgeOperation;
  readonly runId: string;
  readonly parentDispatchId: string;
  readonly targetDispatchId?: string;
}

export interface ExternalBridgeGrant {
  /** Opaque, narrowly scoped bridge credential. It is not a model/provider credential. */
  readonly token: string;
  readonly runId: string;
  readonly parentDispatchId: string;
  readonly expiresAt: number;
}

export type ExternalBridgeFailureCode =
  | "token_unknown"
  | "token_expired"
  | "token_revoked"
  | "operation_denied"
  | "authority_denied"
  | "scope_denied"
  | "invalid_request"
  | "controller_error";

export type ExternalBridgeResponse =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: ExternalBridgeFailureCode; readonly message: string };

interface GrantRecord {
  readonly digest: string;
  readonly runId: string;
  readonly parentDispatchId: string;
  readonly expiresAt: number;
  readonly allowedOperations: ReadonlySet<ExternalBridgeOperation>;
  readonly dispatchIds: Set<string>;
  revoked: boolean;
}

export interface ExternalBridgeGrantSnapshot {
  readonly digest: string;
  readonly runId: string;
  readonly parentDispatchId: string;
  readonly expiresAt: number;
  readonly allowedOperations: readonly ExternalBridgeOperation[];
  readonly dispatchIds: readonly string[];
  readonly revoked: boolean;
}

/** Durable store contains token digests only. The opaque bearer remains with the child. */
export interface ExternalBridgeGrantStore {
  readonly load: () => readonly ExternalBridgeGrantSnapshot[];
  readonly save: (records: readonly ExternalBridgeGrantSnapshot[]) => void;
}

const ALL_OPERATIONS: readonly ExternalBridgeOperation[] = ["spawn", "status", "wait", "result", "cancel"];

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generatedToken(): string {
  return randomBytes(32).toString("base64url");
}

function failure(code: ExternalBridgeFailureCode, message: string): ExternalBridgeResponse {
  return { ok: false, code, message };
}

export interface ExternalGeneralBridge {
  readonly issue: (input: {
    readonly parentDispatchId: string;
    readonly ttlMs: number;
    readonly allowedOperations?: readonly ExternalBridgeOperation[];
  }) => ExternalBridgeGrant;
  readonly invoke: (token: string, request: ExternalBridgeRequest) => Promise<ExternalBridgeResponse>;
  readonly revoke: (token: string, reason?: string) => Promise<boolean>;
  readonly revokeParent: (
    parentDispatchId: string,
    reason?: string,
    cancelTracked?: boolean,
  ) => Promise<{ readonly cancelled: readonly string[]; readonly failures: readonly { dispatchId: string; message: string }[] }>;
}

export function createExternalGeneralBridge(options: {
  readonly runId: string;
  readonly controller: ExternalBridgeControllerPort;
  readonly authorize: (request: ExternalBridgeAuthorityRequest) => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly tokenFactory?: () => string;
  readonly grantStore?: ExternalBridgeGrantStore;
}): ExternalGeneralBridge {
  const now = options.now ?? Date.now;
  const tokenFactory = options.tokenFactory ?? generatedToken;
  const records = new Map<string, GrantRecord>();
  for (const saved of options.grantStore?.load() ?? []) {
    if (saved.runId !== options.runId || records.has(saved.digest)) continue;
    records.set(saved.digest, {
      ...saved,
      allowedOperations: new Set(saved.allowedOperations),
      dispatchIds: new Set(saved.dispatchIds),
    });
  }
  const persist = (): void => {
    options.grantStore?.save(
      [...records.values()].map((record) => ({
        digest: record.digest,
        runId: record.runId,
        parentDispatchId: record.parentDispatchId,
        expiresAt: record.expiresAt,
        allowedOperations: [...record.allowedOperations],
        dispatchIds: [...record.dispatchIds],
        revoked: record.revoked,
      })),
    );
  };

  const issue: ExternalGeneralBridge["issue"] = (input) => {
    if (!input.parentDispatchId.trim()) throw new Error("parentDispatchId must not be empty");
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new Error("ttlMs must be a positive whole number");
    const operations = input.allowedOperations ?? ALL_OPERATIONS;
    if (operations.length === 0 || operations.some((operation) => !ALL_OPERATIONS.includes(operation))) {
      throw new Error("allowedOperations must contain known bridge operations");
    }
    const token = tokenFactory();
    if (token.length < 32) throw new Error("bridge token must contain at least 32 characters of entropy-bearing material");
    const digest = tokenDigest(token);
    if (records.has(digest)) throw new Error("bridge token factory returned a duplicate token");
    const record: GrantRecord = {
      digest,
      runId: options.runId,
      parentDispatchId: input.parentDispatchId,
      expiresAt: now() + input.ttlMs,
      allowedOperations: new Set(operations),
      dispatchIds: new Set(),
      revoked: false,
    };
    records.set(digest, record);
    persist();
    return {
      token,
      runId: record.runId,
      parentDispatchId: record.parentDispatchId,
      expiresAt: record.expiresAt,
    };
  };

  const invoke: ExternalGeneralBridge["invoke"] = async (token, request) => {
    if (!validBridgeRequest(request)) return failure("invalid_request", "bridge request is invalid");
    const record = records.get(tokenDigest(token));
    if (record === undefined) return failure("token_unknown", "bridge token is unknown");
    if (record.revoked) return failure("token_revoked", "bridge token has been revoked");
    if (now() >= record.expiresAt) return failure("token_expired", "bridge token has expired");
    if (!record.allowedOperations.has(request.operation)) {
      return failure("operation_denied", `bridge token does not allow ${request.operation}`);
    }
    const targetDispatchId = request.operation === "spawn" ? undefined : request.dispatchId;
    if (targetDispatchId !== undefined && !record.dispatchIds.has(targetDispatchId)) {
      return failure("scope_denied", `dispatch ${targetDispatchId} is outside the token's subtree`);
    }
    const allowed = await Promise.resolve(
      options.authorize({
        operation: request.operation,
        runId: record.runId,
        parentDispatchId: record.parentDispatchId,
        ...(targetDispatchId === undefined ? {} : { targetDispatchId }),
      }),
    ).catch(() => false);
    if (!allowed) return failure("authority_denied", `host authority denied ${request.operation}`);

    try {
      if (request.operation === "spawn") {
        if (!validSpawnInput(request.input)) return failure("invalid_request", "spawn input is invalid");
        const value = await options.controller.spawn(record.parentDispatchId, request.input);
        if (
          typeof value === "object" &&
          value !== null &&
          Reflect.get(value, "ok") === true &&
          typeof Reflect.get(value, "dispatchId") === "string"
        ) {
          const dispatchId = Reflect.get(value, "dispatchId") as string;
          if (!(await options.controller.isDescendant(record.parentDispatchId, dispatchId))) {
            return failure("scope_denied", `controller returned dispatch ${dispatchId} outside the token's subtree`);
          }
          record.dispatchIds.add(dispatchId);
          persist();
        }
        return { ok: true, value };
      }
      if (request.operation === "status") return { ok: true, value: await options.controller.status(request.dispatchId) };
      if (request.operation === "wait") return { ok: true, value: await options.controller.wait(request.dispatchId) };
      if (request.operation === "result") return { ok: true, value: await options.controller.result(request.dispatchId) };
      if (request.operation === "cancel") {
        return { ok: true, value: await options.controller.cancel(request.dispatchId, request.reason) };
      }
      return failure("controller_error", `unsupported bridge operation: ${String(Reflect.get(request, "operation"))}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure("controller_error", `controller ${request.operation} failed: ${message}`);
    }
  };

  const revoke: ExternalGeneralBridge["revoke"] = async (token, reason = "external bridge grant revoked") => {
    const record = records.get(tokenDigest(token));
    if (record === undefined || record.revoked) return false;
    record.revoked = true;
    persist();
    const failures: Error[] = [];
    await Promise.all(
      [...record.dispatchIds].map(async (dispatchId) => {
        try {
          if (await options.controller.isTerminal(dispatchId)) return;
          await options.controller.cancel(dispatchId, reason);
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
    if (failures.length > 0) throw new AggregateError(failures, "failed to cancel every child while revoking bridge grant");
    return true;
  };

  const revokeParent: ExternalGeneralBridge["revokeParent"] = async (
    parentDispatchId,
    reason = "external general grant revoked",
    cancelTracked = true,
  ) => {
    const children = new Set<string>();
    for (const record of records.values()) {
      if (record.parentDispatchId !== parentDispatchId) continue;
      record.revoked = true;
      if (cancelTracked) for (const dispatchId of record.dispatchIds) children.add(dispatchId);
    }
    persist();
    const cancelled: string[] = [];
    const failures: Array<{ dispatchId: string; message: string }> = [];
    await Promise.all(
      [...children].map(async (dispatchId) => {
        try {
          if (await options.controller.isTerminal(dispatchId)) return;
          await options.controller.cancel(dispatchId, reason);
          cancelled.push(dispatchId);
        } catch (error) {
          failures.push({ dispatchId, message: error instanceof Error ? error.message : String(error) });
        }
      }),
    );
    return { cancelled: cancelled.sort(), failures: failures.sort((a, b) => a.dispatchId.localeCompare(b.dispatchId)) };
  };

  return { issue, invoke, revoke, revokeParent };
}

export interface ExternalGeneralRunnerInput {
  readonly request: ReviewAgentAdapterRequest;
  readonly signal: AbortSignal;
  readonly grant: ExternalBridgeGrant;
  readonly bridge: Pick<ExternalGeneralBridge, "invoke">;
}

export interface ExternalGeneralRunner {
  /** Capability evidence is bound to the runner construction, not accepted from dispatch JSON. */
  readonly enforcement: {
    readonly sourceSandbox: "read-only";
    readonly resultWrites: "controller-only";
    readonly hierarchy: "scoped-bridge";
    readonly processCancellation: "handle";
    readonly usageAccounting: boolean;
    readonly toolProfile: "bridge-only";
    readonly sourceRead: false;
    readonly authRefresh: false;
  };
  readonly execute: (input: ExternalGeneralRunnerInput) => Promise<ReviewAgentAdapterResult>;
  /**
   * Must resolve only after the operating-system process has exited. Merely
   * delivering a signal is not cancellation evidence and must return
   * `stopped:false`, causing the adapter cancellation to fail closed.
   */
  readonly cancel?: (request: {
    readonly runId: string;
    readonly dispatchId: string;
    readonly reason: string;
  }) => Promise<ExternalGeneralStopEvidence>;
  readonly reconcile?: (request: { readonly runId: string; readonly dispatchId: string }) => Promise<"running" | "cancelled" | "unknown">;
}

export type ExternalGeneralStopEvidence =
  | { readonly stopped: true; readonly observedAt: string; readonly exitCode: number | null }
  | { readonly stopped: false; readonly reason: string };

/**
 * Adapts a verified external-general process runner to the shared review-agent controller.
 * The runner receives only a scoped bridge grant. Model/provider credentials stay
 * in the process runtime selected by the operator and are never copied here.
 */
export function createExternalGeneralAdapter(options: {
  readonly id: string;
  readonly bridge: ExternalGeneralBridge;
  readonly runner: ExternalGeneralRunner;
  readonly grantTtlMs: number;
}): ReviewAgentAdapter {
  if (options.runner.cancel === undefined) throw new Error("external general runner must provide process cancellation");
  const capabilities: ReviewAgentAdapterCapabilities = {
    readOnlyEnforced: options.runner.enforcement.sourceSandbox === "read-only",
    resultPersistence: options.runner.enforcement.resultWrites === "controller-only",
    cancellation: options.runner.enforcement.processCancellation === "handle",
    hierarchy: options.runner.enforcement.hierarchy === "scoped-bridge",
    usageAccounting: options.runner.enforcement.usageAccounting,
    toolProfile: options.runner.enforcement.toolProfile,
    sourceRead: options.runner.enforcement.sourceRead,
    authRefresh: options.runner.enforcement.authRefresh,
  };
  const active = new Map<string, AbortController>();
  return {
    id: options.id,
    capabilities,
    async execute(request) {
      const local = new AbortController();
      active.set(request.dispatchId, local);
      const grant = options.bridge.issue({ parentDispatchId: request.dispatchId, ttlMs: options.grantTtlMs });
      const signal = AbortSignal.any([request.signal, local.signal]);
      let result: ReviewAgentAdapterResult | undefined;
      let executionError: unknown;
      try {
        result = await options.runner.execute({ request, signal, grant, bridge: options.bridge });
      } catch (error) {
        executionError = error;
      }
      active.delete(request.dispatchId);
      const cleanup = await options.bridge.revokeParent(request.dispatchId, "external general finished", true);
      if (cleanup.failures.length > 0) {
        throw new AggregateError(
          cleanup.failures.map((entry) => new Error(`${entry.dispatchId}: ${entry.message}`)),
          "failed to cancel every external general child",
        );
      }
      if (executionError !== undefined) throw executionError;
      return result!;
    },
    async cancel(request) {
      active.get(request.dispatchId)?.abort(request.reason);
      const stopped = await options.runner.cancel!(request);
      const cleanup = await options.bridge.revokeParent(request.dispatchId, request.reason, true);
      if (cleanup.failures.length > 0) {
        throw new AggregateError(cleanup.failures.map((entry) => new Error(`${entry.dispatchId}: ${entry.message}`)));
      }
      if (!stopped.stopped) {
        throw new Error(`external general process stop was not confirmed: ${stopped.reason}`);
      }
    },
    ...(options.runner.reconcile === undefined ? {} : { reconcile: options.runner.reconcile }),
  };
}

function validBridgeRequest(value: unknown): value is ExternalBridgeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const operation = Reflect.get(value, "operation");
  const keys = Object.keys(value);
  if (operation === "spawn") {
    return keys.length === 2 && keys.includes("operation") && keys.includes("input") && validSpawnInput(Reflect.get(value, "input"));
  }
  if (["status", "wait", "result"].includes(String(operation))) {
    return keys.length === 2 && keys.includes("operation") && keys.includes("dispatchId") &&
      typeof Reflect.get(value, "dispatchId") === "string" && (Reflect.get(value, "dispatchId") as string).trim().length > 0;
  }
  if (operation === "cancel") {
    return keys.length === 3 && keys.includes("operation") && keys.includes("dispatchId") && keys.includes("reason") &&
      typeof Reflect.get(value, "dispatchId") === "string" && (Reflect.get(value, "dispatchId") as string).trim().length > 0 &&
      typeof Reflect.get(value, "reason") === "string" && (Reflect.get(value, "reason") as string).trim().length > 0;
  }
  return false;
}

function validSpawnInput(value: unknown): value is ReviewAgentSpawnInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const allowed = new Set([
    "taskId", "task", "attempt", "idempotencyKey", "entity", "role", "adapterId", "skillRef", "scopeIds",
    "waveId", "maxRuntimeMs",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  const get = (key: string): unknown => Reflect.get(value, key);
  if (typeof get("taskId") !== "string" || !(get("taskId") as string).trim()) return false;
  if (!Number.isSafeInteger(get("attempt")) || (get("attempt") as number) < 1) return false;
  if (typeof get("entity") !== "string" || !(get("entity") as string).trim()) return false;
  if (!["worker", "scout", "validator"].includes(String(get("role")))) return false;
  if (typeof get("adapterId") !== "string" || !(get("adapterId") as string).trim()) return false;
  for (const key of ["task", "idempotencyKey", "skillRef", "waveId"] as const) {
    if (get(key) !== undefined && typeof get(key) !== "string") return false;
  }
  if (get("scopeIds") !== undefined && (!Array.isArray(get("scopeIds")) || !(get("scopeIds") as unknown[]).every((v) => typeof v === "string"))) return false;
  return get("maxRuntimeMs") === undefined || (Number.isSafeInteger(get("maxRuntimeMs")) && (get("maxRuntimeMs") as number) > 0);
}
