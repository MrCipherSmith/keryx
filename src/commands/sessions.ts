// `keryx sessions` — list / export per-project interactive shell sessions.

import {
  TranscriptUnreadableError,
  UnknownSessionError,
  exportSessionMarkdown,
  findSession,
  forkSession,
  listSessions,
  projectSessionsDir,
  resolveProjectRoot,
  shortSessionId,
} from "../session";

export async function sessionsCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printHelp();
    return;
  }

  const cwd = process.cwd();

  if (sub === "list") {
    const asJson = args.includes("--json");
    const rows = listSessions(cwd);
    if (asJson) {
      console.log(JSON.stringify({ schemaVersion: 1, project: resolveProjectRoot(cwd), sessions: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(`No sessions for project ${resolveProjectRoot(cwd)}`);
      console.log(`(store: ${projectSessionsDir(cwd)})`);
      return;
    }
    console.log(`Project: ${resolveProjectRoot(cwd)}`);
    console.log(`Store:   ${projectSessionsDir(cwd)}`);
    console.log("");
    console.log(
      pad("ID", 10) + pad("UPDATED", 22) + pad("MSGS", 6) + pad("MODEL", 24) + "TITLE",
    );
    for (const s of rows) {
      const model =
        s.provider !== undefined && s.model !== undefined
          ? `${s.provider}/${s.model}`
          : s.model ?? "-";
      console.log(
        pad(shortSessionId(s.id), 10) +
          pad(s.updatedAt.slice(0, 19).replace("T", " "), 22) +
          pad(String(s.messageCount), 6) +
          pad(clip(model, 22), 24) +
          // A fork is marked in the listing rather than only in `--json`: the
          // ancestry is the whole point of the verb, and a row that looks
          // identical to an unrelated session hides it.
          (s.parentSessionId !== undefined ? `↳ ${s.title}` : s.title),
      );
    }
    console.log("");
    console.log("Resume: keryx shell -r <id>   Continue last: keryx shell -c");
    return;
  }

  if (sub === "export") {
    const id = args[1];
    if (id === undefined || id.length === 0) {
      console.error("Usage: keryx sessions export <id>");
      process.exitCode = 1;
      return;
    }
    const found = findSession(cwd, id);
    if (found === undefined) {
      console.error(`No session "${id}" in this project.`);
      process.exitCode = 1;
      return;
    }
    // Guarded, because `loadContext` throws on a transcript it cannot read
    // rather than returning an empty one. Unguarded, that throw left `main()`
    // to print a stack trace carrying an absolute home-directory path, for a
    // condition — an oversized or non-regular transcript — the operator can act
    // on if simply told which file and why.
    try {
      console.log(exportSessionMarkdown(cwd, found.id));
    } catch (cause) {
      if (!(cause instanceof TranscriptUnreadableError)) {
        throw cause;
      }
      console.error(`Cannot export session "${found.id}": ${cause.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === "fork") {
    const id = args[1];
    if (id === undefined || id.length === 0 || id.startsWith("-")) {
      console.error("Usage: keryx sessions fork <id> [--title \"<t>\"]");
      process.exitCode = 1;
      return;
    }
    const titleIndex = args.indexOf("--title");
    const title = titleIndex >= 0 ? args[titleIndex + 1] : undefined;
    if (titleIndex >= 0 && (title === undefined || title.length === 0)) {
      console.error("Usage: keryx sessions fork <id> [--title \"<t>\"]");
      process.exitCode = 1;
      return;
    }
    try {
      const forked = forkSession({ cwd, sourceIdOrPrefix: id, ...(title !== undefined ? { title } : {}) });
      if (args.includes("--json")) {
        console.log(
          JSON.stringify(
            {
              schemaVersion: 1,
              id: forked.handle.summary.id,
              parentSessionId: forked.source.id,
              title: forked.handle.summary.title,
              messageCount: forked.messageCount,
              archiveMessageCount: forked.archiveCount,
              dir: forked.handle.dir,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Forked ${shortSessionId(forked.source.id)} -> ${shortSessionId(forked.handle.summary.id)}`);
      console.log(`  title:   ${forked.handle.summary.title}`);
      console.log(`  parent:  ${forked.source.id}`);
      console.log(`  history: ${forked.messageCount} context / ${forked.archiveCount} archive`);
      console.log("");
      console.log(`Resume: keryx shell -r ${shortSessionId(forked.handle.summary.id)}`);
    } catch (cause) {
      if (cause instanceof UnknownSessionError) {
        console.error(`No session "${id}" in this project. Use \`keryx sessions list\`.`);
        process.exitCode = 1;
        return;
      }
      // Same reason `export` guards this: an unreadable transcript is an
      // operator-actionable condition, not a stack trace with a home path in it.
      if (cause instanceof TranscriptUnreadableError) {
        console.error(`Cannot fork session "${id}": ${cause.message}`);
        process.exitCode = 1;
        return;
      }
      throw cause;
    }
    return;
  }

  if (sub === "path") {
    console.log(projectSessionsDir(cwd));
    return;
  }

  console.error(`Unknown sessions subcommand: ${sub}`);
  printHelp();
  process.exitCode = 1;
}

function pad(s: string, n: number): string {
  return s.length >= n ? `${s.slice(0, n - 1)} ` : s + " ".repeat(n - s.length);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function printHelp(): void {
  console.log(`keryx sessions

Per-project interactive shell sessions (isolated by git root / cwd).

Usage:
  keryx sessions list [--json]     List sessions for the current project
  keryx sessions fork <id>         Branch a session into a new one (--title, --json)
  keryx sessions export <id>       Export transcript as Markdown
  keryx sessions path              Print the on-disk sessions directory

Shell:
  keryx shell -c                   Continue last session in this project
  keryx shell -r [id]              Resume session (id / short id / title)
`);
}
