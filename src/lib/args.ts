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
