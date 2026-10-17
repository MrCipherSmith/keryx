import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type JsonSchema, validateJson } from "../gdskills/contracts";
import { DISPLAY_ID_FORM, displayIdHasHash } from "./display-id";
import { DEFAULT_SLICE_MAX_BYTES, type SliceManifest, byteLength, manifestSizeProblem, waveBytesOf } from "./slice";

export type DispatchCheckCode =
  | "REVIEWER_INPUT_INVALID"
  | "REVIEWER_INPUT_NO_SLICE"
  | "REVIEWER_INPUT_SLICE_UNKNOWN"
  | "REVIEWER_INPUT_TOO_LARGE"
  | "REVIEWER_INPUT_NO_PR_CONTEXT"
  | "REVIEWER_INPUT_PATH_MISSING"
  | "REVIEWER_INPUT_MANIFEST_UNSIZED"
  | "REVIEWER_INPUT_PLAN_UNCONFIRMED"
  | "REVIEWER_INPUT_ID_FORM";

export type DispatchCheckError = {
  code: DispatchCheckCode;
  reviewer: string;
  message: string;
  path?: string;
};

export type DispatchCheckResult = {
  ok: boolean;
  checked: number;
  maxBytes: number;
  errors: DispatchCheckError[];
};

const SCHEMA_CANDIDATES = [
  new URL("../gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json", import.meta.url),
  new URL("./bundled/skills/review/review-orchestrator/reviewer-input.schema.json", import.meta.url),
  // the packaged build runs from dist/, with the bundled skills under src/ one level up
  new URL("../src/gdskills/bundled/skills/review/review-orchestrator/reviewer-input.schema.json", import.meta.url),
];

