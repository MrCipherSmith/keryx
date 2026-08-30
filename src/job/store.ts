import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { loadSchema } from "../gdskills/contracts";
import { pathExists, writeFileAtomic } from "../lib/fs";
import { DOCUMENT_TYPES, type JobDocumentType, type JobState } from "./types";

/**
 * `.metaproject/jobs/` — the directory `src/gdskills/install.ts:42` has created
 * since job packages were designed, and which nothing else has ever written to.
 * One package reached git history (commit `13676f0f`), hand-authored by a model
 * and then removed. This module is the writer it never had.
 */
export function jobsRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "jobs");
}

export function jobDir(cwd: string, name: string): string {
  return path.join(jobsRoot(cwd), name);
}

export function jobStatePath(cwd: string, name: string): string {
  return path.join(jobDir(cwd, name), "state.json");
}

/**
 * The schema's own `job_name` pattern, duplicated here so the CLI can refuse
 * BEFORE building a path out of the value. Validating only on write would mean
 * `../../etc` had already been joined into a directory name.
 */
export const JOB_NAME_PATTERN = /^[a-z0-9-]+$/;

export function assertJobName(name: string | undefined): string {
  if (name === undefined || name.length === 0) {
    throw new Error('Missing --name. Usage: keryx job init --name <slug>');
  }
  if (!JOB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid --name "${name}". Expected lowercase letters, digits and hyphens only ` +
        `(pattern ${JOB_NAME_PATTERN.source}).`,
    );
  }
  return name;
}

export async function listJobNames(cwd: string): Promise<string[]> {
  const root = jobsRoot(cwd);
  if (!(await pathExists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && JOB_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function readJob(cwd: string, name: string): Promise<JobState> {
  const file = jobStatePath(cwd, name);
  if (!(await pathExists(file))) {
    const known = await listJobNames(cwd);
    throw new Error(
      `Job not found: ${name}.` +
        (known.length > 0 ? ` Known: ${known.join(", ")}` : " Run: keryx job list"),
    );
  }
  return JSON.parse(await readFile(file, "utf8")) as JobState;
}

/**
 * Write `state.json` atomically, but only after it validates against the
 * REGISTERED contract schema.
 *
 * The schema is loaded through `loadSchema("job-orchestrator-state")` rather
 * than read from a path here, deliberately: that is the registry entry
 * requirement 2 adds, so if the registration is removed this throws and every
 * `job` write fails loudly, instead of the schema quietly becoming decorative
 * again — which is the state the audit found it in.
 */
export async function writeJob(cwd: string, name: string, state: JobState): Promise<void> {
  const schema = (await loadSchema("job-orchestrator-state")) as Record<string, unknown>;
  const result = validateAgainstSchemaObject(schema, state);
  if (!result.valid) {
    throw new Error(
      `Refusing to write .metaproject/jobs/${name}/state.json — it does not validate against ` +
        `job-orchestrator-state:\n` +
        result.errors.map((error) => `  - ${error.path}: ${error.message}`).join("\n"),
    );
  }
  const file = jobStatePath(cwd, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

export async function appendJournal(
  cwd: string,
  name: string,
  at: string,
  line: string,
): Promise<void> {
  await appendFile(path.join(jobDir(cwd, name), "journal.md"), `- ${at} - ${line}\n`, "utf8");
}

export function renderJournal(name: string, at: string): string {
  return [
    `# Journal — job ${name}`,
    "",
    "Append-only. Written by `keryx job`; do not edit by hand.",
    "",
    `- ${at} - created`,
    "",
  ].join("\n");
}

export function assertDocumentType(raw: string | undefined): JobDocumentType {
  if (raw === undefined || !(DOCUMENT_TYPES as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid --type "${raw ?? ""}". Expected one of: ${DOCUMENT_TYPES.join(", ")}`,
    );
  }
  return raw as JobDocumentType;
}

/**
 * The document's name inside the package. The type is carried by the file name
 * because `documentation.documents_created` is typed `array of string` by the
 * schema and a richer record would be rejected outright. The source extension is
 * preserved so a JSON verification report does not land as `.md`.
 */
export function documentFileName(type: JobDocumentType, sourcePath: string): string {
  const extension = path.extname(sourcePath) || ".md";
  return `${type}${extension}`;
}
