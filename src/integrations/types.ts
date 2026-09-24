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

/**
 * The JSON type a surface's top-level key must hold, for the OQ-3 coherence
 * check (`assertRegistryCoherent`). Every top-level key a surface's
 * merge/strip touches must appear here — `_keryxManaged` and, where the
 * surface's merge migrates a pre-existing legacy array under `hooks` (see
 * `mergeIntoHookArray`), `unmigratedHooks` — not only the surface's own
 * primary container key, so the coherence check actually sees every
 * collision class rather than only the obvious one.
 *
 * `access` says HOW the surface may touch the key:
 * - `"owns"`: the surface is free to create/replace the key with a value of
 *   `type`. Two `"owns"` slots on one settings file that disagree on `type`
 *   for the same key is exactly the `hooks: object` vs `hooks: array`
 *   collision (OQ-3) this registry closes by construction, so it throws.
 * - `"migrates-legacy"`: the surface only touches the key when it is
 *   ALREADY present with `type` (a legacy shape written before this key had
 *   an owner) — it never creates the key when absent, and never gives it a
 *   different type. Because it can never introduce the key, a
 *   `"migrates-legacy"` slot can safely coexist with an `"owns"` slot on the
 *   same key declaring a different `type` (the flat security surfaces'
 *   `hooks: array` migration alongside a ctx-guard/orient surface's
 *   `hooks: object` on the same file, for instance): the migrating surface
 *   can only ever narrow or clear a pre-existing array, never fight the
 *   owner over what an absent or object-shaped key becomes. The coherence
 *   check therefore never flags an `"owns"`/`"migrates-legacy"` pair —
 *   flagging it would require the migrating surface to be able to write that
 *   type when the key is absent, which by this definition it cannot.
 */
export interface SurfaceSlot {
  readonly key: string;
  readonly type: "object" | "array" | "number" | "string" | "boolean";
  readonly access: "owns" | "migrates-legacy";
}

// The known subsystems today, as named constants rather than a closed union
// (F10, interface prep for W5-b/W6/W8): a future subsystem (skills, agents,
// mcp, ...) is just another string a new `SurfaceAdapter` carries, with no
// union type anywhere to widen first. `surfacesOf`'s `subsystem` query still
// narrows correctly against these constants (`string` compares fine).
export const SUBSYSTEM_CTX_GUARD = "ctx-guard";
export const SUBSYSTEM_ORIENT = "orient";
export const SUBSYSTEM_SECURITY = "security";

/**
 * One installable capability of one harness. `id` is unique within its
 * `HarnessAdapter`. JSON-config surfaces implement `merge`/`strip`/`validate`;
 * a surface that writes a non-JSON artifact (the OpenCode plugin) leaves those
 * undefined and implements `customInstall`/`customUninstall` instead.
 */
export interface SurfaceAdapter {
  readonly id: string;
  readonly flag: SurfaceFlag;
  /** An open string — see `SUBSYSTEM_CTX_GUARD`/`SUBSYSTEM_ORIENT`/`SUBSYSTEM_SECURITY` for the known values (F10). */
  readonly subsystem: string;
  readonly sentinel: string;
  readonly confidence: Confidence;
  readonly riskNotes?: readonly string[];
  readonly sourceDocs: readonly string[];
  /** Absolute path of the settings artifact this surface installs into. */
  settingsFile?(root: string): string;
  /**
   * Path relative to the project root. Most surfaces set this for
   * `SettingsFileOwner` lookup — but a non-JSON artifact (the OpenCode
   * plugin file) may ALSO carry one, purely to say where its file lives; it
   * is never owned by a `SettingsFileOwner` regardless (F10 — the prior
   * comment here, "absent for non-JSON artifacts", was not true of that
   * surface and is corrected). What actually decides ownership is `merge`/
   * `strip` both being defined — see `registry.ts`'s `SETTINGS_FILE_OWNERS`
   * builder.
   */
  readonly relativePath?: string;
  readonly slots: readonly SurfaceSlot[];
  merge?(settings: Settings): Settings;
  strip?(settings: Settings): Settings;
  validate?(settings: Settings): string[];
  customInstall?(projectRoot: string): Promise<string[]>;
  customUninstall?(projectRoot: string): Promise<boolean>;

  // --- ctx-guard-only presentation/decode facts -----------------------------
  // Carried on the surface (rather than hand-duplicated per view module) so
  // `src/ctx/runtimes.ts`'s `CTX_RUNTIMES` can be BUILT by mapping over
  // `surfacesOf(adapter, {subsystem:"ctx-guard"})` instead of listing every
  // runtime's shape a second time (flow 305 review fix, F4).
  /** Human label for this surface's settings artifact (ctx CLI output). */
  readonly label?: string;
  /** How the installed group is shaped — see `GroupShape` in settings-json.ts. */
  readonly groupShape?: "flat" | "nested";
  readonly groupKey?: string;
  readonly groupContainer?: string;
  /** Native tools (beyond the shell) this ctx-guard runtime's matcher also covers. */
  readonly nativeSearchTools?: readonly string[];
  /** Parses this harness's hook payload into the shell command it carries. */
  readonly payloadCodec?: PayloadCodec;
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
  /**
   * How THIS harness signals refuse/allow back to its process — the ONLY
   * decision codec for this harness (R3-F1): no `SurfaceAdapter` carries its
   * own copy, so a mismatch between an adapter and one of its surfaces is
   * unexpressible. Every reader — a ctx-guard runtime built from this
   * adapter's surface (`src/ctx/runtimes.ts`'s `runtimeFromSurface`), and a
   * caller with only a bare runtime id in hand (the ctx native-search refusal
   * in `src/ctx/hook.ts`, and the security CLI's `--runtime <id>` argument
   * path) — reads this same field, directly or via `decisionCodecFor`/
   * `refusalAction`/`allowAction` in `registry.ts`, which is what makes the
   * registry the SINGLE place that answers "how does runtime X signal a
   * decision", instead of a second id-keyed switch.
   */
  readonly decisionCodec: DecisionCodec;
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
