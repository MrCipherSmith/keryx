// Trigger config: types, path, per-entry validation and the loader (flow 286
// T6). No command wiring here — `keryx trigger run/install/list/status`
// (T7-T9) are separate dispatches that import this module.
//
// House style copied from the two existing hand-edited project/operator
// config loaders rather than invented fresh (dispatch instruction, flow 286
// T6):
//
//   - `src/lib/provider-config.ts` (`llm-providers.json`): a keyed/array
//     collection where EACH entry is independently validated by an
//     `isX(value): value is X` guard, and a malformed entry is dropped while
//     its neighbours still load — `loadCustomCompatProviders` never throws
//     and returns `[]` for an absent/malformed/wrong-schema file.
//   - `src/lib/shell-config.ts` (`auth.json`): `loadX(dir?)` reads through
//     `readConfigFile` (the size-bounded reader from `config-dir.ts` — the
//     same guard against the oversized-file-aborts-the-process class of bug
//     documented there), and is `{}`/best-effort on any failure, never a
//     throw.
//
// Neither of those two records WHY an entry was dropped — AC1 explicitly
// requires "refused on load with the reason", which is a stronger contract.
// For that half of the shape this module borrows
// `src/bus/schema.ts`'s "Checks. Each returns the list of problems; empty
// means valid" convention (`busEventProblems` etc.) — `triggerEntryProblems`
// answers the same way, and the loader keeps the reasons rather than
// discarding them.
//
// WHERE THE FILE LIVES, and why (recorded in the flow's journal.md as the T5
// decision): `.metaproject/triggers.json`, hand-edited by the operator, NOT
// inside `.metaproject/metaproject.json` and NOT a `<module>.config.json`
// alongside `gdctx.config.json`/`health.config.json`/etc. Those two are
// machine-managed — `metaproject.json` is rewritten by `keryx init`/`update`
// (`routingEntrypointSteps`'s "one writer" discipline in
// `src/lib/routing-entrypoint.ts`), and every `<module>.config.json` in the
// repo today is a module `init`/`update` also owns the shape of. A trigger
// list is neither: it is read (never rewritten wholesale) by keryx, grows and
// shrinks as the operator edits it by hand, and doing that safely next to a
// generated manifest that a re-`init`/`update` can rewrite would risk losing
// hand-authored entries on the next `keryx update`. A dedicated file mirrors
// `llm-providers.json`'s own reason for being separate from `auth.json`: an
// operator-owned collection of independently-valid entries needs its own
// namespace, not a corner of a generated one. This also matches the shape the
// flow's own description.md names first (`.metaproject/triggers.json`).

