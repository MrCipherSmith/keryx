import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ContractName =
  | "agent-event"
  | "flow-orchestrator-input"
  | "review-pr-feedback-input"
  | "review-pr-feedback-output"
  | "job-orchestrator-state"
  | "orchestrator-state"
  | "review-finding"
  | "subagent-dispatch"
  | "subagent-result"
  | "task-implementer-input"
  | "task-implementer-output";

/**
 * Whether keryx itself refuses a bad value of this contract, and where.
 *
 * Required, and a union rather than an optional field, so a new registration
 * cannot join the unenforced set by saying nothing. That is how the set grew:
 * three contracts were registered in PR #424 so a validator could be POINTED at
 * them, which is worth doing and is not an enforcement, and nothing recorded
 * the difference.
 *
 * `kind: "production"` is a checkable claim, not a comment. The guard in
 * `contract-enforcement.test.ts` opens the named module and requires it to
 * contain the actual `loadSchema("<name>")` call — a declaration that names a
 * file which does not load the schema fails the build. The alternative, taking
 * the registration's word for it, is the defect this whole flow is about.
 */
export type ContractEnforcement =
  | {
      kind: "production";
      /** Repo-relative non-test module that loads this schema and refuses on error. */
      module: string;
      /** What a rejected value looks like, in one sentence. */
      refuses: string;
    }
  | {
      kind: "none";
      /**
       * Why nothing can refuse it. Required: a gap with no stated reason reads
       * as an oversight, and the reader cannot tell "no keryx process is on
       * this path" from "somebody forgot".
       */
      reason: string;
    };

export type ContractInfo = {
  name: ContractName;
  /** Name this contract is written under in `.metaproject/core/gdskills/contracts/`. */
  fileName: string;
  description: string;
  enforcement: ContractEnforcement;
  /**
   * Repo-relative location of the AUTHORITATIVE file, when it does not live in
   * `src/gdskills/contracts/`.
   *
   * `job-orchestrator-state` is the case this exists for. Its schema has always
   * shipped inside the skill that owns it, and copying it into the contracts
   * directory would create a second copy to keep in step — which is how a schema
   * ends up describing a shape nothing writes. The registry points at the one
   * file instead.
   */
  sourcePath?: string;
};

type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  /**
   * Upper bound on a number, and `minItems` the lower bound on an array length.
   *
   * Both are here for the reason the `if`/`then` comment below gives, observed a
   * second time: this validator IGNORES a keyword it does not implement, so a
   * schema that had already been written with them was enforcing nothing while
   * reading as enforced. `task-implementer`'s input contract carried
   * `target_files: { minItems: 1 }` — the machine form of its own
   * `ASSERT target_files IS NOT EMPTY → ABORT("No target files")` — and
   * `max_self_fix_attempts: { maximum: 5 }`, and registering that contract
   * without these two keywords would have shipped the same defect one layer up.
   * `subagent-dispatch` and `review-finding` were already relying on `minItems`
   * and got the same silent pass.
   */
  maximum?: number;
  minItems?: number;
  /**
   * Upper bound on an array length — and the THIRD time this exact defect has
   * been found here, which is why it is called out rather than quietly added.
   *
   * `minItems` and `maximum` were declared-but-ignored once and fixed; the
   * comment above records that. Then 0.2.74 registered
   * `review-pr-feedback-output`, whose schema uses
   * `excluded_for_injection: { maxItems: 0 }` under
   * `screen_status: "unavailable"` — the machine form of "if the injection
   * screen never ran, you may not claim it excluded anything". The validator
   * had no `maxItems` branch, so that self-contradiction validated clean: a
   * record could say the screen did not run AND that it excluded two comments,
   * and `keryx skills contracts validate` — the enforcement point the contract's
   * own doc-comment names — called it valid.
   *
   * The pattern is not "we forgot a keyword". It is that adding a keyword to a
   * schema is easy and adding it to the validator is a separate act nobody is
   * forced to perform, so the two drift apart silently. The guard below
   * (`schemasDeclareOnlyImplementedKeywords`) is the structural answer.
   */
  maxItems?: number;
  /** Strict lower bound on a number. See the `exclusiveMinimum` branch below. */
  exclusiveMinimum?: number;
  /**
   * The value must NOT match this subschema. It is how a schema expresses a
   * prohibition — `subagent-dispatch` uses `not: { required: ["agent"] }` to say
   * a field must be absent in one branch — and there is no other way to say it.
   */
  not?: JsonSchema;
  minLength?: number;
  pattern?: string;
  // Conditional application. Added for the `class_scope` rule on
  // `review-finding`, where a requirement depends on `severity`.
  //
  // This validator is hand-rolled because keryx carries zero runtime
  // dependencies, and it silently IGNORES any keyword it does not implement. A
  // schema written with `if`/`then` before this existed would have looked
  // enforced and enforced nothing — see `review-finding-class-scope.test.ts`,
  // which pins the keyword itself so the finding rule cannot pass for the wrong
  // reason.
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  allOf?: JsonSchema[];
};

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  schema: ContractName;
  file: string;
  errors: ValidationError[];
};

