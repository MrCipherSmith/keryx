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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { readConfigFile } from "../lib/config-dir";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import type { BinaryPin } from "./granted-binary";
import { grantedToolProblems } from "./granted-tools";

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
export const TRIGGER_ACTION_KINDS = ["reconcile", "rebuild", "open-flow", "flow-next", "agent-task"] as const;
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
  | { readonly kind: "flow-next"; readonly flow: string; readonly dispatch?: TriggerDispatch }
  | AgentTaskAction;

/**
 * Flow 295 (AC1): a free-form scheduled agent task, with no flow and no task
 * behind it. The operator states the prompt, the runner and its budget, and
 * the grants (network mode, granted tools, and the repositories those tools
 * may touch). An `agent-task` entry is only ever loaded from the per-machine
 * schedule store (`./store.ts`) and never from the committed `triggers.json`
 * (flow 295 C1). The dispatcher refuses it unless its content still matches
 * the hash the operator confirmed (AC5).
 */
export interface AgentTaskAction {
  readonly kind: "agent-task";
  /** The operator's own words; the dispatcher wraps them in a fixed unattended preamble. */
  readonly prompt: string;
  /** Same money-shaped fields as a `flow-next` dispatch. `maxAttempts` and `network` do not apply here (network is a grant). */
  readonly dispatch: TriggerDispatch;
  readonly grants: AgentTaskGrants;
  readonly report: { readonly keep: number };
}

/**
 * Flow 301: `allowlist` reaches only `domains` through the loopback domain proxy —
 * `off`/`full` never touch it. The sandbox still runs `--unshare-net` (same as `off`);
 * only the agent's own `shell_exec` traffic is governed — the model call and every
 * granted tool already run outside the sandbox (`trigger-agent-task.ts`).
 */
export const AGENT_TASK_NETWORK_MODES = ["off", "full", "allowlist"] as const;
export type AgentTaskNetworkMode = (typeof AGENT_TASK_NETWORK_MODES)[number];

/**
 * Flow 301 (F3): parse one `inet_aton`-style dotted part (decimal, `0x`-hex, or
 * leading-`0` octal) into a non-negative integer, or `null`. A CORE-zone module may
 * not import `src/harness/mutation/guard.ts` (client zone — no exception, see
 * `src/lib/import-zones.ts`), so this mirrors that module's `parseFlatInt` by hand;
 * keep the two in step if either changes.
 */
function parseFlatIntForDomainCheck(s: string): number | null {
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(s)) value = parseInt(s.slice(2), 16);
  else if (/^0[0-7]+$/.test(s)) value = parseInt(s.slice(1), 8);
  else if (/^[0-9]+$/.test(s)) value = parseInt(s, 10);
  else return null;
  return Number.isFinite(value) && value >= 0 && value <= 0xffffffff ? value : null;
}

/**
 * Flow 301 (F3): true when `value` parses as an `inet_aton` IPv4 address — 2 to 4
 * dotted parts, each decimal/hex/octal, in the short/mixed-radix forms a strict
 * dotted-quad regex misses (`127.1` == 127.0.0.1, `10.1.2` == 10.1.0.2). Mirrors
 * `guard.ts`'s `decodeDottedIPv4` by hand — see {@link parseFlatIntForDomainCheck}.
 */
function looksLikeInetAton(value: string): boolean {
  const parts = value.split(".");
  if (parts.length < 2 || parts.length > 4) return false;
  const nums = parts.map(parseFlatIntForDomainCheck);
  if (nums.some((n) => n === null)) return false;
  const n = nums as number[];
  if (parts.length === 4) return n.every((x) => x <= 255);
  if (parts.length === 3) return (n[0] as number) <= 255 && (n[1] as number) <= 255 && (n[2] as number) <= 0xffff;
  return (n[0] as number) <= 255 && (n[1] as number) <= 0xffffff;
}

