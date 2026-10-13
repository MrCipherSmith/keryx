// An autonomous review run answers its own questions and never waits for a host.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { journaledAskUser, setAskUserHost } from "./ask-user-bridge";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-ask-autonomous-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  setAskUserHost(undefined);
  delete process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"];
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one", recommended: true },
  { id: "b", label: "Option B", description: "the quick one" },
];

test("takes the recommended option, records it, and does not reach the host", async () => {
  const file = path.join(root, "answers.ndjson");
  process.env["KERYX_AUTONOMOUS_ANSWERS_FILE"] = file;
  let hostCalled = false;
  setAskUserHost(async () => {
    hostCalled = true;
    return "b";
  });
  const answer = await journaledAskUser(root)({ question: "Which?", options: OPTIONS });
  expect(answer).toBe("a");
  expect(hostCalled).toBe(false);
  expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("without the variable the host is asked as before", async () => {
  setAskUserHost(async () => "b");
  const answer = await journaledAskUser(root)({ question: "Which?", options: OPTIONS });
  expect(answer).not.toBe("a");
});
