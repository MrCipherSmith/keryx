// Two installers write the same files. Neither may destroy the other.
//
// `keryx security hooks install` and `keryx ctx hooks install` both target
// `.cursor/hooks.json` and `.windsurf/hooks.json`. They used to write the key
// `hooks` with incompatible JSON types — an object keyed by the runtime's real
// event name on one side, an array of `{on, command}` on the other — and each
// strip helper replaces what it does not recognise wholesale. Whichever ran
// second destroyed the first, and the shared `_keryxManaged` sentinel went on
// listing both, so an audit or an uninstall reported a guard that was not there.
//
// Measured before the fix:
//
//   ctx then security -> ctx.validate: ["cursor: missing beforeShellExecution guard"]
//   security then ctx -> sec.validate: ["cursor: missing input hook routing …"]
//   sentinel in both  -> ["ctx-agent-hooks","security-agent-hooks"]
//
// An operator who ran both documented commands got exactly one guard, chosen by
// ordering. This file is the pin, and it drives the REAL registries in both
// orders rather than asserting a shape.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CTX_RUNTIMES } from "../ctx/runtimes";
import {
  AGENT_HOOKS_SENTINEL,
  getRuntime,
  SECURITY_HOOKS_KEY,
} from "./agent-hooks/runtimes";

/** Runtimes both installers claim. Derived, so a new overlap joins the test. */
function sharedRuntimes(root: string): Array<{ id: string; file: string }> {
  const shared: Array<{ id: string; file: string }> = [];
  for (const ctx of CTX_RUNTIMES) {
    const security = getRuntime(ctx.id);
    if (security === undefined) {
      continue;
    }
    if (security.settingsPath(root) === ctx.locate(root)) {
      shared.push({ id: ctx.id, file: ctx.locate(root) });
    }
  }
  return shared;
}

/**
 * Both sides of one runtime, with the JSON-config methods proven present.
 *
 * `CtxRuntime.merge`/`strip`/`validate` are OPTIONAL — a runtime that writes a
 * non-JSON artifact (the OpenCode plugin) leaves them undefined and implements
 * `customInstall` instead. `sharedRuntimes` already excludes those by comparing
 * paths, but the type does not know that, and asserting it here is better than
 * a non-null assertion at four call sites.
 */
function pair(id: string): {
  security: NonNullable<ReturnType<typeof getRuntime>>;
  ctx: {
    merge: (s: Record<string, unknown>) => Record<string, unknown>;
    strip: (s: Record<string, unknown>) => Record<string, unknown>;
    validate: (s: Record<string, unknown>) => string[];
  };
} {
  const security = getRuntime(id);
  const ctx = CTX_RUNTIMES.find((r) => r.id === id);
  if (security === undefined || ctx === undefined) {
    throw new Error(`registry lost ${id} mid-test`);
  }
  const { merge, strip, validate } = ctx;
  if (merge === undefined || strip === undefined || validate === undefined) {
    throw new Error(`${id} is not a JSON-config ctx runtime; it should not be in the shared set`);
  }
  return {
    security,
    ctx: {
      merge: (s) => merge(s) as Record<string, unknown>,
      strip: (s) => strip(s) as Record<string, unknown>,
      validate,
    },
  };
}

