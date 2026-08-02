// The failed-authentication throttle (flow 131 / D4, spec AC-11).
//
// The load-bearing property is negative and easy to assert vacuously: an
// authenticated caller is never throttled. So it is asserted through
// `handleServeRequest` with a peer that has ALREADY been throttled, rather than
// by inspecting the throttle in isolation — the throttle passing a unit test
// says nothing about whether the request path consults it in the wrong order.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultServeConfig } from "./serve-config";
import { issueServeToken, readServeCredential, type ServeCredentialRecord } from "./serve-credential";
import { handleServeRequest } from "./serve-server";
import {
  AUTH_FAILURE_LIMIT,
  AUTH_FAILURE_WINDOW_MS,
  AUTH_THROTTLE_COOLDOWN_MS,
  AuthFailureThrottle,
  MAX_TRACKED_PEERS,
} from "./serve-throttle";

let configDir = "";
let token = "";
let credential: ServeCredentialRecord;

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "keryx-throttle-"));
  const issued = issueServeToken(configDir);
  if (!issued.ok) {
    throw new Error("fixture could not issue a token");
  }
  token = issued.token;
  credential = issued.record;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

/** A clock a test drives by hand. Nothing here may depend on wall time. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

describe("AuthFailureThrottle", () => {
  test("a peer is not throttled until it reaches the limit, and is at it", async () => {
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    // One short of the limit: still allowed to try.
    for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i += 1) {
      expect({ i, throttled: throttle.recordFailure("peer").throttled }).toEqual({ i, throttled: false });
    }
    expect(throttle.recordFailure("peer").throttled).toBe(true);
  });

  test("the window slides: failures that age out do not count", async () => {
    // A fixed bucket would let a peer spend the whole allowance at the end of
    // one window and the whole allowance again at the start of the next.
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    for (let i = 0; i < AUTH_FAILURE_LIMIT - 1; i += 1) {
      throttle.recordFailure("peer");
    }
    clock.advance(AUTH_FAILURE_WINDOW_MS + 1);
    // Every earlier failure has aged out, so this is the first one again.
    expect(throttle.recordFailure("peer").throttled).toBe(false);
  });

  test("a throttled peer is released after the cooldown", async () => {
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      throttle.recordFailure("peer");
    }
    expect(throttle.check("peer").throttled).toBe(true);
    clock.advance(AUTH_THROTTLE_COOLDOWN_MS + 1);
    expect(throttle.check("peer").throttled).toBe(false);
  });

  test("checking does not extend the cooldown", async () => {
    // Otherwise a client retrying in a loop can never get back in, and the
    // cooldown stops being a cooldown. `check` is what the request path calls
    // for a peer already serving one.
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      throttle.recordFailure("peer");
    }
    for (let i = 0; i < 50; i += 1) {
      clock.advance(1_000);
      throttle.check("peer");
    }
    // 50 s of hammering later, the original 60 s cooldown is still the one
    // running: 10 s left, not 60.
    const verdict = throttle.check("peer");
    expect(verdict.throttled).toBe(true);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(10);
  });

  test("peers are independent", async () => {
    const throttle = new AuthFailureThrottle(fakeClock().now);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      throttle.recordFailure("noisy");
    }
    expect(throttle.check("noisy").throttled).toBe(true);
    expect(throttle.check("quiet").throttled).toBe(false);
  });

  test("the peer table is bounded, so an unauthenticated caller cannot grow it without limit", async () => {
    // A map an unauthenticated caller can grow is a memory-exhaustion primitive
    // wearing the costume of a security control.
    const throttle = new AuthFailureThrottle(fakeClock().now);
    for (let i = 0; i < MAX_TRACKED_PEERS + 500; i += 1) {
      throttle.recordFailure(`peer-${i}`);
    }
    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
  });

  test("flooding the table does not clear an existing cooldown", async () => {
    // F-011. This test asserted `size() <= MAX_TRACKED_PEERS` — a duplicate of
    // the test above — while its own comment recorded that the flood DID evict
    // the target. The title claimed a property the assertions did not cover, and
    // the property was false: `check` reads `seenAt` and never writes it, so a
    // peer in cooldown stops being seen the moment it starts being refused, and
    // oldest-first eviction took it first. Flooding cleared exactly the cooldown
    // the implementation comment said flooding could not clear.
    //
    // Now eviction skips peers serving a cooldown, and this asserts the title.
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      throttle.recordFailure("target");
    }
    expect(throttle.check("target").throttled).toBe(true);

    for (let i = 0; i < MAX_TRACKED_PEERS + 200; i += 1) {
      clock.advance(1); // each flood peer is seen LATER than `target`
      throttle.recordFailure(`flood-${i}`);
    }

    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
    // The property the title names, asserted: the ban survives the flood.
    expect(throttle.check("target").throttled).toBe(true);
  });

  test("the flood itself is still evicted, so the bound is not held by keeping everything", async () => {
    // The other half. Skipping throttled peers must not turn into skipping
    // eviction: if nothing were evicted the assertion above would pass because
    // the table grew without limit, which is the memory-exhaustion primitive the
    // bound exists to prevent.
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    throttle.recordFailure("target"); // one failure: tracked, NOT throttled

    for (let i = 0; i < MAX_TRACKED_PEERS + 200; i += 1) {
      clock.advance(1);
      throttle.recordFailure(`flood-${i}`);
    }

    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
    // An untracked peer is not throttled, and this one was correctly dropped:
    // it was the oldest and it was not serving a cooldown.
    expect(throttle.check("target").throttled).toBe(false);
  });

  test("saturating the table with cooldowns does NOT disable the throttle for a new peer", async () => {
    // The regression this round introduced and a five-reviewer fix round caught.
    // Eviction preferred an unthrottled victim, and the peer that overflows the
    // table is always the one that just recorded its FIRST failure — so on a
    // saturated table the newcomer evicted itself every time, its record was
    // re-created empty, and it could never reach the limit.
    //
    // Measured on that version: 1024 bans in the table, then 1000 consecutive
    // failed authentications from a fresh address, never throttled once.
    // 127.0.0.0/8 gives a local attacker 16.7M addresses to saturate with, so
    // this was the control switched off globally for everyone new — strictly
    // worse than the escape it replaced.
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    for (let i = 0; i < MAX_TRACKED_PEERS; i += 1) {
      for (let f = 0; f < AUTH_FAILURE_LIMIT; f += 1) {
        throttle.recordFailure(`banned-${i}`);
      }
      clock.advance(1);
    }
    expect(throttle.size()).toBe(MAX_TRACKED_PEERS);

    // A fresh address, arriving after saturation, driven exactly as the route
    // drives it: `check` then `recordFailure`.
    let refused = false;
    for (let f = 0; f < AUTH_FAILURE_LIMIT * 2; f += 1) {
      if (throttle.check("newcomer").throttled) {
        refused = true;
        break;
      }
      throttle.recordFailure("newcomer");
    }

    expect(refused).toBe(true);
    expect(throttle.check("newcomer").throttled).toBe(true);
    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
  });

  test("on a saturated table the ban that expires SOONEST is the one that goes", async () => {
    // The fallback branch, which is reachable now that the newcomer is excluded
    // from candidacy — the previous version recorded it as unreachable and left
    // it untested, which is how it stayed wrong. The trade is deliberate: the
    // table converges on the bans of peers currently attacking rather than on
    // the oldest bans, and the oldest ban is also the one closest to expiring.
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    for (let i = 0; i < MAX_TRACKED_PEERS; i += 1) {
      for (let f = 0; f < AUTH_FAILURE_LIMIT; f += 1) {
        throttle.recordFailure(`banned-${i}`);
      }
      clock.advance(1); // each later peer's cooldown ends later
    }
    expect(throttle.check("banned-0").throttled).toBe(true);

    // One more peer overflows the table. Every other record is in cooldown.
    throttle.recordFailure("newcomer");

    expect(throttle.size()).toBe(MAX_TRACKED_PEERS);
    // The soonest-expiring ban went...
    expect(throttle.check("banned-0").throttled).toBe(false);
    // ...and the newest ban did not.
    expect(throttle.check(`banned-${MAX_TRACKED_PEERS - 1}`).throttled).toBe(true);
    // ...and the newcomer survived, which is the point of rule 1.
    expect(throttle.size()).toBe(MAX_TRACKED_PEERS);
  });

  test("a table saturated with cooldowns is still bounded, and holds real bans", async () => {
    const clock = fakeClock();
    const throttle = new AuthFailureThrottle(clock.now);
    for (let i = 0; i < MAX_TRACKED_PEERS + 50; i += 1) {
      for (let f = 0; f < AUTH_FAILURE_LIMIT; f += 1) {
        throttle.recordFailure(`banned-${i}`);
      }
      clock.advance(1);
    }

    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_PEERS);
    // Not an empty table passing the bound: the most recent ban is held.
    expect(throttle.check(`banned-${MAX_TRACKED_PEERS + 49}`).throttled).toBe(true);
  });
});

describe("the request path consults the throttle in the right order (AC11)", () => {
  function ctx(throttle: AuthFailureThrottle, peer = "10.0.0.9") {
    return {
      config: defaultServeConfig(credential.id, { port: 0 }),
      resolveCredential: () => readServeCredential(configDir),
      nonLoopback: false,
      boundPort: 12345,
      dir: configDir,
      state: () => "listening" as const,
      peer,
      throttle,
    };
  }

  test("a wrong token is 401 until the limit, then 429 with a Retry-After", async () => {
    const throttle = new AuthFailureThrottle(fakeClock().now);
    const wrong = new Request("http://127.0.0.1/v1/status", {
      headers: { authorization: "Bearer not-the-token" },
    });

    const codes: number[] = [];
    for (let i = 0; i < AUTH_FAILURE_LIMIT + 1; i += 1) {
      codes.push((await handleServeRequest(wrong.clone(), ctx(throttle))).status);
    }
    expect(codes.slice(0, AUTH_FAILURE_LIMIT - 1)).toEqual(Array(AUTH_FAILURE_LIMIT - 1).fill(401));
    expect(codes.at(-1)).toBe(429);

    const throttled = await handleServeRequest(wrong.clone(), ctx(throttle));
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("a VALID token is served even while that peer is throttled", async () => {
    // The requirement, and the reason the throttle is consulted only on the
    // failure path. An operator whose address has been used for guessing must
    // not be locked out of their own server by the attacker's failures.
    const throttle = new AuthFailureThrottle(fakeClock().now);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      throttle.recordFailure("10.0.0.9");
    }
    expect(throttle.check("10.0.0.9").throttled).toBe(true);

    const good = new Request("http://127.0.0.1/v1/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    const response = await handleServeRequest(good, ctx(throttle));
    expect(response.status).toBe(200);
  });

  test("a successful authentication records no failure", async () => {
    // The other half: a valid request must not creep the counter toward a ban.
    const throttle = new AuthFailureThrottle(fakeClock().now);
    for (let i = 0; i < 200; i += 1) {
      const good = new Request("http://127.0.0.1/v1/status", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect((await handleServeRequest(good, ctx(throttle))).status).toBe(200);
    }
    expect(throttle.size()).toBe(0);
  });

  test("a context without a throttle is unthrottled, not crashed", async () => {
    // Every pre-existing synthetic context in the suite omits both fields.
    const wrong = new Request("http://127.0.0.1/v1/status", {
      headers: { authorization: "Bearer nope" },
    });
    const bare = {
      config: defaultServeConfig(credential.id, { port: 0 }),
      resolveCredential: () => readServeCredential(configDir),
      nonLoopback: false,
      boundPort: 12345,
      dir: configDir,
      state: () => "listening" as const,
    };
    for (let i = 0; i < AUTH_FAILURE_LIMIT + 5; i += 1) {
      expect((await handleServeRequest(wrong.clone(), bare)).status).toBe(401);
    }
  });

  test("the 429 body reveals nothing a 401 does not", async () => {
    // A throttle is a rate signal, not an oracle. It must not become the one
    // response that distinguishes a known path from an unknown one, or a
    // malformed token from a wrong one.
    const throttle = new AuthFailureThrottle(fakeClock().now);
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      throttle.recordFailure("10.0.0.9");
    }
    const paths = ["/v1/status", "/v1/nothing-here", "/"];
    const bodies: number[] = [];
    for (const p of paths) {
      const response = await handleServeRequest(
        new Request(`http://127.0.0.1${p}`, { headers: { authorization: "Bearer x" } }),
        ctx(throttle),
      );
      bodies.push(response.status);
    }
    // Identical on every path, exactly as the fixed 401 is.
    expect(bodies).toEqual([429, 429, 429]);
  });
});
