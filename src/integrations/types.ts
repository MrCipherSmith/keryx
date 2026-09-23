// Flow 305 (W5-a): shared types for the host-harness surface registry.
//
// A "surface" is one host-hook capability keryx can install into a harness's
// own config (a shell-command gate, a context injector, a security check,
// ...). A "harness adapter" is one coding agent/IDE and the surfaces it
// supports. This module is pure types — no logic, no I/O — so every other
// file in this directory (and the three legacy view modules that re-derive
// their exports from the registry) can depend on it without a cycle.

/**
 * The 12 W5 integration points a harness's hook system may expose. Only a
 * subset is wired up in W5-a (block, prompt-gate, inject-context); the rest
 * are named here so `HarnessAdapter.unsupported` and future surfaces have a
 * fixed vocabulary to grow into, per the W5 spec's flag list.
 */
export type SurfaceFlag =
  | "block"
  | "prompt-gate"
  | "pre-tool-context"
  | "inject-context"
  | "observe"
  | "post-tool"
  | "session-start"
  | "stop"
  | "skills"
  | "agents"
  | "instructions"
  | "mcp";

export type Confidence = "verified" | "experimental";

/**
 * How a surface reaches the harness:
 * - `host-hook`: keryx writes into a settings file (or plugin file) the
 *   harness's own process reads — today's shape for every registered surface.
 * - `policy-travels-with-agent`: the policy ships with the agent definition
 *   rather than a host settings file (zed's future shape — W5-b).
 * - `instruction-only`: no scriptable enforcement; only a documented
 *   convention (e.g. AGENTS.md).
 */
export type AdapterKind = "host-hook" | "policy-travels-with-agent" | "instruction-only";

export type Settings = Record<string, unknown>;

/**
 * What a hook process should do for one decision. `exitCode` plus optional
 * `stdout`/`stderr` covers every block/allow style a harness uses: exit-code
 * signalling (Claude/Codex/Windsurf) and stdout-JSON decisions (Cursor,
 * Antigravity).
 */
export interface HookAction {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** Parses a harness's hook payload into the shell command it carries, or null. */
export type PayloadCodec = (payload: string) => string | null;

/** How a runtime signals refuse/allow back to the harness process. */
export interface DecisionCodec {
  refuse(runtimeId: string, message: string): HookAction;
  allow(runtimeId: string): HookAction;
}

/** The JSON type a surface's top-level key must hold, for the OQ-3 coherence check. */
export interface SurfaceSlot {
  readonly key: string;
  readonly type: "object" | "array" | "number" | "string" | "boolean";
}

/**
 * One installable capability of one harness. `id` is unique within its
 * `HarnessAdapter`. JSON-config surfaces implement `merge`/`strip`/`validate`;
 * a surface that writes a non-JSON artifact (the OpenCode plugin) leaves those
 * undefined and implements `customInstall`/`customUninstall` instead.
 */
export interface SurfaceAdapter {
  readonly id: string;
  readonly flag: SurfaceFlag;
  readonly subsystem: "ctx-guard" | "orient" | "security";
  readonly sentinel: string;
  readonly confidence: Confidence;
  readonly riskNotes?: readonly string[];
  readonly sourceDocs: readonly string[];
  /** Absolute path of the settings artifact this surface installs into. */
  settingsFile?(root: string): string;
  /** Path relative to the project root, for owner lookup. Absent for non-JSON artifacts. */
  readonly relativePath?: string;
  readonly slots: readonly SurfaceSlot[];
  merge?(settings: Settings): Settings;
  strip?(settings: Settings): Settings;
  validate?(settings: Settings): string[];
  customInstall?(projectRoot: string): Promise<string[]>;
  customUninstall?(projectRoot: string): Promise<boolean>;
}

/** One harness/IDE and every surface it supports. */
export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  readonly confidence: Confidence;
  readonly adapterKind: AdapterKind;
  readonly surfaces: readonly SurfaceAdapter[];
  /** Reason strings for flags this harness cannot support today (verbatim carry-over). */
  readonly unsupported: Partial<Record<SurfaceFlag, string>>;
  readonly sourceDocs: readonly string[];
  /** ISO date the confidence/unsupported facts were last checked against docs. */
  readonly lastVerified: string;
}

/**
 * The single owner of one settings file, mediating every surface that targets
 * it so two surfaces never independently clobber each other's JSON shape.
 */
export interface SettingsFileOwner {
  readonly relativePath: string;
  surfaces(): readonly SurfaceAdapter[];
  /**
   * Apply install/uninstall of the named surface ids, in the owner's fixed
   * canonical order, and validate the result. Returns the new settings AND
   * errors; callers must not write when `errors.length > 0`.
   */
  apply(
    existing: Settings,
    ops: { install?: readonly string[]; uninstall?: readonly string[] },
  ): { settings: Settings; errors: string[] };
}
