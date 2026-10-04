// Flow 401, AC12: the own-answer path is described where an operator looks for it: `/help`, the command
// registry, the recommendation journal guide, the Telegram remote guide and the route table. The button
// label is read from the code, so renaming it without a docs change fails here.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OWN_ANSWER_BUTTON_LABEL } from "../remote/protocol";
import { COMMAND_DESCRIPTORS } from "../standard/command-registry";
import { findCliEntry, findSlashEntry } from "../standard/help-groups";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const JOURNAL = read("docs/docs/guides/recommendation-journal.md");
const REMOTE = read("docs/docs/guides/drive-keryx-remotely.md");
const CLI = read("docs/docs/cli-reference.md");

const DOCK_ROW = "Свой ответ…";

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start === -1) return "";
  const next = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("the recommendation journal guide (AC12)", () => {
  const own = section(JOURNAL, "## Your own answer and a typed reason");

  it("has a section on the own answer and the typed reason", () => {
    expect(own.length).toBeGreaterThan(800);
  });

  it("names the dock row, the key for a reason and the Telegram button", () => {
    expect(own).toContain(DOCK_ROW);
    expect(own).toContain("**Tab**");
    expect(own).toContain(OWN_ANSWER_BUTTON_LABEL);
  });

  it("states the storage rules: 2000 characters, marker, redaction, journal.md, report", () => {
    expect(own).toContain("2000 characters");
    expect(own).toContain("[truncated: N more characters]");
    expect(own).toContain("redacted");
    expect(own).toContain("journal.md");
    expect(own).toContain("--json");
    expect(own).toContain("in full");
  });

  it("says approvals have no own-answer path", () => {
    expect(own).toMatch(/typed text never approves anything/);
  });

  it("is linked from the Telegram guide, and the other way round", () => {
    expect(REMOTE).toContain("recommendation-journal.md#your-own-answer-and-a-typed-reason");
    expect(own).toContain("drive-keryx-remotely.md");
  });
});

describe("the Telegram remote guide (AC12)", () => {
  const start = REMOTE.indexOf("**Questions from the agent, and your own answer.**");
  const part = start === -1 ? "" : REMOTE.slice(start, REMOTE.indexOf("**Approval answers are confirmed by the shell.**"));

  it("has the paragraph, with the button and the reply rule", () => {
    expect(part.length).toBeGreaterThan(800);
    expect(part).toContain(OWN_ANSWER_BUTTON_LABEL);
    expect(part).toMatch(/Reply\s+to \*\*that message\*\*/);
    expect(part).toContain("same person");
  });

  it("states the first-answer-wins rule, the 5 minute window and the late-reply note", () => {
    expect(part).toContain("first answer");
    expect(part).toContain("5 minutes");
    expect(part).toContain("no longer open");
  });

  it("says approvals are button-only and that pickers get no own row", () => {
    expect(part).toContain("Approvals (Allow, Deny, Always, `/mode`, grants) have no such path");
    expect(part).toContain("`/model`, `/connect` and `/resume`");
  });

  it("lists the new loopback routes in the guide and in the CLI reference", () => {
    expect(REMOTE).toContain("`prompt-close`");
    expect(CLI).toContain("`POST /v1/remote/prompt-close`");
    expect(CLI).toContain("`POST /v1/remote/prompt`");
    expect(CLI).toContain(OWN_ANSWER_BUTTON_LABEL);
  });
});

describe("/help and the command registry (AC12)", () => {
  it("/help names the dock row, the Telegram button and the Tab reason", () => {
    const cli = findCliEntry("decisions")?.summary ?? "";
    expect(cli).toContain(DOCK_ROW);
    expect(cli).toContain(OWN_ANSWER_BUTTON_LABEL);
    expect(cli).toContain("Tab");
  });

  it("/decisions and /remote-control mention own answers", () => {
    expect(findSlashEntry("/decisions")?.summary).toContain("own answers and typed reasons in full");
    expect(findSlashEntry("/remote-control")?.summary).toContain(OWN_ANSWER_BUTTON_LABEL);
  });

  it("the registry's decisions answer entry says where the own text comes from", () => {
    const entry = COMMAND_DESCRIPTORS.find((command) => command.command === "decisions answer");
    expect(entry?.summary).toContain(DOCK_ROW);
    expect(entry?.summary).toContain(OWN_ANSWER_BUTTON_LABEL);
  });

  it("the report entry says own answers and reasons are printed in full", () => {
    const entry = COMMAND_DESCRIPTORS.find((command) => command.command === "decisions report");
    expect(entry?.summary).toContain("own answers and typed reasons in full");
  });
});
