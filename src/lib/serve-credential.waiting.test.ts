// The "waiting for the serve credential lock…" message is actually emitted.
//
// A review of PR #216 executed the contended path and recorded the transcript:
// `issue` blocked for 10 seconds and wrote nothing to stdout or stderr. The
// message existed as a `waitingMessage` string handed to `withFileLock`, which
// only emits through `options.onWaiting` — and `withServeCredentialLock` passed
// no `onWaiting`. The registry sibling passes a real callback; this one named a
// control that no code performed, which is the exact shape the flow-127 lesson
// file warns about.
//
// The operator-visible consequence: a crashed `keryx serve token issue` leaves a
// lock, the next run is silent for up to 15 seconds, it looks hung, the operator
// interrupts and retries — which is precisely the situation the message exists
// to explain.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOCK_STALE_MS } from "./file-lock";
import { issueServeToken, revokeServeToken, rotateServeToken, serveCredentialPath } from "./serve-credential";

let base = "";
let configDir = "";

/**
 * Plant a foreign lock that goes stale shortly AFTER the one-second
 * announcement threshold.
 *
 * The two timings are what make this both meaningful and fast: `withFileLock`
 * announces once the wait passes 1s, and breaks a lock older than
 * `LOCK_STALE_MS`. Ageing the lock to `LOCK_STALE_MS - 1500` puts the break at
 * roughly t+1.5s, so the announcement fires at t+1s with half a second of
 * margin and the call still completes in about a second and a half rather than
 * waiting out the full stale window.
 */
function plantContendedLock(): void {
  const lockPath = `${serveCredentialPath(configDir)}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  writeFileSync(lockPath, "some-other-holder", { mode: 0o600 });
  const aged = (Date.now() - (LOCK_STALE_MS - 1_500)) / 1_000;
  utimesSync(lockPath, aged, aged);
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-cred-waiting-"));
  configDir = path.join(base, "keryx");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("a contended credential lock says so", () => {
  test("issue reports the wait, and still succeeds", () => {
    const seen: string[] = [];
    plantContendedLock();

    const outcome = issueServeToken(configDir, undefined, (message) => seen.push(message));

    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(["waiting for the serve credential lock…"]);
  }, 30_000);

  test("rotate reports the wait", () => {
    const seen: string[] = [];
    expect(issueServeToken(configDir).ok).toBe(true);
    plantContendedLock();

    const outcome = rotateServeToken(configDir, undefined, (message) => seen.push(message));

    expect(outcome.ok).toBe(true);
    expect(seen).toEqual(["waiting for the serve credential lock…"]);
  }, 30_000);

  test("revoke reports the wait", () => {
    const seen: string[] = [];
    expect(issueServeToken(configDir).ok).toBe(true);
    plantContendedLock();

    const outcome = revokeServeToken(configDir, (message) => seen.push(message));

    expect(outcome).toBe("revoked");
    expect(seen).toEqual(["waiting for the serve credential lock…"]);
  }, 30_000);

  test("an UNCONTENDED call says nothing", () => {
    // Without this the assertions above would also pass against a callback
    // fired unconditionally, which would train the operator to ignore it.
    const seen: string[] = [];

    expect(issueServeToken(configDir, undefined, (message) => seen.push(message)).ok).toBe(true);

    expect(seen).toEqual([]);
  });
});
