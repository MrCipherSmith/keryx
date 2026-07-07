import { parseArgs } from "node:util";

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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