import { existsSync } from "node:fs";
import path from "node:path";
import { readConfigFile } from "../lib/config-dir";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Repository events a trigger can fire on (flow 286 description.md §"What
 * this flow builds"). `"ci"` is a CI job calling `keryx trigger run <name>`
 * itself — there is no keryx-side listener for it (out of scope: "Reacting to
 * GitHub webhooks directly"), so it exists here only so an entry can be
 * DECLARED to fire from CI, for `keryx trigger list`/documentation purposes;
 * nothing about loading or running an entry treats `"ci"` differently from
 * any other event name.
 */
export const TRIGGER_EVENT_NAMES = ["post-merge", "post-commit", "post-checkout", "ci"] as const;
export type TriggerEventName = (typeof TRIGGER_EVENT_NAMES)[number];

/** What a fired trigger does (flow 286 description.md §"What this flow builds"). */
export const TRIGGER_ACTION_KINDS = ["reconcile", "rebuild", "open-flow", "flow-next"] as const;
export type TriggerActionKind = (typeof TRIGGER_ACTION_KINDS)[number];

/** A safe CLI-argument-shaped name: `keryx trigger run <name>` passes it through argv verbatim. */
const TRIGGER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A cron expression is validated only for SHAPE here (5-6 whitespace
 * separated fields of cron-legal characters) — not for calendar validity
 * (`"99 99 * * *"` passes this and is rejected, if at all, by whatever T10
 * hands the line to). Deep cron semantics belong to T10 (schedule output),
 * which is out of scope for this dispatch; this guard exists only so a
 * hand-typed non-cron string (`"nightly"`, `""`, a natural-language phrase)
 * is refused at load time instead of surfacing as a confusing failure when a
 * scheduler line is printed later.
 */
const CRON_FIELD_PATTERN = /^[0-9*/,-]+$|^[A-Za-z]{3}(?:[,-][A-Za-z]{3})*$/;

function looksLikeCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return false;
  return fields.every((field) => CRON_FIELD_PATTERN.test(field));
}

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------

export type TriggerFire =
  | { readonly kind: "event"; readonly event: TriggerEventName }
  | { readonly kind: "schedule"; readonly cron: string };

export type TriggerAction =
  | { readonly kind: "reconcile" }
  | { readonly kind: "rebuild" }
  | { readonly kind: "open-flow"; readonly template: string; readonly skipIfOpen?: boolean }
  | { readonly kind: "flow-next"; readonly flow: string; readonly dispatch?: TriggerDispatch };

/**
 * Flow 290 (AC1, AC4, AC6, AC7): what turns a report-only `flow-next` into
 * one that DISPATCHES an agent to work the flow's next task, unattended.
 *
 * Every money-shaped field is required: a dispatch whose cost cannot be priced
 * could never move either spend ceiling, so it is rejected at load rather than
 * allowed to spend without bound. `permissionMode` may only be `ask` or
 * `trust` — `auto` is refused here, because an unattended run has nobody to
 * notice what `auto` waves through.
 */
export interface TriggerDispatch {
  readonly provider: string;
  readonly model: string;
  /** `ask` (default): every non-read call is denied. `trust`: non-destructive calls run; the unattended floor still applies. */
  readonly permissionMode: UnattendedPermissionMode;
  readonly rates: { readonly inputUsdPerMTok: number; readonly outputUsdPerMTok: number };
  /** This trigger's own spend ceiling in USD, on top of the project-wide one. */
  readonly ceilingUsd: number;
  /** Wall-clock limit for one agent run. */
  readonly maxSeconds: number;
  /** A task whose attempt count has reached this is not dispatched again. */
  readonly maxAttempts: number;
  /** Loopback only (see `dispatchProblems`). */
  readonly baseUrl?: string;
  /** Flow 290 T13 (AC13): network inside the unattended sandbox. Default false — off. */
  readonly network: boolean;
}

export const UNATTENDED_PERMISSION_MODES = ["ask", "trust"] as const;
export type UnattendedPermissionMode = (typeof UNATTENDED_PERMISSION_MODES)[number];

export const DEFAULT_DISPATCH_MAX_SECONDS = 1800;
export const DEFAULT_DISPATCH_MAX_ATTEMPTS = 3;

/** One validated trigger config entry. */
export interface TriggerEntry {
  /** Unique within the file (T6 loader rejects a later duplicate — see `loadTriggersConfig`). Also the `keryx trigger run <name>` argument. */
  readonly name: string;
  readonly fire: TriggerFire;
  readonly action: TriggerAction;
  /** Defaults to `true` when absent. A disabled entry loads (and lists) but a run refuses it — that refusal belongs to T7, not this loader. */
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// On-disk (pre-validation) shape
// ---------------------------------------------------------------------------

export const TRIGGERS_SCHEMA_VERSION = 1;

interface RawTriggersFile {
  readonly schemaVersion?: unknown;
  readonly triggers?: unknown;
}

// ---------------------------------------------------------------------------
// Per-entry validation — "Checks. Each returns the list of problems; empty
// means valid" (mirrors `src/bus/schema.ts`).
// ---------------------------------------------------------------------------

function fireProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["on: must be an object naming an event or a schedule"];
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === "event") {
    if (typeof raw.event !== "string" || raw.event.length === 0) {
      return ["on.event: required, non-empty string"];
    }
    if (!(TRIGGER_EVENT_NAMES as readonly string[]).includes(raw.event)) {
      return [`on.event: unknown event "${raw.event}" (expected one of ${TRIGGER_EVENT_NAMES.join(", ")})`];
    }
    return [];
  }
  if (raw.kind === "schedule") {
    if (typeof raw.cron !== "string" || raw.cron.trim().length === 0) {
      return ["on.cron: required, non-empty string"];
    }
    if (!looksLikeCron(raw.cron)) {
      return [`on.cron: "${raw.cron}" does not look like a 5- or 6-field cron expression`];
    }
    return [];
  }
  return ['on.kind: must be "event" or "schedule"'];
}

function actionProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["action: must be an object naming what the trigger does"];
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !(TRIGGER_ACTION_KINDS as readonly string[]).includes(raw.kind)) {
    return [`action.kind: must be one of ${TRIGGER_ACTION_KINDS.join(", ")}`];
  }
  if (raw.kind === "open-flow") {
    const problems: string[] = [];
    if (typeof raw.template !== "string" || raw.template.length === 0) {
      problems.push("action.template: required, non-empty string");
    }
    if (raw.skipIfOpen !== undefined && typeof raw.skipIfOpen !== "boolean") {
      problems.push("action.skipIfOpen: must be a boolean when present");
    }
    return problems;
  }
  if (raw.kind === "flow-next") {
    const problems: string[] = [];
    if (typeof raw.flow !== "string" || raw.flow.length === 0) {
      problems.push("action.flow: required, non-empty string");
    }
    if (raw.dispatch !== undefined) {
      problems.push(...dispatchProblems(raw.dispatch));
    }
    return problems;
  }
  // "reconcile" / "rebuild" carry no extra fields.
  return [];
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Flow 290: every problem with an `action.dispatch` block; empty means valid. */
function dispatchProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["action.dispatch: must be an object"];
  }
  const raw = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof raw.provider !== "string" || raw.provider.trim().length === 0) {
    problems.push("action.dispatch.provider: required, non-empty string");
  }
  if (typeof raw.model !== "string" || raw.model.trim().length === 0) {
    problems.push("action.dispatch.model: required, non-empty string");
  }
  if (raw.permissionMode !== undefined) {
    if (raw.permissionMode === "auto") {
      problems.push(
        'action.dispatch.permissionMode: "auto" is never allowed for an unattended run — nobody is there to see what it ' +
          'approves. Use "ask" (read-only in effect) or "trust" (non-destructive calls run; the unattended floor still applies).',
      );
    } else if (
      typeof raw.permissionMode !== "string" ||
      !(UNATTENDED_PERMISSION_MODES as readonly string[]).includes(raw.permissionMode)
    ) {
      problems.push(`action.dispatch.permissionMode: must be one of ${UNATTENDED_PERMISSION_MODES.join(", ")}`);
    }
  }
  const rates = raw.rates;
  if (rates === undefined) {
    problems.push(
      "action.dispatch.rates: required — {inputUsdPerMTok, outputUsdPerMTok}. Without rates a run's cost cannot be " +
        "priced, so no spend ceiling could ever stop it; an unpriced dispatch is refused.",
    );
  } else if (rates === null || typeof rates !== "object" || Array.isArray(rates)) {
    problems.push("action.dispatch.rates: must be an object {inputUsdPerMTok, outputUsdPerMTok}");
  } else {
    const r = rates as Record<string, unknown>;
    // Flow 290 T13 (AC14): a zero rate prices every run at $0, so neither
    // ceiling could ever stop it — the same hole as having no rates at all.
    if (!(isNonNegativeFinite(r.inputUsdPerMTok) && r.inputUsdPerMTok > 0)) {
      problems.push("action.dispatch.rates.inputUsdPerMTok: required, a positive number (USD per million input tokens) — a zero rate would make every run free to the ceiling");
    }
    if (!(isNonNegativeFinite(r.outputUsdPerMTok) && r.outputUsdPerMTok > 0)) {
      problems.push("action.dispatch.rates.outputUsdPerMTok: required, a positive number (USD per million output tokens) — a zero rate would make every run free to the ceiling");
    }
  }
  if (raw.ceilingUsd === undefined) {
    problems.push(
      "action.dispatch.ceilingUsd: required — this trigger's own spend ceiling in USD. A dispatch without one is refused.",
    );
  } else if (!(isNonNegativeFinite(raw.ceilingUsd) && raw.ceilingUsd > 0)) {
    problems.push("action.dispatch.ceilingUsd: must be a positive number of USD");
  }
  if (raw.maxSeconds !== undefined && !(Number.isSafeInteger(raw.maxSeconds) && (raw.maxSeconds as number) > 0)) {
    problems.push("action.dispatch.maxSeconds: must be a positive integer when present");
  }
  if (raw.maxAttempts !== undefined && !(Number.isSafeInteger(raw.maxAttempts) && (raw.maxAttempts as number) > 0)) {
    problems.push("action.dispatch.maxAttempts: must be a positive integer when present");
  }
  if (raw.baseUrl !== undefined) {
    // Flow 290 T13 (review item 8): `triggers.json` is a committed file, and a
    // dispatch sends the operator's SAVED key for `provider` to `baseUrl`. A
    // merged edit pointing it at another host would hand that key over. So a
    // base URL is accepted only when it is loopback (a local model server).
    if (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0) {
      problems.push("action.dispatch.baseUrl: must be a non-empty string when present");
    } else if (!isLoopbackUrl(raw.baseUrl)) {
      problems.push(
        `action.dispatch.baseUrl: "${raw.baseUrl}" is not loopback — triggers.json is a committed file, and a non-loopback ` +
          "base URL would send the operator's saved provider key to whatever host it names. Only http(s)://localhost, " +
          "127.0.0.0/8 or [::1] is accepted.",
      );
    }
  }
  if (raw.network !== undefined && typeof raw.network !== "boolean") {
    problems.push("action.dispatch.network: must be a boolean when present");
  }
  return problems;
}

