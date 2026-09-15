// The readline host for `ask_user` — the surface the OpenTUI dock is to the TUI.
//
// Why this exists: `setAskUserHost` had exactly ONE caller (`src/tui/tui-shell.ts`),
// so on every other surface — `keryx shell --no-tui`, a non-TTY, or any TUI init
// falling back to readline (`src/commands/shell.ts`'s documented fallback path) —
// a model's question reached the bridge with no host and answered itself
// `ASK_USER_NO_HOST`. The model then chose an option on the user's behalf while
// the transcript said the question had been put to a human. Nothing was broken in
// the mode logic: the surface simply had no way to ask. This is that way.
//
// Shape follows `src/mcp-servers/approval-render.ts`, for the reason that module
// records: the DECISION is the half that must be testable, and a prompt whose
// verdict is welded to a terminal is a prompt no suite can drive. This function
// touches no terminal — IO is injected — so a test feeds a real answer and asserts
// the real returned id.
//
// It reads through the shell's SINGLE shared line iterator (the same one
// `requestApproval` uses mid-turn), so a question never races the main REPL loop.

import { ASK_USER_CANCEL, ASK_USER_UNANSWERABLE } from "../harness/tool/builtin/ask-user-tool";

export interface AskUserPromptIo {
  readonly out: (text: string) => void;
  /** `undefined` means end of input — nobody is left who could answer. */
  readonly readLine: () => Promise<string | undefined>;
}

export interface AskUserPromptOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

export interface AskUserPromptRequest {
  readonly question: string;
  readonly options: readonly AskUserPromptOption[];
  readonly allowFreeform?: boolean;
}

type Paint = {
  readonly yellow: (t: string) => string;
  readonly dim: (t: string) => string;
  readonly green: (t: string) => string;
};

const IDENTITY: Paint = { yellow: (t) => t, dim: (t) => t, green: (t) => t };

/** Retries on an unparseable answer before giving up, so a typo is not a cancel. */
const MAX_REREAD = 2;

/**
 * Render `request` and resolve the answer.
 *
 * Returns an option id, freeform text, {@link ASK_USER_CANCEL} (the human
 * declined or could not be understood — a real, seen dismissal), or
 * {@link ASK_USER_UNANSWERABLE} (end of input: no human remains, so NO answer
 * exists). Those two are never collapsed into each other — the tool result and
 * the model's next move differ, and that collapse is the original bug.
 */
export async function promptAskUser(
  io: AskUserPromptIo,
  request: AskUserPromptRequest,
  style: Paint = IDENTITY,
  gutter = "",
): Promise<string> {
  const options = request.options;
  io.out(`\n${gutter}${style.yellow(`? ${request.question}`)}\n`);
  options.forEach((option, index) => {
    const mark = option.recommended === true ? style.green(" (recommended)") : "";
    const desc = option.description !== undefined && option.description.length > 0 ? ` — ${option.description}` : "";
    io.out(`${gutter}  ${style.dim(`${index + 1}) ${option.label}${mark}`)}${style.dim(desc)}\n`);
  });
  // Names the accepted vocabulary rather than leaving it to be guessed: an
  // unparseable answer here must be a visible retry, never a silent dismissal.
  const hint =
    request.allowFreeform === true
      ? `[1-${options.length} or type an answer, Enter to skip] `
      : `[1-${options.length}, Enter to skip] `;

  for (let attempt = 0; attempt <= MAX_REREAD; attempt += 1) {
    io.out(`${gutter}${style.dim(attempt === 0 ? hint : `[1-${options.length}, Enter to skip] `)}`);
    const answer = await io.readLine();
    if (answer === undefined) {
      // EOF is not a refusal. A refused question was seen; this one cannot be.
      io.out(`${style.dim("no input — nobody could answer\n")}\n`);
      return ASK_USER_UNANSWERABLE;
    }
    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      io.out(`${style.dim("skipped\n")}\n`);
      return ASK_USER_CANCEL;
    }
    const numeric = Number.parseInt(trimmed, 10);
    if (Number.isFinite(numeric) && String(numeric) === trimmed && numeric >= 1 && numeric <= options.length) {
      const picked = options[numeric - 1]!;
      io.out(`${style.green(`→ ${picked.label}`)}\n`);
      return picked.id;
    }
    // Also accept an exact id (`mvp`), which is what a scripted/piped session
    // and the TUI's own ids both speak.
    const byId = options.find((option) => option.id === trimmed);
    if (byId !== undefined) {
      io.out(`${style.green(`→ ${byId.label}`)}\n`);
      return byId.id;
    }
    if (request.allowFreeform === true) {
      io.out(`${style.green(`→ ${trimmed}`)}\n`);
      return trimmed;
    }
    if (attempt === MAX_REREAD) {
      io.out(`${style.dim(`not one of 1-${options.length} — skipped\n`)}\n`);
      return ASK_USER_CANCEL;
    }
    io.out(`${style.dim(`not a valid choice — answer 1-${options.length} or press Enter to skip\n`)}`);
  }
  // Unreachable: the loop returns or exhausts at MAX_REREAD. Fail closed anyway.
  return ASK_USER_CANCEL;
}
