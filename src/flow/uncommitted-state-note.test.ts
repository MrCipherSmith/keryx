// The closed-flow "uncommitted state" note: `flow complete` writes the closing
// state after the merge and nothing commits it. Read-only git, informational.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { uncommittedFlowStateNote, UNCOMMITTED_LIST_CAP } from "./uncommitted-state";
import { uncommittedFlowStateNote as viaFacade } from "./service";

const DIR = "359-2026-09-28-example";
let root = "";

async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

async function write(rel: string, text: string): Promise<void> {
  const file = path.join(root, ".metaproject", "flows", DIR, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function commitAll(): Promise<void> {
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "seed");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-uncommitted-"));
  await git("init", "-q");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("is re-exported through the flow service facade", () => {
  expect(viaFacade).toBe(uncommittedFlowStateNote);
});

test("tracked and dirty: names the changed files, says nothing gates", async () => {
  await write("flow.json", "{}");
  await write("journal.md", "a");
  await commitAll();
  await write("flow.json", '{"status":"done"}');
  await write("reviews/r1.json", "{}");

  const note = await uncommittedFlowStateNote(root, "359", DIR);
  expect(note).not.toBeNull();
  expect(note).toContain("flow 359 has uncommitted state in .metaproject/flows/" + DIR);
  expect(note).toContain("flow.json");
  expect(note).toContain("reviews/");
  expect(note).not.toContain("journal.md");
  expect(note).toContain("nothing gates on this");
});

test("tracked and clean: null", async () => {
  await write("flow.json", "{}");
  await commitAll();
  expect(await uncommittedFlowStateNote(root, "359", DIR)).toBeNull();
});

test("untracked-only flow directory: null (newer flows stay local)", async () => {
  await write("flow.json", "{}");
  await write("journal.md", "a");
  expect(await uncommittedFlowStateNote(root, "359", DIR)).toBeNull();
});

test("not a git repository: null", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "keryx-not-a-repo-"));
  try {
    await mkdir(path.join(plain, ".metaproject", "flows", DIR), { recursive: true });
    await writeFile(path.join(plain, ".metaproject", "flows", DIR, "flow.json"), "{}");
    expect(await uncommittedFlowStateNote(plain, "359", DIR)).toBeNull();
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

test("any git failure is swallowed into null", async () => {
  await write("flow.json", "{}");
  await commitAll();
  await write("flow.json", "changed");

  const throwing = async (): Promise<never> => {
    throw new Error("spawn failed");
  };
  expect(await uncommittedFlowStateNote(root, "359", DIR, throwing)).toBeNull();

  const failing = async () => ({ code: 128, out: "fatal: nope" });
  expect(await uncommittedFlowStateNote(root, "359", DIR, failing)).toBeNull();

  // ls-files succeeds, status fails.
  let call = 0;
  const statusFails = async () => (++call === 1 ? { code: 0, out: "x" } : { code: 1, out: "" });
  expect(await uncommittedFlowStateNote(root, "359", DIR, statusFails)).toBeNull();

  // A working directory that does not exist.
  expect(await uncommittedFlowStateNote(path.join(root, "missing"), "359", DIR)).toBeNull();
});

test("caps the listed files and says how many more", async () => {
  await write("flow.json", "{}");
  await commitAll();
  const extra = UNCOMMITTED_LIST_CAP + 3;
  for (let i = 0; i < extra; i += 1) await write(`file-${i}.md`, "x");

  const note = await uncommittedFlowStateNote(root, "359", DIR);
  expect(note).not.toBeNull();
  const listed = /: (.*) — the closing state/.exec(note ?? "")?.[1] ?? "";
  const parts = listed.split(", ");
  expect(parts.length).toBe(UNCOMMITTED_LIST_CAP + 1);
  expect(parts.at(-1)).toBe("+3 more");
});
