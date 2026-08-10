import path from "node:path";
import {
  ensureKeryxConfigDir,
  readConfigFile,
  writeOwnerOnlyFileAtomic,
} from "./config-dir";
import { withFileLock } from "./fs";

export const REGISTRY_URL = "https://registry.npmjs.org/@mrciphersmith%2Fkeryx/latest";
export const FIXED_INSTALL_COMMAND = "npm install -g @mrciphersmith/keryx@latest";
export const RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
export const REQUEST_TIMEOUT_MS = 2_000;
export const SUCCESS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const FAILURE_BACKOFF_MS = 15 * 60 * 1_000;
const CACHE_LOCK_TIMEOUT_MS = 250;
const CACHE_LOCK_RETRY_MS = 10;
const CACHE_LOCK_STALE_MS = 5_000;

export type VersionCheckUnavailableReason =
  | "invalid-current-version"
  | "suppressed"
  | "timeout"
  | "network"
  | "http"
  | "response-too-large"
  | "malformed-response"
  | "invalid-latest-version";

export type VersionCheckResult =
  | {
      status: "update-available";
      currentVersion: string;
      latestVersion: string;
      installCommand: typeof FIXED_INSTALL_COMMAND;
      source: "cache" | "registry";
    }
  | {
      status: "up-to-date";
      currentVersion: string;
      latestVersion: string;
      source: "cache" | "registry";
    }
  | {
      status: "unavailable";
      currentVersion: string;
      reason: VersionCheckUnavailableReason;
      cachedLatestVersion?: string;
    };

export interface VersionCheckOptions {
  currentVersion: string;
  fetch?: VersionFetch;
  cacheDir?: string;
  now?: () => number;
  timer?: VersionCheckTimer;
}

export type VersionFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Injectable only so timeout behavior can be tested without sleeping. */
export interface VersionCheckTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const SYSTEM_TIMER: VersionCheckTimer = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Shared human advisory text. Non-update outcomes deliberately render nothing. */
export function formatVersionUpdateAdvisory(result: VersionCheckResult): string | undefined {
  if (result.status !== "update-available") return undefined;
  return `Keryx update ${result.currentVersion} → ${result.latestVersion}\n${result.installCommand}`;
}

type ParsedSemVer = {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: Array<bigint | string>;
};

