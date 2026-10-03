// What the shell does with a "/" line from the topic (flow 387).
//
// The gateway decides (`command-gateway.ts`); this carries it out: it runs an allowed command in
// the shell and sends what it printed back to the topic, answers the commands the bridge answers
// itself, opens the button pickers and the Yes/No questions, and refuses the rest with the
// reason. It never gives a command more than the operator could type, and it never runs anything
// the gateway did not allow.
//
// Commands run one at a time, in the order they arrived. A command that waits for a human (a
// picker, a Yes/No) does not hold the line: it is asked detached and joins the queue only when
// it has something to run.

import {
  BUSY_REASON,
  classifyRemoteCommand,
  type GatewayDecision,
  isBusyDeferred,
  refusalText,
  remoteHelpText,
} from "./command-gateway";
import { HISTORY_EMPTY_MESSAGE } from "./history";

/** What running a command in the shell produced. */
export interface CommandOutcome {
  /** Everything the command printed, as plain text. May be empty. */
  output: string;
  /** False when the shell reported an error for it. */
  ok: boolean;
}

export interface ModelChoice {
  id: string;
  label: string;
  current?: boolean;
}

export interface ModelListing {
  /** The provider these models belong to, as the topic is told it. */
  provider: string;
  models: ModelChoice[];
}

export interface ProviderChoice {
  id: string;
  label: string;
  current?: boolean;
}

export interface SessionChoice {
  id: string;
  label: string;
  current?: boolean;
}

/** What the router needs from the shell. Every member but the first two is optional. */
export interface RemoteCommandHost {
  isBusy(): boolean;
  /** Stop the running turn. The router never calls it: a command from the topic must not stop a turn. The bridge uses it for a Telegram turn's own run limit. */
  cancelTurn(): void;
  /**
   * `/stop` (flow 396): end the running turn if Telegram started it. "stopped" means it was asked to stop (the
   * bridge says so when the turn ends); "idle" means no turn is running; "operator" means the running turn
   * was started in the shell, which a topic may not stop.
   */
  stopTelegramTurn?(): "stopped" | "idle" | "operator";
  /** Run a slash line as the operator would type it and collect what it printed. */
  runCommand?(line: string): Promise<CommandOutcome>;
  /**
   * The reason the shell would not run this line right now (it is busy and the command is one
   * it defers), or undefined. Asked only while busy.
   */
  busyRefusal?(line: string): string | undefined;
  /** The models of a provider (the current one when none is named). Never includes a key or an address. */
  listModels?(providerId?: string): Promise<ModelListing | undefined>;
  /** The providers the operator already connected, usable as they are. Never a way to connect a new one. */
  listProviders?(): Promise<ProviderChoice[]>;
  /** Switch the model (and the provider, when one is named). */
  switchModel?(modelId: string, providerId?: string): Promise<CommandOutcome>;
  /** Recent sessions of this project, newest first. */
  listSessions?(): Promise<SessionChoice[]>;
  /** Make a session the live one, the way `/resume` does. */
  resumeSession?(id: string): Promise<CommandOutcome>;
}

export interface RouterLimits {
  /** After this long a command that is still running says so in the topic. */
  runningNoticeMs: number;
  /** After this long the topic stops waiting for a command and is told it is still running. Nothing is cancelled. */
  commandLimitMs: number;
  /** How long a picker or a Yes/No waits for a press. */
  choiceTimeoutMs: number;
}

export const DEFAULT_ROUTER_LIMITS: RouterLimits = { runningNoticeMs: 4_000, commandLimitMs: 120_000, choiceTimeoutMs: 120_000 };

/** The most items on one picker page; with the navigation row this stays within the eight rows a keyboard may have. */
export const PICKER_PAGE_SIZE = 7;
const LABEL_CHARS = 56;