export const CONTRACTS: ContractInfo[] = [
  {
    name: "agent-event",
    fileName: "agent-event.schema.json",
    description: "Append-only lifecycle event emitted by orchestrators and subagents.",
    enforcement: {
      kind: "none",
      reason:
        "Events are appended by whichever agent is running, in that agent's own runtime. No keryx process sits between the emitter and the log, so there is no point at which a malformed event could be refused rather than written.",
    },
  },
  /**
   * `flow-orchestrator`'s input, on the `task-implementer-input` precedent.
   *
   * It shipped unregistered while the skill was dispatched with a payload that
   * decides where the work LANDS — which branch the fix is cut from, which
   * branch it merges into, whether a human authorised the merge at all. None of
   * that could be validated, because nothing could load the schema; a dispatch
   * that dropped `base_branch` merged to whatever base the orchestrator resolved
   * on its own and reported success.
   */
  {
    name: "flow-orchestrator-input",
    fileName: "flow-orchestrator-input-contract.schema.json",
    description:
      "Dispatch payload handed to flow-orchestrator (request + base branch + completion outcome + constraints).",
    sourcePath:
      "src/gdskills/bundled/skills/orchestration/flow-orchestrator/input-contract.schema.json",
    enforcement: {
      kind: "none",
      reason:
        "This payload is handed from one AGENT to another. In a session driven by a host agent's own dispatch tool, no keryx process is on that path, so nothing can refuse a malformed dispatch. Same structural position as reviewer-input, recorded for the same reason. Registering it made `keryx skills contracts validate --schema flow-orchestrator-input` possible, which is a validator an agent must remember to run, not an enforcement.",
    },
  },
  /**
   * `review-pr-feedback`'s two, registered for the same reason its sibling was.
   *
   * Its input schema carried the rule "operator_confirmed is REQUIRED whenever
   * `fix` is true" as a property DESCRIPTION and nothing else — the fence that
   * matters most, since `--fix` merges third-party review comments into somebody
   * else's pull request. The conditional is now expressed, and registering the
   * file is what lets anything point a validator at it: unregistered, `keryx
   * skills contracts validate --schema review-pr-feedback-input` exits with the
   * usage banner, so the refusal the skill describes had no way to fire.
   */
  {
    name: "review-pr-feedback-input",
    fileName: "review-pr-feedback-input-contract.schema.json",
    description:
      "Request handed to review-pr-feedback (PR reference, --fix, and the operator confirmation --fix requires).",
    sourcePath: "src/gdskills/bundled/skills/review/review-pr-feedback/input-contract.schema.json",
    enforcement: {
      kind: "none",
      reason:
        "The request is what an operator or a host agent hands the skill before any keryx command runs, so keryx is not yet in the path when the payload would have to be refused. This is the one where that hurts most: `--fix` merges third-party review comments into somebody else's pull request, and `operator_confirmed` is the fence. The conditional is expressed in the schema and `keryx skills contracts validate --schema review-pr-feedback-input` will apply it — but only when something invokes it.",
    },
  },
  {
    name: "review-pr-feedback-output",
    fileName: "review-pr-feedback-output-contract.schema.json",
    description:
      "Result review-pr-feedback returns: verdict counts, the injection-screen record, and what the fix run merged.",
    sourcePath: "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json",
    enforcement: {
      kind: "production",
      module: "src/commands/review.ts",
      /*
       * This entry said `none` first, and briefly said `production` pointing at
       * src/review/managed.ts before that — where the guard in
       * contract-enforcement.test.ts rejected it by name for containing no
       * `loadSchema` call. The guard caught its own author, which is the only
       * reason this claim is worth reading now.
       */
      refuses:
        "`keryx review comments reply --result <file>` validates the skill's result before the pass is built, so nothing reaches the pull request when the result contradicts itself — an analyze-mode run reporting a branch and a merge, or a record saying the injection screen never ran while claiming it excluded comments.",
    },
  },
  {
    name: "job-orchestrator-state",
    fileName: "job-orchestrator-state.schema.json",
    description:
      "Persisted job package state (.metaproject/jobs/<name>/state.json), written by `keryx job`.",
    sourcePath: "src/gdskills/bundled/skills/orchestration/job-orchestrator/state.schema.json",
    enforcement: {
      kind: "production",
      module: "src/job/store.ts",
      refuses:
        "`writeJob` refuses to write a state file that does not satisfy the schema, so an invalid job package cannot reach disk.",
    },
  },
  {
    name: "orchestrator-state",
    fileName: "orchestrator-state.schema.json",
    description: "Persisted resumable orchestrator state.",
    enforcement: {
      kind: "none",
      reason:
        "No keryx command reads or writes this file. It describes state an orchestrator agent persists for itself, in its own runtime, so there is no keryx-owned write path to refuse at. Contrast job-orchestrator-state, which looks similar and IS enforced for exactly one reason: `keryx job` writes that one.",
    },
  },
  {
    name: "review-finding",
    fileName: "review-finding.schema.json",
    description: "Normalized reviewer finding consumed by review-orchestrator and learning flows.",
    enforcement: {
      kind: "production",
      module: "src/review/managed.ts",
      refuses:
        "`createManagedReviewPackage` refuses to record findings that do not satisfy the schema, and the disposition sub-schema is applied the same way, so a review round cannot be written with a malformed finding or an unreadable outcome.",
    },
  },
  {
    name: "subagent-dispatch",
    fileName: "subagent-dispatch.schema.json",
    description: "Orchestrator-to-subagent dispatch payload.",
    enforcement: {
      kind: "none",
      /*
       * Recorded as `none` against the flow description that opened this work,
       * which lists it as refused in production by
       * `src/harness/child/{spawn,contract}.ts` and
       * `src/harness/extension/execute.ts`.
       *
       * Those three files name it. None loads it. `subagent-dispatch` appears
       * there as a label — `canonicalContract: "subagent-dispatch"` — on the
       * harness extension metadata, and the schema it labels is validated
       * nowhere: `loadSchema("subagent-dispatch")` occurs in no non-test file,
       * and nothing reads `subagent-dispatch.schema.json` either. Six files
       * mention the schema in prose, several describing it as defining or
       * gating the dispatch.
       *
       * So the enumeration that this flow called "not by impression" carried
       * one entry claiming an enforcement that does not exist — which is the
       * defect the flow was opened to fix, present in its own statement of the
       * problem. Kept visible here rather than silently corrected, because a
       * table that got believed is the thing being guarded against.
       */
      reason:
        "The dispatch is built and consumed inside the harness without the canonical schema being loaded: `subagent-dispatch` appears only as a label on the extension metadata. Its sibling `subagent-result` IS validated, because the harness parses a child's reply back and has to decide whether it is well-formed; nothing performs the equivalent act on the way out.",
    },
  },
  {
    name: "subagent-result",
    fileName: "subagent-result.schema.json",
    description: "Subagent-to-orchestrator result payload.",
    enforcement: {
      kind: "production",
      module: "src/harness/external/runtime.ts",
      refuses:
        "A child's reply that does not parse as a well-formed result is rejected when the harness reads it back, so a malformed result cannot be persisted as if the child had succeeded.",
    },
  },
  /**
   * `task-implementer`'s two contracts, on the `job-orchestrator-state`
   * precedent: the authoritative file stays inside the skill that owns it and
   * the registry points at it, so there is no second copy to drift.
   *
   * They shipped for a year unregistered, which meant
   * `keryx skills contracts validate` could not load either one — while the
   * skill's Phase 1.4 listed five `ASSERT … → ABORT(…)` refusals and its task
   * request template said "Валидация: input-contract.schema.json". Nothing could
   * perform either. Registered, the refusals are the validator's.
   */
  {
    name: "task-implementer-input",
    fileName: "task-implementer-input-contract.schema.json",
    description:
      "Task request handed to task-implementer (task + workspace + automation), validated before dispatch.",
    sourcePath:
      "src/gdskills/bundled/skills/orchestration/task-implementer/input-contract.schema.json",
    enforcement: {
      kind: "none",
      reason:
        "Dispatched agent-to-agent, like flow-orchestrator-input. The skill's Phase 1.4 lists five `ASSERT … → ABORT(…)` refusals; registering the contract is what lets `keryx skills contracts validate` perform them, and nothing forces that call. The comment beside this registration has said so since it was written.",
    },
  },
  {
    name: "task-implementer-output",
    fileName: "task-implementer-output-contract.schema.json",
    description:
      "JSON result task-implementer writes in Phase 6.1 before it emits its STATUS line.",
    sourcePath:
      "src/gdskills/bundled/skills/orchestration/task-implementer/output-contract.schema.json",
    enforcement: {
      kind: "none",
      reason:
        "The skill writes this file itself, in its own runtime, and no keryx command reads it back. Contrast subagent-result, which is the same shape of thing and IS enforced for one reason: the harness reads that one back and must decide whether it is well-formed.",
    },
  },
];

