// RED tests for flow 142 / AC1-AC2 and AC7.
//
// The implementation is intentionally absent in this phase. These tests pin
// the dependency-free service boundary: callers inject fetch, time, and the
// user-global cache directory, so this suite never reaches the network or the
// developer's real configuration directory.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FAILURE_BACKOFF_MS,
  FIXED_INSTALL_COMMAND,
  REGISTRY_URL,
  REQUEST_TIMEOUT_MS,
  RESPONSE_BODY_LIMIT_BYTES,
  SUCCESS_CACHE_TTL_MS,
  VERSION_STRING_LIMIT_CHARS,
  checkVersion,
  type VersionCheckResult,
  type VersionFetch,
} from "./version-check";

const EXPECTED_VERSION_STRING_LIMIT_CHARS = 64;
const cacheDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cacheDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newCacheDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-version-check-"));
  cacheDirs.push(dir);
  return dir;
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function registryResponse(version: string, extra: Record<string, unknown> = {}): Response {
  return response(JSON.stringify({ name: "@mrciphersmith/keryx", version, ...extra }));
}

function numericVersionWithLength(length: number, digit: "8" | "9" = "9"): string {
  return `${digit.repeat(length - ".0.0".length)}.0.0`;
}

type FetchCall = { url: string; signal: AbortSignal | null | undefined };

function stubFetch(
  result: Response | Error,
  calls: FetchCall[],
): VersionFetch {
  return async (input, init) => {
    calls.push({ url: String(input), signal: init?.signal });
    if (result instanceof Error) throw result;
    return result.clone();
  };
}

async function check(
  currentVersion: string,
  fetchImpl: VersionFetch,
  cacheDir: string,
  now: () => number,
): Promise<VersionCheckResult> {
  return checkVersion({ currentVersion, fetch: fetchImpl, cacheDir, now });
}