export interface RouterContext {
  host: RemoteCommandHost;
  /** Send text to the topic. False when it could not be sent. */
  reply(text: string): Promise<boolean>;
  /**
   * `/history [N]` (flow 399): post the session's last messages to the topic. Resolves with the one
   * line to answer with when nothing was posted (usage, empty history), undefined when the messages went out.
   */
  history?(args: string): Promise<string | undefined>;
  /** One line in the bridge's recent events. */
  record(text: string): void;
  /** Redact, trim and cap text for the topic. */
  compose(text: string): string;
  /**
   * Ask the topic with buttons. Resolves with the flat index of the pressed button, or undefined
   * when nobody pressed in time (or the topic is gone).
   */
  choose(text: string, rows: string[][], timeoutMs: number, forUserId: number | undefined): Promise<number | undefined>;
  /** True while a command that swaps the session runs: the topic stays bound to it. */
  holdTopic(on: boolean): void;
  /** Whether the session was swapped since the last call; the separator line replaced the output. */
  takeSwitched(): boolean;
  limits: RouterLimits;
}

interface PickOption {
  id: string;
  label: string;
}

/** Commands that swap the live session; the topic follows them. */
const SESSION_COMMANDS: readonly string[] = ["new", "clear", "resume"];

/** How a question to the topic ended: a result, or "deferred" when a run took over the reaction. */
type AskResult = "done" | "failed" | "deferred";

/** How a command line ended, for the reaction on the message that carried it. */
export type CommandEnd = (result: "done" | "failed") => void;

function ended(end: CommandEnd | undefined, result: "done" | "failed"): void {
  try {
    end?.(result);
  } catch {
    // A reaction is a courtesy; it never changes what the command did.
  }
}

export class RemoteCommandRouter {
  private chain: Promise<void> = Promise.resolve();
  private detached = 0;
  private readonly detachedDone: Array<() => void> = [];

  constructor(private readonly ctx: RouterContext) {}

  /** Take one "/" line. Returns at once; the reply comes when the work is done. */
  handle(line: string, fromId?: number, end?: CommandEnd): void {
    const decision = classifyRemoteCommand(line);
    switch (decision.kind) {
      case "refuse":
        this.refuse(decision);
        ended(end, "failed");
        return;
      case "builtin":
        this.ctx.record(`/${decision.command}`);
        if (decision.command === "sessions") {
          this.detach(async () => {
            await this.listSessionsText();
            ended(end, "done");
          });
        } else if (decision.command === "stop") {
          this.stop(end);
        } else if (decision.command === "history") {
          // Reads the session and posts to the topic; allowed while a turn runs.
          this.detach(async () => {
            const answer = this.ctx.history === undefined ? "This shell cannot post its history." : await this.ctx.history(decision.args);
            if (answer === undefined) {
              ended(end, "done");
              return;
            }
            // An empty history is an answer, not a failure; a usage error or a refused post is one.
            ended(end, answer === HISTORY_EMPTY_MESSAGE ? "done" : "failed");
            await this.ctx.reply(this.ctx.compose(answer)).catch(() => false);
          });
        } else {
          void this.ctx.reply(this.ctx.compose(remoteHelpText())).catch(() => false);
          ended(end, "done");
        }
        return;
      case "run":
        this.enqueue(decision.line, decision.command, end);
        return;
      case "picker":
        // The reaction stays "working" until the operator answers or the question expires.
        this.detach(async () => {
          const result = await this.picker(decision.command, fromId, end);
          if (result !== "deferred") {
            ended(end, result);
          }
        });
        return;
      case "confirm":
        this.detach(async () => {
          const result = await this.confirm(decision, fromId, end);
          if (result !== "deferred") {
            ended(end, result);
          }
        });
        return;
    }
  }

  /** `/stop`: answered at once, never queued behind the turn it stops. */
  private stop(end: CommandEnd | undefined): void {
    const result = this.ctx.host.stopTelegramTurn?.() ?? "idle";
    if (result === "stopped") {
      // The topic hears "Stopped by you." when the turn has really ended.
      ended(end, "done");
      return;
    }
    const text =
      result === "operator"
        ? "/stop did nothing: the running turn was started in the shell, so only the shell can stop it."
        : "/stop did nothing: no run started from Telegram is going on.";
    this.ctx.record(`/stop: ${result === "operator" ? "turn belongs to the shell" : "nothing to stop"}`);
    void this.ctx.reply(text).catch(() => false);
    ended(end, "failed");
  }

  /** Resolves when every command taken so far, and every question asked, has finished. */
  async idle(): Promise<void> {
    await this.chain;
    if (this.detached > 0) {
      await new Promise<void>((resolve) => this.detachedDone.push(resolve));
      await this.idle();
    }
  }