/**
 * One allowed `allowlist` entry: an exact hostname, or a `*.domain` wildcard covering
 * the apex and every subdomain (the grammar `matchesAllowlist` enforces at proxy time).
 * Rejects an IP literal (v4 or v6, including `inet_aton` short/mixed-radix forms like
 * `127.1`), a domain whose final label is numeric or hex-numeric (no real public TLD
 * is), and a bare `*` — see {@link agentTaskDomainProblem}. The proxy
 * (`src/harness/process/sandbox/proxy.ts`) enforces the SAME rule at connect time,
 * via `looksLikeIpHost` — this is defence in depth at the data-entry point, not the
 * only gate.
 */
export function agentTaskDomainProblem(domain: unknown): string | undefined {
  if (typeof domain !== "string" || domain.trim().length === 0) return "must be a non-empty string";
  const value = domain.trim().toLowerCase();
  if (value === "*") return '"*" is not a domain — every allowlist entry names a specific domain or "*.domain"';
  if (value.includes(":")) {
    return `"${domain}" is an IP literal — the allowlist is domains only (the proxy refuses an IP-literal target at connect time too)`;
  }
  const name = value.startsWith("*.") ? value.slice(2) : value;
  if (name.length === 0) return `"${domain}" has no domain after the wildcard`;
  if (looksLikeInetAton(name)) {
    return `"${domain}" is an IP literal (inet_aton form) — the allowlist is domains only (the proxy refuses an IP-literal target at connect time too)`;
  }
  const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const labels = name.split(".");
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) {
    return `"${domain}" does not look like a domain (expected labels like "example.com" or "*.example.com")`;
  }
  const lastLabel = labels[labels.length - 1] ?? "";
  if (/^\d+$/.test(lastLabel) || /^0x[0-9a-f]+$/i.test(lastLabel)) {
    return `"${domain}"'s final label is numeric — no real public domain ends that way (this is how an IP address like "example.123" would slip past a domain check)`;
  }
  return undefined;
}

export interface AgentTaskGrants {
  /** `off` (default) keeps `--unshare-net`; `full` is the host network, always shown with NETWORK_ON_WARNING. */
  readonly network: AgentTaskNetworkMode;
  /** Flow 301: required, non-empty when `network === "allowlist"`; empty otherwise. */
  readonly domains: readonly string[];
  /**
   * Flow 301 (F2): restricts every domain in `domains` to these ports, for both plain
   * HTTP and CONNECT. Absent (undefined): the proxy's own default — 443 for CONNECT,
   * 80 for plain HTTP. "The allowlist is domains only" would otherwise mean every
   * port on an allowed host is reachable, not just the API endpoint the grant intended.
   */
  readonly ports?: readonly number[];
  /** Granted-tool catalogue ids (`./granted-tools.ts`). */
  readonly tools: readonly string[];
  /** Repositories every repo-scoped granted tool is limited to. */
  readonly repos: readonly string[];
  /** Absolute program paths resolved when the operator confirmed (`{ gh: "/usr/bin/gh" }`). Each basename equals its program. */
  readonly bins: Readonly<Record<string, string>>;
  /**
   * Flow 295 (F1d): per program, the realpath and the sha256 of the binary as it was when
   * the operator confirmed. Both are covered by the signed hash and checked again before
   * every `execFile`, so a swapped binary or a repointed symlink refuses with `grants-changed`.
   */
  readonly binDigests: Readonly<Record<string, BinaryPin>>;
  /** The account the granted tools act as, as shown on the confirmation card (display only). */
  readonly account?: string;
}

export const DEFAULT_AGENT_TASK_MAX_SECONDS = 600;
export const DEFAULT_AGENT_TASK_REPORT_KEEP = 20;

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
  /** Flow 295: where the entry came from — the committed `triggers.json` or the per-machine schedule store. */
  readonly source: TriggerEntrySource;
  /** Flow 295 (AC5): the content hash the operator confirmed. Present only on schedule-store entries. */
  readonly confirmedHash?: string;
  /**
   * Flow 295 (M1): the keryx invocation and pinned environment the operator confirmed on the
   * card. Signed with the rest of the content. Install, resume and reinstall write exactly
   * this into the unit, whichever process presses the key.
   */
  readonly install?: ConfirmedRunner;
}

