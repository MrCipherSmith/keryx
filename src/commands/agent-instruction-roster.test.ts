// Review F-001 (flow 249): the instruction is static text, and it contradicted two
// fixes — it told the model to call graph_symbol FIRST in a project whose roster no
// longer had it, and said read_file "cannot page forward" after it learned to.
import { expect, test } from "bun:test";
import { buildAgentSystemInstruction } from "./agent";

const PLAIN_REPO_ROSTER = [
  "apply_patch",
  "ask_user",
  "get_cwd",
  "list_dir",
  "read_file",
  "search_code",
  "shell_exec",
  "slate_read",
  "slate_write_seed",
  "spawn_subagent",
  "web_fetch",
  "web_search",
  "workspace_create",
  "workspace_list",
  "workspace_overview",
  "workspace_propose",
  "workspace_read",
  "workspace_show",
];

test("a roster without the graph gets no instruction to call it", () => {
  const text = buildAgentSystemInstruction(undefined, { toolNames: PLAIN_REPO_ROSTER });
  for (const absent of ["graph_symbol", "graph_affected", "graph_query", "memory_search", "read_wiki", "wiki_ask"]) {
    expect(text).not.toContain(absent);
  }
  expect(text).toContain("search_code");
});

test("read_file is described as paging by start_line, never as unable to", () => {
  for (const toolNames of [PLAIN_REPO_ROSTER, undefined]) {
    const text = buildAgentSystemInstruction(undefined, toolNames === undefined ? {} : { toolNames });
    expect(text).not.toContain("cannot page");
    expect(text).toContain("start_line");
  }
});

test("without a roster, the instruction still names every metaproject tool, as it always did", () => {
  const text = buildAgentSystemInstruction(undefined);
  for (const present of ["graph_symbol", "graph_affected", "memory_search", "read_wiki", "repomap"]) {
    expect(text).toContain(present);
  }
  expect(text).toContain("**graph_symbol** with `{ name }` FIRST");
});
