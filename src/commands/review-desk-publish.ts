import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { PUBLICATION_REQUEST_LIMIT, type PublicationOptionId, type PublicationRequest, type PublicationState } from "../review/desk-publication-types";
import type { DeskRunKey } from "../review/desk-run-types";

export const DESK_PUBLISH_USAGE =
  "keryx review desk-publish --json --repo owner/name --repository-id ID --viewer LOGIN --number N (--request <JSON> | --request-file <path>)";

const TERMINAL_REQUIRED = "permission: Publishing a review requires an interactive terminal. Use Desktop or run this command in your terminal.";
const verdict = z.enum(["approve", "suggestions", "changes", "comment"]);
const attemptId = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const answerKey = z.string().regex(/^[A-Za-z0-9_.:/#-]{1,512}$/)
  .refine(key => key !== "__proto__" && key !== "constructor" && key !== "prototype");
const optionId = z.string().refine((value): value is PublicationOptionId => /^option:[0-9a-f]{64}$/.test(value));
const settings = z.strictObject({
  inline: z.boolean(),
  general: z.boolean(),
  keryxTemplate: z.boolean(),
  overlay: z.boolean(),
  verdict,
  verdictOverride: verdict.nullable().optional(),
  answers: z.record(answerKey, z.union([z.enum(["uphold", "dismiss"]), optionId])),
});
const request = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preview"), id: attemptId, settings: settings.optional(), refresh: z.boolean().optional() }),
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
  if (Buffer.byteLength(raw) > PUBLICATION_REQUEST_LIMIT) throw new Error("configuration: Review publication request is too large.");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("configuration: Invalid Review publication JSON.");
  }
  const parsed = request.safeParse(data);
  if (!parsed.success) throw new Error("configuration: Invalid Review publication request.");
  const operation = parsed.data;
  const cleanSettings = ({ verdictOverride, ...rest }: z.infer<typeof settings>) =>
    ({ ...rest, ...(verdictOverride === undefined ? {} : { verdictOverride }) });
  if (operation.kind === "preview") {
    return {
      kind: "preview", id: operation.id,
      ...(operation.settings ? { settings: cleanSettings(operation.settings) } : {}),
      ...(operation.refresh === undefined ? {} : { refresh: operation.refresh }),
    };
  }
  return { ...operation, settings: cleanSettings(operation.settings) };
}

/** Browser development uses the same scoped wire contract as the native bridge. */
export function publicationArgs(key: unknown, requestFile: string): string[] {
  const scope = publicationTarget(key);
  return [
    "review", "desk-publish", "--json",
    "--repo", scope.repo, "--repository-id", scope.repositoryId, "--viewer", scope.viewer,
    "--number", String(scope.number), "--request-file", requestFile,
  ];
}

async function readPublicationRequest(path: string): Promise<string> {
  // Avoid blocking on named pipes or arbitrary devices, and cap bytes actually read even if the file grows.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("configuration: A Review publication request must be a regular file.");
    if (stat.size > PUBLICATION_REQUEST_LIMIT) throw new Error("configuration: Review publication request is too large.");
    const data = Buffer.alloc(PUBLICATION_REQUEST_LIMIT + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > PUBLICATION_REQUEST_LIMIT) throw new Error("configuration: Review publication request is too large.");
    return data.toString("utf8", 0, offset);
  } finally {
    await file.close();
  }
}

async function confirmSubmit(key: DeskRunKey, state: PublicationState): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  const closed = new AbortController();
  terminal.once("close", () => closed.abort());
  try {
    const answer = await terminal.question(
      `Publish a ${state.settings.verdict} review with ${state.inlineCount} inline notes to ${key.repo} #${key.number} as @${key.viewer} (preview ${state.digest.slice(0, 12)})? Type 'publish' to confirm: `,
      { signal: closed.signal },
    );
    if (answer.trim() === "publish") return;
  } catch (error) {
    if (!closed.signal.aborted) throw error;
  } finally {
    terminal.close();
    process.stderr.write("\n");
  }
  throw new Error("permission: Publication cancelled. No review was sent.");
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
      "request-file": { type: "string" },
    },
  });
  const requestFile = values["request-file"];
  const hasInline = values.request !== undefined;
  const hasFile = requestFile !== undefined;
  if (!values.json || hasInline === hasFile || !/^[1-9]\d*$/.test(values.number ?? "")) {
    throw new Error(DESK_PUBLISH_USAGE);
  }
  const targetKey = publicationTarget({
    repo: values.repo, repositoryId: values["repository-id"], viewer: values.viewer, number: Number(values.number),
  });
  const input = parsePublicationRequest(hasFile ? await readPublicationRequest(requestFile) : values.request ?? "");
  if (input.kind === "submit" && process.stdin.isTTY !== true) throw new Error(TERMINAL_REQUIRED);
  const { requestDeskPublication } = await import("../review/desk-publication");
  const result = await requestDeskPublication(process.cwd(), targetKey, input, state => confirmSubmit(targetKey, state));
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(result) + "\n", error => error ? reject(error) : resolve()),
  );
}