/** Flow 295 (M1): what the installed timer executes — `argv` then `trigger run --schedule <name>` — and the environment it pins. */
export interface ConfirmedRunner {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * True for every argv shape `invocationArgv` (`./schedule.ts`) actually
 * produces: `[binary]` (a compiled keryx), `[interpreter, script]` (the
 * pre-R2-02 shape, still accepted so an entry stored before that fix keeps
 * validating), or `[interpreter, ...SAFE_BUN_SPAWN_ARGS, script]` (the
 * current shape — R2-02 inserts the two safe re-exec flags BETWEEN the
 * interpreter and the script for every script-based invocation, so this
 * argv is 2 longer than it used to be for that case).
 */
function isValidRunnerArgv(argv: readonly unknown[]): boolean {
  const isAbsString = (a: unknown): a is string => typeof a === "string" && path.isAbsolute(a);
  if (argv.length === 1) return isAbsString(argv[0]);
  if (argv.length === 2) return argv.every(isAbsString);
  if (argv.length === 2 + SAFE_BUN_SPAWN_ARGS.length) {
    return (
      isAbsString(argv[0]) &&
      SAFE_BUN_SPAWN_ARGS.every((flag, i) => argv[1 + i] === flag) &&
      isAbsString(argv[argv.length - 1])
    );
  }
  return false;
}

/** Problems with a stored `install` block; empty means valid. */
export function confirmedRunnerProblems(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["install: must be an object {argv, env}"];
  const raw = value as { argv?: unknown; env?: unknown };
  const problems: string[] = [];
  // R3 regression (flow 319 CI): this used to accept only 1 or 2 absolute
  // paths, predating R2-02's SAFE_BUN_SPAWN_ARGS insertion into every
  // script-based `invocationArgv` — so `draftSchedule` (which builds its
  // `install` block from `currentRunner`, which calls `invocationArgv`)
  // could never pass its own validation for any interpreter+script
  // invocation, only for a compiled-binary one. `isValidRunnerArgv` accepts
  // both the current 4-element shape and the legacy 1/2-element ones.
  if (!Array.isArray(raw.argv) || !isValidRunnerArgv(raw.argv)) {
    problems.push(
      "install.argv: must be one absolute path (the keryx binary), two absolute paths (the interpreter and keryx's entry " +
        "script), or the interpreter, the two safe re-exec flags, and the entry script",
    );
  }
  if (raw.env === null || typeof raw.env !== "object" || Array.isArray(raw.env)) {
    problems.push("install.env: must be an object of string values");
  } else {
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || typeof v !== "string") problems.push(`install.env.${k}: must be an upper-case name with a string value`);
    }
  }
  return problems;
}

export type TriggerEntrySource = "config" | "store";

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
  if (raw.kind === "agent-task") {
    return agentTaskProblems(raw);
  }
  // "reconcile" / "rebuild" carry no extra fields.
  return [];
}

/** Flow 295 (AC1, AC4): every problem with an `agent-task` action; empty means valid. */
function agentTaskProblems(raw: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (typeof raw.prompt !== "string" || raw.prompt.trim().length === 0) {
    problems.push("action.prompt: required — the free-form task the scheduled agent is given");
  } else if (raw.prompt.length > 4000) {
    problems.push("action.prompt: at most 4000 characters");
  }
  if (raw.dispatch === undefined) {
    problems.push(
      "action.dispatch: required — {provider, model, rates, ceilingUsd}. An agent task always calls a model, so it " +
        "always needs a priced runner and a ceiling.",
    );
  } else {
    problems.push(...dispatchProblems(raw.dispatch));
    const d = raw.dispatch as Record<string, unknown> | null;
    if (d !== null && typeof d === "object" && !Array.isArray(d)) {
      if (d.network !== undefined) {
        problems.push("action.dispatch.network: not used by an agent task — the network is a grant (action.grants.network)");
      }
      if (d.maxAttempts !== undefined) {
        problems.push("action.dispatch.maxAttempts: not used by an agent task — there is no flow task to retry");
      }
    }
  }
  const grants = raw.grants;
  if (grants === undefined) {
    problems.push('action.grants: required — at least {"network": "off", "tools": []}');
  } else if (grants === null || typeof grants !== "object" || Array.isArray(grants)) {
    problems.push("action.grants: must be an object");
  } else {
    problems.push(...grantsProblems(grants as Record<string, unknown>));
  }
  if (raw.report !== undefined) {
    const report = raw.report as Record<string, unknown> | null;
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
      problems.push("action.report: must be an object when present");
    } else if (report.keep !== undefined && !(Number.isSafeInteger(report.keep) && (report.keep as number) > 0 && (report.keep as number) <= 1000)) {
      problems.push("action.report.keep: must be an integer from 1 to 1000 when present");
    }
  }
  return problems;
}