/** The reviewer-input contract is deliberately not a registered ContractName, so it is read from the bundled skill. */
export async function loadReviewerInputSchema(): Promise<JsonSchema> {
  for (const url of SCHEMA_CANDIDATES) {
    const file = fileURLToPath(url);
    if (existsSync(file)) {
      return JSON.parse(await readFile(file, "utf8")) as JsonSchema;
    }
  }
  throw new Error("reviewer-input.schema.json is not in this install");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Payload fields that name a file the reviewer is told to read; inline text fields (diff, file_contents) are not paths. */
const PATH_FIELDS = ["skill_path", "context_doc"] as const;

export type CheckDispatchOptions = {
  /** Whether a path named by a payload field exists. Defaults to the filesystem, relative paths resolved against the cwd as the pr_context check does. */
  pathExists?: (filePath: string) => boolean;
  /** Ceiling for what one dispatch carries in total. Defaults to the manifest's wave budget. */
  maxBytes?: number;
  manifest?: SliceManifest;
  /** Bytes of a slice named by a path rather than a manifest id. Undefined when it cannot be read. */
  pathBytes?: (slicePath: string) => number | undefined;
  /** Set for a pull-request review: every payload must name the collected `pr-context.md`, and it must be readable. */
  prContext?: { exists: (contextPath: string) => boolean };
  /**
   * The round's plan: when it is over the operator threshold and no plan confirmation is recorded, every payload is
   * refused (`planGateRefusal` in estimate.ts says what to do).
   */
  plan?: { refusal: string | undefined };
};

/**
 * Refuse a reviewer payload that a bounded reviewer cannot finish.
 *
 * Shape comes from reviewer-input.schema.json. On top of it, a `diff` scope must
 * name its slices or carry a diff that fits the ceiling, and what a reviewer is
 * assigned must fit the ceiling in total — the unbounded `git diff` pasted into
 * a prompt is the case this exists to stop. The ceiling is the manifest's wave budget,
 * not its slice ceiling: a role owning many slices is dispatched in waves, and each
 * wave has to fit what a reviewer can finish before its child deadline.
 */
export async function checkDispatch(payloads: readonly unknown[], options: CheckDispatchOptions = {}): Promise<DispatchCheckResult> {
  const unsized = options.maxBytes === undefined && options.manifest !== undefined ? manifestSizeProblem(options.manifest) : undefined;
  if (unsized !== undefined) {
    // Without a size every byte comparison below would be against NaN and pass; refuse the whole check instead.
    return { ok: false, checked: payloads.length, maxBytes: 0, errors: [{ code: "REVIEWER_INPUT_MANIFEST_UNSIZED", reviewer: "manifest", message: unsized }] };
  }
  const maxBytes = options.maxBytes ?? (options.manifest === undefined ? DEFAULT_SLICE_MAX_BYTES : waveBytesOf(options.manifest));
  const schema = await loadReviewerInputSchema();
  const errors: DispatchCheckError[] = [];
  if (options.plan?.refusal !== undefined) {
    errors.push({ code: "REVIEWER_INPUT_PLAN_UNCONFIRMED", reviewer: "plan", message: options.plan.refusal });
  }
  const pathExists = options.pathExists ?? ((filePath: string) => existsSync(path.resolve(filePath)));

  for (const [index, payload] of payloads.entries()) {
    const reviewer = isRecord(payload) && typeof payload.reviewer === "string" && payload.reviewer !== "" ? payload.reviewer : `payload[${index}]`;
    for (const problem of await validateJson(payload, schema)) {
      errors.push({ code: "REVIEWER_INPUT_INVALID", reviewer, path: problem.path, message: problem.message });
    }
    if (isRecord(payload)) {
      for (const field of PATH_FIELDS) {
        const value = payload[field];
        if (typeof value === "string" && value !== "" && !pathExists(value)) {
          errors.push({
            code: "REVIEWER_INPUT_PATH_MISSING",
            reviewer,
            path: `$.${field}`,
            message: `${field} ${value} does not exist; the reviewer would be rejected at dispatch. Fix the path or omit the field`,
          });
        }
      }
    }
    // Flow 460: a finding handed to the reviewer is named by a display id it will echo back; one holding "#" would
    // only fail at ingest, after the whole round, when its global_id is minted.
    if (isRecord(payload)) {
      for (const [field, ids] of [
        ["known_findings", (Array.isArray(payload.known_findings) ? payload.known_findings : []).map((entry) => (isRecord(entry) ? entry.id : undefined))],
        ["prior_findings", (Array.isArray(payload.prior_findings) ? payload.prior_findings : []).map((entry) => (isRecord(entry) && isRecord(entry.finding) ? entry.finding.id : undefined))],
      ] as const) {
        ids.forEach((id, at) => {
          if (displayIdHasHash(id)) {
            errors.push({ code: "REVIEWER_INPUT_ID_FORM", reviewer, path: `$.${field}[${at}]`, message: `finding id "${id}": ${DISPLAY_ID_FORM}` });
          }
        });
      }
    }
    if (options.prContext !== undefined) {
      const contextPath = isRecord(payload) && typeof payload.pr_context === "string" ? payload.pr_context : "";
      if (contextPath === "" || !options.prContext.exists(contextPath)) {
        errors.push({
          code: "REVIEWER_INPUT_NO_PR_CONTEXT",
          reviewer,
          path: "$.pr_context",
          message: contextPath === ""
            ? "a pull-request review dispatches with the collected pull request context; run `keryx review context-collect` and set pr_context to its pr-context.md"
            : `pr_context ${contextPath} is not a readable file; run \`keryx review context-collect\` to write it`,
        });
      }
    }
    if (!isRecord(payload) || payload.scope_mode !== "diff") {
      continue;
    }

    const slices = Array.isArray(payload.slices) ? payload.slices.filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
    const diff = typeof payload.diff === "string" ? payload.diff : "";
    if (slices.length === 0 && diff === "") {
      errors.push({
        code: "REVIEWER_INPUT_NO_SLICE",
        reviewer,
        message: "scope_mode is diff but the payload names no slice and carries no diff; run `keryx review slice` and assign slices",
      });
      continue;
    }

    let assigned = 0;
    for (const slice of slices) {
      const entry = options.manifest?.slices.find((candidate) => candidate.id === slice || candidate.path === slice);
      const bytes = entry?.bytes ?? options.pathBytes?.(slice);
      if (bytes === undefined) {
        errors.push({
          code: "REVIEWER_INPUT_SLICE_UNKNOWN",
          reviewer,
          path: slice,
          message: `slice ${slice} is neither in the manifest nor a readable file`,
        });
        continue;
      }
      assigned += bytes;
    }
    if (assigned > maxBytes) {
      errors.push({
        code: "REVIEWER_INPUT_TOO_LARGE",
        reviewer,
        message: `assigned slices total ${assigned} bytes, over the ${maxBytes} byte wave ceiling; dispatch them in waves (\`keryx review retry-plan --manifest <manifest> --reviewer ${reviewer} --next-wave\` hands out the next one)`,
      });
    }
    const diffBytes = byteLength(diff);
    if (diffBytes > maxBytes) {
      errors.push({
        code: "REVIEWER_INPUT_TOO_LARGE",
        reviewer,
        path: "$.diff",
        message: `diff is ${diffBytes} bytes, over the ${maxBytes} byte ceiling; send a slice instead of the whole diff`,
      });
    }
  }

  return { ok: errors.length === 0, checked: payloads.length, maxBytes, errors };
}

export function renderDispatchCheck(result: DispatchCheckResult): string {
  if (result.ok) {
    return `dispatch-check: ${result.checked} payload(s) ok (ceiling ${result.maxBytes} bytes)`;
  }
  return [
    `dispatch-check: ${result.errors.length} problem(s) in ${result.checked} payload(s)`,
    ...result.errors.map((error) => `- ${error.code}  ${error.reviewer}${error.path === undefined ? "" : ` ${error.path}`}: ${error.message}`),
  ].join("\n");
}
