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
    this.evictIfFull();

    return record.throttledUntil > now
      ? { throttled: true, retryAfterSeconds: Math.ceil((record.throttledUntil - now) / 1000) }
      : { throttled: false };
  }

  /** Peers currently tracked. Exposed so a test can assert the bound holds. */
  size(): number {
    return this.peers.size;
  }

  private evictIfFull(): void {
    if (this.peers.size <= MAX_TRACKED_PEERS) {
      return;
    }
    // Oldest-seen first. Throttled peers are NOT preferred for eviction, which
    // would let an attacker clear their own cooldown by flooding the table.
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, record] of this.peers) {
      if (record.seenAt < oldestAt) {
        oldestAt = record.seenAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) {
      this.peers.delete(oldestKey);
    }
  }
}