function grantsProblems(grants: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const network = grants.network ?? "off";
  if (typeof network !== "string" || !(AGENT_TASK_NETWORK_MODES as readonly string[]).includes(network)) {
    problems.push(`action.grants.network: must be one of ${AGENT_TASK_NETWORK_MODES.join(", ")}`);
  }
  const domains = grants.domains ?? [];
  if (!Array.isArray(domains) || !domains.every((d) => typeof d === "string")) {
    problems.push("action.grants.domains: must be an array of strings");
  } else if (network === "allowlist") {
    if (domains.length === 0) {
      problems.push('action.grants.domains: required and non-empty when network is "allowlist" — a name or "*.domain" wildcard for every domain the agent\'s shell may reach');
    }
    for (const domain of domains) {
      const problem = agentTaskDomainProblem(domain);
      if (problem !== undefined) problems.push(`action.grants.domains: ${problem}`);
    }
  }
  // Flow 301 (F2): the allowlist restricts host AND port. Absent `ports` keeps the
  // proxy's own default (443 for CONNECT, 80 for plain HTTP); present, it REPLACES
  // that default for every listed domain, so it must not be empty (an empty list
  // would silently mean "no port at all," not "the default").
  if (grants.ports !== undefined) {
    const ports = grants.ports;
    if (!Array.isArray(ports) || ports.length === 0 || !ports.every((p) => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535)) {
      problems.push("action.grants.ports: when present, must be a non-empty array of integers 1-65535");
    }
  }
  const tools = grants.tools ?? [];
  if (!Array.isArray(tools)) {
    problems.push("action.grants.tools: must be an array of catalogue ids");
  } else {
    problems.push(...grantedToolProblems(tools));
  }
  const repos = grants.repos ?? [];
  if (!Array.isArray(repos) || !repos.every((r) => typeof r === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(r))) {
    problems.push("action.grants.repos: must be an array of owner/name repository strings");
  } else if (Array.isArray(tools) && tools.length > 0 && repos.length === 0) {
    problems.push("action.grants.repos: required when granted tools are listed — every granted tool is scoped to named repositories");
  }
  const bins = grants.bins ?? {};
  if (bins === null || typeof bins !== "object" || Array.isArray(bins)) {
    problems.push("action.grants.bins: must be an object mapping a program to its absolute path");
  } else {
    for (const [program, bin] of Object.entries(bins as Record<string, unknown>)) {
      if (typeof bin !== "string" || !path.isAbsolute(bin)) {
        problems.push(`action.grants.bins.${program}: must be an absolute path`);
      } else if (path.basename(bin) !== program) {
        // Flow 295 (F1d): `bins.gh` must be a program named `gh`, never `/bin/bash`.
        problems.push(`action.grants.bins.${program}: "${bin}" is not a program named "${program}"`);
      }
    }
  }
  const digests = grants.binDigests ?? {};
  if (digests === null || typeof digests !== "object" || Array.isArray(digests)) {
    problems.push("action.grants.binDigests: must be an object");
  } else {
    const filePinOk = (d: unknown): boolean => {
      const f = d as { realpath?: unknown; sha256?: unknown; ino?: unknown; mtimeMs?: unknown } | null;
      return (
        f !== null &&
        typeof f === "object" &&
        typeof f.realpath === "string" &&
        path.isAbsolute(f.realpath) &&
        typeof f.sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(f.sha256) &&
        (f.ino === undefined || typeof f.ino === "number") &&
        (f.mtimeMs === undefined || typeof f.mtimeMs === "number")
      );
    };
    for (const [program, digest] of Object.entries(digests as Record<string, unknown>)) {
      const interp = (digest as { interpreter?: unknown } | null)?.interpreter as { command?: unknown } | undefined;
      if (!filePinOk(digest) || (interp !== undefined && (!filePinOk(interp) || typeof interp.command !== "string"))) {
        problems.push(`action.grants.binDigests.${program}: must be {realpath (absolute), sha256 (hex), ino?, mtimeMs?, interpreter?}`);
      }
    }
  }
  if (grants.account !== undefined && typeof grants.account !== "string") {
    problems.push("action.grants.account: must be a string when present");
  }
  return problems;
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
  if (action.kind === "agent-task") return normalizeAgentTask(action);
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

function normalizeAgentTask(action: AgentTaskAction): AgentTaskAction {
  const raw = action.dispatch as Partial<TriggerDispatch> & Pick<TriggerDispatch, "provider" | "model" | "rates" | "ceilingUsd">;
  const grants = (action.grants ?? {}) as Partial<AgentTaskGrants>;
  return {
    kind: "agent-task",
    prompt: action.prompt,
    dispatch: {
      provider: raw.provider,
      model: raw.model,
      permissionMode: raw.permissionMode ?? "ask",
      rates: { inputUsdPerMTok: raw.rates.inputUsdPerMTok, outputUsdPerMTok: raw.rates.outputUsdPerMTok },
      ceilingUsd: raw.ceilingUsd,
      maxSeconds: raw.maxSeconds ?? DEFAULT_AGENT_TASK_MAX_SECONDS,
      maxAttempts: 1,
      network: (grants.network ?? "off") === "full",
      ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl } : {}),
    },
    grants: {
      network: grants.network ?? "off",
      domains: [...(grants.domains ?? [])],
      ...(grants.ports !== undefined ? { ports: [...grants.ports] } : {}),
      tools: [...(grants.tools ?? [])],
      repos: [...(grants.repos ?? [])],
      bins: { ...(grants.bins ?? {}) },
      binDigests: { ...(grants.binDigests ?? {}) },
      ...(grants.account !== undefined ? { account: grants.account } : {}),
    },
    report: { keep: action.report?.keep ?? DEFAULT_AGENT_TASK_REPORT_KEEP },
  };
}

