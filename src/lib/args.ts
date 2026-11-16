import { parseArgs } from "node:util";

/**
 * The value of `--name`, in either spelling.
 *
 * `--name value` and `--name=value` both answer. The equals form was not
 * handled, and the consequence was not cosmetic: `keryx security check-input
 * --runtime=cursor` read `undefined`, so the command fell back to the
 * no-runtime path — the human report went to stdout and no decision document
 * was emitted at all. A guard that reports and does not refuse, re-entered
 * through an argument spelling, which is the same class as the source guards
 * that lost to spellings for three rounds.
 *
 * A trailing `--name` with nothing after it answers `undefined` rather than
 * consuming the next flag, and `--name=` answers the empty string, which a
 * caller can tell apart from absence.
 */
export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index >= 0) {
    const next = args[index + 1];
    // Not the following FLAG: `--runtime --json` means the runtime was omitted,
    // and returning `"--json"` would be worse than returning nothing.
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  }
  const prefixed = args.find((argument) => argument.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

/**
 * Every value of a repeatable `--name`, in both spellings and in argv order.
 *
 * The same two rules as {@link optionValue}: an occurrence with nothing after
 * it (or with a flag after it) contributes no value and does not consume that
 * flag, and an explicit empty value (`--name=`, `--name ""`) is kept as `""`
 * so a caller can tell it from absence. It used to be filtered out, which made
 * `--only ""` read as "no --only": the selection it was meant to narrow was
 * dropped without a word.
 */
export function optionValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === name) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values.push(next);
        index += 1;
      }
    } else if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    }
  }
  return values;
}

export interface UnknownFlagOptions {
  /** Also treat any single-dash token (`-`, `-x`, `-5`) as a flag. Default: only `--name` tokens are flags. */
  readonly shortFlags?: boolean;
  /**
   * The flags whose `--name=value` spelling the caller actually reads (through
   * {@link optionValue} / {@link optionValues}). Default: none. A `--name=value`
   * token for any other flag is refused: a caller that reads its boolean flags
   * with `args.includes("--name")` never sees `--name=1`, so accepting it would
   * drop the flag and report success.
   */
  readonly valueFlags?: readonly string[];
}

function flagNameOf(argument: string): string {
  const equals = argument.indexOf("=");
  return equals > 0 ? argument.slice(0, equals) : argument;
}

function isFlagToken(argument: string, options: UnknownFlagOptions): boolean {
  if (argument.startsWith("--")) return true;
  return options.shortFlags === true && argument.startsWith("-");
}

/**
 * The distinct flag names in `args` that are not in `allowed`, in argv order.
 *
 * A flag is any `--name` token, in either spelling (`--name value`, `--name=value`):
 * the name is what precedes the first `=`. A bare word is a value or a positional
 * and is never judged here.
 */
export function unknownFlags(args: readonly string[], allowed: readonly string[], options: UnknownFlagOptions = {}): string[] {
  const names: string[] = [];
  for (const argument of args) {
    if (!isFlagToken(argument, options)) continue;
    const name = flagNameOf(argument);
    if (!allowed.includes(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The distinct allowed flags given in the `--name=value` spelling that the
 * caller does not read that way (not in `options.valueFlags`), as typed.
 */
export function unreadableValueFlags(args: readonly string[], allowed: readonly string[], options: UnknownFlagOptions = {}): string[] {
  const valueFlags = options.valueFlags ?? [];
  const tokens: string[] = [];
  for (const argument of args) {
    if (!argument.startsWith("--")) continue;
    const name = flagNameOf(argument);
    if (name === argument || !allowed.includes(name) || valueFlags.includes(name)) continue;
    if (!tokens.includes(argument)) tokens.push(argument);
  }
  return tokens;
}

/**
 * The one refusal every keryx command uses for an unrecognised flag
 * (`cli-interface-design.mdc`, decision 4): it throws one line naming the flag(s)
 * and listing what is accepted, which the CLI prints on stderr with exit code 1.
 * A dropped flag writes nothing and reports success, so it is refused instead.
 * A `--name=value` token for a flag the caller does not read in that spelling is
 * refused the same way (see {@link UnknownFlagOptions.valueFlags}).
 *
 * `command` is the invocation as the person typed it after `keryx`, e.g.
 * `"review slice"` or `"memory search"`.
 */
export function rejectUnknownFlags(
  args: readonly string[],
  allowed: readonly string[],
  command: string,
  options: UnknownFlagOptions = {},
): void {
  const unknown = unknownFlags(args, allowed, options);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx ${command}\`: ${unknown.join(", ")}. Accepted: ${
        allowed.length > 0 ? allowed.join(", ") : "(none)"
      }.`,
    );
  }
  const valued = unreadableValueFlags(args, allowed, options);
  if (valued.length > 0) {
    throw new Error(
      `\`keryx ${command}\` does not take a value with ${valued.map((token) => flagNameOf(token)).join(", ")} (got ${valued.join(", ")}). Give the bare flag.`,
    );
  }
}

export function parseBooleanFlags<const T extends readonly string[]>(
  args: string[],
  flags: T,
): { values: Record<T[number], boolean>; positionals: string[] } {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: Object.fromEntries(flags.map((flag) => [flag, { type: "boolean", short: shortFlag(flag) }])) as Record<
      T[number],
      { type: "boolean"; short?: string }
    >,
  });

  const values = Object.fromEntries(flags.map((flag) => [flag, Boolean(parsed.values[flag])])) as Record<T[number], boolean>;
  return { values, positionals: parsed.positionals };
}

function shortFlag(flag: string): string | undefined {
  if (flag === "help") {
    return "h";
  }
  if (flag === "yes") {
    return "y";
  }
  return undefined;
}