type VersionCache = {
  latestVersion?: string;
  successAt?: number;
  failureAt?: number;
};

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemVer(value: string): ParsedSemVer | undefined {
  const match = STRICT_SEMVER.exec(value);
  if (match === null) return undefined;
  const prereleaseText = match[4];
  const prerelease: Array<bigint | string> = [];
  if (prereleaseText !== undefined) {
    for (const identifier of prereleaseText.split(".")) {
      if (/^\d+$/.test(identifier)) {
        if (identifier.length > 1 && identifier.startsWith("0")) return undefined;
        prerelease.push(BigInt(identifier));
      } else {
        prerelease.push(identifier);
      }
    }
  }
  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease,
  };
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined) {
      if (a === b) return 0;
      return a === undefined ? -1 : 1;
    }
    if (typeof a === "bigint" && typeof b === "bigint") {
      if (a < b) return -1;
      if (a > b) return 1;
    } else if (typeof a === "bigint") {
      return -1;
    } else if (typeof b === "bigint") {
      return 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

function parseCache(file: string): VersionCache | undefined {
  const read = readConfigFile(file);
  if (!read.ok) return undefined;
  try {
    const value: unknown = JSON.parse(read.text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const cache: VersionCache = {};
    if (
      typeof record.latestVersion === "string" &&
      record.latestVersion.length <= RESPONSE_BODY_LIMIT_BYTES &&
      parseSemVer(record.latestVersion) !== undefined
    ) {
      cache.latestVersion = record.latestVersion;
    }
    if (typeof record.successAt === "number" && Number.isFinite(record.successAt)) cache.successAt = record.successAt;
    if (typeof record.failureAt === "number" && Number.isFinite(record.failureAt)) cache.failureAt = record.failureAt;
    return cache;
  } catch {
    return undefined;
  }
}

function resultFor(
  currentVersion: string,
  current: ParsedSemVer,
  latestVersion: string,
  source: "cache" | "registry",
): VersionCheckResult {
  const latest = parseSemVer(latestVersion)!;
  return compareSemVer(current, latest) < 0
    ? { status: "update-available", currentVersion, latestVersion, installCommand: FIXED_INSTALL_COMMAND, source }
    : { status: "up-to-date", currentVersion, latestVersion, source };
}

function cancelWithoutWaiting(cancel: () => Promise<void>): void {
  try {
    void cancel().catch(() => {
      // Cancellation is best-effort; the size violation remains authoritative.
    });
  } catch {
    // A non-conforming stream may throw before returning its cancellation promise.
  }
}

async function boundedResponseText(response: Response): Promise<string | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(RESPONSE_BODY_LIMIT_BYTES)) {
    if (response.body !== null) {
      cancelWithoutWaiting(() => response.body!.cancel());
    }
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > RESPONSE_BODY_LIMIT_BYTES) {
        cancelWithoutWaiting(() => reader.cancel());
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function unavailable(
  currentVersion: string,
  reason: VersionCheckUnavailableReason,
  cache?: VersionCache,
): VersionCheckResult {
  return {
    status: "unavailable",
    currentVersion,
    reason,
    ...(cache?.latestVersion !== undefined ? { cachedLatestVersion: cache.latestVersion } : {}),
  };
}

function saveCache(file: string, cache: VersionCache): boolean {
  try {
    writeOwnerOnlyFileAtomic(file, `${JSON.stringify(cache, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialize only the read/merge/write cache critical section. Network I/O is
 * deliberately outside the lock, and lock contention is bounded so a cache can
 * never delay shell startup indefinitely.
 */
async function updateCache(
  file: string,
  update: (committed: VersionCache) => VersionCache,
): Promise<boolean> {
  try {
    return await withFileLock(
      `${file}.lock`,
      async () => saveCache(file, update(parseCache(file) ?? {})),
      {
        timeoutMs: CACHE_LOCK_TIMEOUT_MS,
        retryMs: CACHE_LOCK_RETRY_MS,
        staleMs: CACHE_LOCK_STALE_MS,
      },
    );
  } catch {
    return false;
  }
}

/** Always resolves; registry, validation, timeout and cache failures are values. */
export async function checkVersion(options: VersionCheckOptions): Promise<VersionCheckResult> {
  const current = parseSemVer(options.currentVersion);
  if (current === undefined) return unavailable(options.currentVersion, "invalid-current-version");

  const now = options.now ?? Date.now;
  const timestamp = now();
  const configDir = ensureKeryxConfigDir(options.cacheDir);
  const cacheFile = path.join(configDir, "version-check.json");
  const cache = parseCache(cacheFile);
  if (
    cache?.latestVersion !== undefined &&
    cache.successAt !== undefined &&
    timestamp - cache.successAt >= 0 &&
    timestamp - cache.successAt < SUCCESS_CACHE_TTL_MS
  ) {
    return resultFor(options.currentVersion, current, cache.latestVersion, "cache");
  }
  if (
    cache?.failureAt !== undefined &&
    timestamp - cache.failureAt >= 0 &&
    timestamp - cache.failureAt < FAILURE_BACKOFF_MS
  ) {
    return unavailable(options.currentVersion, "suppressed", cache);
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = options.timer ?? SYSTEM_TIMER;
  let timeout: unknown;
  let timeoutScheduled = false;
  let failure: VersionCheckUnavailableReason | undefined;
  let latestVersion: string | undefined;
  try {
    timeout = timer.schedule(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeoutScheduled = true;
    const response = await fetchImpl(REGISTRY_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok) {
      failure = "http";
    } else {
      const body = await boundedResponseText(response);
      if (body === undefined) {
        failure = "response-too-large";
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          failure = "malformed-response";
        } else {
          const record = parsed as Record<string, unknown>;
          if (record.name !== "@mrciphersmith/keryx" || typeof record.version !== "string") {
            failure = "malformed-response";
          } else if (parseSemVer(record.version) === undefined) {
            failure = "invalid-latest-version";
          } else {
            latestVersion = record.version;
          }
        }
      }
    }
  } catch {
    failure = controller.signal.aborted ? "timeout" : "network";
  } finally {
    if (timeoutScheduled) {
      try {
        timer.cancel(timeout);
      } catch {
        // A timer cleanup failure must not reject this fail-soft service.
      }
    }
  }

  if (latestVersion === undefined) {
    await updateCache(cacheFile, (committed) => ({ ...committed, failureAt: timestamp }));
    return unavailable(options.currentVersion, failure ?? "network", cache);
  }
  await updateCache(cacheFile, () => ({ latestVersion, successAt: timestamp }));
  return resultFor(options.currentVersion, current, latestVersion, "registry");
}