export function normalizeContractName(value: string | undefined): ContractName | undefined {
  return CONTRACTS.find((contract) => contract.name === value)?.name;
}

export async function validateContractFile(
  filePath: string,
  schemaName: ContractName,
): Promise<ValidationResult> {
  const schema = await loadSchema(schemaName);
  const raw = await readFile(filePath, "utf8");
  const data = JSON.parse(raw) as unknown;
  const errors: ValidationError[] = [];
  const schemaCache = new Map<string, JsonSchema>([[schemaName, schema]]);

  await validateValue(data, schema, "$", errors, schema, schemaCache);

  return {
    valid: errors.length === 0,
    schema: schemaName,
    file: filePath,
    errors,
  };
}

/**
 * Validate an in-memory value against an in-memory schema.
 *
 * `validateContractFile` reads both from disk, which makes the conditional
 * keywords above untestable in isolation: a test could only observe them
 * through a real contract, and would then pass or fail for two reasons at once.
 * This is the seam that lets the keyword be pinned on its own.
 */
export async function validateJson(value: unknown, schema: JsonSchema): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  await validateValue(value, schema, "$", errors, schema, new Map());
  return errors;
}

export async function loadSchema(name: ContractName): Promise<JsonSchema> {
  const contract = CONTRACTS.find((entry) => entry.name === name);
  if (!contract) {
    throw new Error(`Unknown contract schema: ${name}`);
  }

  const raw = await readFile(contractPath(contract), "utf8");
  return JSON.parse(raw) as JsonSchema;
}

