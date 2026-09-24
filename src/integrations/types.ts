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
 *
 * `"rules"` (flow 313, W4 portability, review round 1 F19) is a 13th flag
 * added OUTSIDE the frozen W5 list, for the `rules-export` surfaces
 * (`surfaces-rules.ts`) alone. It exists so `--surface instructions` selects
 * only the pre-existing `keryx:instructions` pointer-block surfaces, never
 * the (opt-in, content-reflecting) `keryx:rules` index block — the two used
 * to share the `instructions` flag, which made `--surface instructions`
 * silently also install/uninstall `rules-export`.
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
  | "mcp"
  | "rules";

export type Confidence = "verified" | "experimental";

/**
 * How a surface reaches the harness:
 * - `host-hook`: keryx writes into a settings file (or plugin file) the
 *   harness's own process reads — today's shape for every registered surface.
 * - `policy-travels-with-agent`: the policy ships with the agent definition
 *   rather than a host settings file. Zed's shape (W5-b): keryx runs AS the
 *   ACP agent, so its own deny-by-default permission mapping
 *   (`src/acp/permission.ts`'s `approvalFromPermissionResponse`) already
 *   implements the surface — there is no Zed-owned settings file to install
 *   into at all.
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
export const SUBSYSTEM_INSTRUCTIONS = "instructions";
export const SUBSYSTEM_ACP_PERMISSION = "acp-permission";
/** Flow 310 (W2): the agent-definitions export subsystem — a harness's own `<runtime>/agents/*` directory, written by `src/agents/export.ts`. */
export const SUBSYSTEM_AGENTS = "agents";
// Flow 306 (W6, T20): `keryx shell`'s own compiled-in lifecycle hook runtime
// (`src/harness/hooks/`) — a `policy-travels-with-agent` capability like
// `SUBSYSTEM_ACP_PERMISSION`, not a settings file keryx installs into.
export const SUBSYSTEM_SHELL_HOOKS = "shell-hooks";
// Flow 313 (W4 portability), T9: the canonical `.metaproject/rules/**`
// library rendered into a harness's own instruction file as an index (title +
// description per rule, never the rule bodies themselves). Distinct from
// `SUBSYSTEM_INSTRUCTIONS` (the short, fixed Keryx bootstrap pointer every
// `markdown-block.ts` surface writes) — this subsystem actually reflects
// project content (the rule list), so it is deliberately NOT special-cased by
// `matrix.ts`'s `classifySurfaceState` as `instruction-only`.
export const SUBSYSTEM_RULES_EXPORT = "rules-export";

/**
 * T17: the richer `customUninstall` return shape for a surface that may keep
 * part of what it manages rather than deleting it (e.g. `agents`'s hand-edited
 * managed files). `removed` carries the same meaning the plain `boolean`
 * shape's value always has; `warnings`, when present, is folded into the
 * surface's `SurfaceResult.warnings` by `installer.ts` so a kept file is
 * visible in the CLI/JSON output alongside the uninstall's own status line.
 */
export interface CustomUninstallResult {
  readonly removed: boolean;
  readonly warnings?: readonly string[];
}

/**
 * Review round 2 fix (R2-F6): the richer `customInstall` return shape for a
 * surface that can partially succeed — writing SOME of what it manages while
 * skipping a piece it refuses on principled grounds (e.g. `rules-export`
 * skipping one unsafe rule name, per `export-render.ts`'s F7 fix, while still
 * indexing every other rule). `errors` is what the plain `string[]` shape
 * always meant: a non-empty `errors` makes `installer.ts` report `failed` and
 * skip `recordSurfaceInstalled`, exactly as before. `warnings` — folded into
 * the surface's `SurfaceResult.warnings` the same way `CustomUninstallResult.warnings`
 * and an experimental surface's static risk notes already are — reports a
 * partial skip WITHOUT making the operation a failure: before this fix,
 * `rules-export` had no way to say "the block was written, but rule X wasn't
 * indexed" without also reporting the whole install `failed`, which left the
 * block on disk while the CLI and install-state disagreed with it (exit 1,
 * but the file was written and never recorded).
 */
