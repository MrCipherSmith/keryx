import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseGrantedOutput } from "../scheduler/digest-gh";
import { parseFailedRuns } from "../intake/events";
import { protectJsonIds } from "./granted-json-ids";
import { runGrantedCommand, scrubGrantedOutput } from "./trigger-agent-task";

// A run id is 11 digits, which the PII detector reads as a phone number.
const RUN_ID = 37265165898;
const COMMENT_ID = 4156789012345;
const PHONE = "+1 415 555 0199";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function runsJson(title: string): string {
  return JSON.stringify([
    {
      conclusion: "failure",
      createdAt: "2026-10-05T04:49:29Z",
      databaseId: RUN_ID,
      displayTitle: title,
      event: "pull_request",
      headBranch: "feat/x",
      status: "completed",
      url: `https://github.com/MrCipherSmith/keryx/actions/runs/${RUN_ID}`,
    },
  ]);
}

let dir = "";
let fakeGh = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-granted-json-"));
  fakeGh = path.join(dir, "gh");
  await writeFile(fakeGh, `#!/bin/sh\ncat "${path.join(dir, "answer.json")}"\n`, "utf8");
  await chmod(fakeGh, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function answer(body: string): Promise<string> {
  await writeFile(path.join(dir, "answer.json"), body, "utf8");
  const r = await runGrantedCommand(fakeGh, ["run", "list"], dir, {}, undefined, []);
  return parseGrantedOutput(r.output, r.ok, r.exitCode).stdout;
}

describe("granted gh JSON keeps its ids through the scrub", () => {
  test("an 11-digit databaseId and a run url come back as the same JSON and parse as failed runs", async () => {
    const stdout = await answer(runsJson("fix(shell): smoke"));
    expect(stdout).toContain(`"databaseId":${RUN_ID}`);
    expect(stdout).toContain(`/actions/runs/${RUN_ID}"`);
    expect(stdout).not.toContain("REDACTED");
    const parsed = parseFailedRuns("MrCipherSmith/keryx", stdout, new Set(["feat/x"]));
    expect(parsed).not.toHaveProperty("error");
    expect(Array.isArray(parsed) ? parsed.length : 0).toBe(1);
  });

  test("a comment id in a fragment of a pull url stays intact", () => {
    const text = JSON.stringify([{ id: COMMENT_ID, url: `https://github.com/o/r/pull/12#issuecomment-${COMMENT_ID}` }]);
    const out = scrubGrantedOutput(text, {}, [], true);
    expect(out).toBe(text);
  });

  test("a phone number and a token inside displayTitle are still masked, and the JSON still parses", async () => {
    const stdout = await answer(runsJson(`call ${PHONE} with ${TOKEN}`));
    expect(stdout).not.toContain("415 555 0199");
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).toContain("[REDACTED:phone]");
    expect(JSON.parse(stdout)[0].databaseId).toBe(RUN_ID);
  });

  test("a phone number written as a bare JSON string value is still masked", () => {
    const out = scrubGrantedOutput(JSON.stringify({ title: "tel 415-555-0199", n: 5 }), {}, [], true);
    expect(out).toContain("[REDACTED:phone]");
    expect(JSON.parse(out).n).toBe(5);
  });

  test("a number under a secret-looking key is still shown to the detector", () => {
    const out = scrubGrantedOutput('{"password": 123456789012, "databaseId": 37265165898}', {}, [], true);
    expect(out).toContain('"password": [REDACTED:phone]');
    expect(out).toContain('"databaseId": 37265165898');
  });

  test("a github url that carries a phone number outside the id segments is not exempted", () => {
    const text = JSON.stringify({ url: "https://github.com/o/r/pull/12?contact=415-555-0199" });
    expect(scrubGrantedOutput(text, {}, [], true)).toContain("[REDACTED:phone]");
  });

  test("stderr after the JSON does not stop the ids being kept", () => {
    const text = `${runsJson("x")}\n[stderr]\nwarning: call ${PHONE}`;
    const out = scrubGrantedOutput(text, {}, [], true);
    expect(out).toContain(`"databaseId":${RUN_ID}`);
    expect(out).not.toContain("415 555 0199");
  });

  test("text that is not one JSON document is scrubbed exactly as before", () => {
    const text = `ids 37265165898 and ${PHONE}`;
    expect(scrubGrantedOutput(text, {}, [], true)).toBe(scrubGrantedOutput(text, {}, []));
    expect(protectJsonIds(text)).toBeUndefined();
    expect(protectJsonIds('{"a": 1} trailing')).toBeUndefined();
  });

  test("without the json flag the old behaviour is unchanged", () => {
    expect(scrubGrantedOutput(runsJson("x"), {})).toContain("[REDACTED:phone]");
  });
});
