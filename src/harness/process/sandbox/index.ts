// OS-sandbox public surface (flow 093). Workspace-write + network-off OS
// containment for real `shell_exec` subprocesses, grok-build model: build a
// launcher-wrapped command (macOS seatbelt / Linux bwrap) around the approved
// command, enforced by the OS regardless of what the model chose to run.
//
// Layering: this sits UNDER the existing policy engine + approval + structural
// guard (which decide WHAT runs); the sandbox bounds WHAT a run can touch.

export type {
  SandboxMode,
  SandboxNetwork,
  SandboxProfile,
  SandboxProfileInput,
} from "./profile";
export {
  defaultReadDenyList,
  defaultSandboxProfile,
  sandboxProfileFromPolicy,
} from "./profile";
export { buildSeatbeltProfile, wrapSeatbelt, SANDBOX_EXEC_PATH } from "./seatbelt";
export { buildBwrapArgs, wrapBwrap, BWRAP_PROGRAM } from "./bwrap";
export { wrapWithSandbox, type WrapOptions, type WrapResult } from "./wrap";
export {
  createAllowlistProxy,
  matchesAllowlist,
  type AllowlistProxy,
  type AllowlistProxyOptions,
  type ProxyDecision,
  type CredentialMask,
} from "./proxy";
export {
  setupNetworkRun,
  type NetworkRunSetup,
  type NetworkRunOptions,
  type MaskedCredential,
} from "./network-run";
export { SandboxedProcessAdapter, type SandboxedProcessAdapterOptions } from "./adapter";
export {
  detectSandboxLauncher,
  resolveSandboxAdapter,
  type SandboxLauncherInfo,
  type DetectOptions,
  type ResolveSandboxOptions,
} from "./detect";
export { createRunCa, type RunCa, type LeafCertificate, type CreateRunCaOptions } from "./tls-ca";
