// The unattended posture (flow 136, AC3–AC8).
//
// These tests exist to fail the flow if `--unattended` ever becomes a blanket
// approve-everything switch. That switch would pass AC3 and AC11 on the first
// try and destroy the only property the benchmark actually demonstrated: on case
// C1, keryx and opencode ran the same model and only keryx stopped before
// deleting the project's graph index.

import { expect, test } from "bun:test";
import { decide } from "./engine";
import { resolveLocalProfile } from "./profiles";
import {
  createUnattendedApprover,
  decideUnattended,
  DEFAULT_UNATTENDED_PROFILE,
  parseUnattendedFlag,
  postureRecord,
  UNATTENDED_ASK_USER_REFUSAL,
  unattendedAskUserHost,
  unattendedHeaderLabel,
  type UnattendedPosture,
} from "./unattended";
import type { PolicyDeps } from "./types";

/** Deterministic ids/clock: the engine's record must not depend on wall time. */
function deps(): PolicyDeps {
  let n = 0;
  return { clock: () => "2026-08-05T00:00:00.000Z", idSeq: () => `id-${++n}` };
}

const READ_ONLY: UnattendedPosture = { profile: "read-only-review" };
const TRUSTED_LOCAL: UnattendedPosture = { profile: "monitored-trusted-local" };

test("the flag parses bare, with a profile, and refuses an unknown one", () => {
  expect(parseUnattendedFlag([])).toEqual({ kind: "absent" });
  expect(parseUnattendedFlag(["--provider", "fake"])).toEqual({ kind: "absent" });

  expect(parseUnattendedFlag(["--unattended"])).toEqual({
    kind: "posture",
    posture: { profile: DEFAULT_UNATTENDED_PROFILE },
  });
  expect(parseUnattendedFlag(["--unattended=monitored-trusted-local"])).toEqual({
    kind: "posture",
    posture: { profile: "monitored-trusted-local" },
  });

  // A typo'd profile must NOT silently fall back — running under a posture
  // nobody named is the failure the flag exists to prevent.
  const bad = parseUnattendedFlag(["--unattended=monitored-trusted-locl"]);
  expect(bad.kind).toBe("error");
  expect(bad.kind === "error" && bad.message).toContain("monitored-trusted-locl");
});

test("the default profile is read-only — the flag grants no mutation authority by itself", () => {
  expect(DEFAULT_UNATTENDED_PROFILE).toBe("read-only-review");
  const profile = resolveLocalProfile(DEFAULT_UNATTENDED_PROFILE);
  expect(profile.defaults.write).toBe("deny");
  expect(profile.defaults.shell).toBe("deny");
  expect(profile.defaults.network).toBe("deny");
  expect(profile.defaults.delegate).toBe("deny");
});

test("AC3: a read-risk action is allowed with no prompt and no approver", () => {
  const decision = decideUnattended(
    READ_ONLY,
    { risk: "read", actionFingerprint: "fp-read" },
    deps(),
  );
  expect(decision.decision).toBe("allow");
});

test("AC4: a deny stays terminal under the flag, exactly as it is without it", () => {
  const action = { risk: "shell" as const, actionFingerprint: "fp-shell" };
  const withFlag = decideUnattended(READ_ONLY, action, deps());

  // The same call resolved WITHOUT the posture path — through the engine
  // directly, the way every other consumer reaches it.
  const withoutFlag = decide(
    { toolCallId: "fp-shell", risk: "shell" },
    {
      profile: resolveLocalProfile("read-only-review"),
      interactive: true,
      approvals: [],
      actionFingerprint: "fp-shell",
    },
    deps(),
  );

  expect(withFlag.decision).toBe("deny");
  expect(withoutFlag.decision).toBe("deny");
  expect(withFlag.decision).toBe(withoutFlag.decision);
  expect(withFlag.matchedRules).toContain("hard-deny:shell");
});

