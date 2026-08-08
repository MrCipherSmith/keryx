// The production turn runner for `keryx serve`.
//
// This module exists to keep two things apart that must not become one. The
// transport (`serve-server.ts`) knows about requests, routes and framing and
// must know nothing about providers, models or run assembly — "the adapter
// depends inward" is the rule, and a review confirmed it holds: no HTTP type,
// header or framing concept crosses into a harness contract today.
//
// But holding that rule by having the transport take a runner it never received
// is how `POST /v1/turns` shipped answering 503 to everything. `createSubmitTurn`
// had zero production callers; the only production `ServeContext` omitted the
// one optional field that makes a submission executable, and the criteria that
// were supposed to prove otherwise had each been verified through a fixture.
//
// So: the assembly lives here, the transport declares it REQUIRED, and
// `commands/serve.ts` — the composition root, which already reads the
// configuration and the credential — passes this function in. Forgetting is now
// a type error rather than a 503.

import { detectSandboxLauncher } from "../harness/process/sandbox/detect";
import { makeProvider } from "../harness/provider/make-provider";
import type { PolicyProfile } from "../harness/policy/types";
import { keryxConfigDir } from "./config-dir";
import { applySavedApiKeys, loadShellConfig } from "./shell-config";
import { createSubmitTurn, type SubmitOutcome, type TurnRequest } from "./serve-turn";

/**
 * Assemble the runner a listener executes turns with.
 *
 * `profile` is the one `resolveServeStartup` already resolved and compared
 * against the local baseline, passed through rather than re-resolved: two
 * resolutions is two chances for the profile a turn runs under to differ from
 * the one that was checked for widening.
 *
 * `dir` is the install directory override. It is the config root, the turn store
 * and the scan root — one directory, because the prompt is untrusted content
 * arriving at the INSTALL boundary and scanning it against the caller's declared
 * project would let a remote caller choose which project's security
 * configuration governs the scan of their own prompt.
 */
export function assembleSubmitTurn(
  profile: PolicyProfile,
  dir: string | undefined,
  seams: {
    /**
     * Overrides the sandbox-launcher probe. TESTS ONLY.
     *
     * It exists because the property that must be pinned is bidirectional — a
     * turn under a containment-requiring profile RUNS when a launcher is
     * present and is REFUSED when it is not — and no single host can exercise
     * both. Without the seam, the assertion that would have caught this round's
     * blocker is only possible on a machine with bubblewrap installed, which is
     * to say on almost no CI runner.
     *
     * It can make a turn run uncontained, so it is a weakening seam and is
     * treated like `localBaseline`: `serve-server.test.ts` holds a source-level
     * guard asserting that no file outside this one supplies it.
     */
    containmentAvailable?: () => boolean;
  } = {},
): (request: TurnRequest, project: string) => Promise<SubmitOutcome> {
  // Saved keys into the environment first, so `makeProvider` can see them — the
  // same order `keryx shell` uses. Without a key every provider falls closed to
  // the offline `FakeProvider`, which is the correct failure: a listener that
  // runs turns against nothing is better than one that reaches the network with
  // a credential the operator did not grant it.
  applySavedApiKeys(dir);
  const saved = loadShellConfig(dir);
  const providerName = saved.provider ?? "fake";
  const model = saved.model ?? "";

  return createSubmitTurn({
    profile,
    provider: makeProvider(providerName, model, {
      // The real one. `makeProvider` never calls it during construction, so this
      // is the provider's network seam and not a network call here.
      fetch: globalThis.fetch,
      ...(saved.baseUrl !== undefined ? { baseUrl: saved.baseUrl } : {}),
    }),
    providerName,
    model,
    dir: keryxConfigDir(dir),
    // The real probe, and its absence was the second blocker of the fix round.
    //
    // `runRemoteTurn` defaults this seam to `() => false`, and the shipped
    // default profile `remote-restricted` resolves to `unattended-untrusted`,
    // whose `requiredControls.isolation` is `required-fail-closed`. So an
    // assembly that omitted it refused EVERY turn with
    // `containment-unavailable` — a 202 whose record says `refused`, on a
    // listener that had just been wired specifically so turns could run.
    //
    // Evaluated per turn rather than captured at startup, deliberately: a
    // launcher installed while the listener is up should be picked up without a
    // restart, and the detection is a handful of `existsSync` calls over PATH
    // with no spawn. It is also the honest direction to fail in — a launcher
    // REMOVED while the listener is up must start refusing immediately.
    //
    // KNOWN GAP (keryx-linux-containment step 1). This asks whether a launcher
    // is PRESENT, not whether containment WORKS. On Ubuntu 23.10+ those differ:
    // bubblewrap is present and every contained run dies, so `keryx sandbox
    // status` now reports containment as broken while this gate still admits
    // required-fail-closed turns. Closing it means probing — one spawn per turn,
    // which the per-turn evaluation above exists to avoid, or a cached probe
    // with an invalidation policy that would break the "picked up without a
    // restart" property. Both are design work beyond step 1's "report the
    // truth" scope, so the gap is recorded rather than half-closed.
    //
    // The gap is a diagnostic one, not a containment one: a broken launcher
    // still never yields an unsandboxed run. The turn is admitted, then
    // `SandboxedProcessAdapter` wraps the command and the launcher itself exits
    // nonzero, so the command never executes. What is wrong is only that the
    // operator learns this as an opaque per-command failure instead of an
    // up-front refusal naming the cause.
    containmentAvailable: seams.containmentAvailable ?? (() => detectSandboxLauncher().available),
  });
}