function withRoot(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-coexist-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the security and ctx hook installers coexist in one file", () => {
  test("the overlap is real and is enumerated from the registries", () => {
    // The numerator. If this ever returns nothing the tests below are vacuous,
    // and the previous version of this situation had no test at all precisely
    // because nobody had written down that the overlap existed.
    withRoot((root) => {
      const shared = sharedRuntimes(root).map((r) => r.id).sort();
      expect(shared).toEqual(["claude", "cursor", "windsurf"]);
    });
  });

  test("either order leaves BOTH guards valid", () => {
    withRoot((root) => {
      for (const { id } of sharedRuntimes(root)) {
        const { security, ctx } = pair(id);

        for (const order of ["ctx-then-security", "security-then-ctx"] as const) {
          let settings: Record<string, unknown> = {};
          if (order === "ctx-then-security") {
            settings = ctx.merge(settings) as Record<string, unknown>;
            settings = security.merge(settings) as Record<string, unknown>;
          } else {
            settings = security.merge(settings) as Record<string, unknown>;
            settings = ctx.merge(settings) as Record<string, unknown>;
          }
          expect({ id, order, ctx: ctx.validate(settings) }).toEqual({ id, order, ctx: [] });
          expect({ id, order, security: security.validate(settings) }).toEqual({
            id,
            order,
            security: [],
          });
        }
      }
    });
  });

  test("uninstalling one leaves the other standing, and the sentinel tells the truth", () => {
    // The other half. A strip that removed the foreign guard would pass the test
    // above and still be the same defect on the way out.
    withRoot((root) => {
      for (const { id } of sharedRuntimes(root)) {
        const { security, ctx } = pair(id);

        let settings = security.merge(ctx.merge({}) as Record<string, unknown>) as Record<string, unknown>;
        settings = security.strip(settings) as Record<string, unknown>;
        expect({ id, ctxSurvives: ctx.validate(settings) }).toEqual({ id, ctxSurvives: [] });
        // ...and the sentinel no longer claims the security guard.
        const managed = Array.isArray(settings._keryxManaged) ? settings._keryxManaged : [];
        expect({ id, stillClaimed: managed.includes(AGENT_HOOKS_SENTINEL) }).toEqual({
          id,
          stillClaimed: false,
        });

        let other = ctx.merge(security.merge({}) as Record<string, unknown>) as Record<string, unknown>;
        other = ctx.strip(other) as Record<string, unknown>;
        expect({ id, securitySurvives: security.validate(other) }).toEqual({
          id,
          securitySurvives: [],
        });
      }
    });
  });

  test("a config in the LEGACY array shape is migrated, and user entries in it survive", () => {
    // A config written before the split has managed groups in `hooks`. They must
    // move, or an uninstall leaves them behind and a re-install duplicates them.
    // Only ours, though: an array a user wrote is theirs.
    withRoot((root) => {
      const { security, ctx } = pair("cursor");

      const legacy: Record<string, unknown> = {
        hooks: [
          { on: "input", command: "keryx security check-input --source untrusted-external", _keryxManaged: AGENT_HOOKS_SENTINEL },
          { on: "output", command: "keryx security check-output", _keryxManaged: AGENT_HOOKS_SENTINEL },
          { on: "input", command: "the operator's own hook" },
        ],
      };

      const migrated = security.merge(legacy) as Record<string, unknown>;
      expect(security.validate(migrated)).toEqual([]);
      // The user's entry is still there, and ours are no longer beside it.
      expect(migrated.hooks).toEqual([{ on: "input", command: "the operator's own hook" }]);
      expect(Array.isArray(migrated[SECURITY_HOOKS_KEY])).toBe(true);

      // And ctx can now install into the same file without a collision.
      const both = ctx.merge(migrated) as Record<string, unknown>;
      expect(ctx.validate(both)).toEqual([]);
      expect(security.validate(both)).toEqual([]);
    });
  });

  test("a legacy array holding ONLY our entries is removed entirely", () => {
    withRoot((root) => {
      const { security } = pair("windsurf");
      const legacy: Record<string, unknown> = {
        hooks: [
          { on: "input", command: "keryx security check-input --source untrusted-external", _keryxManaged: AGENT_HOOKS_SENTINEL },
        ],
      };
      const migrated = security.merge(legacy) as Record<string, unknown>;
      // Not left as an empty array, which would still be a type collision with
      // ctx's object — the whole reason for the split.
      expect(migrated.hooks).toBeUndefined();
    });
  });

  test("re-installing either is still idempotent with the other present", () => {
    let flatChecked = 0;
    withRoot((root) => {
      for (const { id } of sharedRuntimes(root)) {
        const { security, ctx } = pair(id);
        let settings = ctx.merge({}) as Record<string, unknown>;
        for (let i = 0; i < 3; i += 1) {
          settings = security.merge(settings) as Record<string, unknown>;
          settings = ctx.merge(settings) as Record<string, unknown>;
        }
        expect({ id, ctx: ctx.validate(settings) }).toEqual({ id, ctx: [] });
        expect({ id, security: security.validate(settings) }).toEqual({ id, security: [] });

        // Claude keeps its shipped event-keyed schema and never uses this key,
        // so the count applies to the flat runtimes only. Asserting it for
        // Claude would be asserting the absence of a design decision.
        if (settings[SECURITY_HOOKS_KEY] !== undefined) {
          const ours = settings[SECURITY_HOOKS_KEY] as unknown[];
          expect({ id, entries: ours.length }).toEqual({ id, entries: 2 });
          flatChecked += 1;
        }
      }
    });
    // ...and at least one flat runtime was actually counted, so the branch above
    // is not silently skipped for every member.
    expect(flatChecked).toBeGreaterThan(0);
  });
});
