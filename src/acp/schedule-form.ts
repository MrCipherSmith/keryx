// The desktop `/schedule` form (Keryx Desktop Client M2a, specification §3.9.1 "Views").
//
// The shell's `/schedule` takes free text (`--every "<cadence>"`, `--rates in,out`, the session's
// provider) and refuses what it cannot parse or price. A form must not let a person type its way
// into those refusals, so this file builds the form from the shell's own rules and converts what
// the form submits back to the shell's flags:
//
//   - cadence: the allowed minute and hour steps are read FROM `parseCadence` (every N that it
//     accepts), never listed here;
//   - provider: only the connected providers the schedule's usage-reporting rule accepts
//     (`providerReportsUsage`, the function the draft and the dispatcher both use);
//   - rates: two numbers, composed to `in,out`.
//
// The form-friendly flags (`--repeat --minutes --hours --at --cron --rate-in --rate-out`) exist only
// on this surface; `toShellScheduleLine` turns them into the shell's `--every` and `--rates`
// before the shell's own parser sees the line, so the shell's CLI flags are unchanged.

import { providerReportsUsage } from "../commands/trigger-dispatch";
import { loadModelProfiles, profileKey } from "../harness/routing/model-profile";
import { parseCadence } from "../trigger/cron";
import { providerUsageRefusal } from "../trigger/schedules";
import { tokenizeArgs, SCHEDULE_SLASH_USAGE } from "../tui/schedule-command";
import type { AcpModelChoice } from "./models";
import type { ShellCommandHost } from "./shell-command-runners";
import type { ShellView, ShellViewField } from "./shell-views";

/** Every N (within `range`) that the shell's cadence parser accepts for `unit`. */
function acceptedSteps(unit: "minutes" | "hours", max: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max; n += 1) if (parseCadence(`every ${n} ${unit}`).ok) out.push(n);
  return out;
}

export const SCHEDULE_MINUTE_STEPS: readonly number[] = acceptedSteps("minutes", 59);
export const SCHEDULE_HOUR_STEPS: readonly number[] = acceptedSteps("hours", 23);

const REPEAT_OPTIONS = [
  { value: "minutes", label: "every N minutes" },
  { value: "hours", label: "every N hours" },
  { value: "daily", label: "daily" },
  { value: "weekdays", label: "weekdays (Mon-Fri)" },
  { value: "cron", label: "cron (advanced)" },
] as const;

const TIME_NOTE = "HH:MM, 00:00-23:59";

/** The session model's "<in>,<out>" USD per million tokens when keryx knows the price (stored or curated profile). */
export function knownRatePair(host: ShellCommandHost, providerId: string, modelId: string): { input: number; output: number } | undefined {
  try {
    const profile = loadModelProfiles(host.configDir)[profileKey(providerId, modelId)];
    const input = profile?.priceInputPerMillion.value;
    const output = profile?.priceOutputPerMillion.value;
    return typeof input === "number" && typeof output === "number" ? { input, output } : undefined;
  } catch {
    return undefined;
  }
}

interface ProviderModels {
  readonly provider: string;
  readonly models: readonly string[];
}

/** Connected providers (the model picker's own detection) with their models, the session's model always among them. */
async function connectedProviders(host: ShellCommandHost, session: { providerId: string; modelId: string }): Promise<ProviderModels[]> {
  const choices: readonly AcpModelChoice[] = await Promise.resolve(host.modelChoices?.()).then(
    (listed) => listed ?? [],
    () => [],
  );
  const order: string[] = [];
  const byProvider = new Map<string, string[]>();
  const add = (provider: string, model: string): void => {
    let list = byProvider.get(provider);
    if (list === undefined) {
      list = [];
      byProvider.set(provider, list);
      order.push(provider);
    }
    if (!list.includes(model)) list.push(model);
  };
  add(session.providerId, session.modelId);
  for (const choice of choices) add(choice.providerId, choice.modelId);
  return order.map((provider) => ({ provider, models: byProvider.get(provider) ?? [] }));
}

const numberOf = (value: number): string => String(value);

