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

/** Whether a field is shown: no `showWhen`, or its controlling field is itself shown and holds one of the listed values. */
export function fieldVisible(field: ViewField, fields: readonly ViewField[], values: FieldValues, depth = 0): boolean {
  const when = field.showWhen;
  if (!when) return true;
  if (depth > fields.length) return false;
  const parent = fields.find((x) => x.id === when.field);
  if (!parent || !fieldVisible(parent, fields, values, depth + 1)) return false;
  return when.equals.includes(fieldText(values[when.field]));
}

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Fills `{fieldId}` placeholders. With `mask`, secret fields are shown as bullets: the line to display, never to send. A hidden field's placeholder is dropped with the `--flag` before it. */
export function fillTemplate(template: string, fields: readonly ViewField[], values: FieldValues, mask = false): string {
  let line = template;
  for (const f of fields) {
    if (fieldVisible(f, fields, values)) continue;
    const id = escapeRe(f.id);
    line = line.replace(new RegExp(`\\s*--[\\w-]+\\s+["']?\\{${id}\\}["']?`, "g"), "").replace(new RegExp(`["']?\\{${id}\\}["']?`, "g"), "");
  }
  return line.replace(/\{([^{}\s]+)\}/g, (whole, id: string) => {
    const f = fields.find((x) => x.id === id);
    if (!f) return whole;
    return mask && f.kind === "secret" ? SECRET_MASK : fieldText(values[id]);
  });
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The message for a shown field whose non-empty value is wrong, or undefined. An empty value is a "required" matter, not an error. */
export function fieldError(field: ViewField, value: string | boolean | undefined): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const text = value.trim();
  if (field.kind === "number") {
    const n = Number(text);
    if (!Number.isFinite(n)) return field.error ?? "Enter a number";
    if (field.min !== undefined && n < field.min) return field.error ?? `Enter a number of ${field.min} or more`;
    return undefined;
  }
  if (field.kind === "time") return TIME_RE.test(text) ? undefined : (field.error ?? "Use HH:MM, 00:00-23:59");
  if (field.pattern !== undefined) {
    try {
      if (!new RegExp(field.pattern).test(text)) return field.error ?? "This value is not in the expected form";
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The shown required fields that are still empty (blank text counts as empty). A toggle always has a value. */
export function missingRequired(fields: readonly ViewField[], values: FieldValues): ViewField[] {
  return fields.filter(
    (f) => fieldVisible(f, fields, values) && f.required === true && f.kind !== "toggle" && (typeof values[f.id] !== "string" || (values[f.id] as string).trim() === ""),
  );
}

/** The shown fields holding a wrong value, with the message for each. */
export function invalidFields(fields: readonly ViewField[], values: FieldValues): Array<{ field: ViewField; message: string }> {
  const out: Array<{ field: ViewField; message: string }> = [];
  for (const f of fields) {
    if (!fieldVisible(f, fields, values)) continue;
    const message = fieldError(f, values[f.id]);
    if (message !== undefined) out.push({ field: f, message });
  }
  return out;
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
