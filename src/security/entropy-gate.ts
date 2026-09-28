import { DEFAULT_SECURITY_CONFIG, loadSecurityConfig } from "./config";

// F-REG-F3 (flow 355 review round, PR #776): `redactSensitiveText` (S-6) and
// `harness/web/outbound-secret.ts`'s outbound check (S-8) both call
// `detectEntropy` UNCONDITIONALLY, ignoring `backends.entropy.enabled` — the
// same config gate `detect/index.ts`'s `runDetectors` already honours for
// `keryx security scan`. An operator who disables the entropy backend in
// `security.config.json` therefore sees it turn off for scans but keep
// running everywhere else, silently.
//
// Both call sites are SYNCHRONOUS (dozens of callers across the codebase
// depend on `redactSensitiveText` staying that way — see its own doc
// comment), so this cannot simply thread an awaited config load through
// them. Instead: read `security.config.json` ONCE, in the background, the
// first time either caller asks, and cache the answer for the life of the
// process — the shipped default (enabled) answers any call made before that
// first load resolves. Both consumers read this ONE cache rather than each
// loading (and potentially disagreeing on) the config independently, which
// is what "the same effective config" means here.
let cachedEnabled = DEFAULT_SECURITY_CONFIG.backends.entropy.enabled;
let loadStarted = false;

function ensureLoading(): void {
  if (loadStarted) {
    return;
  }
  loadStarted = true;
  loadSecurityConfig(process.cwd())
    .then((config) => {
      cachedEnabled = config.backends.entropy.enabled;
    })
    .catch(() => {
      // Config unreadable: keep the last known value rather than guessing —
      // `loadSecurityConfig` itself already fails closed to the strictest
      // defaults on a read error, which is what `cachedEnabled` already is.
    });
}

/** Whether the entropy backend is enabled, per the last successful load. */
export function isEntropyBackendEnabled(): boolean {
  ensureLoading();
  return cachedEnabled;
}

/**
 * Test-only: force the cached value directly — no disk I/O, no timing
 * dependency on a background `Promise` resolving before an assertion runs.
 */
export function setEntropyBackendEnabledForTests(enabled: boolean): void {
  loadStarted = true;
  cachedEnabled = enabled;
}

/** Test-only: restore the shipped default and re-arm the background load. */
export function resetEntropyGateForTests(): void {
  loadStarted = false;
  cachedEnabled = DEFAULT_SECURITY_CONFIG.backends.entropy.enabled;
}
