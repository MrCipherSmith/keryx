import { modelRefKey, type ModelRef } from "./model-class";
import { createRoutingSnapshot, type RoutingSnapshot } from "./snapshot";

interface FailureEntry {
  readonly catalogRevision: string;
  readonly target: ModelRef;
  readonly kind: "cooldown" | "model-unavailable";
  readonly expiresAtMs?: number;
}

/** Shared runtime failures, scoped so a catalog refresh makes model failures stale. */
export class RoutingFailureRegistry {
  readonly #models = new Map<string, FailureEntry>();
  readonly #authFailedProviders = new Set<string>();

  recordModelNotFound(target: ModelRef, catalogRevision: string): void {
    this.#models.set(this.#key(target, catalogRevision), { target, catalogRevision, kind: "model-unavailable" });
  }

  recordRateLimit(target: ModelRef, catalogRevision: string, retryAfterMs: number | undefined, now: Date): void {
    if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
    const key = this.#key(target, catalogRevision);
    const existing = this.#models.get(key);
    if (existing?.kind === "model-unavailable") return;
    this.#models.set(key, {
      target,
      catalogRevision,
      kind: "cooldown",
      expiresAtMs: Math.max(existing?.expiresAtMs ?? 0, now.getTime() + retryAfterMs),
    });
  }

  recordAuthFailure(providerId: string): void {
    this.#authFailedProviders.add(providerId);
  }

  clearAuthFailure(providerId: string): void {
    this.#authFailedProviders.delete(providerId);
  }

  apply(snapshot: RoutingSnapshot, now: Date): RoutingSnapshot {
    let changed = false;
    const authFailedProviderIds = [...new Set([...snapshot.authFailedProviderIds, ...this.#authFailedProviders])];
    if (authFailedProviderIds.length !== snapshot.authFailedProviderIds.length) changed = true;
    const models = snapshot.models.map((facts) => {
      const entry = this.#models.get(this.#key(facts.target, snapshot.catalogRevision));
      if (entry?.expiresAtMs !== undefined && entry.expiresAtMs <= now.getTime()) {
        this.#models.delete(this.#key(facts.target, snapshot.catalogRevision));
        return facts;
      }
      const authFailed = this.#authFailedProviders.has(facts.target.providerId);
      if (entry === undefined && !authFailed) return facts;
      changed = true;
      return {
        ...facts,
        ...(authFailed ? { credentialsAvailable: false } : {}),
        ...(entry?.kind === "cooldown" ? { cooldown: true } : {}),
        ...(entry?.kind === "model-unavailable" ? { availability: "unavailable" as const } : {}),
      };
    });
    if (!changed) return snapshot;
    return createRoutingSnapshot({
      configDigest: snapshot.configDigest,
      observedAt: now.toISOString(),
      catalogRevision: snapshot.catalogRevision,
      policyRevision: snapshot.policyRevision,
      capabilityRevision: snapshot.capabilityRevision,
      authFailedProviderIds,
      baseline: snapshot.baseline,
      models,
    });
  }

  #key(target: ModelRef, catalogRevision: string): string {
    return `${catalogRevision}\u0000${modelRefKey(target)}`;
  }
}
