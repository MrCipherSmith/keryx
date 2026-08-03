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
