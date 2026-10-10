import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type JsonSchema, validateJson } from "../gdskills/contracts";
import { DEFAULT_SLICE_MAX_BYTES, type SliceManifest, byteLength } from "./slice";

export type DispatchCheckCode =
  | "REVIEWER_INPUT_INVALID"
  | "REVIEWER_INPUT_NO_SLICE"
  | "REVIEWER_INPUT_SLICE_UNKNOWN"
  | "REVIEWER_INPUT_TOO_LARGE";

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

export type CheckDispatchOptions = {
  maxBytes?: number;
  manifest?: SliceManifest;
  /** Bytes of a slice named by a path rather than a manifest id. Undefined when it cannot be read. */
  pathBytes?: (slicePath: string) => number | undefined;
};

/**
 * Refuse a reviewer payload that a bounded reviewer cannot finish.
 *
 * Shape comes from reviewer-input.schema.json. On top of it, a `diff` scope must
 * name its slices or carry a diff that fits the ceiling, and what a reviewer is
 * assigned must fit the ceiling in total — the unbounded `git diff` pasted into
 * a prompt is the case this exists to stop.
 */
export async function checkDispatch(payloads: readonly unknown[], options: CheckDispatchOptions = {}): Promise<DispatchCheckResult> {
  const maxBytes = options.maxBytes ?? options.manifest?.maxBytes ?? DEFAULT_SLICE_MAX_BYTES;
  const schema = await loadReviewerInputSchema();
  const errors: DispatchCheckError[] = [];

  for (const [index, payload] of payloads.entries()) {
    const reviewer = isRecord(payload) && typeof payload.reviewer === "string" && payload.reviewer !== "" ? payload.reviewer : `payload[${index}]`;
    for (const problem of await validateJson(payload, schema)) {
      errors.push({ code: "REVIEWER_INPUT_INVALID", reviewer, path: problem.path, message: problem.message });
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
        message: `assigned slices total ${assigned} bytes, over the ${maxBytes} byte ceiling`,
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