describe("version-check service contract", () => {
  test("pins the registry endpoint, bounds, cache policy, and install command", () => {
    expect(REGISTRY_URL).toBe("https://registry.npmjs.org/@mrciphersmith%2Fkeryx/latest");
    expect(FIXED_INSTALL_COMMAND).toBe("npm install -g @mrciphersmith/keryx@latest");
    expect(RESPONSE_BODY_LIMIT_BYTES).toBe(64 * 1024);
    expect(REQUEST_TIMEOUT_MS).toBe(2_000);
    expect(SUCCESS_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1_000);
    expect(FAILURE_BACKOFF_MS).toBe(15 * 60 * 1_000);
    expect(VERSION_STRING_LIMIT_CHARS).toBe(EXPECTED_VERSION_STRING_LIMIT_CHARS);
  });

  test.each([
    ["1.0.0", "1.0.1", "update-available"],
    ["1.0.0", "2.0.0", "update-available"],
    ["1.0.0-alpha", "1.0.0", "update-available"],
    ["1.0.0+build.1", "1.0.0+build.2", "up-to-date"],
    ["2.0.0", "1.9.9", "up-to-date"],
  ] as const)("uses strict SemVer 2.0 precedence for %s -> %s", async (current, latest, status) => {
    const cacheDir = await newCacheDir();
    const result = await check(
      current,
      stubFetch(registryResponse(latest), []),
      cacheDir,
      () => 1_000,
    );

    expect(result.status).toBe(status);
    if (status === "update-available") {
      expect(result).toMatchObject({ currentVersion: current, latestVersion: latest, installCommand: FIXED_INSTALL_COMMAND });
    } else {
      expect(result).toMatchObject({ currentVersion: current, latestVersion: latest });
      expect(result).not.toHaveProperty("installCommand");
    }
  });

  test.each([
    ["01.2.3", "1.2.4"],
    ["1.2", "1.2.4"],
    ["1.2.3-", "1.2.4"],
    ["1.2.3", "1.2.03"],
    ["1.2.3", "not-semver"],
  ])("rejects non-strict SemVer versions (%s / %s)", async (current, latest) => {
    const cacheDir = await newCacheDir();
    const calls: FetchCall[] = [];
    const result = await check(current, stubFetch(registryResponse(latest), calls), cacheDir, () => 1_000);

    expect(result.status).toBe("unavailable");
  });

  test("accepts large numeric identifiers within the display bound without number coercion", async () => {
    const cacheDir = await newCacheDir();
    const huge = "999999999999999999999999999999.0.0";
    const result = await check("1.0.0", stubFetch(registryResponse(huge), []), cacheDir, () => 1_000);

    expect(result).toMatchObject({ status: "update-available", latestVersion: huge });
  });

  test("accepts current and registry versions exactly at the display-safe boundary", async () => {
    const cacheDir = await newCacheDir();
    const current = numericVersionWithLength(VERSION_STRING_LIMIT_CHARS, "8");
    const latest = numericVersionWithLength(VERSION_STRING_LIMIT_CHARS, "9");
    let fetchCount = 0;
    const fetchImpl: VersionFetch = async () => {
      fetchCount += 1;
      return registryResponse(latest);
    };

    const result = await check(current, fetchImpl, cacheDir, () => 1_000);
    const cached = await check(current, fetchImpl, cacheDir, () => 1_001);

    expect(current).toHaveLength(EXPECTED_VERSION_STRING_LIMIT_CHARS);
    expect(latest).toHaveLength(EXPECTED_VERSION_STRING_LIMIT_CHARS);
    expect(result).toMatchObject({
      status: "update-available",
      currentVersion: current,
      latestVersion: latest,
      source: "registry",
    });
    expect(cached).toMatchObject({
      status: "update-available",
      currentVersion: current,
      latestVersion: latest,
      source: "cache",
    });
    expect(fetchCount).toBe(1);
  });

  test("rejects an oversized current version before fetching", async () => {
    const cacheDir = await newCacheDir();
    const calls: FetchCall[] = [];
    const oversizedCurrent = numericVersionWithLength(VERSION_STRING_LIMIT_CHARS + 1);

    const result = await check(
      oversizedCurrent,
      stubFetch(registryResponse("1.0.1"), calls),
      cacheDir,
      () => 1_000,
    );

    expect(result).toMatchObject({
      status: "unavailable",
      currentVersion: oversizedCurrent,
      reason: "invalid-current-version",
    });
    expect(calls).toHaveLength(0);
  });

  test("rejects an oversized registry version without caching or recommending it", async () => {
    const cacheDir = await newCacheDir();
    const oversizedLatest = numericVersionWithLength(VERSION_STRING_LIMIT_CHARS + 1);

    const result = await check(
      "1.0.0",
      stubFetch(registryResponse(oversizedLatest), []),
      cacheDir,
      () => 1_000,
    );

    expect(result).toMatchObject({ status: "unavailable", reason: "invalid-latest-version" });
    expect(result).not.toHaveProperty("latestVersion");
    expect(result).not.toHaveProperty("installCommand");
    const persisted = JSON.parse(
      await readFile(path.join(cacheDir, "version-check.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("latestVersion");
  });

  test.each([
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta", "1.0.0-beta.2"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-beta.11", "1.0.0-rc.1"],
    ["1.0.0-rc.1", "1.0.0"],
  ])("implements the SemVer 2.0 prerelease precedence chain (%s < %s)", async (current, latest) => {
    const cacheDir = await newCacheDir();
    const result = await check(current, stubFetch(registryResponse(latest), []), cacheDir, () => 1_000);
    expect(result.status).toBe("update-available");
  });

  test("returns typed unavailable for HTTP, malformed JSON, wrong shape, and offline failures", async () => {
    const failures: Array<Response | Error> = [
      response("server error", 503),
      response("not json"),
      response(JSON.stringify({ name: "wrong-package", version: "1.2.3" })),
      new Error("network is offline"),
    ];

    for (const failure of failures) {
      const cacheDir = await newCacheDir();
      const result = await check("1.0.0", stubFetch(failure, []), cacheDir, () => 1_000);
      expect(result.status).toBe("unavailable");
      expect(result).toHaveProperty("currentVersion", "1.0.0");
    }
  });

  test("always calls the fixed endpoint and never an operator-configured registry", async () => {
    const cacheDir = await newCacheDir();
    const calls: FetchCall[] = [];
    await check("1.0.0", stubFetch(registryResponse("1.0.1"), calls), cacheDir, () => 1_000);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(REGISTRY_URL);
  });

  test("rejects a response body over 64 KiB before trusting its version", async () => {
    const cacheDir = await newCacheDir();
    const oversized = JSON.stringify({ version: "9.9.9", padding: "x".repeat(RESPONSE_BODY_LIMIT_BYTES) });
    const result = await check("1.0.0", stubFetch(response(oversized), []), cacheDir, () => 1_000);

    expect(result.status).toBe("unavailable");
  });

  test("cancels a declared oversized body and treats cancellation errors as unavailable", async () => {
    const cacheDir = await newCacheDir();
    let cancelAttempted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelAttempted = true;
        throw new Error("transport cancellation failed");
      },
    });
    const oversized = new Response(body, {
      headers: { "content-length": String(RESPONSE_BODY_LIMIT_BYTES + 1) },
    });

    const result = await check("1.0.0", async () => oversized, cacheDir, () => 1_000);

    expect(result).toMatchObject({ status: "unavailable", reason: "response-too-large" });
    expect(cancelAttempted).toBe(true);
  });

  test("does not wait for an oversized body's cancellation to settle", async () => {
    const cacheDir = await newCacheDir();
    let cancelAttempted = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelAttempted = true;
        return new Promise<void>(() => {});
      },
    });
    const oversized = new Response(body, {
      headers: { "content-length": String(RESPONSE_BODY_LIMIT_BYTES + 1) },
    });

    const result = await check("1.0.0", async () => oversized, cacheDir, () => 1_000);

    expect(result).toMatchObject({ status: "unavailable", reason: "response-too-large" });
    expect(cancelAttempted).toBe(true);
  }, 500);

  test("aborts a request through the deterministic timer seam at the fixed timeout", async () => {
    const cacheDir = await newCacheDir();
    let observedSignal: AbortSignal | null | undefined;
    let scheduledMs: number | undefined;
    let fireTimeout: (() => void) | undefined;
    let cancelled = false;
    const fetchImpl: VersionFetch = async (_input, init) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    };

    const pending = checkVersion({
      currentVersion: "1.0.0",
      fetch: fetchImpl,
      cacheDir,
      now: () => 1_000,
      timer: {
        schedule(callback, delayMs) {
          fireTimeout = callback;
          scheduledMs = delayMs;
          return Symbol("timeout");
        },
        cancel() {
          cancelled = true;
        },
      },
    });
    fireTimeout?.();
    const result = await pending;

    expect(result).toMatchObject({ status: "unavailable", reason: "timeout" });
    expect(scheduledMs).toBe(REQUEST_TIMEOUT_MS);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("reuses successful metadata inside the 24-hour TTL and refreshes at the boundary", async () => {
    const cacheDir = await newCacheDir();
    let now = 10_000;
    let fetchCount = 0;
    const fetchImpl: VersionFetch = async () => {
      fetchCount += 1;
      return registryResponse("1.0.1");
    };

    await check("1.0.0", fetchImpl, cacheDir, () => now);
    now += SUCCESS_CACHE_TTL_MS - 1;
    await check("1.0.0", fetchImpl, cacheDir, () => now);
    expect(fetchCount).toBe(1);

    now += 1;
    await check("1.0.0", fetchImpl, cacheDir, () => now);
    expect(fetchCount).toBe(2);
  });

  test("suppresses repeated failures for 15 minutes and retries at the boundary", async () => {
    const cacheDir = await newCacheDir();
    let now = 20_000;
    let fetchCount = 0;
    const fetchImpl: VersionFetch = async () => {
      fetchCount += 1;
      throw new Error("offline");
    };

    expect((await check("1.0.0", fetchImpl, cacheDir, () => now)).status).toBe("unavailable");
    now += FAILURE_BACKOFF_MS - 1;
    expect((await check("1.0.0", fetchImpl, cacheDir, () => now)).status).toBe("unavailable");
    expect(fetchCount).toBe(1);

    now += 1;
    expect((await check("1.0.0", fetchImpl, cacheDir, () => now)).status).toBe("unavailable");
    expect(fetchCount).toBe(2);
  });

  test("recovers from corrupt cache and writes owner-only cache metadata", async () => {
    const cacheDir = await newCacheDir();
    await writeFile(path.join(cacheDir, "version-check.json"), "{corrupt", "utf8");
    const result = await check("1.0.0", stubFetch(registryResponse("1.0.1"), []), cacheDir, () => 30_000);

    expect(result.status).toBe("update-available");
    const cacheStat = await stat(path.join(cacheDir, "version-check.json"));
    expect(cacheStat.mode & 0o777).toBe(0o600);
  });

  test.each([
    ["2.0.0", "update-available"],
    ["1.0.0", "up-to-date"],
  ] as const)("keeps a valid registry result when cache persistence fails (%s)", async (latest, status) => {
    const cacheDir = await newCacheDir();
    const blockingFile = path.join(cacheDir, "not-a-directory");
    await writeFile(blockingFile, "blocked", "utf8");

    const result = await checkVersion({
      currentVersion: "1.0.0",
      fetch: stubFetch(registryResponse(latest), []),
      cacheDir: path.join(blockingFile, "cache"),
      now: () => 30_000,
    });

    expect(result.status).toBe(status);
    expect(result).toMatchObject({ latestVersion: latest, source: "registry" });
  });

  test("a concurrent failure cannot erase a freshly committed success", async () => {
    const cacheDir = await newCacheDir();
    let resolveSuccess: (response: Response) => void = () => {};
    let rejectFailure: (error: Error) => void = () => {};
    let call = 0;
    const concurrentFetch: VersionFetch = async () => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((resolve) => { resolveSuccess = resolve; });
      }
      return new Promise<Response>((_resolve, reject) => { rejectFailure = reject; });
    };

    const success = check("1.0.0", concurrentFetch, cacheDir, () => 31_000);
    const failure = check("1.0.0", concurrentFetch, cacheDir, () => 31_000);
    resolveSuccess(registryResponse("2.0.0"));
    expect((await success).status).toBe("update-available");
    rejectFailure(new Error("offline"));
    expect((await failure).status).toBe("unavailable");

    let refreshCalls = 0;
    const cached = await check("1.0.0", async () => {
      refreshCalls += 1;
      return registryResponse("3.0.0");
    }, cacheDir, () => 31_001);
    expect(cached).toMatchObject({ status: "update-available", latestVersion: "2.0.0", source: "cache" });
    expect(refreshCalls).toBe(0);
  });

  test.each([
    {
      name: "an older observation loses even when its version is higher",
      firstAt: 32_000,
      firstVersion: "4.0.0",
      secondAt: 32_001,
      secondVersion: "3.0.0",
      cachedVersion: "3.0.0",
    },
    {
      name: "equal timestamps retain the higher version by SemVer precedence",
      firstAt: 33_000,
      firstVersion: "2.0.0-beta.2",
      secondAt: 33_000,
      secondVersion: "2.0.0-beta.11",
      cachedVersion: "2.0.0-beta.11",
    },
    {
      name: "equal timestamps allow the later-completing higher version to replace the lower one",
      firstAt: 34_000,
      firstVersion: "2.0.0-beta.11",
      secondAt: 34_000,
      secondVersion: "2.0.0-beta.2",
      cachedVersion: "2.0.0-beta.11",
    },
  ])("out-of-order successful refreshes: $name", async ({
    firstAt,
    firstVersion,
    secondAt,
    secondVersion,
    cachedVersion,
  }) => {
    const cacheDir = await newCacheDir();
    let resolveFirst: (response: Response) => void = () => {};
    let resolveSecond: (response: Response) => void = () => {};
    let call = 0;
    const concurrentFetch: VersionFetch = async () => {
      call += 1;
      return new Promise<Response>((resolve) => {
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    };

    const first = check("1.0.0", concurrentFetch, cacheDir, () => firstAt);
    const second = check("1.0.0", concurrentFetch, cacheDir, () => secondAt);
    resolveSecond(registryResponse(secondVersion));
    expect(await second).toMatchObject({ latestVersion: secondVersion, source: "registry" });
    resolveFirst(registryResponse(firstVersion));
    expect(await first).toMatchObject({ latestVersion: firstVersion, source: "registry" });

    let refreshCalls = 0;
    const cached = await check("1.0.0", async () => {
      refreshCalls += 1;
      return registryResponse("9.0.0");
    }, cacheDir, () => Math.max(firstAt, secondAt) + 1);
    expect(cached).toMatchObject({ latestVersion: cachedVersion, source: "cache" });
    expect(refreshCalls).toBe(0);
  });

  test.each([
    { name: "first request completes first", completionOrder: [0, 1] as const },
    { name: "second request completes first", completionOrder: [1, 0] as const },
  ])("SemVer-equal build metadata resolves deterministically when $name", async ({
    completionOrder,
  }) => {
    const cacheDir = await newCacheDir();
    const versions = ["2.0.0+aaa", "2.0.0+bbb"] as const;
    const resolvers: Array<(response: Response) => void> = [];
    const concurrentFetch: VersionFetch = async () => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    });

    const checks = versions.map((version) =>
      check("1.0.0", concurrentFetch, cacheDir, () => 35_000).then((result) => {
        expect(result).toMatchObject({ latestVersion: version, source: "registry" });
      })
    );

    for (const index of completionOrder) {
      resolvers[index]!(registryResponse(versions[index]!));
      await checks[index];
    }

    let refreshCalls = 0;
    const cached = await check("1.0.0", async () => {
      refreshCalls += 1;
      return registryResponse("9.0.0");
    }, cacheDir, () => 35_001);
    expect(cached).toMatchObject({ latestVersion: "2.0.0+bbb", source: "cache" });
    expect(refreshCalls).toBe(0);
  });

  test("rejects an oversized cached version before SemVer bigint parsing", async () => {
    const cacheDir = await newCacheDir();
    const oversizedVersion = numericVersionWithLength(VERSION_STRING_LIMIT_CHARS + 1);
    await writeFile(
      path.join(cacheDir, "version-check.json"),
      JSON.stringify({ latestVersion: oversizedVersion, successAt: 32_000 }),
      "utf8",
    );
    let fetchCount = 0;

    const result = await check("1.0.0", async () => {
      fetchCount += 1;
      return registryResponse("1.0.1");
    }, cacheDir, () => 32_000);

    expect(result).toMatchObject({ status: "update-available", latestVersion: "1.0.1", source: "registry" });
    expect(fetchCount).toBe(1);
  });

  test("never recommends from stale metadata after refresh failure", async () => {
    const cacheDir = await newCacheDir();
    let now = 40_000;
    const fresh = await check("1.0.0", stubFetch(registryResponse("9.9.9"), []), cacheDir, () => now);
    expect(fresh.status).toBe("update-available");

    now += SUCCESS_CACHE_TTL_MS;
    const stale = await check("1.0.0", stubFetch(new Error("offline"), []), cacheDir, () => now);
    expect(stale.status).toBe("unavailable");
    expect(stale).not.toHaveProperty("installCommand");
  });

  test("does not throw for every operational unavailable state", async () => {
    const cacheDir = await newCacheDir();
    const result: VersionCheckResult = await check("1.0.0", stubFetch(new Error("offline"), []), cacheDir, () => 50_000);
    expect(result.status).toBe("unavailable");
  });
});
