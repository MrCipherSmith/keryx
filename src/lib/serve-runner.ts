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
  });
}
