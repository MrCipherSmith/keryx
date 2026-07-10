// Process-scoped warn-once helper for the Capability Seam (specification.md §3,
// §7; AC0-6, AC0-7). Generalizes the "report once, never spam" discipline the
// security seam already applies to guard warnings.
//
// The degradation warning for an unavailable opt-in capability MUST be emitted
// to stderr exactly once per command invocation, regardless of how many call
// sites hit the same unavailable capability. Keys are process-scoped, so a
// single long-lived CLI process warns once per distinct key.
//
// This module imports nothing but stays dependency-free by design.

const emitted = new Set<string>();

// Emit `message` to stderr the first time `key` is seen in this process; every
// later call with the same key is a silent no-op. Never throws.
export function warnOnce(key: string, message: string): void {
  if (emitted.has(key)) {
    return;
  }
  emitted.add(key);
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // stderr write failures must never break a caller.
  }
}

// The canonical capability-degradation warning. Keyed by capability id so a
// capability that is resolved from many call sites warns exactly once (AC0-7).
export function warnCapabilityDegraded(id: string, reason: string): void {
  warnOnce(
    `capability:${id}`,
    `[capability] ${id} unavailable: ${reason}; using deterministic fallback`,
  );
}

// True when the degradation warning for `id` has already been emitted this
// process. Exposed for assertions/diagnostics.
export function hasWarned(id: string): boolean {
  return emitted.has(`capability:${id}`);
}

// Reset the process-scoped guard. Intended for test isolation only, so one test
// file's warnings do not leak into another's assertions.
export function resetWarnOnce(): void {
  emitted.clear();
}
