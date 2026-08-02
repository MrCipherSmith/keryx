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
 * primitive dressed as a security control. So the table is bounded, and
 * something has to go when it is full — see `evictIfFull` for WHICH, because it
 * is no longer "the oldest entry" and this sentence used to say that a round
 * after it stopped being true.
 *
 * The honest trade is unchanged: a determined attacker with many source
 * addresses can still push records out, and the alternative is refusing service
 * to everyone because someone spoofed a thousand peers. What the eviction order
 * decides is WHOSE record that is, and the order exists to make it never the
 * record of whoever is currently attacking. On a loopback-bound listener the
 * peer set is tiny.
 */
export const MAX_TRACKED_PEERS = 1_024;

/**
 * What a cooldown record is worth, against `liveFailures / AUTH_FAILURE_LIMIT`.
 *
 * Just under halfway, and DERIVED rather than chosen. See `evictIfFull` rule 2
 * for why the two properties this control needs cannot both hold under a strict
 * "bans first" or "peers first" order, and why the crossover is where they meet.
 *
 * The `- 0.5` is what makes the crossover exact. A live failure count is an
 * integer, so the peer scale only ever takes values `k / AUTH_FAILURE_LIMIT`;
 * placing the ban strictly BETWEEN two of them means no peer can ever tie it.
 * At a flat `0.5` a peer at exactly 5 of 10 tied, lost the tie-break — which
 * compares a ban's future expiry against a peer's past `seenAt`, so the peer
 * always loses it — and was evicted, letting an attacker interleaving five
 * guesses per throw-away address run UNBOUNDED guesses unrefused. The docstring
 * said "a peer more than halfway is not cheaper to lose" and was off by one at
 * exactly halfway, with nothing testing the boundary.
 *
 * Re-measured: the attacker is never refused at all in that configuration, and
 * the probe stops at whatever bound its loop was given. This comment used to
 * quote "1500", which was 300 rounds x 5 — the loop cap, reported as a result,
 * and inherited verbatim from a review report into a commit that opened by
 * insisting every number had been re-derived. The figure also UNDERSTATED the
 * defect it described.
 *
 * Read it as the rule it now is: HALF THE LIMIT OR MORE outranks a cooldown.
 *
 * WHAT THE CROSSOVER STILL COSTS, measured while re-deriving the figures above
 * rather than found by a review, because any threshold has a region below it:
 *
 *   per-round guesses 5..9   refused after 10, from one address
 *   per-round guesses 4      never refused — 4000 and counting from one address
 *
 * A peer at 4 live failures is worth 0.4, below the ban, so it is the cheapest
 * record and is evicted before any cooldown. That band cannot be removed by
 * moving the constant; it can only be moved, and wherever it sits the same
 * thing is true below it.
 *
 * The reason it is not worth removing: at 4 guesses per throw-away request the
 * attacker buys 4 guesses per extra address, and the per-peer allowance already
 * gives them AUTH_FAILURE_LIMIT - 1 = 9 guesses per address for free, with no
 * decoys and no eviction. 1023 fresh addresses are 9207 guesses per window at
 * zero cost. The escape is strictly worse than the baseline it competes with,
 * and the bearer token is 32 CSPRNG bytes either way.
 */
