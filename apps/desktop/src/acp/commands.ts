// Pure helpers over the shell profile's slash commands (spec 3.9): advertised metadata,
// the palette's grouping and filter, command lines, and view form templates.

import type { AvailableCommand, CommandMeta, InitializeResult, ViewField } from "./types";

/** keryx lists this in `initialize._meta.keryx.extensions` when it serves `_keryx/command`. */
export const COMMAND_METHOD = "_keryx/command";

export function hasCommandExtension(init: InitializeResult): boolean {
  return init._meta?.keryx?.extensions?.includes(COMMAND_METHOD) === true;
}

export function commandMeta(c: AvailableCommand): CommandMeta {
  return c._meta?.keryx ?? {};
}

/** A command with no metadata (older keryx, editor profile) is a text command. */
export function commandSurface(c: AvailableCommand): NonNullable<CommandMeta["surface"]> {
  return commandMeta(c).surface ?? "text";
}

export interface ParsedLine {
  name: string;
  args: string;
}

/** `/tasks kill t3` gives name `tasks`, args `kill t3`. Null when the line is not a command line. */
export function parseCommandLine(line: string): ParsedLine | null {
  if (!line.startsWith("/")) return null;
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(line);
  if (!m || !m[1]) return null;
  return { name: m[1], args: (m[2] ?? "").trim() };
}

/** The advertised command a line names, or undefined (the line is then ordinary text). */
export function findCommand(
  commands: readonly AvailableCommand[],
  line: string,
): { command: AvailableCommand; parsed: ParsedLine } | undefined {
  const parsed = parseCommandLine(line);
  if (!parsed) return undefined;
  const command = commands.find((c) => c.name.toLowerCase() === parsed.name.toLowerCase());
  return command ? { command, parsed } : undefined;
}

export interface CommandGroup {
  group: string;
  items: AvailableCommand[];
}

const NO_GROUP = "Commands";

/** Commands matching `query` (name prefix first, then name or description contains it), grouped in first-seen order. */
export function groupCommands(commands: readonly AvailableCommand[], query: string): CommandGroup[] {
  const q = query.toLowerCase();
  const rank = (c: AvailableCommand): number => {
    const n = c.name.toLowerCase();
    if (q === "" || n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    return c.description.toLowerCase().includes(q) ? 2 : 3;
  };
  const kept = commands.filter((c) => rank(c) < 3);
  kept.sort((a, b) => rank(a) - rank(b));
  const groups: CommandGroup[] = [];
  for (const c of kept) {
    const g = commandMeta(c).group || NO_GROUP;
    let slot = groups.find((x) => x.group === g);
    if (!slot) {
      slot = { group: g, items: [] };
      groups.push(slot);
    }
    slot.items.push(c);
  }
  return groups;
}

export function flattenGroups(groups: readonly CommandGroup[]): AvailableCommand[] {
  return groups.flatMap((g) => g.items);
}

export const SECRET_MASK = "••••••";

export type FieldValues = Record<string, string | boolean>;

function fieldText(v: string | boolean | undefined): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v ?? "";
}

/** Fills `{fieldId}` placeholders. With `mask`, secret fields are shown as bullets: the line to display, never to send. */
export function fillTemplate(template: string, fields: readonly ViewField[], values: FieldValues, mask = false): string {
  return template.replace(/\{([^{}\s]+)\}/g, (whole, id: string) => {
    const f = fields.find((x) => x.id === id);
    if (!f) return whole;
    return mask && f.kind === "secret" ? SECRET_MASK : fieldText(values[id]);
  });
}

export function initialValues(fields: readonly ViewField[]): FieldValues {
  const out: FieldValues = {};
  for (const f of fields) {
    if (f.kind === "toggle") out[f.id] = f.value === true || f.value === "true";
    else if (f.kind === "choice") {
      const first = f.options?.[0];
      out[f.id] = typeof f.value === "string" ? f.value : typeof first === "string" ? first : (first?.value ?? "");
    } else out[f.id] = typeof f.value === "string" ? f.value : "";
  }
  return out;
}