/**
 * Flow 295 (AC5): the content an operator confirms. It covers everything that decides what
 * an `agent-task` run does: its name, cadence, prompt, runner, budget and grants,
 * including the realpath and sha256 of every granted binary. `enabled` is excluded on
 * purpose, because pause and resume are not a change of content. The input is the RAW
 * entry as stored (before defaults are filled), canonicalised by sorting object keys.
 *
 * Flow 295 (F1): this is signed with an HMAC keyed by a per-machine secret
 * (`./schedule-key.ts`), never merely hashed. Anyone could compute a plain hash for a
 * committed or forged store; only this machine's key can produce the MAC.
 */
export function scheduleContentCanonical(entry: unknown): string {
  const raw = (entry ?? {}) as Record<string, unknown>;
  // M1: `install` (the confirmed keryx invocation and pinned env) is signed too, so an
  // edit that points the timer at another program fails verification.
  return canonicalJson({ name: raw.name, on: raw.on, action: raw.action, install: raw.install });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
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
  if (raw.confirmedHash !== undefined && (typeof raw.confirmedHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.confirmedHash))) {
    problems.push("confirmedHash: must be a sha256 hex string when present");
  }
  if (raw.install !== undefined) problems.push(...confirmedRunnerProblems(raw.install));

  return problems;
}

