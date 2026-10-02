// Flow 374: the two rules of `/settings` that live in the shell but must be
// testable without mounting it — which slash line goes to which handler, and
// when the modal may be opened at all. Both are pure over injected handlers.

export interface SettingsActionHandlers {
  /** `/mode <mode>` through the command's own handler, `auto`'s confirmation dialog included. */
  mode: (line: string) => void;
  /** The mode change itself, after a confirmation has already happened. */
  commitMode: (mode: "auto") => void;
  plan: (line: string) => void;
  guard: (on: boolean) => void;
  editGuard: (on: boolean) => Promise<void>;
  route: (on: boolean) => void;
  external: (value: "on" | "off") => Promise<void>;
  /** `/external-agents [on|off]`: the text to show. */
  externalAgents: (arg: string) => Promise<string>;
  /** `/rendering [mode]` (flow 395): the text to show. */
  rendering: (arg: string) => string;
  reasoning: (arg: string) => void;
  think: (arg: string) => void;
  theme: (arg: string) => void;
  onSystem: (text: string) => void;
}

/**
 * Runs one button's slash line. Never rejects: a failure is reported through
 * `onSystem`, the way the typed command reports its own, so the modal always
 * gets to rebuild its rows afterwards.
 *
 * `/mode auto` goes straight to `commitMode`: the modal only hands it over after
 * its own second Enter, so the dialog `/mode auto` would show is already answered.
 * No line built by the rows ever carries `save` or `clear`, so a press never
 * writes the project's permission-mode default.
 */
export async function runSettingsCommand(command: string, handlers: SettingsActionHandlers): Promise<void> {
  const [name = "", ...rest] = command.trim().split(/\s+/);
  const arg = rest.join(" ");
  try {
    switch (name) {
      case "/mode":
        if (arg === "auto") handlers.commitMode("auto");
        else handlers.mode(command);
        return;
      case "/plan":
        handlers.plan(command);
        return;
      case "/guard":
        handlers.guard(arg === "on");
        return;
      case "/editguard":
        await handlers.editGuard(arg === "on");
        return;
      case "/route":
        handlers.route(arg === "on");
        return;
      case "/external":
        await handlers.external(arg === "on" ? "on" : "off");
        return;
      case "/external-agents":
        handlers.onSystem(await handlers.externalAgents(arg));
        return;
      case "/rendering":
        handlers.onSystem(handlers.rendering(arg));
        return;
      case "/reasoning":
        handlers.reasoning(arg);
        return;
      case "/think":
        handlers.think(arg);
        return;
      case "/theme":
        handlers.theme(arg);
        return;
    }
  } catch (error) {
    handlers.onSystem(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Whether the modal may open now. A pending approval dock owns the keyboard and
 * the pointer (opening over it would let two clicks commit `auto` without the
 * dialog), and `/settings` typed during a turn is deferred, so a click is refused
 * too rather than opening a modal whose buttons would each be deferred if typed.
 */
export function settingsOpenDecision(state: { overlayActive: boolean; busy: boolean }): { open: true } | { open: false; message?: string } {
  if (state.overlayActive) return { open: false };
  if (state.busy) return { open: false, message: "/settings opens once the current turn is done.\n" };
  return { open: true };
}
