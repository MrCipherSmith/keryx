import { parseArgs } from "node:util";
import { z } from "zod";
import type { PublicationRequest } from "../review/desk-publication-types";
import type { DeskRunKey } from "../review/desk-run-types";

export const DESK_PUBLISH_USAGE =
  "keryx review desk-publish --json --repo owner/name --repository-id ID --viewer LOGIN --number N --request <JSON>";

const REQUEST_LIMIT = 32 * 1024;
const attemptId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const answerKey = z.string().regex(/^[A-Za-z0-9_.:/#-]{1,512}$/)
  .refine(key => key !== "__proto__" && key !== "constructor" && key !== "prototype");
const settings = z.strictObject({
  inline: z.boolean(),
  general: z.boolean(),
  keryxTemplate: z.boolean(),
  overlay: z.boolean(),
  verdict: z.enum(["approve", "suggestions", "changes", "comment"]),
  answers: z.record(answerKey, z.enum(["uphold", "dismiss"])).refine(answers => Object.keys(answers).length <= 100),
});
const request = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preview"), id: attemptId, settings: settings.optional() }),
  z.strictObject({ kind: z.literal("save"), id: attemptId, settings }),
  z.strictObject({ kind: z.literal("submit"), id: attemptId, settings, digest: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
const target = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/).refine(value => !value.startsWith("-")),
  repositoryId: z.string().regex(/^[A-Za-z0-9_:+/=-]{1,200}$/).refine(value => !value.startsWith("-")),
  viewer: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  number: z.number().int().positive().max(2147483647),
});

function publicationTarget(value: unknown): DeskRunKey {
  const parsed = target.safeParse(value);
  if (!parsed.success) throw new Error("configuration: Invalid Review publication target.");
  return parsed.data;
}

export function parsePublicationRequest(raw: string): PublicationRequest {
  if (Buffer.byteLength(raw) > REQUEST_LIMIT) throw new Error("configuration: Review publication request is too large.");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("configuration: Invalid Review publication JSON.");
  }
  const parsed = request.safeParse(data);
  if (!parsed.success) throw new Error("configuration: Invalid Review publication request.");
  const operation = parsed.data;
  if (operation.kind === "preview") {
    return operation.settings
      ? { kind: "preview", id: operation.id, settings: operation.settings }
      : { kind: "preview", id: operation.id };
  }
  return operation;
}

/** Browser development uses the same scoped wire contract as the native bridge. */
export function publicationArgs(key: unknown, action: unknown): { args: string[]; readOnly: boolean } {
  const scope = publicationTarget(key);
  const raw = JSON.stringify(action);
  if (raw === undefined) throw new Error("configuration: Missing Review publication request.");
  const operation = parsePublicationRequest(raw);
  return {
    args: [
      "review", "desk-publish", "--json",
      "--repo", scope.repo, "--repository-id", scope.repositoryId, "--viewer", scope.viewer,
      "--number", String(scope.number), "--request", raw,
    ],
    readOnly: operation.kind === "preview",
  };
}

export async function runReviewDeskPublish(args: string[]): Promise<void> {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(DESK_PUBLISH_USAGE);
    return;
  }
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      json: { type: "boolean" },
      repo: { type: "string" },
      "repository-id": { type: "string" },
      viewer: { type: "string" },
      number: { type: "string" },
      request: { type: "string" },
    },
  });
  if (!values.json || !values.request || !/^[1-9]\d*$/.test(values.number ?? "")) {
    throw new Error(DESK_PUBLISH_USAGE);
  }
  const targetKey = publicationTarget({
    repo: values.repo, repositoryId: values["repository-id"], viewer: values.viewer, number: Number(values.number),
  });
  const input = parsePublicationRequest(values.request);
  const { requestDeskPublication } = await import("../review/desk-publication");
  const result = await requestDeskPublication(process.cwd(), targetKey, input);
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(result) + "\n", error => error ? reject(error) : resolve()),
  );
}