/** Parse `value` into a {@link TriggerEntry}, or `undefined` when {@link triggerEntryProblems} finds any. Never throws. */
function parseTriggerEntry(value: unknown, source: TriggerEntrySource = "config"): TriggerEntry | undefined {
  try {
    if (triggerEntryProblems(value).length > 0) return undefined;
    const raw = value as {
      name: string;
      on: { kind: "event"; event: TriggerEventName } | { kind: "schedule"; cron: string };
      action: TriggerAction;
      enabled?: boolean;
      confirmedHash?: string;
      install?: ConfirmedRunner;
    };
    const fire: TriggerFire =
      raw.on.kind === "event" ? { kind: "event", event: raw.on.event } : { kind: "schedule", cron: raw.on.cron };
    return {
      name: raw.name,
      fire,
      action: normalizeAction(raw.action),
      enabled: raw.enabled ?? true,
      source,
      ...(raw.confirmedHash !== undefined ? { confirmedHash: raw.confirmedHash } : {}),
      ...(raw.install !== undefined ? { install: { argv: [...raw.install.argv], env: { ...raw.install.env } } } : {}),
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
  /** Position in the `triggers` array (0-based), for pointing a hand-editor at the right entry. -1 for a whole-file problem of the schedule store. */
  readonly index: number;
  /** The entry's own `name`, when it had a readable string one — `undefined` when even that could not be read. */
  readonly name: string | undefined;
  readonly reasons: readonly string[];
  /** Flow 295: which file the entry was in. */
  readonly source?: TriggerEntrySource;
}

export type TriggersFileProblem =
  | "absent"
  | "unreadable"
  | "not-json"
  | "not-an-object"
  | "wrong-schema-version"
  | "triggers-not-an-array";

export interface TriggersLoadResult {
  /** Valid, de-duplicated entries, in file order (`triggers.json` first, then the schedule store). */
  readonly triggers: readonly TriggerEntry[];
  /** Malformed entries, each with the reason(s) it was refused (AC1). */
  readonly rejected: readonly RejectedTriggerEntry[];
  /**
   * Set when `triggers.json` itself could not be read as a triggers document at all
   * (absent, not JSON, wrong top-level shape, ...) — as opposed to one bad
   * entry inside an otherwise-valid file, which shows up in `rejected`
   * instead. `triggers`/`rejected` are always `[]` together with this set,
   * except `"absent"`, which is the ordinary "no trigger config yet" state,
   * not an error to surface. Flow 295: `"absent"` means NEITHER `triggers.json`
   * NOR the schedule store exists; a broken schedule store never hides the
   * committed entries — it is reported as one rejected pseudo-entry.
   */
  readonly fileProblem: TriggersFileProblem | undefined;
}

/** Absolute path to the project's trigger config. Never created implicitly — see the file-header note on why this lives outside `metaproject.json`. */
export function triggersConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "triggers.json");
}

/**
 * Flow 295 (C1): the per-machine schedule store. Keryx writes it (`./store.ts`),
 * only after the operator confirms. It lives under `.metaproject/data/trigger/`,
 * which the unattended floor protects and which `./store.ts` makes self-ignoring,
 * so it is never committed. A merged edit to a shared file can therefore never
 * change the prompt or the grants behind an installed timer.
 */
export function scheduleStorePath(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "trigger", "schedules.json");
}

type TriggerFileRead = { readonly problem: TriggersFileProblem } | { readonly problem: undefined; readonly entries: readonly unknown[] };

function readTriggerFile(file: string): TriggerFileRead {
  if (!existsSync(file)) return { problem: "absent" };
  const read = readConfigFile(file);
  // `readConfigFile`'s own reasons all collapse to "unreadable" — none of them describe an entry.
  if (!read.ok) return { problem: "unreadable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { problem: "not-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "not-an-object" };
  const raw = parsed as RawTriggersFile;
  if (raw.schemaVersion !== TRIGGERS_SCHEMA_VERSION) return { problem: "wrong-schema-version" };
  if (!Array.isArray(raw.triggers)) return { problem: "triggers-not-an-array" };
  return { problem: undefined, entries: raw.triggers };
}

/**
 * Load and validate every entry in `.metaproject/triggers.json` and, since flow
 * 295, the per-machine schedule store.
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
/**
 * Flow 295 (F1b): is the schedule store tracked by git? A tracked store is shared
 * content, and so possibly someone else's. It is refused whole. `git ls-files
 * --error-unmatch` exits 0 only when the path is in the index. Any other exit
 * (untracked, not a repository, no git) means "not tracked".
 */