/** True for http(s) URLs whose host is localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Normalize a validated action: fills a dispatch block's defaults. */
function normalizeAction(action: TriggerAction): TriggerAction {
  if (action.kind !== "flow-next" || action.dispatch === undefined) return action;
  const raw = action.dispatch as Partial<TriggerDispatch> & Pick<TriggerDispatch, "provider" | "model" | "rates" | "ceilingUsd">;
  const dispatch: TriggerDispatch = {
    provider: raw.provider,
    model: raw.model,
    permissionMode: raw.permissionMode ?? "ask",
    rates: { inputUsdPerMTok: raw.rates.inputUsdPerMTok, outputUsdPerMTok: raw.rates.outputUsdPerMTok },
    ceilingUsd: raw.ceilingUsd,
    maxSeconds: raw.maxSeconds ?? DEFAULT_DISPATCH_MAX_SECONDS,
    maxAttempts: raw.maxAttempts ?? DEFAULT_DISPATCH_MAX_ATTEMPTS,
    network: raw.network ?? false,
    ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl } : {}),
  };
  return { kind: "flow-next", flow: action.flow, dispatch };
}

/**
 * Every problem with `value` as a {@link TriggerEntry}; empty means valid.
 * Pure, total, never throws — the loader's per-entry `try` still wraps the
 * call site because a hand-edited file can hand this a value whose shape
 * `typeof`/property access on nested fields does not expect (e.g. a string
 * where the schema assumes an object one level down); every branch here is
 * written to degrade to a problem string rather than throw, but the wrapper
 * is defence in depth for the same reason `isCustomCompatProvider` and
 * `busEventProblems` are both called from a `try` at their own use sites.
 */
export function triggerEntryProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["entry: must be an object"];
  }
  const raw = value as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof raw.name !== "string" || raw.name.length === 0) {
    problems.push("name: required, non-empty string");
  } else if (!TRIGGER_NAME_PATTERN.test(raw.name)) {
    problems.push(
      `name: "${raw.name}" must start with a letter or digit and contain only letters, digits, "-", "_" or "." (max 64 chars) — it is passed as the \`keryx trigger run <name>\` argument`,
    );
  }

  if (raw.on === undefined) {
    problems.push("on: required");
  } else {
    problems.push(...fireProblems(raw.on));
  }

  if (raw.action === undefined) {
    problems.push("action: required");
  } else {
    problems.push(...actionProblems(raw.action));
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    problems.push("enabled: must be a boolean when present");
  }

  return problems;
}

