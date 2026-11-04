export type RoutingBudgetPurpose = "classifier" | "execution";
export type RoutingBudgetReason = "budget-exceeded" | "cost-unknown";

export interface RoutingBudgetLimits {
  readonly parentUsd?: number | null;
  readonly taskUsd?: number | null;
  readonly configUsd?: number | null;
  readonly unknownCost?: "allow" | "deny";
}

export interface RoutingBudgetReservation {
  readonly id: string;
  readonly purpose: RoutingBudgetPurpose;
  readonly estimatedCostUsd: number;
}

export type RoutingBudgetReserveResult =
  | { readonly ok: true; readonly reservation: RoutingBudgetReservation }
  | { readonly ok: false; readonly reason: RoutingBudgetReason };

interface MutableReservation extends RoutingBudgetReservation {
  state: "reserved" | "reconciled" | "released";
  actualCostUsd?: number;
}

function assertCost(name: string, value: number | null | undefined): void {
  if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${name} must be a non-negative finite number or null`);
}

/** The strictest configured parent/task/config cap. Null and undefined mean unbounded. */
export function effectiveRoutingCostCap(limits: RoutingBudgetLimits): number | null {
  assertCost("parentUsd", limits.parentUsd);
  assertCost("taskUsd", limits.taskUsd);
  assertCost("configUsd", limits.configUsd);
  const caps = [limits.parentUsd, limits.taskUsd, limits.configUsd].filter((value): value is number => value !== null && value !== undefined);
  return caps.length === 0 ? null : Math.min(...caps);
}

/** Shared classifier/execution money ledger with synchronous atomic reservation. */
export class RoutingBudgetLedger {
  readonly capUsd: number | null;
  readonly unknownCost: "allow" | "deny";
  #sequence = 0;
  #spentUsd = 0;
  #reservedUsd = 0;
  readonly #reservations = new Map<string, MutableReservation>();

  constructor(limits: RoutingBudgetLimits = {}) {
    this.capUsd = effectiveRoutingCostCap(limits);
    this.unknownCost = limits.unknownCost ?? "deny";
  }

  reserve(input: { readonly estimatedCostUsd: number | null; readonly purpose: RoutingBudgetPurpose }): RoutingBudgetReserveResult {
    assertCost("estimatedCostUsd", input.estimatedCostUsd);
    if (input.estimatedCostUsd === null && (this.capUsd !== null || this.unknownCost === "deny")) return { ok: false, reason: "cost-unknown" };
    const amount = input.estimatedCostUsd ?? 0;
    if (this.capUsd !== null && this.#spentUsd + this.#reservedUsd + amount > this.capUsd) return { ok: false, reason: "budget-exceeded" };
    const reservation: MutableReservation = { id: `routing-budget-${++this.#sequence}`, purpose: input.purpose, estimatedCostUsd: amount, state: "reserved" };
    this.#reservations.set(reservation.id, reservation);
    this.#reservedUsd += amount;
    return { ok: true, reservation };
  }

  reconcile(reservationId: string, actualCostUsd: number): void {
    assertCost("actualCostUsd", actualCostUsd);
    const reservation = this.#active(reservationId);
    this.#reservedUsd -= reservation.estimatedCostUsd;
    this.#spentUsd += actualCostUsd;
    reservation.actualCostUsd = actualCostUsd;
    reservation.state = "reconciled";
  }

  release(reservationId: string): void {
    const reservation = this.#active(reservationId);
    this.#reservedUsd -= reservation.estimatedCostUsd;
    reservation.state = "released";
  }

  snapshot(): { readonly capUsd: number | null; readonly spentUsd: number; readonly reservedUsd: number; readonly remainingUsd: number | null } {
    return {
      capUsd: this.capUsd,
      spentUsd: this.#spentUsd,
      reservedUsd: this.#reservedUsd,
      remainingUsd: this.capUsd === null ? null : Math.max(0, this.capUsd - this.#spentUsd - this.#reservedUsd),
    };
  }

  #active(reservationId: string): MutableReservation {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined || reservation.state !== "reserved") throw new Error(`routing budget reservation is not active: ${reservationId}`);
    return reservation;
  }
}
