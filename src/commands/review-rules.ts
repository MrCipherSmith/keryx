import { parseArgs } from "node:util";
import { z } from "zod";
import { applyReviewRuleAction } from "../review/review-rules";
import type { ReviewRuleAction } from "../review/review-rule-types";
import { mainCheckout, parseWatcherKey, verifyIdentity } from "../review/watcher-project";

export const RULES_USAGE =
  "keryx review rules --repo owner/name --repository-id ID --viewer LOGIN --json [--request <JSON>]";
const number = z.number().int().positive().max(2147483647);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const login = "[a-z0-9][a-z0-9._-]*(?:\\[bot\\])?";
const filter = (team: boolean) =>
  z
    .string()
    .trim()
    .max(180)
    .refine(value => value !== "@", "Enter a GitHub login or leave the field empty.")
    .transform((value) => value.replace(/^@/, ""))
    .pipe(z.string().regex(new RegExp(team ? `^(?:${login}(?:/[a-z0-9._-]+)?)?$` : `^(?:${login})?$`, "i")));
const rule = z.strictObject({
  id,
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\p{Cc}]+$/u),
  enabled: z.boolean(),
  event: z.enum(["review_requested", "push"]),
  author: filter(false),
  assignee: filter(false),
  reviewer: filter(true),
  requireGreen: z.boolean(),
  budgetMinutes: z.number().int().min(1).max(30),
  budgetTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
});
const choice = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("auto"), ruleId: id }),
  z.strictObject({ mode: z.literal("project") }),
  z.strictObject({ mode: z.literal("manual") }),
]);
const actions = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("status"), number: number.optional() }),
  z.strictObject({ kind: z.literal("mode"), number, choice }),
  z.strictObject({ kind: z.literal("save"), rule, expected: rule.nullable().optional(), number: number.optional() }),
  z.strictObject({ kind: z.literal("delete"), id, expected: rule.optional(), number: number.optional() }),
]);

export function parseRuleRequest(raw: string): ReviewRuleAction {
  if (Buffer.byteLength(raw) > 8192) throw new Error("configuration: Review rule request is too large.");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("configuration: Invalid review rule JSON.");
  }
  const result = actions.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(
      `configuration: Invalid review rule field ${issue.path.join(".") || "request"}. ${issue.message}`,
    );
  }
  return result.data;
}

export async function runReviewRules(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(RULES_USAGE);
    return;
  }
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      repo: { type: "string" },
      "repository-id": { type: "string" },
      viewer: { type: "string" },
      request: { type: "string" },
    },
  });
  const key = parseWatcherKey(values);
  if (!key || !values.json) throw new Error(RULES_USAGE);
  const action = parseRuleRequest(values.request ?? '{"kind":"status"}');
  const project = await mainCheckout(process.cwd());
  await verifyIdentity(project, key);
  const snapshot = applyReviewRuleAction(project, key, action);
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(snapshot) + "\n", (error) => (error ? reject(error) : resolve())),
  );
}