export const BAN_VALUE = (Math.floor(AUTH_FAILURE_LIMIT / 2) - 0.5) / AUTH_FAILURE_LIMIT;

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
   * Two rules, and both were learned by getting them wrong. There were three
   * until a round folded the old rule 3 into the tie-break and left this line
   * saying three — which is the same class of stale count this module has now
   * produced twice.
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
   * 2. Otherwise the record with the least VALUE, on one scale:
   *
   *      an unthrottled peer   liveFailures / AUTH_FAILURE_LIMIT   (0 .. <1)
   *      a peer in cooldown    BAN_VALUE = 0.45                    (derived)
   *
   *    So a peer at HALF THE LIMIT OR MORE outranks a cooldown, and one below
   *    it does not.
   *
   *    This table said `0.5` and closed with "a peer more than halfway is not
   *    cheaper to lose" — which is verbatim the sentence this file quotes 120
   *    lines above as the defect it fixed. The constant was corrected in its own
   *    docstring and the rule that explains it was not, so the file shipped the
   *    fix, documented the fix, and restated the defect as its rule.
   *
   *    There is no separate "prefer a peer not in cooldown" step, and an earlier
   *    version of this comment described one after the code had stopped having
   *    it. The scale subsumes it, and NOT absolutely: a fresh peer at 0 or 1
   *    failures loses to a ban, which is what stops a flood clearing the
   *    flooder's own ban — `check` reads `seenAt` and never writes it, so a peer
   *    in cooldown stops being seen the moment it starts being refused, its
   *    `seenAt` freezes, and any oldest-first rule takes it first. A peer at 9
   *    of 10 does not lose to a ban, which is the other half.
   *
   * One scale rather than a priority order, and that is forced rather than
   * chosen. The two properties this control needs are in direct conflict on a
   * full table, and no strict ordering satisfies both:
   *
   *   a flood of fresh peers must not clear an existing ban — so a ban has to
   *   outrank a one-failure record;
   *
   *   a saturated table of bans must not evict the peer at 9 of 10 — so an
   *   accumulation near the limit has to outrank a ban.
   *
   * Both were learned by measurement. Preferring unthrottled records outright
   * left an attacker unthrottled through 450 consecutive guesses, one throw-away
   * address per nine — 50 rounds of 9, which is what the probe in the test file
   * actually runs. It was reported as 1800 for two rounds because the figure was
   * restated rather than re-derived. Preferring bans outright let a flood clear the
   * flooder's own ban, which is the escape the rule above it exists for. The
   * scale is where those two meet: halfway to a ban is the point at which an
   * accumulation becomes worth more than an enforced refusal that is already
   * counting down.
   *
   * Ties break on one field read two ways — `throttledUntil` for a ban, `seenAt`
   * otherwise, lowest first. For two bans that is the soonest to expire, which
   * under a constant cooldown is the same record as the oldest ban; it is one
   * criterion, not two, and the version of this sentence that offered both as
   * alternatives was describing a distinction that cannot arise here. The
   * newcomer is never a candidate — see rule 1.
   *
   * WHAT THIS DOES NOT PROVIDE, stated because the previous version of this
   * sentence claimed the opposite and was the round's blocker:
   *
   *   > "What they cannot do is push out the record of the address they are
   *   > currently guessing from."
   *
   * They can. Any bounded table can be defeated by an attacker willing to keep
   * it full of whatever the eviction order protects; that is inherent to
   * bounding it, and bounding it is not optional because an unbounded map an
   * unauthenticated caller can grow is a memory-exhaustion primitive. What the
   * order decides is the PRICE, and the three known routes now cost:
   *
   *   pin with decoys at half the limit   1023 x 5 / 60s = 85.3 req/s,
   *                                       sustained, because every decoy must be
   *                                       refreshed inside the window to keep
   *                                       counting. Before the prune this was a
   *                                       one-time 6138 requests and then free.
   *                                       It clears ANY cooldown in the table,
   *                                       including one with the full 60s left.
   *   saturate with active cooldowns      1023 x 10 / 60s = 170.5 req/s,
   *                                       sustained. Strictly more expensive
   *                                       than the row above and buys the same
   *                                       thing.
   *   flood with fresh peers              nothing: they are the cheapest records
   *                                       in the table and evict each other.
   *   stay below the crossover            unbounded guesses from ONE address at
   *                                       4 per throw-away request. See the note
   *                                       on `BAN_VALUE`.
   *
   * The second row previously read "buys only the early expiry of a cooldown
   * that was about to lapse". That is false and was measured false: once every
   * other record is worth more than `BAN_VALUE`, any cooldown is the unique
   * minimum, the soonest-expiring tie-break never runs, and remaining time stops
   * mattering. Verified directly — a victim at `{"throttled":true,
   * "retryAfterSeconds":60}` before, `{"throttled":false}` after.
   *
   * WHAT NONE OF THEM BUY. The throttle is per-peer and the limit is 10, so an
   * attacker with 1023 source addresses already has 9 guesses from each — 9207
   * per window, free, no decoys, no eviction. Every route above costs traffic to
   * obtain a worse rate. What they defeat is the module's claim, not the token.
   *
   * And the honest ceiling on all of it: the bearer token is 32 CSPRNG bytes
   * (`serve-credential.ts`), so none of these makes guessing it feasible. This
   * control exists to make repeated failure expensive and visible, not to be the
   * thing standing between an attacker and the token.
   */
  private evictIfFull(justInserted: string): void {
    if (this.peers.size <= MAX_TRACKED_PEERS) {
      return;
    }
    const now = this.now();
    const cutoff = now - AUTH_FAILURE_WINDOW_MS;
    /**
     * Failures still inside the window, counted NOW.
     *
     * THE fix. `recordFailure` prunes only the peer it is recording, so a record
     * nobody has touched keeps every timestamp it ever had. The previous version
     * read `failures.length` raw, so a record parked at six failures an hour ago
     * scored 0.6 forever and outranked every active cooldown in the table. An
     * attacker filled 1023 slots with such decoys ONCE — about 6100 requests —
     * and from then on their own ban was the cheapest record in the table and
     * one throw-away request evicted it. Measured: 500 consecutive guesses, zero
     * refusals, against a control of 10 guesses and 490 refusals. The control
     * was not weakened, it was off.
     *
     * Pruning here does not make the table attack-proof and the sentence at the
     * end of this docstring no longer says it does. What it does is take the
     * cost of pinning the table from a one-time 6100 requests to a sustained
     * ~85 requests per second, forever, because every decoy must now be
     * refreshed inside the window to keep counting.
     */
    const liveFailures = (record: PeerRecord): number =>
      record.failures.reduce((n, at) => (at > cutoff ? n + 1 : n), 0);
    /** A record's worth, on the one scale rule 2 describes. */
    const valueOf = (record: PeerRecord): number =>
      record.throttledUntil > now ? BAN_VALUE : liveFailures(record) / AUTH_FAILURE_LIMIT;

    let victim: string | undefined;
    let lowest = Number.POSITIVE_INFINITY;
    let tieBreak = Number.POSITIVE_INFINITY;
    for (const [key, record] of this.peers) {
      if (key === justInserted) {
        continue;
      }
      const value = valueOf(record);
      // Soonest-expiring for a ban, oldest-seen for a peer: the least useful
      // member of whichever group the tie is in.
      const within = record.throttledUntil > now ? record.throttledUntil : record.seenAt;
      if (value < lowest || (value === lowest && within < tieBreak)) {
        lowest = value;
        tieBreak = within;
        victim = key;
      }
    }
    if (victim !== undefined) {
      this.peers.delete(victim);
    }
  }
}
