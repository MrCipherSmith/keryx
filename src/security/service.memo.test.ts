// The per-instance memo under `createSecurityService`.
//
// It exists for a measured reason: `redact` used to reload the security config
// and the HMAC key on every call, which is invisible while every caller
// constructs a service per call and is not once `keryx serve` gave it a loop —
// 80µs of the 121µs each `assistant.delta` cost, ten thousand times a turn.
//
// The first version was `once ??= load()`, which caches the PROMISE. A promise
// that rejects is still a value, so one transient filesystem fault poisoned the
// instance for the rest of the turn while an uncached caller would simply have
// read the file again. These tests are the difference between those two.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keyDir } from "./redact";
import { createSecurityService, memoizeResolved } from "./service";

describe("memoizeResolved", () => {
  test("a resolved value is loaded once and reused", () => {
    // The reason the memo exists at all. Without this the fix below could be
    // "call load() every time", which passes every other test here.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      return "config";
    });

    return Promise.all([memo(), memo(), memo()]).then(async (values) => {
      expect(values).toEqual(["config", "config", "config"]);
      expect(await memo()).toBe("config");
      expect(calls).toBe(1);
    });
  });

  test("a rejection is NOT remembered — the next call retries and can succeed", async () => {
    // THE finding. One `EINTR` reading the HMAC key used to cost a 10,000-event
    // turn its entire redaction.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("EINTR");
      }
      return "key";
    });

    await expect(memo()).rejects.toThrow("EINTR");
    // Not the cached rejection — a real second attempt, which succeeds.
    expect(await memo()).toBe("key");
    expect(calls).toBe(2);

    // And the success is now the memoised value, so the retry did not turn the
    // memo into a pass-through.
    expect(await memo()).toBe("key");
    expect(calls).toBe(2);
  });

  test("callers already awaiting a failing load all see that failure", async () => {
    // Correct rather than unfortunate: they asked at the same time, so they get
    // the same answer. What must not happen is the call AFTER them inheriting it.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient");
      }
      return "value";
    });

    const settled = await Promise.allSettled([memo(), memo(), memo()]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(calls).toBe(1);

    expect(await memo()).toBe("value");
    expect(calls).toBe(2);
  });

  test("a load that keeps failing keeps being attempted", async () => {
    // The other direction. A permanent fault must not be silently swallowed into
    // one report and then forgotten.
    let calls = 0;
    const memo = memoizeResolved(async () => {
      calls += 1;
      throw new Error("EACCES");
    });

    for (let i = 0; i < 3; i++) {
      await expect(memo()).rejects.toThrow("EACCES");
    }
    expect(calls).toBe(3);
  });
});