  private detach(work: () => Promise<void>): void {
    this.detached += 1;
    void work()
      .catch(() => undefined)
      .finally(() => {
        this.detached -= 1;
        if (this.detached === 0) {
          for (const done of this.detachedDone.splice(0)) {
            done();
          }
        }
      });
  }

  private refuse(decision: Extract<GatewayDecision, { kind: "refuse" }>): void {
    const shown = decision.command.length === 0 ? "/" : `/${decision.command}`;
    this.ctx.record(`refused ${shown}: ${decision.reason}`);
    void this.ctx.reply(refusalText(decision.command, decision.reason)).catch(() => false);
  }

  /** Put a run on the line. Used by the gateway's `run` and by an answered Yes/No. */
  enqueue(line: string, command: string, end?: CommandEnd): void {
    this.chain = this.chain
      .then(() => this.execute(command, line, async () => (this.ctx.host.runCommand === undefined ? undefined : this.ctx.host.runCommand(line)), end))
      .catch(() => undefined);
  }

  /** The reason the shell would refuse this right now, or undefined. */
  busyReason(line: string, command: string): string | undefined {
    if (!this.ctx.host.isBusy()) {
      return undefined;
    }
    const fromHost = this.ctx.host.busyRefusal?.(line);
    if (fromHost !== undefined) {
      return fromHost;
    }
    return this.ctx.host.busyRefusal === undefined && isBusyDeferred(command) ? BUSY_REASON : undefined;
  }

  /** Run `work` under the busy check, the running notice and the time limit; the output goes to the topic. */
  private async execute(command: string, line: string, work: () => Promise<CommandOutcome | undefined>, end?: CommandEnd): Promise<void> {
    const { limits } = this.ctx;
    const busy = this.busyReason(line, command);
    if (busy !== undefined) {
      this.ctx.record(`/${command} not run: ${busy}`);
      ended(end, "failed");
      await this.ctx.reply(`/${command} was not run: ${busy}.`).catch(() => false);
      return;
    }
    this.ctx.record(`/${command} started`);
    const holds = SESSION_COMMANDS.includes(command);
    if (holds) {
      this.ctx.holdTopic(true);
    }
    let finished = false;
    const notice = setTimeout(() => {
      if (!finished) {
        void this.ctx.reply(`Still running /${command}...`).catch(() => false);
      }
    }, limits.runningNoticeMs);
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<"limit">((resolve) => {
      limitTimer = setTimeout(() => resolve("limit"), limits.commandLimitMs);
    });
    let outcome: CommandOutcome | undefined | "limit";
    try {
      outcome = await Promise.race([work(), limit]);
    } catch (error) {
      outcome = { output: error instanceof Error ? error.message : String(error), ok: false };
    } finally {
      finished = true;
      clearTimeout(notice);
      if (limitTimer !== undefined) {
        clearTimeout(limitTimer);
      }
      if (holds) {
        this.ctx.holdTopic(false);
      }
    }
    if (outcome === "limit") {
      // Never cancel anything here. The shell may be running the operator's own turn, which a
      // command from the topic has no right to stop; the command's own work is left to finish.
      this.ctx.record(`/${command} still running: stopped waiting after the time limit`);
      ended(end, "failed");
      await this.ctx
        .reply(`/${command} is still running in the shell. Stopped waiting for it after ${Math.max(1, Math.round(limits.commandLimitMs / 1000))} seconds.`)
        .catch(() => false);
      return;
    }
    if (outcome === undefined) {
      this.ctx.record(`/${command} not run: this shell cannot run it from the topic`);
      ended(end, "failed");
      await this.ctx.reply(`/${command} was not run: this shell cannot run it from the topic.`).catch(() => false);
      return;
    }
    this.ctx.record(`/${command} ${outcome.ok ? "done" : "failed"}`);
    ended(end, outcome.ok ? "done" : "failed");
    if (this.ctx.takeSwitched()) {
      // The session changed under the topic; the separator line is the answer.
      return;
    }
    const text = outcome.output.trim();
    if (text.length === 0) {
      await this.ctx.reply(outcome.ok ? `/${command}: done. It printed nothing.` : `/${command} failed. The details are in the shell.`).catch(() => false);
      return;
    }
    await this.ctx.reply(this.ctx.compose(outcome.ok ? text : `/${command} failed:\n${text}`)).catch(() => false);
  }