/** Parse `value` into a {@link TriggerEntry}, or `undefined` when {@link triggerEntryProblems} finds any. Never throws. */
function parseTriggerEntry(value: unknown): TriggerEntry | undefined {
  try {
    if (triggerEntryProblems(value).length > 0) return undefined;
    const raw = value as {
      name: string;
      on: { kind: "event"; event: TriggerEventName } | { kind: "schedule"; cron: string };
      action: TriggerAction;
      enabled?: boolean;
    };
    const fire: TriggerFire =
      raw.on.kind === "event" ? { kind: "event", event: raw.on.event } : { kind: "schedule", cron: raw.on.cron };
    return {
      name: raw.name,
      fire,
      action: normalizeAction(raw.action),
      enabled: raw.enabled ?? true,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** One entry the loader could not accept, and why. */
export interface RejectedTriggerEntry {
  /** Position in the `triggers` array (0-based), for pointing a hand-editor at the right entry. */
  readonly index: number;
  /** The entry's own `name`, when it had a readable string one — `undefined` when even that could not be read. */
  readonly name: string | undefined;
  readonly reasons: readonly string[];
}

export type TriggersFileProblem =
  | "absent"
  | "unreadable"
  | "not-json"
  | "not-an-object"
  | "wrong-schema-version"
  | "triggers-not-an-array";

export interface TriggersLoadResult {
  /** Valid, de-duplicated entries, in file order. */
  readonly triggers: readonly TriggerEntry[];
  /** Malformed entries, each with the reason(s) it was refused (AC1). */
  readonly rejected: readonly RejectedTriggerEntry[];
  /**
   * Set when the FILE itself could not be read as a triggers document at all
   * (absent, not JSON, wrong top-level shape, ...) — as opposed to one bad
   * entry inside an otherwise-valid file, which shows up in `rejected`
   * instead. `triggers`/`rejected` are always `[]` together with this set,
   * except `"absent"`, which is the ordinary "no trigger config yet" state,
   * not an error to surface.
   */
  readonly fileProblem: TriggersFileProblem | undefined;
}

/** Absolute path to the project's trigger config. Never created implicitly — see the file-header note on why this lives outside `metaproject.json`. */
export function triggersConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "triggers.json");
}

/**
 * Load and validate every entry in `.metaproject/triggers.json`.
 *
 * AC1: "an entry that is malformed is refused on load with the reason, and
 * the other entries still work" — never throws, and one bad entry never
 * drops its neighbours. A duplicate `name` is treated the same way a
 * structurally malformed entry is: the FIRST occurrence of a name wins and
 * loads; every later entry reusing that name is rejected with the reason,
 * exactly like any other refusal — `keryx trigger run <name>` needs `name` to
 * resolve to exactly one entry, and a loader that let the last duplicate
 * silently win would make that resolution depend on file order without
 * saying so.
 */
export function loadTriggersConfig(projectRoot: string): TriggersLoadResult {
  const empty = (fileProblem: TriggersFileProblem | undefined): TriggersLoadResult => ({
    triggers: [],
    rejected: [],
    fileProblem,
  });

  const file = triggersConfigPath(projectRoot);
  if (!existsSync(file)) {
    return empty("absent");
  }

  const read = readConfigFile(file);
  if (!read.ok) {
    // `readConfigFile`'s own reasons ("not-regular" | "too-large" | "unreadable" | "absent")
    // all collapse to "unreadable" here — none of them describe an entry, so
    // none belongs in `rejected`, and the caller only needs "the file could
    // not be read" plus (if it wants it) `read.reason` from a direct call.
    return empty("unreadable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return empty("not-json");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return empty("not-an-object");
  }
  const raw = parsed as RawTriggersFile;

  if (raw.schemaVersion !== TRIGGERS_SCHEMA_VERSION) {
    return empty("wrong-schema-version");
  }
  if (!Array.isArray(raw.triggers)) {
    return empty("triggers-not-an-array");
  }

  const triggers: TriggerEntry[] = [];
  const rejected: RejectedTriggerEntry[] = [];
  const seenNames = new Set<string>();

  raw.triggers.forEach((candidate, index) => {
    let reasons: string[];
    try {
      reasons = triggerEntryProblems(candidate);
    } catch (error) {
      reasons = [`entry: threw during validation (${error instanceof Error ? error.message : String(error)})`];
    }
    const candidateName =
      candidate !== null && typeof candidate === "object" && typeof (candidate as { name?: unknown }).name === "string"
        ? ((candidate as { name: string }).name)
        : undefined;

    if (reasons.length === 0 && candidateName !== undefined && seenNames.has(candidateName)) {
      reasons = [`name: "${candidateName}" is already used by an earlier entry in this file`];
    }

    if (reasons.length > 0) {
      rejected.push({ index, name: candidateName, reasons });
      return;
    }

    const entry = parseTriggerEntry(candidate);
    if (entry === undefined) {
      // Defensive: `triggerEntryProblems` found nothing, but the parse step
      // itself failed. Should be unreachable given the two functions agree on
      // shape; refused rather than silently dropped either way.
      rejected.push({ index, name: candidateName, reasons: ["entry: failed to parse after passing validation"] });
      return;
    }
    seenNames.add(entry.name);
    triggers.push(entry);
  });

  return { triggers, rejected, fileProblem: undefined };
}
