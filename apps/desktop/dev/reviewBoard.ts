type Json = Record<string, unknown>;

export function reviewBoardArgs(args: Json): string[] {
  const argv = ["review", "board", "--json"];
  if (args.repo != null) {
    if (typeof args.repo !== "string" || !args.repo || args.repo.startsWith("-") || /\s/.test(args.repo)) {
      throw new Error("configuration: Invalid repository");
    }
    argv.push("--repo", args.repo);
  }
  if (args.badgeTarget != null) {
    const target = args.badgeTarget as Json;
    if (!args.repo || args.repositoriesOnly || args.prState != null || args.number != null || args.paged || args.cursor != null ||
        typeof target.revisions !== "string" || !target.revisions || target.revisions.length > 50000 || !/^[0-9a-f:,]+$/.test(target.revisions) ||
        [target.viewer, target.repositoryId].some(value => typeof value !== "string" || !value || /^-|\s/.test(value))) {
      throw new Error("configuration: Invalid badge request");
    }
    argv.push("--viewer", String(target.viewer), "--repository-id", String(target.repositoryId), "--badge-revisions", target.revisions);
  } else if (args.repositoriesOnly === true) {
    if (args.repo != null || args.prState != null || args.number != null) {
      throw new Error("configuration: Repository discovery cannot be combined with a PR query");
    }
    argv.push("--repositories");
  } else if (args.number != null && args.prState == null && args.repo && Number.isSafeInteger(args.number) && Number(args.number) > 0) {
    argv.push("--number", String(args.number));
  } else if (args.number == null && ["open", "closed", "merged", "all"].includes(String(args.prState))) {
    argv.push("--state", String(args.prState));
  } else {
    throw new Error("configuration: Select a PR state or a repository and PR number");
  }

  if (args.paged === true) {
    if (args.prState == null) throw new Error("configuration: Select a board state to page");
    argv.push("--page", "--cards-only");
  }
  if (args.cursor != null) {
    if (args.paged !== true || typeof args.cursor !== "string" || !args.cursor || args.cursor.length > 4096) throw new Error("configuration: Invalid board cursor");
    argv.push("--cursor=" + args.cursor);
  }
  return argv;
}
