# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `buildLandlockRuleset(profile, abi)` converts a `SandboxProfile` into a Landlock ruleset description deterministically and offline — no syscall, no FFI, no spawn, no filesystem read, no `process.platform` branch; identical inputs yield deeply equal output, proven by unit test.
- AC2: A profile that cannot be faithfully expressed in Landlock terms returns `{ ok: false, failures }` with at least one machine-readable reason code and never a ruleset; covered by unit tests for `network: "off"`, `network: "restricted"`, a non-empty `readDenyList`, `danger-full-access`, a non-absolute path, and an ABI below the ruleset's `minimumAbi`.
- AC3: A returned ruleset enforces the whole profile: every rule's `allow` set is a subset of `handledFs`, `minimumAbi` is the maximum first-ABI over every handled access right, and there is no field on `LandlockRuleset` in which a partially enforced boundary could be recorded.
- AC4: No profile — including `network: "off"` — produces a non-empty `handledNet` or `netRules`, so Landlock is never credited with network-off (specification §4.3, PRD R2); asserted by unit test.
- AC5: `landlock-abi.ts` exposes only an injectable ABI-reader interface plus a per-process cache, assumes no mechanism (`bun:ffi`, compiled helper or otherwise), and its cache is proven to call the injected reader exactly once.
- AC6: The quality gate is green on the touched scope — `keryx health run`, `bun test src/harness/process/sandbox`, and `bun scripts/check-doc-links.ts` at or above the recorded baseline.
- AC7: No file outside `src/harness/process/sandbox/landlock.ts`, `landlock.test.ts`, `landlock-abi.ts`, `landlock-abi.test.ts` and the export block of `sandbox/index.ts` is modified in `src/`.