export interface CustomInstallResult {
  readonly errors: readonly string[];
  readonly warnings?: readonly string[];
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
  /** An open string — see `SUBSYSTEM_CTX_GUARD`/`SUBSYSTEM_ORIENT`/`SUBSYSTEM_SECURITY` for the known values (F10). */
  readonly subsystem: string;
  readonly sentinel: string;
  readonly confidence: Confidence;
  readonly riskNotes?: readonly string[];
  readonly sourceDocs: readonly string[];
  /**
   * Flow 310 (W2): true excludes this surface from an EMPTY-selector
   * install/uninstall (`resolveSurfaceSelection`/`resolveSurfaceSelectionLenient`
   * in `installer.ts`) — `keryx integrations install --runtime <id>` with no
   * `--surface` keeps installing exactly what it always has, unchanged. An
   * opt-in surface is only selected by naming it explicitly: its own flag
   * (`--surface agents`) or its id. Used by the `agents` surfaces (T7) so a
   * default install never starts silently writing per-agent export files
   * nobody asked for.
   */
  readonly optIn?: boolean;
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
  /**
   * True when `relativePath` is a file Keryx itself creates and is the ONLY
   * writer of (e.g. `.kiro/hooks/keryx-ctx-guard.json`) — as opposed to a
   * file other tools or the user's own config may also hold keys in (e.g.
   * `.claude/settings.json`). `uninstallSurfaces` (review round 1, F6) deletes
   * the file outright, instead of writing `{}`, only when this is set AND the
   * post-strip settings are empty — never for a shared file, regardless of
   * whether stripping happened to empty it out.
   */
  readonly ownsWholeFile?: boolean;
  merge?(settings: Settings): Settings;
  strip?(settings: Settings): Settings;
  validate?(settings: Settings): string[];
  /**
   * Review round 2, F6: the plain `string[]` shape (every pre-flow-313
   * surface) is treated exactly as before — every entry is an error, and any
   * non-empty result fails the install. A surface that can partially succeed
   * returns `CustomInstallResult` instead — see its own doc comment.
   */
  customInstall?(projectRoot: string): Promise<string[] | CustomInstallResult>;
  /**
   * Uninstall this surface's artifact. The plain `boolean` shape (every
   * pre-flow-310 surface) reports only whether anything was removed. T17: a
   * surface that can legitimately REFUSE to delete part of what it manages —
   * `agents`, which never deletes a hand-edited managed file even though it
   * still carries a keryx sentinel — instead returns
   * `CustomUninstallResult`, whose `warnings` (kept files, and why) `installer.ts`
   * folds into the surface's `SurfaceResult.warnings` the same way an
   * experimental surface's static risk notes already are.
   */
  customUninstall?(projectRoot: string): Promise<boolean | CustomUninstallResult>;
  /**
   * Health check for a surface that has no `merge`/`strip` to validate
   * against — a non-JSON artifact (a generated plugin file, a markdown
   * instructions block) or a surface satisfied entirely by keryx's own
   * runtime behavior (zed's `acp-permission` block surface). Returns a
   * problem string per issue found, `[]` when healthy. `doctor` calls this
   * for any surface lacking `validate`.
   */
  probe?(projectRoot: string): Promise<string[]>;
  /**
   * Structured dry-run probe for a custom (non-JSON) surface (review round 2,
   * F4/N1): reports exactly what `customInstall`/`customUninstall` would find
   * as a typed state, instead of a caller having to string-match a `probe`
   * message. Markdown-block `instructions` surfaces (gemini-cli/kiro/
   * github-copilot-agent) wire this to `inspectMarkdownBlock`
   * (`markdown-block.ts`); a custom surface without one (the OpenCode plugin)
   * falls back to a plain file-existence dry-run check in `installer.ts`.
   * `"malformed"` (an unterminated/unpairable block) is the one state that
   * must make a dry run report `failed` — the same outcome the real
   * install/uninstall would hit.
   */
  inspect?(projectRoot: string): Promise<{
    readonly state: "absent-file" | "no-block" | "present" | "stale" | "malformed";
    readonly message?: string;
  }>;

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
  /**
   * Extra field a managed group must carry to belong to THIS surface, when
   * `groupKey`/`groupContainer` alone are ambiguous — e.g. the flat security
   * surfaces, where `security-check-input`/`security-check-output` share one
   * array (`securityHooks`) and are told apart only by each entry's own `on`
   * field. `installer.ts`'s `wasSurfaceInstalled` (review round 3, M2) reads
   * this to judge per-surface presence without needing a second, surface-id-
   * keyed special case.
   */
  readonly groupMatchField?: { readonly key: string; readonly value: string };
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
  /** Free-text caveats about this harness's adapter as a whole (non-empty when `confidence: "experimental"`). */
  readonly riskNotes?: readonly string[];
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
