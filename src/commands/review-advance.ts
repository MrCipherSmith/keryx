// `keryx review advance`: the update round of a Review on the pull request's current head (flow 521, spec "Раунд обновления").
import { parseArgs } from "node:util";
import { projectGithubConnection } from "../review/board-github";
import { DeskRunStore } from "../review/desk-run-store";
import { requestDeskRun, resolveDeskSubject } from "../review/desk-run-service";
import { advanceReview } from "../review/review-advance";

export const ADVANCE_USAGE =
  "keryx review advance --json --repo owner/name --number N [--id UUID] [--repository-id ID --viewer LOGIN] [--base SHA --head SHA]";
const sha = /^[0-9a-f]{40}$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export async function runReviewAdvance(args: string[], cwd = process.cwd()): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(ADVANCE_USAGE);
    return;
  }
  const { values: v } = parseArgs({
    args, strict: true, allowPositionals: false,
    options: {
      json: { type: "boolean" }, repo: { type: "string" }, number: { type: "string" }, id: { type: "string" },
      "repository-id": { type: "string" }, viewer: { type: "string" }, base: { type: "string" }, head: { type: "string" },
    },
  });
  const number = Number(v.number);
  if (!v.json || !v.repo || !/^[\w.-]+\/[\w.-]+$/.test(v.repo) || !v.number || !/^[1-9]\d*$/.test(v.number) || !Number.isSafeInteger(number) ||
      (v.id !== undefined && !uuid.test(v.id)) || (v.base === undefined) !== (v.head === undefined) ||
      (v.base !== undefined && (!sha.test(v.base) || !sha.test(v.head!)))) {
    throw new Error(ADVANCE_USAGE);
  }
  const snapshot = await advanceReview({
    repo: v.repo, number, id: v.id, repositoryId: v["repository-id"], viewer: v.viewer,
    ...(v.base !== undefined && { revision: { baseSha: v.base, headSha: v.head! } }),
  }, {
    resolve: async (repo, pr) => resolveDeskSubject(cwd, repo, pr, await projectGithubConnection(cwd)),
    history: (key) => {
      const store = new DeskRunStore();
      try { return store.history(key).runs; } finally { store.close(); }
    },
    start: async (key, revision, options) => {
      const { resolveDeskReviewOptions } = await import("./review-desk-provider");
      return requestDeskRun(cwd, key, { action: "start", revision, ...(options && { options }) }, resolveDeskReviewOptions);
    },
  });
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(snapshot) + "\n", (error) => (error ? reject(error) : resolve())),
  );
}