/**
 * Absolute path of a contract's authoritative schema file.
 *
 * A contract that declares `sourcePath` is resolved there first, from whichever
 * root this module happens to be running under (checked out source, or the
 * packaged build where `src/` sits one level up). Everything else keeps the
 * original `contracts/<fileName>` lookup.
 */
export function contractPath(contract: ContractInfo): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  if (contract.sourcePath) {
    for (const root of [path.join(here, "..", ".."), path.join(here, ".."), here]) {
      const candidate = path.resolve(root, contract.sourcePath);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const directPath = fileURLToPath(new URL(`./contracts/${contract.fileName}`, import.meta.url));
  if (existsSync(directPath)) {
    return directPath;
  }

  const packagedSourcePath = path.join(here, "..", "src", "gdskills", "contracts", contract.fileName);
  if (existsSync(packagedSourcePath)) {
    return packagedSourcePath;
  }

  return directPath;
}

async function validateValue(
  value: unknown,
  schema: JsonSchema,
  valuePath: string,
  errors: ValidationError[],
  rootSchema: JsonSchema,
  schemaCache: Map<string, JsonSchema>,
): Promise<void> {
  if (schema.$ref) {
    const resolved = await resolveRef(schema.$ref, rootSchema, schemaCache);
    await validateValue(value, resolved, valuePath, errors, resolved, schemaCache);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({
      path: valuePath,
      message: `Expected type ${formatType(schema.type)}, got ${describeValue(value)}`,
    });
    return;
  }

  if (schema.enum && !schema.enum.some((item) => item === value)) {
    errors.push({
      path: valuePath,
      message: `Expected one of ${schema.enum.map(String).join(", ")}`,
    });
  }

  if ("const" in schema && schema.const !== value) {
    errors.push({
      path: valuePath,
      message: `Expected ${describeValue(schema.const)}`,
    });
  }

  for (const branch of schema.allOf ?? []) {
    await validateValue(value, branch, valuePath, errors, rootSchema, schemaCache);
  }

  if (schema.if) {
    // The `if` subschema is a TEST, not an assertion: its errors decide which
    // branch applies and are then discarded. Collecting them into `errors`
    // would report every non-matching branch as a violation.
    const probe: ValidationError[] = [];
    await validateValue(value, schema.if, valuePath, probe, rootSchema, schemaCache);
    const branch = probe.length === 0 ? schema.then : schema.else;
    if (branch) {
      await validateValue(value, branch, valuePath, errors, rootSchema, schemaCache);
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({
      path: valuePath,
      message: `Expected number >= ${schema.minimum}`,
    });
  }

  if (typeof value === "number" && schema.maximum !== undefined && value > schema.maximum) {
    errors.push({
      path: valuePath,
      message: `Expected number <= ${schema.maximum}`,
    });
  }

  if (Array.isArray(value) && schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({
      path: valuePath,
      message: `Expected array length >= ${schema.minItems}`,
    });
  }

  if (Array.isArray(value) && schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({
      path: valuePath,
      message: `Expected array length <= ${schema.maxItems}`,
    });
  }

  // Surfaced by `contract-keywords.test.ts` on its first run, in a schema nobody
  // had re-read: `subagent-dispatch` declares `maxCostUnits: { exclusiveMinimum:
  // 0 }`, so a dispatch claiming a budget of exactly 0 — or a negative one —
  // validated clean while the schema said it must be positive.
  if (typeof value === "number" && schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    errors.push({
      path: valuePath,
      message: `Expected number > ${schema.exclusiveMinimum}`,
    });
  }

  // Also surfaced by the same guard. `subagent-dispatch` uses
  // `then: { not: { required: ["agent"] } }` — a PROHIBITION, the only way the
  // schema can say "this field must be absent here". Ignored, the prohibition
  // was decorative: the branch it guards accepted exactly what it forbade.
  if (schema.not !== undefined) {
    const negated: ValidationError[] = [];
    await validateValue(value, schema.not, valuePath, negated, rootSchema, schemaCache);
    if (negated.length === 0) {
      errors.push({
        path: valuePath,
        message: "Expected value NOT to match the prohibited subschema",
      });
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({
        path: valuePath,
        message: `Expected string length >= ${schema.minLength}`,
      });
    }

    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({
        path: valuePath,
        message: `Expected string to match pattern ${schema.pattern}`,
      });
    }
  }

  if (isPlainObject(value)) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        errors.push({
          path: `${valuePath}.${key}`,
          message: "Missing required property",
        });
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedSchema = properties[key];
      if (nestedSchema) {
        await validateValue(
          nestedValue,
          nestedSchema,
          `${valuePath}.${key}`,
          errors,
          rootSchema,
          schemaCache,
        );
      } else if (schema.additionalProperties === false) {
        errors.push({
          path: `${valuePath}.${key}`,
          message: "Additional property is not allowed",
        });
      } else if (isPlainObject(schema.additionalProperties)) {
        await validateValue(
          nestedValue,
          schema.additionalProperties,
          `${valuePath}.${key}`,
          errors,
          rootSchema,
          schemaCache,
        );
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (const [index, item] of value.entries()) {
      await validateValue(
        item,
        schema.items,
        `${valuePath}[${index}]`,
        errors,
        rootSchema,
        schemaCache,
      );
    }
  }
}

async function resolveRef(
  ref: string,
  rootSchema: JsonSchema,
  schemaCache: Map<string, JsonSchema>,
): Promise<JsonSchema> {
  if (ref.startsWith("#/$defs/")) {
    const name = ref.replace("#/$defs/", "");
    const schema = rootSchema.$defs?.[name];
    if (!schema) {
      throw new Error(`Cannot resolve schema ref: ${ref}`);
    }

    return schema;
  }

  if (ref === "review-finding.schema.json") {
    const cached = schemaCache.get("review-finding");
    if (cached) {
      return cached;
    }

    const schema = await loadSchema("review-finding");
    schemaCache.set("review-finding", schema);
    return schema;
  }

  // Any other sibling schema, resolved by filename from the directories that
  // hold one. `reviewer-input.schema.json` has always carried
  // `$ref: review-context.schema.json`, and before this the validator threw on
  // it — so that contract could not be validated at all, and the `$ref` read as
  // enforcement while enforcing nothing.
  //
  // Filename lookup rather than a relative path because a schema is validated
  // from memory as often as from disk (`validateJson`), so there is not always a
  // containing directory to be relative to. The names are unique across these
  // roots; `resolves every sibling ref` in `review-input-fix-round.test.ts`
  // fails if that stops being true.
  if (ref.endsWith(".schema.json") && !ref.includes("..") && !ref.includes("/")) {
    const cached = schemaCache.get(ref);
    if (cached) {
      return cached;
    }

    for (const dir of SCHEMA_ROOTS) {
      const candidate = path.join(dir, ref);
      if (existsSync(candidate)) {
        const schema = JSON.parse(await readFile(candidate, "utf8")) as JsonSchema;
        schemaCache.set(ref, schema);
        return schema;
      }
    }
  }

  throw new Error(`Unsupported schema ref: ${ref}`);
}

/** Directories that hold a resolvable `$ref` target, in precedence order. */
const SCHEMA_ROOTS: string[] = [
  fileURLToPath(new URL("./contracts/", import.meta.url)),
  fileURLToPath(new URL("./bundled/skills/review/review-orchestrator/", import.meta.url)),
];

function matchesType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => {
    if (entry === "array") return Array.isArray(value);
    if (entry === "null") return value === null;
    if (entry === "integer") return Number.isInteger(value);
    if (entry === "object") return isPlainObject(value);
    return typeof value === entry;
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatType(type: string | string[]): string {
  return Array.isArray(type) ? type.join(" | ") : type;
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** Repo-relative path of a contract's authoritative schema file, for listings. */
export function relativeContractPath(contract: ContractInfo): string {
  return contract.sourcePath ?? path.join("src", "gdskills", "contracts", contract.fileName);
}
