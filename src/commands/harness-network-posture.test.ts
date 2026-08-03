// SF-2. A credential that happens to exist must not choose the network posture
// of an unrelated command.
//
// The defect this locks out: `keryx harness exec` decided "restricted network"
// from `maskHosts.length > 0`. Those hosts come from masks resolved against
// `envWithSavedApiKeys`, so ANY provider key — in the environment or saved in
// the user-global `auth.json`, for a provider this command never touches —
// silently changed the posture. On macOS that widened the run to restricted
// networking with TLS termination; on Linux, where `restricted` is refused, the
// same command was blocked outright. `keryx harness exec -- /bin/echo hi` either
// worked or failed depending on whether an unrelated key existed on the machine.
//
// The shape of the mistake is this repository's standing lesson — branching on a
// value whose domain was never written down. `maskHosts.length > 0` meant both
// "the operator asked for masking" and "a credential happens to be present".
// The fix writes the domain down: `resolveNetworkRestriction` enumerates every
// way an operator can ask for restriction, returns a discriminated union, and
// nothing else can produce one.
import { describe, expect, test } from "bun:test";
import { resolveNetworkRestriction } from "./harness";

const noIntent = {
  allowedDomainsFlag: undefined,
  envOrPolicyDomains: undefined,
  explicitMaskSpecs: [] as readonly string[],
  maskModeFlag: undefined,
  tlsTerminateFlag: false,
};

describe("resolveNetworkRestriction — only the operator chooses the posture", () => {
  test("no signal at all → not restricted", () => {
    expect(resolveNetworkRestriction(noIntent)).toEqual({ restricted: false });
  });

  // THE REGRESSION LOCK. Ambient credentials are not represented in the input at
  // all, which is the point: they cannot reach this decision. Before the fix a
  // saved ANTHROPIC_API_KEY produced an inject-host, and an inject-host produced
  // a restricted run.
  test("an ambient credential cannot make a run restricted", () => {
    // Whatever masks the resolver derives from the environment, the operator
    // asked for nothing here — so the answer must be the same as the empty case.
    expect(resolveNetworkRestriction(noIntent)).toEqual({ restricted: false });
  });

  test("--allowed-domains asks for it", () => {
    expect(
      resolveNetworkRestriction({ ...noIntent, allowedDomainsFlag: ["api.example.com"] }),
    ).toEqual({ restricted: true, because: "allowed-domains-flag" });
  });

  test("env or project policy asks for it", () => {
    expect(
      resolveNetworkRestriction({ ...noIntent, envOrPolicyDomains: ["api.example.com"] }),
    ).toEqual({ restricted: true, because: "env-or-policy-domains" });
  });

  test("--mask-env asks for it", () => {
    expect(
      resolveNetworkRestriction({ ...noIntent, explicitMaskSpecs: ["TOKEN@api.example.com"] }),
    ).toEqual({ restricted: true, because: "explicit-mask-spec" });
  });

  test("--mask-mode asks for it, including `off`", () => {
    // Passing the flag at all is an operator statement about masking, and
    // masking only means anything on a restricted run. `off` is included
    // deliberately: the resolver, not this function, decides what `off` does to
    // the masks — this function only answers who asked.
    expect(resolveNetworkRestriction({ ...noIntent, maskModeFlag: "auto" })).toEqual({
      restricted: true,
      because: "mask-mode-flag",
    });
    expect(resolveNetworkRestriction({ ...noIntent, maskModeFlag: "off" })).toEqual({
      restricted: true,
      because: "mask-mode-flag",
    });
  });

  test("--tls-terminate asks for it", () => {
    expect(resolveNetworkRestriction({ ...noIntent, tlsTerminateFlag: true })).toEqual({
      restricted: true,
      because: "tls-terminate-flag",
    });
  });

  // Precedence is fixed and reported, so a reader of the output can tell WHICH
  // request produced the posture rather than guessing.
  test("the reported reason follows a fixed precedence", () => {
    expect(
      resolveNetworkRestriction({
        allowedDomainsFlag: ["a.example.com"],
        envOrPolicyDomains: ["b.example.com"],
        explicitMaskSpecs: ["TOKEN@c.example.com"],
        maskModeFlag: "auto",
        tlsTerminateFlag: true,
      }),
    ).toEqual({ restricted: true, because: "allowed-domains-flag" });
  });

  // An empty list is not a request. `--allowed-domains ""` parses to [] and must
  // not be read as "restrict with no domains", which would deny all egress under
  // the guise of an operator choice.
  test("empty lists are not requests", () => {
    expect(resolveNetworkRestriction({ ...noIntent, allowedDomainsFlag: [] })).toEqual({
      restricted: false,
    });
    expect(resolveNetworkRestriction({ ...noIntent, envOrPolicyDomains: [] })).toEqual({
      restricted: false,
    });
    expect(resolveNetworkRestriction({ ...noIntent, explicitMaskSpecs: [] })).toEqual({
      restricted: false,
    });
  });
});
