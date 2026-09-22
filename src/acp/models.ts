// Model selection over ACP (flow 288, AC5/AC6).
//
// ACP's mechanism is a session config option of category `model`
// ("Session Config Options", agentclientprotocol.com): returned on
// `session/new`/`session/load`, changed with `session/set_config_option`,
// pushed with `config_option_update`. There is no `session/set_model`.
//
// This file is the pure half — the choice list, the option shape, the lookup.
// WHERE the choices come from and HOW a provider is built for one is the CLI's
// business (`../commands/acp.ts`, `shellModelSource`), because both must be
// `keryx shell`'s own: the picker's detection and model listing, and the
// shell's provider factory with its grant refresh.

import type { ProviderPort } from "../harness/provider/types";
import type { AgentDeps } from "../commands/agent";
import type { AcpSessionConfigOption } from "./protocol";

/** The subset of `AgentDeps` `keryx shell` resolves per provider (flow 287). */
export type AcpTurnSettings = Pick<AgentDeps, "modelParams" | "maxOutputTokens" | "reasoningEffort">;

/** One model a session can switch to. `value` is what goes on the wire. */
export interface AcpModelChoice {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl?: string;
}

/** What a turn runs against: the provider and the per-provider settings resolved for it. */
export interface AcpModelBinding {
  readonly provider: ProviderPort;
  readonly providerId: string;
  readonly modelId: string;
  readonly turnSettings: AcpTurnSettings;
}

export interface AcpModelSource {
  /** Every model this project can run, from the same source `keryx shell`'s picker uses. */
  readonly choices: () => Promise<readonly AcpModelChoice[]>;
  /**
   * Build the provider for `choice` through the shell's path. A string is the
   * reason it cannot run — shown to the operator, never replaced by a stand-in.
   * `signal` aborts when the `/model` command asking for it is cancelled; the
   * server applies nothing after that either way.
   */
  readonly bind: (choice: AcpModelChoice, signal?: AbortSignal) => Promise<AcpModelBinding | string>;
}

/** The config option id keryx uses for the model. */
export const ACP_MODEL_CONFIG_ID = "model";

/**
 * A choice's wire value: `<provider>/<model>`. Opaque to the client and never
 * parsed back — a value is looked up in the choice list, so a model id that
 * itself contains `/` (OpenRouter's `vendor/model`) is still exact.
 */
export function acpModelValue(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function acpModelChoice(providerId: string, modelId: string, baseUrl?: string): AcpModelChoice {
  return {
    value: acpModelValue(providerId, modelId),
    name: modelId,
    description: `${providerId}`,
    providerId,
    modelId,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  };
}

/** The one `select` option of category `model`, with `currentValue` the model the session runs. */
export function acpModelConfigOption(
  choices: readonly AcpModelChoice[],
  current: AcpModelChoice,
): AcpSessionConfigOption {
  const listed = choices.some((choice) => choice.value === current.value) ? choices : [current, ...choices];
  return {
    id: ACP_MODEL_CONFIG_ID,
    name: "Model",
    description: "The model keryx runs this session's turns with. A change applies from the next turn.",
    category: "model",
    type: "select",
    currentValue: current.value,
    options: listed.map((choice) => ({
      value: choice.value,
      name: choice.name,
      ...(choice.description !== undefined ? { description: choice.description } : {}),
    })),
  };
}

/**
 * Find the choice `requested` names: its exact wire value, or — for `/model`,
 * where a person types it — a bare model id that exactly one choice carries.
 */
export function findAcpModelChoice(
  choices: readonly AcpModelChoice[],
  requested: string,
  allowBareModelId: boolean,
): AcpModelChoice | undefined {
  const exact = choices.find((choice) => choice.value === requested);
  if (exact !== undefined || !allowBareModelId) {
    return exact;
  }
  const byModel = choices.filter((choice) => choice.modelId === requested);
  return byModel.length === 1 ? byModel[0] : undefined;
}
