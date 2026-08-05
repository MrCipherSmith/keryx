// One tool surface, three places that describe it (flow 136, AC9 + AC10).
//
// Before this flow: `buildAgentSystemInstruction` named nine tools,
// `readlineAgentHelpText` named six, and the registry built fifteen. A model that
// is not told a tool exists reaches for `shell_exec`, which is default-deny — so
// the drift produced the stall benchmark case A1 recorded, and a fix applied to
// one of the two instructions left the other advertising a smaller product.
//
// The test builds the tool array the shell actually registers and holds all three
// descriptions to it.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildAgentSystemInstruction } from "./agent";
import { advertisedToolNames, defaultAgentToolNames, groupToolNames } from "./agent-tool-surface";
import { buildAgentTools, readlineAgentHelpText } from "./shell";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { METAPROJECT_OPERATIONS } from "../harness/tool/metaproject-operations";

/** The tools `keryx shell` registers in agent mode, built the way the shell builds them. */
function registeredTools(): InteractiveTool[] {
  const cwd = tmpdir();
  const spawnTool: InteractiveTool = {
    definition: {
      name: "spawn_subagent",
      description: "spawn a bounded child agent",
      inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
      risk: "delegate",
    },
    invoke: async () => ({ output: "", isError: false }),
  };
  return buildAgentTools({ cwd, port: createMetaprojectAdapter(cwd), spawnTool });
}

test("AC9: the registered set, the system instruction and the shell help all name the same tools", () => {
  const names = advertisedToolNames(registeredTools());

  // 1. The registered set is the registry's: every metaproject operation, plus
  //    the filesystem, shell, interactive and delegate tools.
  for (const op of METAPROJECT_OPERATIONS) {
    expect(names, `registry operation ${op.name} must be registered`).toContain(op.name);
  }
  expect(names).toEqual(defaultAgentToolNames());

  // 2. The system instruction advertises exactly that set — nothing missing…
  const instruction = buildAgentSystemInstruction(undefined, { toolNames: names });
  for (const name of names) {
    expect(instruction, `system instruction must advertise ${name}`).toContain(name);
  }

  // 3. …and the shell help advertises exactly that set too.
  const help = readlineAgentHelpText(names);
  for (const name of names) {
    expect(help, `shell help must advertise ${name}`).toContain(name);
  }
});

test("AC9: a tool removed from the session disappears from both descriptions", () => {
  // The drift guard has to work in the other direction as well: if the two
  // descriptions were still literals they would keep naming a tool the session
  // does not have, and the model would keep calling a tool that is not there.
  const trimmed = advertisedToolNames(registeredTools()).filter((name) => name !== "wiki_backlinks");
  const instruction = buildAgentSystemInstruction(undefined, { toolNames: trimmed });
  const help = readlineAgentHelpText(trimmed);
  expect(instruction).not.toContain("wiki_backlinks");
  expect(help).not.toContain("wiki_backlinks");
  expect(instruction).toContain("graph_affected");
  expect(help).toContain("graph_affected");
});

test("AC9: every advertised name is grouped — none falls through unclassified", () => {
  const surface = groupToolNames(advertisedToolNames(registeredTools()));
  const grouped = [...surface.filesystem, ...surface.metaproject, ...surface.gated, ...surface.other];
  expect(grouped.sort()).toEqual([...surface.all].sort());
  expect(surface.gated).toEqual(["shell_exec", "spawn_subagent"]);
  expect(surface.metaproject).toEqual(METAPROJECT_OPERATIONS.map((op) => op.name));
});

test("AC10: the instruction no longer routes tool-answerable questions to the shell", () => {
  const instruction = buildAgentSystemInstruction(undefined, {
    toolNames: advertisedToolNames(registeredTools()),
  });

  // The exact sentence the run report traced the A1 failure to.
  expect(instruction).not.toContain(
    "Prefer ONE correct shell_exec over many exploratory tool calls when the user asks to run a known keryx workflow",
  );
  // And the general shape of it: no "prefer shell_exec" for a class of question.
  expect(instruction).not.toMatch(/prefer\s+(?:one\s+correct\s+)?`?shell_exec`?/i);
  // The graph/health/memory/flow catch-all that sent every other keryx question
  // to the CLI is gone too — it was the same instruction wearing a hat.
  expect(instruction).not.toMatch(/graph, health, memory, flow\)\s*→\s*prefer/i);

  // What replaced it points the other way, and names the parameters that made
  // the tool able to answer A1 at all.
  expect(instruction).toMatch(/When a metaproject tool answers the question, CALL IT/);
  expect(instruction).toContain("graph_affected takes `depth` and `ranked`");
  expect(instruction).toMatch(/NOT for a question a metaproject tool answers/);

  // shell_exec is still advertised — for the workflows that genuinely have no
  // tool. Removing it would trade one wrong routing rule for another.
  expect(instruction).toContain("shell_exec");
  expect(instruction).toContain("wiki enrich");
});

test("the unattended posture is stated in the instruction when one is declared", () => {
  const names = advertisedToolNames(registeredTools());
  const supervised = buildAgentSystemInstruction(undefined, { toolNames: names });
  expect(supervised).not.toContain("Unattended run");

  const unattended = buildAgentSystemInstruction(undefined, {
    toolNames: names,
    unattendedProfile: "read-only-review",
  });
  expect(unattended).toContain("Unattended run");
  expect(unattended).toContain("--unattended=read-only-review");
  expect(unattended).toMatch(/Destructive commands are refused/);
  expect(unattended).toMatch(/ask_user cannot be answered/);
});

test("AC8: both surfaces render the posture label and record it in the session", () => {
  // The TUI cannot be rendered headlessly, so the guarantee is held at the seam:
  // both surfaces must go through the shared formatter rather than composing a
  // header string of their own, and both must stamp the run record.
  const repoRoot = path.join(import.meta.dir, "..", "..");
  const readline = readFileSync(path.join(repoRoot, "src", "commands", "shell.ts"), "utf8");
  const tui = readFileSync(path.join(repoRoot, "src", "tui", "tui-shell.ts"), "utf8");

  for (const [name, source] of [
    ["readline shell", readline],
    ["TUI shell", tui],
  ] as const) {
    expect(source, `${name} must render the posture through the shared formatter`).toContain(
      "unattendedHeaderLabel(",
    );
    expect(source, `${name} must stamp the posture into the run record`).toContain("postureRecord(");
    expect(source, `${name} must install the policy approver, not a bypass`).toContain(
      "createUnattendedApprover(",
    );
  }

  // And neither surface may reach for a blanket approval under the flag.
  for (const source of [readline, tui]) {
    expect(source).not.toMatch(/unattended[\s\S]{0,80}approved:\s*true/);
  }
});
