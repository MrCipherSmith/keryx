// Flow 456 (AC1): the shared framework for operator-confirmed tools — a decision only the
// human may take (lift a pass ceiling, post a review, waive coverage, mint a completion
// token, ...) asked as a yes/no CARD in the shell instead of "run this in a terminal".
//
// The pattern is flow 295's `schedule_create` (`./schedule-tools.ts`), made reusable:
//
//   1. `buildCard(input, ctx)` reads the REAL state and returns the card (title, decision
//      lines, subject) or a refusal. The driver (`agent.ts`, `executeCallUnbounded`) asks for
//      it before anything else; a refusal refuses the call without asking.
//   2. `InteractiveTool.confirmation` is set, so the driver treats the call as a hard floor:
//      every permission mode asks (`auto` included), the approval carries `alwaysAsk` + the
//      card, review-auto never grants it (`reviewAutoGrants`), and no saved pattern or MCP
//      trust grant applies. With no approver (an unattended run) the answer is "no".
//   3. The card's one-time token is held HERE, in process memory. The driver hands it to
//      `invoke` only after the operator's yes; a declined or denied card drops it. `invoke`
//      without that token — or with a token issued for a different input — applies nothing.
//      A token is used once: a replay finds nothing.
//   4. On yes, `apply(input, ctx, confirmation, prepared)` performs the effect in process,
//      with the `confirmation` record the gate stores beside its decision.
//
// Nothing here reaches a child process: no env var, file or socket carries the decision,
// because the model controls `shell_exec`'s command line and environment.
//
// Adding a gate: write an `OperatorConfirmSpec` and add it to `operatorConfirmSpecs()` below.
// `buildInteractiveAgentTools` registers every spec in that list for the interactive shell,
// and `../trigger/unattended.ts` refuses every name in it to an unattended run. Both read the
// list through functions, so a spec module may import from this file without an import cycle
// ever reading the list half-built.

import { randomUUID } from "node:crypto";
import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { otherConfirmSpecs } from "./operator-confirm-other";
import { reviewConfirmSpecs } from "./operator-confirm-review";

/** How the operator's yes reached the tool: this shell's card, or the remote topic's mirror of it. */
export type ConfirmedVia = "tui-card" | "remote-card";

/** What the operator is shown. Built from state, never from the model's input alone. */
export interface OperatorCard {
  /** The yes/no question, e.g. `Lift the review pass ceiling to 31 for package X?`. */
  readonly title: string;
  /** The decision, one line each: what changes, the exact effect, the numbers. */
  readonly lines: readonly string[];
  /** What the decision binds to: a package, flow id, patch hash, schedule name. */
  readonly subject: string;
}

/** The record a gate stores beside its decision. */
export interface OperatorConfirmation {
  /** `"<card title>: yes"`. The card text plus the answer is the operator's quote. */
  readonly quote: string;
  readonly answer: "yes";
  /** ISO time of the answer (when `invoke` ran, right after the yes). */
  readonly at: string;
  readonly confirmedVia: ConfirmedVia;
  /** Flow 464: the Telegram user id that pressed the button. Present only when `confirmedVia` is `"remote-card"`. */
  readonly pressedBy?: number;
  /** Flow 464: ISO time of that press. Present only when `confirmedVia` is `"remote-card"`. */
  readonly pressedAt?: string;
  readonly subject: string;
  /** The card exactly as shown, title first. */
  readonly card: readonly string[];
}

/** What a spec is handed. `signal` is present only in `apply`. */
export interface OperatorConfirmContext {
  readonly projectRoot: string;
  readonly now: () => Date;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

/** A card, or why there is nothing to confirm. `prepared` is handed to `apply` unchanged. */
export type OperatorCardResult<P> = (OperatorCard & { readonly prepared?: P }) | { readonly refusal: string };

/** The result of the effect. `isError` defaults to false. */
export interface OperatorApplyResult {
  readonly output: string;
  readonly isError?: boolean;
}

/**
 * One operator-confirmed gate. `buildCard`/`apply` are methods (bivariant), so a spec with its own
 * `prepared` type is still an `OperatorConfirmSpec` in the registry's list.
 */
export interface OperatorConfirmSpec<P = unknown> {
  readonly name: string;
  /** What the model reads. The framework appends that the operator always confirms. */
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  buildCard(input: Record<string, unknown>, ctx: OperatorConfirmContext): Promise<OperatorCardResult<P>>;
  /**
   * The effect, after the operator's yes. Receives what `buildCard` prepared for exactly this card,
   * so it applies what was shown and never re-reads a decision the operator did not see.
   */
  apply(
    input: Record<string, unknown>,
    ctx: OperatorConfirmContext,
    confirmation: OperatorConfirmation,
    prepared: P | undefined,
  ): Promise<OperatorApplyResult>;
}

export interface OperatorConfirmBinding {
  readonly projectRoot: string;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Flow 464 (AC2): the Telegram user ids allowed to answer a card from the topic (`allowedUserIds` of the remote
   * config). The hub already drops a press from any other id; this is the second check, at the record. Absent or
   * returning nothing, no remote answer is accepted.
   */
  readonly allowedUserIds?: () => readonly number[] | undefined;
}

/** Flow 464: a remote card answer counts for one hour after the card was asked. */
export const REMOTE_CARD_TTL_MS = 60 * 60 * 1000;

/** Appended to every spec's description, so the model never tells the operator to go to a terminal. */
export const OPERATOR_CONFIRM_NOTE =
  " The operator ALWAYS sees a yes/no card in the shell and must answer it — you cannot confirm it, and you " +
  "must not ask them to run a command in a terminal instead.";

/**
 * A keryx started from an agent's `shell_exec` inherits `KERYX_TOOL_CALL=1`, and an agent can type into such a
 * nested shell through a pseudo-terminal — so no card is ever asked there, whatever answers its prompt. The same
 * defence `nestedAgentScheduleRefusal` gives schedules, for every gate.
 */
export function nestedAgentCardRefusal(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env["KERYX_TOOL_CALL"] !== "1") return undefined;
  return (
    "refused: this keryx was started from an agent's shell (KERYX_TOOL_CALL=1), and an agent can type into it. " +
    "An operator-confirmed decision is taken only in your own terminal's keryx."
  );
}