describe("the service actually uses it", () => {
  // The memo is exhaustively tested above and nothing pinned that
  // `createSecurityService` calls it. Replacing both wrappers with bare thunks
  // left `src/security/` at 78 pass, and the 80µs-per-event regression the memo
  // exists to prevent came back silently — a helper with four honest tests and
  // no caller under assertion.
  //
  // Observed through BEHAVIOUR, not through the filesystem. The first version of
  // this test counted config reads by `atime` and its own control caught that as
  // unsound: a fresh service re-read the file and the atime did not move, because
  // this mount does not update it per read. A control that fails is the control
  // working — the measurement was wrong, not the claim.
  //
  // What is observable without ambiguity: the config decides whether a `pii`
  // FINDING is reported. Change the file between two calls on ONE service and
  // the memo is the difference between the old finding list and the new one.
  // `enabled` rather than `action`, and that is not arbitrary: `enabled` gates
  // whether `detectPii` runs at all inside `resolveDecision` (detect/index.ts),
  // so disabling the policy makes the finding disappear outright, where the
  // `action` a finding is built with never does — every action still produces
  // a finding. The first version of this test used the action and its control
  // failed, which is the control working.
  //
  // `redacted` itself is NOT that observable any more. The mandatory
  // deterministic output floor (T19/T22, `validateSerializedOutput` inside
  // `redact()`) runs its own independent `detectPii` over the content and masks
  // recognized PII regardless of `pii.enabled` — the whole point of the floor
  // is that an advisory policy can never bring back a raw secret or PII span.
  // An earlier version of this test asserted a FRESH service (policy off)
  // returned the email raw; that stopped being true the moment the floor
  // started masking unconditionally, and reinstating it would assert the
  // opposite of what the floor guarantees. So this test proves memoization
  // through the findings array — the config-dependent signal the floor does
  // not touch — while still checking `redacted` stays masked on every call,
  // memoised config or not.
  //
  // (That `pii: { action: "allow" }` still redacts is a separate question about
  // the resolver, not about this memo. Noted rather than chased here.)
  const PII = "reach me at nobody@example.com";

  function writeConfig(dir: string, piiEnabled: boolean): void {
    writeFileSync(
      path.join(dir, ".metaproject", "security.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        mode: "advisory",
        rawRetention: "off",
        gate: { failOn: "critical", minConfidence: 0.5 },
        policies: {
          secrets: { action: "block" },
          pii: { action: "redact", enabled: piiEnabled },
          promptInjection: { action: "warn" },
          egress: { action: "warn" },
          artifactSafety: { action: "warn" },
        },
      }),
      "utf8",
    );
  }

  test("one service keeps the config it loaded; a fresh one picks up the change", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-memo-use-"));
    try {
      mkdirSync(path.join(dir, ".metaproject"), { recursive: true });
      writeConfig(dir, true);

      const service = createSecurityService(dir);
      const first = await service.redact(PII, { source: "generated" });
      expect(first.redacted).not.toContain("nobody@example.com");
      expect(first.findings.some((f) => f.category === "pii")).toBe(true);

      // The policy is now off. A service that reloaded per call would stop
      // reporting a pii finding here; a memoised one still reports it, because
      // it is still working off the config it loaded on construction. The
      // mandatory floor keeps masking the email either way — that half of the
      // assertion is not the memoization signal, the finding is.
      writeConfig(dir, false);
      const second = await service.redact(PII, { source: "generated" });
      expect(second.redacted).not.toContain("nobody@example.com");
      expect(second.findings.some((f) => f.category === "pii")).toBe(true);

      // The control, and the reason the assertions above are about the memo
      // rather than about the config change being ineffective: a FRESH service
      // reads the new file, its PII detector never runs, and it reports NO pii
      // finding. `redacted` still contains no raw email on this call too — the
      // floor does not care which service, or which config, produced the text.
      const fresh = await createSecurityService(dir).redact(PII, { source: "generated" });
      expect(fresh.redacted).not.toContain("nobody@example.com");
      expect(fresh.findings.some((f) => f.category === "pii")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the service uses it for the HMAC key too — the other caller", () => {
  // `createSecurityService` memoises TWO loads. The test above pins `configFor`;
  // `hashOnce` was left unpinned, and replacing it with a bare thunk left
  // `src/security/` green. That is the load this whole file's opening docstring
  // is about — "one `EINTR` reading the HMAC key used to cost a 10,000-event
  // turn its entire redaction" — so the half that was covered was the half the
  // file is not about.
  //
  // Observable: a finding carries `hash`, computed with the key. Change the key
  // file between two calls on ONE service and a memoised load keeps the old
  // key, an unmemoised one picks up the new one.
  const PII = "mail me at nobody@example.com";

  function project(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-memo-hmac-"));
    mkdirSync(path.join(dir, ".metaproject"), { recursive: true });
    writeFileSync(
      path.join(dir, ".metaproject", "security.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        mode: "advisory",
        rawRetention: "off",
        gate: { failOn: "critical", minConfidence: 0.5 },
        policies: {
          secrets: { action: "block" },
          pii: { action: "redact", enabled: true },
          promptInjection: { action: "warn" },
          egress: { action: "warn" },
          artifactSafety: { action: "warn" },
        },
      }),
      "utf8",
    );
    return dir;
  }

  /**
   * Overwrite the HMAC key, at the path its OWNER computes.
   *
   * `keyDir` rather than a guessed path: the first version of this helper
   * guessed two locations, found neither, and the assertion that the key file
   * had been replaced is what caught it. A test that quietly fails to change
   * the thing it is measuring proves nothing about the memo.
   */
  function replaceKey(dir: string, value: string): boolean {
    const file = path.join(keyDir(dir), "hmac.key");
    if (!existsSync(file)) {
      return false;
    }
    writeFileSync(file, `${value}\n`, "utf8");
    return true;
  }

  test("one service keeps the key it loaded; a fresh one picks up the change", async () => {
    const dir = project();
    try {
      const service = createSecurityService(dir);
      const first = await service.redact(PII, { source: "generated" });
      const firstHash = first.findings[0]?.hash;
      expect(typeof firstHash).toBe("string");

      // The key file exists now, because `getHmacKey` creates it on first use.
      const replaced = replaceKey(dir, "f".repeat(64));
      expect({ keyFileFound: replaced }).toEqual({ keyFileFound: true });

      const second = await service.redact(PII, { source: "generated" });
      expect({ sameService: second.findings[0]?.hash === firstHash }).toEqual({
        sameService: true,
      });

      // The control, and the reason the assertion above is about the memo: a
      // FRESH service reads the new key and hashes differently.
      const fresh = await createSecurityService(dir).redact(PII, { source: "generated" });
      expect({ freshService: fresh.findings[0]?.hash === firstHash }).toEqual({
        freshService: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