/** The form `/schedule` opens with: every selectable value is one the shell accepts. */
export async function scheduleFormView(host: ShellCommandHost): Promise<ShellView> {
  const session = host.session.modelIds();
  const reportsUsage = host.scheduleOverrides?.providerReportsUsage ?? providerReportsUsage;
  const allowed = (await connectedProviders(host, session)).filter((entry) => reportsUsage(entry.provider));
  const usage = SCHEDULE_SLASH_USAGE.join("\n");
  if (allowed.length === 0) {
    return {
      title: "Schedule",
      rows: [],
      body: `No connected provider can run a schedule. ${providerUsageRefusal(session.providerId)}\n\n${usage}`,
      form: { fields: [], submit: "/schedule", disabled: "Connect a provider that reports token usage (anthropic, openai, gemini, grok, deepseek) to create a schedule." },
    };
  }
  const chosen = allowed.find((entry) => entry.provider === session.providerId) ?? allowed[0]!;
  const defaultModel = chosen.provider === session.providerId && chosen.models.includes(session.modelId) ? session.modelId : (chosen.models[0] ?? session.modelId);
  const rates = knownRatePair(host, chosen.provider, defaultModel);
  const minutesDefault = SCHEDULE_MINUTE_STEPS.includes(30) ? "30" : numberOf(SCHEDULE_MINUTE_STEPS[0] ?? 30);
  const hoursDefault = SCHEDULE_HOUR_STEPS.includes(4) ? "4" : numberOf(SCHEDULE_HOUR_STEPS[0] ?? 1);
  const modelFields: ShellViewField[] = allowed.map((entry) => ({
    id: `model:${entry.provider}`,
    label: "Model",
    kind: "choice",
    required: true,
    options: entry.models.length > 0 ? [...entry.models] : [session.modelId],
    ...(entry.provider === chosen.provider ? { value: defaultModel } : {}),
    showWhen: { field: "provider", equals: [entry.provider] },
  }));
  const fields: ShellViewField[] = [
    { id: "name", label: "Name", kind: "text", required: true, placeholder: "e.g. nightly-review" },
    { id: "repeat", label: "Repeat", kind: "choice", required: true, options: [...REPEAT_OPTIONS], value: "hours" },
    {
      id: "minutes",
      label: "Every (minutes)",
      kind: "choice",
      required: true,
      options: SCHEDULE_MINUTE_STEPS.map(numberOf),
      value: minutesDefault,
      showWhen: { field: "repeat", equals: ["minutes"] },
    },
    {
      id: "hours",
      label: "Every (hours)",
      kind: "choice",
      required: true,
      options: SCHEDULE_HOUR_STEPS.map(numberOf),
      value: hoursDefault,
      showWhen: { field: "repeat", equals: ["hours"] },
    },
    {
      id: "at",
      label: "At (HH:MM)",
      kind: "time",
      required: true,
      value: "09:00",
      placeholder: "09:00",
      error: `Use ${TIME_NOTE}`,
      showWhen: { field: "repeat", equals: ["daily", "weekdays"] },
    },
    {
      id: "cron",
      label: "Cron expression",
      kind: "text",
      required: true,
      placeholder: "e.g. 0 9 * * 1-5",
      pattern: "^[0-9*/,a-zA-Z -]+$",
      error: "Five space-separated cron fields, for example 0 9 * * 1-5",
      showWhen: { field: "repeat", equals: ["cron"] },
    },
    { id: "provider", label: "Provider", kind: "choice", required: true, options: allowed.map((entry) => entry.provider), value: chosen.provider },
    ...modelFields,
    {
      id: "rateIn",
      label: "Input $/1M",
      kind: "number",
      required: true,
      min: 0,
      step: 0.01,
      ...(rates !== undefined ? { value: numberOf(rates.input) } : {}),
      placeholder: "USD per million input tokens",
      error: "Enter the price as a number, 0 or more",
    },
    {
      id: "rateOut",
      label: "Output $/1M",
      kind: "number",
      required: true,
      min: 0,
      step: 0.01,
      ...(rates !== undefined ? { value: numberOf(rates.output) } : {}),
      placeholder: "USD per million output tokens",
      error: "Enter the price as a number, 0 or more",
    },
    { id: "ceiling", label: "Spend ceiling per run, USD", kind: "number", required: true, min: 0.01, step: 0.01, value: "0.50", error: "Enter an amount above 0" },
    { id: "prompt", label: "What the agent should do", kind: "text", required: true, placeholder: "e.g. Review yesterday's commits and report risks" },
  ];
  const modelFlags = allowed.map((entry) => `--model {model:${entry.provider}}`).join(" ");
  return {
    title: "Schedule",
    rows: [],
    body: usage,
    form: {
      fields,
      submitLabel: "Create",
      submit: `/schedule --name {name} --repeat {repeat} --minutes {minutes} --hours {hours} --at {at} --cron "{cron}" --provider {provider} ${modelFlags} --rate-in {rateIn} --rate-out {rateOut} --ceiling {ceiling} -- {prompt}`,
    },
  };
}

