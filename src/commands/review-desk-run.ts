import { readDeskOptionsJson } from "../review/desk-run-options";
import { parseArgs } from "node:util";
import { requestDeskRun, runDeskWorker, type DeskAction } from "../review/desk-run-service";
import { DESK_REVIEW_ACTIONS, type DeskReviewAction } from "../review/desk-run-types";
import { isAutonomousEnv } from "../review/run-profile";

export const DESK_USAGE =
  "keryx review desk-run <start|status|cancel|answer|readiness|decide> --json --repo owner/name --repository-id ID --viewer LOGIN --number N [--id UUID] [--decision complete|close|archive|restore|delete --reason TEXT [--waive item,item]]";
const sha = /^[0-9a-f]{40}$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export async function runReviewDesk(args: string[]) {
  const [action, ...flags] = args;
  if (!action || action === "--help" || action === "-h") {
    console.log(DESK_USAGE);
    return;
  }
  if (action === "answer" && process.env.KERYX_UNATTENDED === "1") throw new Error("access: Review replies require the operator.");
  if (action === "decide" && (process.env.KERYX_TOOL_CALL === "1" || process.env.KERYX_UNATTENDED === "1" ||
      isAutonomousEnv(process.env) || !(process.env.KERYX_DESKTOP_REVIEW_ACTION === "1" || (process.stdin.isTTY && process.stdout.isTTY)))) {
    throw new Error("Review outcome changes require an operator in Desktop or at a terminal.");
  }
  const { values: v } = parseArgs({
    args: flags,
    strict: true,
    options: {
      json: { type: "boolean" },
      repo: { type: "string" },
      "repository-id": { type: "string" },
      viewer: { type: "string" },
      number: { type: "string" },
      options: { type: "string" },
      base: { type: "string" },
      head: { type: "string" },
      id: { type: "string" },
      "question-id": { type: "string" },
      answer: { type: "string" },
      "activity-id": { type: "string" },
      decision: { type: "string" },
      reason: { type: "string" },
      waive: { type: "string" },
    },
  });
  if (action === "worker" && Object.keys(v).length === 1 && v.id && uuid.test(v.id)) {
    const { resolveDeskReviewModel } = await import("./review-desk-provider");
    await runDeskWorker(v.id, resolveDeskReviewModel);
    return;
  }
  const number = Number(v.number);
  const repositoryId = v["repository-id"];
  if (
    !v.json ||
    !v.repo ||
    !repositoryId ||
    !v.viewer ||
    !v.number ||
    !/^[1-9]\d*$/.test(v.number) ||
    !Number.isSafeInteger(number)
  )
    throw new Error(DESK_USAGE);
  if (v.options !== undefined && action !== "start") throw new Error(DESK_USAGE);
  const activityId = v["activity-id"];
  if (activityId !== undefined && (action !== "status" || v.id !== undefined || !uuid.test(activityId))) throw new Error(DESK_USAGE);
  const questionId = v["question-id"];
  if (action !== "answer" && (questionId !== undefined || v.answer !== undefined)) throw new Error(DESK_USAGE);
  if (action !== "decide" && (v.decision !== undefined || v.reason !== undefined || v.waive !== undefined)) throw new Error(DESK_USAGE);
  let input: DeskAction;
  if (action === "start" && v.base && sha.test(v.base) && v.head && sha.test(v.head) && !v.id) {
    const options = v.options === undefined ? undefined : readDeskOptionsJson(v.options);
    if (options?.autoPublish && (process.env.KERYX_TOOL_CALL === "1" || process.env.KERYX_UNATTENDED === "1" ||
        isAutonomousEnv(process.env) || !(process.env.KERYX_DESKTOP_REVIEW_ACTION === "1" || (process.stdin.isTTY && process.stdout.isTTY)))) {
      throw new Error("permission: Automatic GitHub publication must be enabled by the operator.");
    }
    input = { action, revision: { baseSha: v.base, headSha: v.head }, ...(options && { options }) };
  } else if (action === "answer" && v.id && uuid.test(v.id) && questionId && uuid.test(questionId) &&
      v.answer?.trim() && v.answer.length <= 2000 && !v.base && !v.head) {
    input = { action, id: v.id, questionId, answer: v.answer };
  } else if (action === "cancel" && v.id && uuid.test(v.id) && !v.base && !v.head) {
    input = { action, id: v.id };
  } else if (action === "readiness" && v.id && uuid.test(v.id) && !v.base && !v.head) {
    input = { action, id: v.id };
  } else if (action === "decide" && v.id && uuid.test(v.id) && !v.base && !v.head &&
      (DESK_REVIEW_ACTIONS as readonly string[]).includes(v.decision ?? "") && v.reason?.trim() && v.reason.length <= 2000 &&
      (v.waive === undefined || (v.decision === "complete" && /^[a-z-]+(?:,[a-z-]+){0,11}$/.test(v.waive)))) {
    input = { action, id: v.id, decision: v.decision as DeskReviewAction, reason: v.reason,
      ...(v.waive ? { waive: v.waive.split(",") } : {}) };
  } else if (action === "status" && !v.base && !v.head && (v.id === undefined || uuid.test(v.id))) {
    input = { action, ...(v.id ? { id: v.id } : {}), ...(activityId ? { activityId } : {}) };
  } else throw new Error(DESK_USAGE);
  const snapshot = await requestDeskRun(
    process.cwd(),
    { repo: v.repo, repositoryId, viewer: v.viewer, number },
    input,
  );
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(snapshot) + "\n", (error) => (error ? reject(error) : resolve())),
  );
}
