import type { IntakeAction } from "./types";

export interface IntakeDecideOptions {
  /** A Telegram user id, or `tui`. */
  readonly decidedBy: string;
  readonly now?: Date;
}

export interface IntakeDecideResult {
  readonly ok: boolean;
  /** One short sentence for the button toast, the modal or the CLI. */
  readonly message: string;
  readonly flowId?: string;
}

// The single door every surface (a button press, the TUI, the CLI) goes through. T9 fills it in.
export async function decideIntakeCard(
  _root: string,
  _cardId: string,
  _action: IntakeAction,
  _options: IntakeDecideOptions,
): Promise<IntakeDecideResult> {
  return { ok: false, message: "not implemented" };
}
