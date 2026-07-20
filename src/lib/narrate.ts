// Shared CLI helper for read-only model narrations (flow 087, item 3).
//
// Used by the model-backed "explain/suggest/plan" commands (health explain
// --narrate, test suggest, flow plan, memory reflect --narrate). Reads the
// standard --provider/--model/--json flags, runs ONE fail-closed provider turn
// via `runModelTurn`, and prints the result (or a clear fail-closed message).
// Never writes project state — narration only.

import { optionValue } from "./args";
import { runModelTurn } from "../harness/provider/single-turn";

export interface NarrateOptions {
  system: string;
  user: string;
  args: string[];
  requestId: string;
  maxOutputTokens?: number;
}

export async function narrate(opts: NarrateOptions): Promise<void> {
  const provider = optionValue(opts.args, "--provider");
  const model = optionValue(opts.args, "--model");
  const asJson = opts.args.includes("--json");

  const turn = await runModelTurn({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    system: opts.system,
    user: opts.user,
    requestId: opts.requestId,
    ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
  });

  if (!turn.credentialAvailable) {
    const message = `No credential for provider "${turn.provider}" (set its API key env var).`;
    emit(asJson, { provider: turn.provider, model: turn.model, credentialAvailable: false, error: message }, message, true);
    return;
  }

  if (turn.error) {
    const message = `${turn.error.kind}: ${turn.error.message}`;
    emit(asJson, { provider: turn.provider, model: turn.model, error: message }, message, true);
    return;
  }

  const text = turn.text.trim();
  if (asJson) {
    console.log(JSON.stringify({ provider: turn.provider, model: turn.model, text }, null, 2));
  } else {
    console.log(text);
  }
}

function emit(asJson: boolean, payload: unknown, message: string, isError: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else if (isError) {
    console.error(message);
  } else {
    console.log(message);
  }
  if (isError) {
    process.exitCode = 1;
  }
}