test("AC5: an ask with no approver resolves to deny, never to allow", () => {
  // `unattended-untrusted` defaults shell to `ask` — the case where a human
  // WOULD have been asked. With nobody to ask, it must fail closed.
  const decision = decideUnattended(
    { profile: "unattended-untrusted" },
    { risk: "shell", actionFingerprint: "fp-ask" },
    deps(),
  );
  expect(decision.decision).toBe("deny");
  expect(decision.matchedRules).toContain("headless-fail-closed");
});

test("AC6: a destructive action is refused even under a profile that allows shell", () => {
  // The profile's own `shell` default is `allow`, so a plain command executes…
  const plain = decideUnattended(
    TRUSTED_LOCAL,
    { risk: "shell", actionFingerprint: "fp-ls" },
    deps(),
  );
  expect(plain.decision).toBe("allow");

  // …and the same tool with a destructive command does not.
  const destructive = decideUnattended(
    TRUSTED_LOCAL,
    { risk: "shell", destructive: true, actionFingerprint: "fp-rm" },
    deps(),
  );
  expect(destructive.decision).toBe("deny");

  const credential = decideUnattended(
    TRUSTED_LOCAL,
    { risk: "shell", credentials: true, actionFingerprint: "fp-cred" },
    deps(),
  );
  expect(credential.decision).toBe("deny");
});

test("AC6: no profile in the selectable set can auto-approve a destructive action", () => {
  // Enumerated rather than spot-checked: "regardless of any profile entry" is
  // the criterion, so the test has to try them all.
  for (const profile of ["read-only-review", "monitored-trusted-local", "unattended-untrusted"] as const) {
    for (const risk of ["read", "write", "shell", "network", "delegate"] as const) {
      const decision = decideUnattended(
        { profile },
        { risk, destructive: true, actionFingerprint: `fp-${profile}-${risk}` },
        deps(),
      );
      expect(decision.decision, `${profile}/${risk} destructive must be refused`).toBe("deny");
    }
  }
});

test("the managed flow-state guard still applies under the flag", () => {
  const decision = decideUnattended(
    TRUSTED_LOCAL,
    {
      risk: "shell",
      actionFingerprint: "fp-flow",
      targetPath: ".metaproject/flows/136-x/flow.json",
    },
    deps(),
  );
  expect(decision.decision).toBe("deny");
  expect(decision.matchedRules).toContain("flow-file-protection");
});

test("the approver answers with the action's own fingerprint and a reason on refusal", async () => {
  const approver = createUnattendedApprover(READ_ONLY, deps());
  const refused = await approver("shell_exec", '{"command":"rm -rf /"}', {
    fingerprint: "fp-1",
    destructive: true,
    risk: "shell",
  });
  expect(refused.approved).toBe(false);
  expect(refused.fingerprint).toBe("fp-1");
  expect(refused.reason ?? "").toContain("--unattended=read-only-review");

  const allowed = await approver("shell_exec", "{}", {
    fingerprint: "fp-2",
    destructive: false,
    risk: "read",
  });
  expect(allowed.approved).toBe(true);
  expect(allowed.fingerprint).toBe("fp-2");
});

test("an approver given no action metadata approves nothing", async () => {
  const approver = createUnattendedApprover(TRUSTED_LOCAL, deps());
  const answer = await approver("shell_exec", '{"command":"ls"}');
  expect(answer.approved).toBe(false);
});

test("AC5: ask_user cannot be answered under the flag and does not block", async () => {
  await expect(unattendedAskUserHost()).rejects.toThrow(UNATTENDED_ASK_USER_REFUSAL);
});

test("AC8: the posture is renderable for a header and recordable in the run record", () => {
  expect(unattendedHeaderLabel(undefined)).toBe("");
  expect(unattendedHeaderLabel(READ_ONLY)).toBe("unattended(read-only-review)");
  expect(unattendedHeaderLabel(TRUSTED_LOCAL)).toBe("unattended(monitored-trusted-local)");

  // A supervised run is recorded as supervised, not as an absent field: "not
  // recorded" and "nobody needed to be asked" are different claims.
  expect(postureRecord(undefined)).toBe("supervised");
  expect(postureRecord(READ_ONLY)).toBe("unattended:read-only-review");
  expect(postureRecord(TRUSTED_LOCAL)).toBe("unattended:monitored-trusted-local");
});
