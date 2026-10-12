// "Automatic review": a review run the operator asked the shell to drive on its
// own. It is a property of one turn, not a permission mode — the mode still
// decides every approval the review does not cover (see AutomaticReviewRun).
// What it changes: the round limit (./round-limit.ts: 200, no question at the
// limit), the approval of the review's OWN commands and files, and which
// questions reach the operator.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ASK_USER_EMERGENCIES } from "../harness/tool/builtin/ask-user-tool";
import type { InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { describeAutomaticReviewLimit } from "./round-limit";

/** The flag that records the mode on a review package's manifest. */
export const AUTOMATIC_REVIEW_FLAG = "--automatic";

/**
 * The `keryx review` subcommands an automatic review runs against its own
 * package without asking. `gate refusal` handling stays in `review complete`
 * itself: nothing here is a way around it.
 */
export const AUTOMATIC_REVIEW_CREATE_SUBCOMMANDS = ["start", "attach", "ingest"] as const;
export const AUTOMATIC_REVIEW_PACKAGE_SUBCOMMANDS = [
  "status",
  "ledger",
  "retry-plan",
  "severity-audit",
  "mutate",
  "complete",
  "compare-reference",
] as const;

/** Where the run's manual-vs-automatic input counts and defaulted answers are written, inside the package. */
export const AUTOMATIC_REVIEW_DISCLOSURE_FILE = "automatic-run-inputs.json";

const PHRASES: readonly RegExp[] = [
  /\bautomatic(?:ally)?[\s-]+(?:code[\s-]+|pr[\s-]+)?review\b/i,
  /\bauto[\s-]?review\b/i,
  /автоматическ\p{L}*\s+(?:код[\s-]?)?ревью/iu,
  /авто[\s-]?ревью/iu,
];

/** True when the operator's own line asks for an automatic review. */
export function isAutomaticReviewRequest(line: string): boolean {
  return PHRASES.some((phrase) => phrase.test(line));
}

/**
 * Appended to the operator's line for an automatic-review turn so the review
 * package the model creates records the mode, and so the model knows how its
 * questions are handled.
 */
export const AUTOMATIC_REVIEW_NOTE =
  `[automatic review] The operator asked for an automatic review. When you run ` +
  `\`keryx review start\`, \`attach\` or \`ingest\`, pass ${AUTOMATIC_REVIEW_FLAG} so the package records it; ` +
  "the review commands for that package then run without a prompt. " +
  "Questions via ask_user are answered with the recommended option and are not shown to the operator; " +
  `only a gate refusal that needs the operator's quote ("gate-waiver") or a reduced reviewer set ("reduced-reviewer-set") ` +
  "may be asked, with the matching `emergency` value, after the gate has refused. " +
  "Commands outside the review package and the review commands still ask, as always.";

/** The closed list of reasons an automatic review still stops to ask the operator. */
export const AUTOMATIC_REVIEW_EMERGENCIES: readonly string[] = [
  "a command outside the review's package or the review commands",
  "a destructive action",
  "provider authentication failure",
  "a gate refusal that needs the operator's quote (waiver)",
  "a reduced reviewer set",
  "a provider error after retries",
];

/** What `/mode` and the mode picker say about automatic review. */
export function describeAutomaticReviewMode(env: Record<string, string | undefined> = process.env): string {
  return (
    `Automatic review (name it in a request): ${describeAutomaticReviewLimit(env)}; ` +
    "its own review commands run without a prompt; every other question is answered with its default and counted; " +
    `it stops to ask only for: ${AUTOMATIC_REVIEW_EMERGENCIES.join("; ")}.`
  );
}

/** The line a turn announces when it belongs to an automatic review. */
export function describeAutomaticReviewTurn(env: Record<string, string | undefined> = process.env): string {
  return `[automatic review] this turn: ${describeAutomaticReviewLimit(env)}; the review's own commands run without a prompt; emergencies only.`;
}

export type ReviewInputKind = "manual" | "automatic";

export interface DisclosureEntry {
  kind: ReviewInputKind;
  what: string;
  detail: string;
}

export interface AutomaticReviewDisclosure {
  manual: number;
  automatic: number;
  entries: DisclosureEntry[];
}

const BARE_CHARACTER = /[A-Za-z0-9_@%+=,.:/-]/;

/**
 * A command made only of literal words — nothing a shell would expand, chain or
 * redirect. Quotes are accepted only around text the shell leaves alone: no
 * `$`, backtick or backslash inside double quotes, no newline anywhere.
 */
function literalWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current: string | undefined;
  let i = 0;
  const text = command.trim();
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === " ") {
      if (current !== undefined) {
        words.push(current);
        current = undefined;
      }
      i += 1;
    } else if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      if (end === -1) {
        return undefined;
      }
      const inner = text.slice(i + 1, end);
      if (inner.includes("\n") || inner.includes("\r") || (ch === '"' && /[$`\\]/.test(inner))) {
        return undefined;
      }
      current = (current ?? "") + inner;
      i = end + 1;
    } else if (BARE_CHARACTER.test(ch)) {
      current = (current ?? "") + ch;
      i += 1;
    } else {
      return undefined;
    }
  }
  if (current !== undefined) {
    words.push(current);
  }
  return words.length === 0 || words.some((word) => word.split("/").includes("..")) ? undefined : words;
}

/**
 * The state of one automatic-review turn: which package it is bound to, whether
 * the completion gate has refused, and the count of inputs the operator gave
 * versus ones the shell supplied.
 *
 * It lowers exactly two prompts and nothing else. A shell command is approved
 * without asking only when it is a literal `keryx review <subcommand>` of the
 * closed set above aimed at THIS run's package; an `apply_patch` only when every
 * target lies inside that package. Every hard floor (credentials, destructive,
 * human confirmation, publish lease, read-only, untrusted content, a hook's ask)
 * is checked by the caller before this is consulted.
 */
export class AutomaticReviewRun {
  private binding: { id: string; dir: string } | undefined;
  private gateRefused = false;
  private readonly entries: DisclosureEntry[] = [];

  constructor(private readonly cwd: string) {}

  /** The bound package directory, once the run has created it. */
  get packageDir(): string | undefined {
    return this.binding?.dir;
  }

  approvesShell(command: string): boolean {
    const words = literalWords(command);
    if (words === undefined || words[0] !== "keryx" || words[1] !== "review") {
      return false;
    }
    const sub = words[2];
    if (sub === undefined) {
      return false;
    }
    if ((AUTOMATIC_REVIEW_CREATE_SUBCOMMANDS as readonly string[]).includes(sub)) {
      return this.binding === undefined && words.includes(AUTOMATIC_REVIEW_FLAG);
    }
    if ((AUTOMATIC_REVIEW_PACKAGE_SUBCOMMANDS as readonly string[]).includes(sub)) {
      const ref = words[3];
      return ref !== undefined && !ref.startsWith("-") && this.isBoundRef(ref);
    }
    return false;
  }

  approvesPatchTargets(targets: readonly string[]): boolean {
    const dir = this.binding?.dir;
    if (dir === undefined || targets.length === 0) {
      return false;
    }
    return targets.every((target) => {
      const resolved = path.resolve(this.cwd, target);
      return resolved === dir || resolved.startsWith(`${dir}${path.sep}`);
    });
  }

  /** Reads what a finished `keryx review …` command did: binds the package it created, notes a refused gate. */
  observe(command: string, result: Pick<InteractiveToolResult, "isError" | "output">): void {
    const words = literalWords(command);
    if (words === undefined || words[0] !== "keryx" || words[1] !== "review") {
      return;
    }
    const sub = words[2];
    if (sub === "complete" && result.isError === true) {
      this.gateRefused = true;
      return;
    }
    if (
      this.binding === undefined &&
      result.isError !== true &&
      sub !== undefined &&
      (AUTOMATIC_REVIEW_CREATE_SUBCOMMANDS as readonly string[]).includes(sub) &&
      words.includes(AUTOMATIC_REVIEW_FLAG)
    ) {
      const id = /^# managed review: (\S+)/m.exec(result.output)?.[1];
      const printed = /^path: (.+)$/m.exec(result.output)?.[1]?.trim();
      if (id === undefined || printed === undefined) {
        return;
      }
      const dir = path.resolve(this.cwd, printed);
      const metaproject = path.join(path.resolve(this.cwd), ".metaproject") + path.sep;
      if (dir.startsWith(metaproject)) {
        this.binding = { id, dir };
      }
    }
  }

  /**
   * An `ask_user` call during the run. Returns the host's answer, or `undefined`
   * when the question is one of the two emergencies and must reach the operator.
   * A claimed emergency is accepted only after the completion gate has refused.
   */
  answerAskUser(input: Record<string, unknown>): InteractiveToolResult | undefined {
    const claimed = typeof input.emergency === "string" ? input.emergency : undefined;
    const emergency = (ASK_USER_EMERGENCIES as readonly string[]).includes(claimed ?? "") && this.gateRefused;
    const question = typeof input.question === "string" ? input.question.trim() : "";
    if (emergency) {
      this.record("manual", "ask_user", `emergency ${claimed}: ${question}`);
      return undefined;
    }
    const options = Array.isArray(input.options)
      ? input.options.filter(
          (raw): raw is Record<string, unknown> =>
            raw !== null &&
            typeof raw === "object" &&
            typeof (raw as Record<string, unknown>).id === "string" &&
            typeof (raw as Record<string, unknown>).label === "string",
        )
      : [];
    const chosen = options.find((option) => option.recommended === true) ?? options[0];
    if (chosen === undefined) {
      return undefined;
    }
    const recommended = chosen.recommended === true;
    const why =
      claimed !== undefined && !emergency
        ? ` The claimed emergency "${claimed}" was not accepted: no gate refusal has been seen in this run.`
        : "";
    this.record("automatic", "ask_user", `${question} -> ${String(chosen.id)}${recommended ? " (recommended)" : " (first option)"}`);
    return {
      output:
        `Automatic review: this question was not put to the operator; the default was applied — ` +
        `id="${String(chosen.id)}" label="${String(chosen.label)}"${recommended ? " (recommended)" : " (first option)"}. ` +
        `It is logged in the run's disclosure.${why}`,
      isError: false,
    };
  }

  record(kind: ReviewInputKind, what: string, detail: string): void {
    this.entries.push({ kind, what, detail });
  }

  disclosure(): AutomaticReviewDisclosure {
    const manual = this.entries.filter((entry) => entry.kind === "manual").length;
    return { manual, automatic: this.entries.length - manual, entries: [...this.entries] };
  }

  summaryLine(): string {
    const { manual, automatic } = this.disclosure();
    return `[automatic review] inputs: ${manual} manual, ${automatic} automatic${
      this.binding === undefined ? "" : ` (${path.relative(this.cwd, path.join(this.binding.dir, AUTOMATIC_REVIEW_DISCLOSURE_FILE))})`
    }`;
  }

  /** Writes the counts and every logged input into the bound package. No package, nothing written. */
  async writeDisclosure(): Promise<string | undefined> {
    if (this.binding === undefined) {
      return undefined;
    }
    const file = path.join(this.binding.dir, AUTOMATIC_REVIEW_DISCLOSURE_FILE);
    await mkdir(this.binding.dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(this.disclosure(), null, 2)}\n`, "utf8");
    return file;
  }

  private isBoundRef(ref: string): boolean {
    if (this.binding === undefined) {
      return false;
    }
    return ref === this.binding.id || path.resolve(this.cwd, ref) === this.binding.dir;
  }
}
