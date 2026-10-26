import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { readJsonObjectFile } from "../lib/json";

// Which review roles are off for a round. A role is off by default (the readability roles), off because the project's
// `routing.config.json` says so, or on because the round asked for it (`--style`, `--with-role`) or the project keeps it on.
// The decision is pure; the callers pass the roster, the config and the package's recorded opt-in.

/** Roles the engine leaves out of a round unless it asks for them. */
export const OPTIONAL_BY_DEFAULT: readonly string[] = ["review-clean-code", "review-style"];
/** What `--style` turns on. */
export const STYLE_ROLES: readonly string[] = OPTIONAL_BY_DEFAULT;
/** The package's recorded opt-in: written by `review start` and `review required --package`. */
export const ROUND_ROLES_FILE = "round-roles.json";
export const ROLE_LINE_PREFIX = "опциональные роли не запускались:";

export type RoleConfig = { disabled: string[]; enabled: string[]; warnings: string[] };

const names = (value: unknown, field: string, warnings: string[]): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    warnings.push(`routing.config.json reviewRoles.${field} must be a list of role names; it is ignored`);
    return [];
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
};

/** `reviewRoles` in the project's `routing.config.json`; a field that is not a list of names is a warning and counts as empty. */
export async function readRoleConfig(projectRoot: string): Promise<RoleConfig> {
  const none: RoleConfig = { disabled: [], enabled: [], warnings: [] };
  const file = path.join(projectRoot, "routing.config.json");
  if (!(await pathExists(file))) return none;
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") return { ...none, warnings: [`${file} could not be read as a JSON object (${read.state}); reviewRoles is ignored`] };
  const own = read.value.reviewRoles;
  if (own === undefined) return none;
  if (own === null || typeof own !== "object" || Array.isArray(own)) return { ...none, warnings: ["routing.config.json reviewRoles must be an object with disabled and enabled lists; it is ignored"] };
  const fields = own as Record<string, unknown>;
  const warnings: string[] = [];
  return { disabled: names(fields.disabled, "disabled", warnings), enabled: names(fields.enabled, "enabled", warnings), warnings };
}

export type RoleSwitchInput = {
  /** The roles the round could run: the roster before gates and depth. */
  roster: readonly string[];
  config: RoleConfig;
  /** Roles the round asked for (`--style`, `--with-role`, or recorded in the package). */
  optIn: readonly string[];
  /** Roles no switch may turn off. */
  protectedRoles: ReadonlySet<string>;
  /** Why the config's `disabled` list is not applied this round, when it is not. */
  configIgnored?: string | undefined;
};

export type RoleSwitches = { off: Map<string, string>; warnings: string[] };

/** The roles of the roster that are off and why, with the warnings the switches earn. */
export function decideRoleSwitches(input: RoleSwitchInput): RoleSwitches {
  const { roster, config, optIn, protectedRoles } = input;
  const known = new Set(roster);
  const warnings = [...config.warnings];
  const off = new Map<string, string>();
  for (const name of OPTIONAL_BY_DEFAULT) off.set(name, `optional role, off by default (--style turns it on)`);
  if (input.configIgnored !== undefined && config.disabled.length > 0) warnings.push(`reviewRoles.disabled not applied: ${input.configIgnored}`);
  else {
    for (const name of config.disabled) {
      if (protectedRoles.has(name)) warnings.push(`reviewRoles.disabled: ${name} is a core role that always runs; it stays on`);
      else if (!known.has(name)) warnings.push(`reviewRoles.disabled: unknown role "${name}"; ignored`);
      else off.set(name, `disabled by routing.config.json reviewRoles.disabled (--with-role ${name} turns it on)`);
    }
  }
  for (const name of config.enabled) {
    if (!known.has(name) && !OPTIONAL_BY_DEFAULT.includes(name)) warnings.push(`reviewRoles.enabled: unknown role "${name}"; ignored`);
    else off.delete(name);
  }
  for (const name of optIn) {
    if (!known.has(name) && !OPTIONAL_BY_DEFAULT.includes(name)) warnings.push(`--with-role: unknown role "${name}"; ignored`);
    else off.delete(name);
  }
  for (const name of [...off.keys()]) if (!known.has(name)) off.delete(name);
  return { off, warnings };
}

/** `--style` and every `--with-role <name>` of an argument list as one list of role names. */
export function optInRolesFromArgs(args: readonly string[]): string[] {
  const roles: string[] = [];
  if (args.includes("--style")) roles.push(...STYLE_ROLES);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--with-role") {
      const value = args[i + 1]?.trim();
      if (value === undefined || value === "" || value.startsWith("--")) throw new Error("--with-role needs a role name, for example --with-role review-clean-code");
      roles.push(value);
      i += 1;
    } else if (arg.startsWith("--with-role=")) {
      const value = arg.slice("--with-role=".length).trim();
      if (value === "") throw new Error("--with-role needs a role name, for example --with-role review-clean-code");
      roles.push(value);
    }
  }
  return [...new Set(roles)];
}

/** The roles recorded in the package's `round-roles.json`; empty when there is none. */
export async function packageEnabledRoles(packageDir: string): Promise<string[]> {
  const read = await readJsonObjectFile(path.join(packageDir, ROUND_ROLES_FILE)).catch(() => undefined);
  if (read?.state !== "object" || !Array.isArray(read.value.enabled)) return [];
  return read.value.enabled.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/** Record the opt-in in the package, keeping what is recorded already. No file is written for an empty opt-in. */
export async function recordEnabledRoles(packageDir: string, roles: readonly string[]): Promise<string[]> {
  const merged = [...new Set([...(await packageEnabledRoles(packageDir)), ...roles])].sort();
  if (merged.length > 0) await writeFileAtomic(path.join(packageDir, ROUND_ROLES_FILE), `${JSON.stringify({ enabled: merged }, null, 2)}\n`);
  return merged;
}

/** Roles that left a driver or a raw reply in the package: they ran, whatever the switches say now. */
export async function rolesThatRan(packageDir: string, roles: readonly string[]): Promise<Set<string>> {
  const ran = new Set<string>();
  for (const dir of ["drivers", "raw"]) {
    const where = path.join(packageDir, dir);
    if (!existsSync(where)) continue;
    for (const file of await readdir(where).catch(() => [] as string[])) {
      for (const role of roles) if (file.startsWith(`${role}-`)) ran.add(role);
    }
  }
  return ran;
}

/** The report line for the roles that did not run, or undefined when there are none. */
export function optionalRolesLine(roles: readonly string[]): string | undefined {
  if (roles.length === 0) return undefined;
  return `${ROLE_LINE_PREFIX} ${[...roles].sort().join(", ")} (включить: --style или --with-role <роль> у \`keryx review start|required\`, либо reviewRoles в routing.config.json)`;
}

const LINE = new RegExp(`^${ROLE_LINE_PREFIX}.*$`, "m");
const EVIDENCE_LINE = /^Evidence level:.*$/m;

/** Put the line into `report`, replacing the one already there, and drop it when there is nothing to say. */
export function upsertOptionalRolesLine(report: string, line: string | undefined): string {
  if (line === undefined) return LINE.test(report) ? report.replace(new RegExp(`\\n?${LINE.source}\\n?`, "m"), "\n").replace(/\n{3,}/g, "\n\n") : report;
  if (LINE.test(report)) return report.replace(LINE, () => line);
  if (EVIDENCE_LINE.test(report)) return report.replace(EVIDENCE_LINE, (found) => `${found}\n${line}`);
  return `${report.trimEnd()}\n\n${line}\n`;
}