  // ---- Yes/No ------------------------------------------------------------------------

  private async confirm(decision: Extract<GatewayDecision, { kind: "confirm" }>, fromId: number | undefined, end: CommandEnd | undefined): Promise<AskResult> {
    const yes = decision.agent !== undefined ? `Yes, send to ${decision.agent} (paid)` : "Yes";
    // Shown in the shell's remote panel for as long as the question stays unanswered.
    this.ctx.record(`/${decision.command} waiting for a press in the topic`);
    const index = await this.ctx.choose(this.ctx.compose(decision.summary), [[this.label(yes), "No"]], this.ctx.limits.choiceTimeoutMs, fromId);
    if (index === 0) {
      this.ctx.record(`/${decision.command} confirmed in the topic`);
      // The reaction follows the run itself, not the question.
      this.enqueue(decision.line, decision.command, end);
      return "deferred";
    }
    // No, or no press in time: nothing runs, the mode and the settings stay as they were.
    this.ctx.record(index === 1 ? `/${decision.command} declined in the topic; nothing changed` : `/${decision.command} not confirmed in time; nothing changed`);
    return index === 1 ? "done" : "failed";
  }

  // ---- pickers -----------------------------------------------------------------------

  private label(text: string): string {
    const one = this.ctx.compose(text).replace(/\s+/g, " ").trim();
    const shown = one.length === 0 ? "(unnamed)" : one;
    return shown.length > LABEL_CHARS ? `${shown.slice(0, LABEL_CHARS - 3)}...` : shown;
  }

  /**
   * Show `options` as buttons, a page at a time. Resolves with the id of the pressed option, or
   * undefined when nobody pressed in time.
   */
  private async pick(title: string, options: PickOption[], fromId: number | undefined): Promise<PickOption | undefined> {
    const pages = Math.max(1, Math.ceil(options.length / PICKER_PAGE_SIZE));
    let page = 0;
    for (;;) {
      const slice = options.slice(page * PICKER_PAGE_SIZE, (page + 1) * PICKER_PAGE_SIZE);
      const rows: string[][] = slice.map((option) => [this.label(option.label)]);
      const nav: Array<"Previous" | "More"> = [];
      if (page > 0) {
        nav.push("Previous");
      }
      if (page < pages - 1) {
        nav.push("More");
      }
      if (nav.length > 0) {
        rows.push([...nav]);
      }
      const text = pages > 1 ? `${title}\nPage ${page + 1} of ${pages}` : title;
      const index = await this.ctx.choose(this.ctx.compose(text), rows, this.ctx.limits.choiceTimeoutMs, fromId);
      if (index === undefined) {
        return undefined;
      }
      if (index < slice.length) {
        return slice[index];
      }
      const pressed = nav[index - slice.length];
      page += pressed === "More" ? 1 : -1;
    }
  }

  private async picker(command: string, fromId: number | undefined, end: CommandEnd | undefined): Promise<AskResult> {
    const line = `/${command}`;
    const busy = this.busyReason(line, command);
    if (busy !== undefined) {
      this.ctx.record(`${line} not run: ${busy}`);
      await this.ctx.reply(`${line} was not run: ${busy}.`).catch(() => false);
      return "failed";
    }
    this.ctx.record(line);
    switch (command) {
      case "model":
        return await this.pickModel(undefined, fromId);
      case "connect":
        return await this.pickProvider(fromId);
      case "resume":
        return await this.pickSession(fromId, end);
      default:
        await this.ctx.reply(`${line} is not available from this shell.`).catch(() => false);
        return "failed";
    }
  }