// ---------------------------------------------------------------------------
// The form's flags -> the shell's flags
// ---------------------------------------------------------------------------

const FORM_FLAGS = new Set(["--repeat", "--minutes", "--hours", "--at", "--cron", "--rate-in", "--rate-out"]);

/** The index in `raw` where the prompt starts (a bare `--` outside quotes), or -1. */
function promptStart(raw: string): number {
  let quote: string | undefined;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "-" && raw[i + 1] === "-" && (i === 0 || /\s/.test(raw[i - 1]!)) && (i + 2 >= raw.length || /\s/.test(raw[i + 2]!))) return i;
  }
  return -1;
}

const quoted = (token: string): string => (/[\s"']/.test(token) || token === "" ? `"${token.replace(/"/g, "")}"` : token);

/** The shell's cadence phrase for the form's Repeat choice and its dependent value. */
function cadenceFor(repeat: string, flags: Map<string, string>): { phrase: string } | { error: string } {
  const need = (flag: string, what: string): string | { error: string } => {
    const value = flags.get(flag);
    return value === undefined || value.trim() === "" ? { error: `${what} is required` } : value.trim();
  };
  if (repeat === "minutes" || repeat === "hours") {
    const n = need(repeat === "minutes" ? "--minutes" : "--hours", repeat === "minutes" ? "Every (minutes)" : "Every (hours)");
    return typeof n === "string" ? { phrase: `every ${n} ${repeat}` } : n;
  }
  if (repeat === "daily" || repeat === "weekdays") {
    const at = need("--at", "At (HH:MM)");
    return typeof at === "string" ? { phrase: `${repeat} at ${at}` } : at;
  }
  if (repeat === "cron") {
    const cron = need("--cron", "Cron expression");
    return typeof cron === "string" ? { phrase: cron } : cron;
  }
  return { error: `Repeat must be one of ${REPEAT_OPTIONS.map((o) => o.value).join(", ")}, not "${repeat}"` };
}

/**
 * Turns a line written by the form into the shell's own `/schedule` arguments: `--repeat` and its
 * parts become `--every "<cadence>"`, `--rate-in/--rate-out` become `--rates in,out`. A line
 * without the form's flags (a hand-typed `/schedule --every ...`) is returned as it is. Nothing is
 * validated here beyond what is missing: the shell's parser is still the one that accepts or refuses.
 */
export function toShellScheduleLine(raw: string): { readonly line: string } | { readonly error: string } {
  const cut = promptStart(raw);
  const head = cut >= 0 ? raw.slice(0, cut) : raw;
  const tail = cut >= 0 ? raw.slice(cut) : "";
  const tokens = tokenizeArgs(head);
  // `--cron` is also a flag of the shell itself: only a line with the form's own flags is rewritten.
  if (!tokens.some((token) => token === "--repeat" || token === "--rate-in" || token === "--rate-out")) return { line: raw };
  const flags = new Map<string, string>();
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (FORM_FLAGS.has(token)) {
      flags.set(token, tokens[i + 1] ?? "");
      i += 1;
    } else kept.push(token);
  }
  if (flags.has("--repeat")) {
    const cadence = cadenceFor(flags.get("--repeat") ?? "", flags);
    if ("error" in cadence) return cadence;
    kept.push("--every", cadence.phrase);
  }
  if (flags.has("--rate-in") || flags.has("--rate-out")) {
    const input = flags.get("--rate-in")?.trim() ?? "";
    const output = flags.get("--rate-out")?.trim() ?? "";
    if (input === "" || output === "") return { error: "Input $/1M and Output $/1M are both required" };
    kept.push("--rates", `${input},${output}`);
  }
  return { line: `${kept.map(quoted).join(" ")}${tail.length > 0 ? ` ${tail}` : ""}` };
}
