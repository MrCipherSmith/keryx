// Authentication-failure throttling for the serve listener.
//
// R4b deferred this, and stated the reason: "on two read-only routes behind a
// loopback socket there is nothing to enumerate and no state to change".
// `POST /v1/turns` changes state, so the debt comes due with the first mutating
// route — recorded as D4 of flow 131.
//
// The shape is decided by one requirement that reads like a detail and is not.
// security-policy.md: "Throttle the peer; never throttle an authenticated
// in-flight turn." A throttle consulted BEFORE authentication cannot honour
// that: a peer that has been guessing tokens would have its next request
// rejected even when that request finally carries the real one, so an operator
// whose token leaked into someone else's script would be locked out of their own
// server by the attacker's failures.
//
// So the order is inverted from the usual: authenticate first, and consult the
// throttle only on the failure path. A request that authenticates is never
// throttled, by construction rather than by a carve-out — there is no code path
// on which a successful authentication reaches this module at all.
//
// This is deliberately NOT a general rate limiter. It counts one thing, failed
// authentications, per peer. api-protocol.md §Bounds leaves request rate to the
// transports ("Transports are responsible for their own rate limits").

/**
 * Failures a peer may accumulate inside the window before it is throttled.
 *
 * Ten rather than three: the loopback listener is reached by an operator's own
 * scripts as well as by a transport, and a token pasted with a trailing newline
 * should not lock someone out on the second try. Ten wrong guesses inside a
 * minute is no longer a typo.
 */
export const AUTH_FAILURE_LIMIT = 10;

/** The sliding window failures are counted in. */
export const AUTH_FAILURE_WINDOW_MS = 60_000;

/** How long a throttled peer is refused before it may try again. */
export const AUTH_THROTTLE_COOLDOWN_MS = 60_000;

/**
 * The largest number of distinct peers tracked at once.
 *
 * A throttle keyed by peer is a map an unauthenticated caller can grow, and a
 * map an unauthenticated caller can grow without limit is a memory exhaustion
 * primitive dressed as a security control. When the table is full the oldest
 * entry is evicted — which means a determined attacker with many source
 * addresses can push their own record out, and that is the honest trade: the
 * alternative is refusing service to everyone because someone spoofed a
 * thousand peers. On a loopback-bound listener the peer set is tiny.
 */
export const MAX_TRACKED_PEERS = 1_024;

interface PeerRecord {
  /** Failure timestamps inside the window, oldest first. */
  failures: number[];
  /** When the current cooldown ends, or 0 when the peer is not throttled. */
  throttledUntil: number;
  /** Last touch, for eviction. */
  seenAt: number;
}

export interface ThrottleVerdict {
  throttled: boolean;
  /** Whole seconds until the peer may retry. Present only when throttled. */
  retryAfterSeconds?: number;
}

/**
 * A per-peer failed-authentication counter.
 *
 * Holds no token material and no request content — only a peer key, a few
 * timestamps and a count. security-policy.md §"Data minimization" forbids
 * recording raw token material anywhere, and the failure path is precisely
 * where a naive implementation would keep "the token that was tried".
 */
export class AuthFailureThrottle {
  private readonly peers = new Map<string, PeerRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Whether this peer is currently refused. Does NOT count anything.
   *
   * Separate from `recordFailure` so the listener can answer a throttled peer
   * without its refusal itself extending the cooldown — otherwise a client
   * retrying in a loop can never get back in, and the cooldown stops being a
   * cooldown.
   */
  check(peer: string): ThrottleVerdict {
    const record = this.peers.get(peer);
    if (record === undefined) {
      return { throttled: false };
    }
    const now = this.now();
    if (record.throttledUntil > now) {
      return { throttled: true, retryAfterSeconds: Math.ceil((record.throttledUntil - now) / 1000) };
    }
    return { throttled: false };
  }

  /**
   * Record one failed authentication and report the resulting verdict.
   *
   * Called ONLY after an authentication attempt has failed. There is no path
   * from a successful authentication to here, which is what makes "never
   * throttle an authenticated in-flight turn" structural.
   */
  recordFailure(peer: string): ThrottleVerdict {
    const now = this.now();
    const record = this.peers.get(peer) ?? { failures: [], throttledUntil: 0, seenAt: now };
    record.seenAt = now;

    // Drop failures that have aged out. A sliding window, not a fixed bucket:
    // with a fixed bucket a peer can spend the whole allowance at the end of one
    // window and the whole allowance again at the start of the next.
    const cutoff = now - AUTH_FAILURE_WINDOW_MS;
    record.failures = record.failures.filter((at) => at > cutoff);
    record.failures.push(now);

    if (record.failures.length >= AUTH_FAILURE_LIMIT) {
      record.throttledUntil = now + AUTH_THROTTLE_COOLDOWN_MS;
      // Cleared, so the cooldown is served once rather than being re-armed by
      // every subsequent attempt inside the same window.
      record.failures = [];
    }

    this.peers.set(peer, record);
    this.evictIfFull(peer);

    return record.throttledUntil > now
      ? { throttled: true, retryAfterSeconds: Math.ceil((record.throttledUntil - now) / 1000) }
      : { throttled: false };
  }

  /** Peers currently tracked. Exposed so a test can assert the bound holds. */
  size(): number {
    return this.peers.size;
  }

  /**
   * Drop one peer when the table is over its bound.
   *
   * Three rules, and each of the first two was learned by getting it wrong.
   *
   * 1. NEVER the peer that just recorded a failure. It is `justInserted`, it is
   *    excluded, and that exclusion is the whole of this round's fix. Without
   *    it: eviction runs from `recordFailure` right after the insert, so once
   *    every OTHER peer is in cooldown the newcomer is the only unthrottled
   *    candidate and evicts itself on every single failure. Its record is
   *    re-created empty next time and it can never reach the limit. Measured on
   *    the version that did this — 1024 bans in the table, then 1000
   *    consecutive failed authentications from a fresh address, never throttled
   *    once. Saturating the table switched the control off for everyone new,
   *    and 127.0.0.0/8 gives a local attacker 16.7M addresses to saturate it
   *    with. That is strictly worse than the escape it replaced.
   *
   * 2. Prefer a peer NOT serving a cooldown. Otherwise a flood clears the
   *    flooder's own ban: `check` reads `seenAt` and never writes it, so a peer
   *    in cooldown stops being seen the moment it starts being refused, its
   *    `seenAt` freezes, and oldest-first takes it first.
   *
   * 3. When every candidate IS in cooldown, take the ban that expires soonest.
   *    This branch is reachable — it is what runs on a saturated table now that
   *    rule 1 protects the newcomer — and it is the right trade: the table
   *    converges on the bans of peers currently attacking rather than on the
   *    oldest bans, which is the ordering that matters. It is tested.
   */
  private evictIfFull(justInserted: string): void {
    if (this.peers.size <= MAX_TRACKED_PEERS) {
      return;
    }
    const now = this.now();
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    let soonestKey: string | undefined;
    let soonestUntil = Number.POSITIVE_INFINITY;
    for (const [key, record] of this.peers) {
      if (key === justInserted) {
        continue;
      }
      if (record.throttledUntil > now) {
        if (record.throttledUntil < soonestUntil) {
          soonestUntil = record.throttledUntil;
          soonestKey = key;
        }
        continue;
      }
      if (record.seenAt < oldestAt) {
        oldestAt = record.seenAt;
        oldestKey = key;
      }
    }
    const victim = oldestKey ?? soonestKey;
    if (victim !== undefined) {
      this.peers.delete(victim);
    }
  }
}
