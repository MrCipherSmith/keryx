import { parseArgs } from "node:util";
import { requestDeskRun, runDeskWorker, type DeskAction } from "../review/desk-run-service";

export const DESK_USAGE =
  "keryx review desk-run <start|status|cancel> --json --repo owner/name --repository-id ID --viewer LOGIN --number N [--base SHA --head SHA | --id UUID | --activity-id UUID]";
const sha = /^[0-9a-f]{40}$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export async function runReviewDesk(args: string[]) {
  const [action, ...flags] = args;
  if (!action || action === "--help" || action === "-h") {
    console.log(DESK_USAGE);
    return;
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
      base: { type: "string" },
      head: { type: "string" },
      id: { type: "string" },
      "activity-id": { type: "string" },
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
  const activityId = v["activity-id"];
  if (activityId !== undefined && (action !== "status" || v.id !== undefined || !uuid.test(activityId))) throw new Error(DESK_USAGE);
  let input: DeskAction;
  if (action === "start" && v.base && sha.test(v.base) && v.head && sha.test(v.head) && !v.id) {
    input = { action, revision: { baseSha: v.base, headSha: v.head } };
  } else if (action === "cancel" && v.id && uuid.test(v.id) && !v.base && !v.head) {
    input = { action, id: v.id };
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
