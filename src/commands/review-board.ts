// Read-only data for the Desktop Review board. The two hosts invoke the same CLI.
import { readLinkedFlows } from "../review/pr-context";
import { attachDeskRunBadges } from "../review/desk-run-store";
import { parseArgs } from "node:util";
import { listReviewCards } from "../review/board";
import { readReviewBoardDetail } from "../review/board-detail";
import { boardGraphql, reviewRepositories, selectRepository } from "../review/board-github";

export const BOARD_USAGE = "keryx review board --json [--repo owner/name] [--state open|closed|merged|all | --number N]\n  keryx review board --json --repositories";

export async function runReviewBoard(args: string[], cwd = process.cwd()): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(BOARD_USAGE);
    return;
  }
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    json: { type: "boolean" }, repositories: { type: "boolean" }, repo: { type: "string" }, number: { type: "string" }, state: { type: "string" },
  } });
  const state = values.state ?? "open";
  if (!values.json || (state !== "open" && state !== "closed" && state !== "merged" && state !== "all")) throw new Error(BOARD_USAGE);
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
  const result = values.number === undefined
    ? attachDeskRunBadges(await listReviewCards(repo, repositories, state, (query, params) => boardGraphql(cwd, query, params)))
    : await readReviewBoardDetail(repo, Number(values.number), cwd);
  if ("comments" in result) result.projectContext = await readLinkedFlows(cwd, repo, result.number);
  // The desktop hosts read through a pipe. Wait until even a large history or
  // discussion snapshot has been flushed before returning from the command.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(result) + "\n", (error) => error ? reject(error) : resolve());
  });
}