  private async pickModel(providerId: string | undefined, fromId: number | undefined): Promise<AskResult> {
    const host = this.ctx.host;
    if (host.listModels === undefined || host.switchModel === undefined) {
      await this.ctx.reply("/model is not available from this shell.").catch(() => false);
      return "failed";
    }
    const listing = await host.listModels(providerId);
    if (listing === undefined || listing.models.length === 0) {
      await this.ctx.reply(this.ctx.compose(`There are no models to pick from${providerId !== undefined ? ` for ${providerId}` : ""}. Use the shell to connect a provider.`)).catch(() => false);
      return "failed";
    }
    const current = listing.models.find((model) => model.current === true);
    const title = `Pick a model (${listing.provider})${current !== undefined ? `\nNow: ${current.label}` : ""}`;
    const options = listing.models.map((model) => ({ id: model.id, label: model.current === true ? `* ${model.label}` : model.label }));
    const chosen = await this.pick(title, options, fromId);
    if (chosen === undefined) {
      this.ctx.record("/model not answered in time; nothing changed");
      return "failed";
    }
    const line = "/model";
    const busy = this.busyReason(line, "model");
    if (busy !== undefined) {
      await this.ctx.reply(`/model was not run: ${busy}.`).catch(() => false);
      return "failed";
    }
    const outcome = await host.switchModel(chosen.id, providerId);
    this.ctx.record(`/model ${outcome.ok ? "switched" : "failed"}`);
    const text = outcome.output.trim();
    await this.ctx.reply(this.ctx.compose(text.length > 0 ? text : outcome.ok ? `Model: ${chosen.label.replace(/^\* /, "")}.` : "The model was not changed.")).catch(() => false);
    return outcome.ok ? "done" : "failed";
  }

  private async pickProvider(fromId: number | undefined): Promise<AskResult> {
    const host = this.ctx.host;
    if (host.listProviders === undefined || host.listModels === undefined || host.switchModel === undefined) {
      await this.ctx.reply("/connect is not available from this shell.").catch(() => false);
      return "failed";
    }
    const providers = await host.listProviders();
    if (providers.length === 0) {
      await this.ctx.reply("No provider is connected yet. Connecting one needs a key, which is never typed into a chat; use the shell.").catch(() => false);
      return "failed";
    }
    const options = providers.map((provider) => ({ id: provider.id, label: provider.current === true ? `* ${provider.label}` : provider.label }));
    const chosen = await this.pick("Connected providers. Pick one to switch to:", options, fromId);
    if (chosen === undefined) {
      this.ctx.record("/connect not answered in time; nothing changed");
      return "failed";
    }
    return await this.pickModel(chosen.id, fromId);
  }

  private async pickSession(fromId: number | undefined, end: CommandEnd | undefined): Promise<AskResult> {
    const host = this.ctx.host;
    if (host.listSessions === undefined || host.resumeSession === undefined) {
      await this.ctx.reply("/resume is not available from this shell.").catch(() => false);
      return "failed";
    }
    const sessions = (await host.listSessions()).filter((session) => session.current !== true);
    if (sessions.length === 0) {
      await this.ctx.reply("There is no earlier session to return to.").catch(() => false);
      return "done";
    }
    const chosen = await this.pick("Return to an earlier session:", sessions.map((s) => ({ id: s.id, label: s.label })), fromId);
    if (chosen === undefined) {
      this.ctx.record("/resume not answered in time; nothing changed");
      return "failed";
    }
    const resume = host.resumeSession.bind(host);
    // The reaction follows the switch itself, not the question.
    this.chain = this.chain.then(() => this.execute("resume", "/resume", () => resume(chosen.id), end)).catch(() => undefined);
    return "deferred";
  }

  private async listSessionsText(): Promise<void> {
    const host = this.ctx.host;
    const busy = this.busyReason("/sessions", "sessions");
    if (busy !== undefined) {
      this.ctx.record(`/sessions not run: ${busy}`);
      await this.ctx.reply(`/sessions was not run: ${busy}.`).catch(() => false);
      return;
    }
    if (host.listSessions === undefined) {
      await this.ctx.reply("/sessions is not available from this shell.").catch(() => false);
      return;
    }
    const sessions = await host.listSessions();
    if (sessions.length === 0) {
      await this.ctx.reply("There are no recorded sessions yet.").catch(() => false);
      return;
    }
    const lines = sessions.slice(0, 20).map((session) => `${session.current === true ? "* " : "- "}${session.label}`);
    await this.ctx.reply(this.ctx.compose(`Recent sessions:\n${lines.join("\n")}`)).catch(() => false);
  }
}
