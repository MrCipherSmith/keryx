// Read-only data for the Desktop Review board. The two hosts invoke the same CLI.
import { readLinkedFlows } from "../review/pr-context";
import { decodeBoardCursor, splitBoardCard } from "../review/board-transport";
import { parseWatcherKey } from "../review/watcher-project";
import { readBoardBadges } from "../review/board-badge-read";
import { attachDeskRunBadges, readLocalBadges } from "../review/desk-run-store";
import { parseArgs } from "node:util";
import { attachAddressedReplies } from "../review/board-addressed-replies";
import { listReviewCards } from "../review/board";
import { readReviewBoardDetail } from "../review/board-detail";
import { boardGh, boardGraphql, projectGithubConnection, reviewRepositories, selectRepository, withCurrentGithubBinding, type GithubConnection } from "../review/board-github";

export const BOARD_USAGE = "keryx review board --json [--repo owner/name] [--state open|closed|merged|all | --number N]\n  keryx review board --json --repositories\n  keryx review board --json --state STATE --page [--cursor CURSOR] [--repo owner/name]\n  keryx review board --json --repo owner/name --badge-revisions N:BASE:HEAD[,...] --repository-id ID --viewer LOGIN";

export async function runReviewBoard(args: string[], cwd = process.cwd()): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(BOARD_USAGE);
    return;
  }
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    page: { type: "boolean" }, cursor: { type: "string" }, "badge-revisions": {type: "string"}, viewer: {type: "string"}, "repository-id": {type: "string"},
    json: { type: "boolean" }, repositories: { type: "boolean" }, repo: { type: "string" }, number: { type: "string" }, state: { type: "string" },
  } });
  const state = values.state ?? "open";
  if (!values.json || (state !== "open" && state !== "closed" && state !== "merged" && state !== "all")) throw new Error(BOARD_USAGE);
  const revisions = values["badge-revisions"];
  if ((values.cursor !== undefined && (!values.page || !values.cursor || values.cursor.length > 4096)) ||
      (values.page && (values.repositories || values.number !== undefined || revisions !== undefined))) throw new Error(BOARD_USAGE);
  if (revisions !== undefined) {
    const key = parseWatcherKey(values);
    if (!key || values.repositories || values.state || values.number) throw new Error(BOARD_USAGE);
    selectRepository(await reviewRepositories(cwd), key.repo);
    const auth = await projectGithubConnection(cwd, process.env, key.viewer);
    const result = await readBoardBadges(cwd, key, revisions.split(",").map(item => {
      const match = /^([1-9]\d*):([a-f0-9]{40}):([a-f0-9]{40})$/.exec(item);
      if (!match) throw new Error(BOARD_USAGE);
      return { number: Number(match[1]), baseSha: match[2]!, headSha: match[3]! };
    }), readLocalBadges, (text, params) => boardGraphql(cwd, text, params, auth));
    await writeJson(result, auth);
    return;
  }
  if (values.viewer !== undefined || values["repository-id"] !== undefined) throw new Error(BOARD_USAGE);
  if (values.repositories) {
    if (values.repo !== undefined || values.number !== undefined || values.state !== undefined) throw new Error(BOARD_USAGE);
    console.log(JSON.stringify(await reviewRepositories(cwd)));
    return;
  }
  if (values.number !== undefined && (values.state !== undefined || !/^[1-9]\d*$/.test(values.number) || !Number.isSafeInteger(Number(values.number)))) {
    throw new Error(BOARD_USAGE);
  }
  const repositories = await reviewRepositories(cwd);
  const repo = selectRepository(repositories, values.repo);
  const auth = await projectGithubConnection(cwd);
  const query = <T>(text: string, params: Record<string, string | number>) => boardGraphql<T>(cwd, text, params, auth);
  if (values.number !== undefined) {
    const result = await readReviewBoardDetail(repo, Number(values.number), cwd, query);
    result.projectContext = await readLinkedFlows(cwd, repo, result.number);
    await writeJson(result, auth);
    return;
  }
  const continuation = decodeBoardCursor(values.cursor);
  let size = continuation.part ? 1 : 100;
  for (;;) {
    const page = values.page ? { cursor: continuation.cursor, size } : undefined;
    let result;
    try { result = await listReviewCards(repo, repositories, state, query, false, page); }
    catch (error) {
      if (!page || size === 1 || !(error instanceof Error) || !error.message.startsWith("unavailable: GitHub page exceeds")) throw error;
      size = Math.ceil(size / 2);
      continue;
    }
    attachDeskRunBadges(result);
    // Check the notification feed once per refresh, including unread candidates beyond page one.
    if (!page?.cursor && !continuation.part && (state === "open" || state === "all"))
      await attachAddressedReplies(result, async (endpoint, timeoutMs) =>
        JSON.parse(await boardGh(cwd, ["api", "--hostname", "github.com", endpoint], auth, timeoutMs)), !!result.nextCursor);
    const json = JSON.stringify(result);
    if (!continuation.part && (!page || Buffer.byteLength(json) <= 30 * 1024 * 1024)) {
      await writeSerialized(json, auth);
      return;
    }
    if (size === 1) {
      await writeJson(splitBoardCard(result, continuation), auth);
      return;
    }
    size = Math.ceil(size / 2);
  }
}

function writeJson(result: unknown, auth: GithubConnection) { return writeSerialized(JSON.stringify(result), auth); }

async function writeSerialized(json: string, auth: GithubConnection) {
  // The desktop hosts read through a pipe. Wait until even a large history or
  // discussion snapshot has been flushed before returning from the command.
  await new Promise<void>((resolve, reject) => {
    // Optional API reads can convert their errors into warnings. Check again
    // at the publication boundary, excluding concurrent writers until the
    // complete payload is handed to the pipe.
    withCurrentGithubBinding(auth, () => {
      process.stdout.write(json + "\n", (error) => error ? reject(error) : resolve());
    });
  });
}