/** The card as the approver prints it: title, the decision lines, the subject. */
export function renderOperatorCard(card: OperatorCard): readonly string[] {
  return [card.title, ...card.lines, `subject: ${card.subject}`];
}

function blank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/** Turn a spec into the tool the driver gates. */
export function operatorConfirmTool<P>(spec: OperatorConfirmSpec<P>, binding: OperatorConfirmBinding): InteractiveTool {
  const now = binding.now ?? (() => new Date());
  const env = binding.env ?? process.env;
  const context = (signal?: AbortSignal): OperatorConfirmContext => ({
    projectRoot: binding.projectRoot,
    now,
    env,
    ...(signal !== undefined ? { signal } : {}),
  });
  // The card whose yes is pending, keyed by its one-time token. Held only here.
  const pending = new Map<
    string,
    {
      readonly input: string;
      readonly card: OperatorCard;
      readonly shown: readonly string[];
      readonly prepared: P | undefined;
      readonly issuedAt: number;
    }
  >();
  const key = (input: Record<string, unknown>): string => JSON.stringify(input);

  return {
    definition: {
      name: spec.name,
      description: `${spec.description}${OPERATOR_CONFIRM_NOTE}`,
      inputSchema: spec.inputSchema,
      risk: "write",
    },
    confirmation: async (input) => {
      const nested = nestedAgentCardRefusal(env);
      if (nested !== undefined) return { error: nested };
      let built: OperatorCardResult<P>;
      try {
        built = await spec.buildCard(input, context());
      } catch (error) {
        return { error: `could not read the state to confirm: ${error instanceof Error ? error.message : String(error)}` };
      }
      if ("refusal" in built) return { error: built.refusal };
      if (blank(built.title) || blank(built.subject)) {
        return { error: "the card has no title or subject — nothing to confirm" };
      }
      const card: OperatorCard = { title: built.title, lines: [...built.lines], subject: built.subject };
      const shown = renderOperatorCard(card);
      const token = randomUUID();
      pending.set(token, { input: key(input), card, shown, prepared: built.prepared, issuedAt: now().getTime() });
      return { card: shown, title: card.title, token };
    },
    confirmationDeclined: (token) => {
      pending.delete(token);
    },
    invoke: async (input, ctx): Promise<InteractiveToolResult> => {
      const token = ctx?.confirmationToken;
      const entry = token === undefined ? undefined : pending.get(token);
      const refuse = (why: string): InteractiveToolResult => ({ output: `${spec.name}: ${why} — nothing was changed`, isError: true });
      if (entry === undefined || entry.input !== key(input)) {
        if (token !== undefined) pending.delete(token);
        return refuse("no operator-confirmed card for this request");
      }
      pending.delete(token as string);
      const remote = ctx?.confirmationVia === "remote";
      let pressedBy: number | undefined;
      let pressedAt: string | undefined;
      if (remote) {
        pressedBy = ctx?.confirmationPressedBy;
        pressedAt = ctx?.confirmationPressedAt;
        const allowed = binding.allowedUserIds?.();
        if (pressedBy === undefined || pressedAt === undefined) return refuse("the remote answer did not say who pressed it");
        if (allowed === undefined || !allowed.includes(pressedBy)) {
          return refuse(`Telegram user ${pressedBy} is not on the allowed list`);
        }
        if (now().getTime() - entry.issuedAt > REMOTE_CARD_TTL_MS) {
          return refuse("the card is older than 1 hour; ask again");
        }
      }
      const confirmation: OperatorConfirmation = {
        quote: `${entry.card.title}: yes`,
        answer: "yes",
        at: now().toISOString(),
        confirmedVia: remote ? "remote-card" : "tui-card",
        ...(remote ? { pressedBy: pressedBy as number, pressedAt: pressedAt as string } : {}),
        subject: entry.card.subject,
        card: entry.shown,
      };
      try {
        const result = await spec.apply(input, context(ctx?.signal), confirmation, entry.prepared);
        return { output: result.output, isError: result.isError ?? false };
      } catch (error) {
        return { output: `${spec.name} failed after the operator's yes: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };
}

/**
 * The registry: every operator-confirmed gate the interactive shell offers. A function, not a
 * constant, so a spec module that imports this file is never read half-built through a cycle.
 */
export function operatorConfirmSpecs(): readonly OperatorConfirmSpec[] {
  return [...reviewConfirmSpecs(), ...otherConfirmSpecs()];
}

/** The names in the registry — what `../trigger/unattended.ts` refuses to an unattended run. */
export function operatorConfirmToolNames(): readonly string[] {
  return operatorConfirmSpecs().map((spec) => spec.name);
}

/** The registered gates as tools, for `buildInteractiveAgentTools`. */
export function operatorConfirmTools(
  binding: OperatorConfirmBinding,
  specs: readonly OperatorConfirmSpec[] = operatorConfirmSpecs(),
): InteractiveTool[] {
  return specs.map((spec) => operatorConfirmTool(spec, binding));
}