export function isScheduleStoreTracked(projectRoot: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", path.relative(projectRoot, scheduleStorePath(projectRoot))], {
      cwd: projectRoot,
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

export function loadTriggersConfig(projectRoot: string): TriggersLoadResult {
  const config = readTriggerFile(triggersConfigPath(projectRoot));
  let store = readTriggerFile(scheduleStorePath(projectRoot));
  let storeTracked = false;
  if (store.problem === undefined && isScheduleStoreTracked(projectRoot)) {
    storeTracked = true;
    store = { problem: "unreadable" };
  }

  if (config.problem !== undefined && config.problem !== "absent") {
    return { triggers: [], rejected: [], fileProblem: config.problem };
  }
  if (config.problem === "absent" && store.problem === "absent") {
    return { triggers: [], rejected: [], fileProblem: "absent" };
  }

  const triggers: TriggerEntry[] = [];
  const rejected: RejectedTriggerEntry[] = [];
  const seenNames = new Set<string>();
  // Flow 295 (F4): a local schedule's name wins over a committed trigger of the
  // same name. Otherwise a committed entry could take over the operator's timer.
  const storeNames = new Set<string>(
    store.problem === undefined
      ? store.entries
          .map((e) => (e !== null && typeof e === "object" ? (e as { name?: unknown }).name : undefined))
          .filter((n): n is string => typeof n === "string")
      : [],
  );

  const take = (candidates: readonly unknown[], source: TriggerEntrySource): void => {
    candidates.forEach((candidate, index) => {
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
      const kind = (candidate as { action?: { kind?: unknown } } | null)?.action?.kind;

      if (reasons.length === 0 && source === "config" && kind === "agent-task") {
        reasons = [
          "action.kind: an agent-task is created with `keryx schedule add` (or /schedule in the shell) and lives in the " +
            "per-machine schedule store — never in the committed triggers.json, where a merged edit could change its prompt or grants",
        ];
      }
      const fireKind = (candidate as { on?: { kind?: unknown } } | null)?.on?.kind;
      if (reasons.length === 0 && source === "store" && kind !== "agent-task") {
        reasons = ["action.kind: the schedule store holds only agent-task schedules"];
      }
      if (reasons.length === 0 && (source === "store" || kind === "agent-task") && fireKind !== "schedule") {
        // Flow 295 (F1c): a stored schedule never fires on a git event, so it is never hooked.
        reasons = ['on.kind: a stored schedule / agent-task fires only on {"kind": "schedule"} — never on a git event'];
      }
      if (reasons.length === 0 && source === "config" && candidateName !== undefined && storeNames.has(candidateName)) {
        reasons = [
          `name: "${candidateName}" is also a local schedule on this machine — the local schedule wins and this committed ` +
            "trigger is refused. Rename one of them.",
        ];
      }
      if (reasons.length === 0 && candidateName !== undefined && seenNames.has(candidateName)) {
        reasons = [`name: "${candidateName}" is already used by an earlier entry`];
      }

      if (reasons.length > 0) {
        rejected.push({ index, name: candidateName, reasons, source });
        return;
      }

      const entry = parseTriggerEntry(candidate, source);
      if (entry === undefined) {
        rejected.push({ index, name: candidateName, reasons: ["entry: failed to parse after passing validation"], source });
        return;
      }
      seenNames.add(entry.name);
      triggers.push(entry);
    });
  };

  if (config.problem === undefined) take(config.entries, "config");
  if (store.problem === undefined) {
    take(store.entries, "store");
  } else if (store.problem !== "absent") {
    rejected.push({
      index: -1,
      name: undefined,
      reasons: [
        storeTracked
          ? `schedule store ${scheduleStorePath(projectRoot)} is tracked by git — it is per-machine and must never be ` +
            "committed; a committed store may be someone else's, so none of its schedules run. `git rm --cached` it."
          : `schedule store ${scheduleStorePath(projectRoot)} could not be read (${store.problem}) — its schedules do not run`,
      ],
      source: "store",
    });
  }

  return { triggers, rejected, fileProblem: undefined };
}
