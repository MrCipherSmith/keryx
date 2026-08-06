// `search_code` stays inside the project root (flow 136).
//
// This file is the surviving half of an adversarial sweep. Two review rounds
// found holes here, both by running the tool rather than reading it, and both in
// the same shape: something that was not the operand decided what got read.
//
//   Round 2: `flags: ["-e", "."]` supplied the pattern by flag, which moved every
//   positional operand from "the pattern" to "a path" — so `pattern` became the
//   file to read, and the confinement that guarded `input.path` never applied.
//
//   Round 3: `flags: ["--follow"]` left the operand alone and changed the WALK.
//   The tool correctly refused a symlink as `path`, then read the identical
//   out-of-root file through that same symlink when told to follow it.
//
// Both matter beyond any posture: `search_code` is `risk: "read"`, so it never
// reaches an approver, and this applies to ordinary supervised sessions. Neither
// existed before this flow gave the tool a `flags` array.
//
// The fixes are positional rather than a list of bad flags: the pattern is always
// `--regexp=<pattern>`, there is always exactly one operand and it is always a
// confined path, and `--no-follow` is always last. Adding a case below is cheap.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { buildSearchArgv, builtinMetaprojectTools } from "./builtin/metaproject-tools";
import { METAPROJECT_OPERATIONS } from "./metaproject-operations";
import type { MetaprojectPort } from "./metaproject-port";
import { SEARCH_TOOL_FORCED_OPTIONS } from "../../lib/rg-options";

const ROOT = "/proj";

/** Inputs that must never produce an argv able to read outside the root. */
const MUST_NOT_ESCAPE: ReadonlyArray<Record<string, unknown>> = [
  // Round 2: a second pattern source turns the operand into a path.
  { pattern: "/etc/hostname", flags: ["-e", "."] },
  { pattern: "/etc/passwd", flags: ["--regexp=."] },
  { pattern: "x", flags: ["-e=.", "--files"] },
  { pattern: "secret", flags: ["--files", "-e", "."] },
  // Round 3: the walk, not the operand.
  { pattern: "SECRET", flags: ["--follow"] },
  { pattern: "SECRET", flags: ["-L"] },
  // Options that run a program per file, or read a file list from disk.
  { pattern: "secret", flags: ["--pre=/tmp/pwn.sh"] },
  { pattern: "secret", flags: ["--pre-glob=*"] },
  { pattern: "secret", flags: ["-f", "/etc/passwd"] },
  { pattern: "secret", flags: ["--file=/etc/passwd"] },
  { pattern: "secret", flags: ["--files-from=/etc/passwd"] },
  { pattern: "secret", flags: ["-Z"] },
  { pattern: "secret", flags: ["--search-zip"] },
  { pattern: "secret", flags: ["--type-add=x:*"] },
  { pattern: "secret", flags: ["--ignore-file=/etc/passwd"] },
  // Paths that leave the root.
  { pattern: ".", path: "/etc/hostname" },
  { pattern: ".", path: "../../../etc/hostname" },
  { pattern: ".", path: "../.." },
  // A dash-leading value in a separate token can be re-parsed as an option.
  { pattern: "secret", flags: ["-g", "--pre=/tmp/pwn.sh"] },
];

/**
 * Inputs that DO build an argv — the ones the shape invariants are about.
 *
 * This list exists because the test below used to run only over
 * {@link MUST_NOT_ESCAPE}, guarded by `if (!built.ok) continue`. All nineteen of
 * those inputs are refused at build time, so the loop body — including the
 * `--regexp=` shape assertion, the one-operand assertion and the containment
 * assertion — executed zero times. The claims were never made about anything.
 *
 * Every entry here is an ordinary, accepted call, several of them carrying
 * awkward patterns on purpose: a pattern that looks like a path, one that looks
 * like an option, and one containing a space. Those are precisely the cases where
 * "the pattern is never an operand" has to hold and would be easy to get wrong.
 */
const MUST_BUILD: ReadonlyArray<Record<string, unknown>> = [
  { pattern: "needle" },
  { pattern: "needle", path: "src" },
  { pattern: "needle", path: "src/commands/agent.ts" },
  { pattern: "needle", flags: ["-i"] },
  { pattern: "needle", flags: ["-t", "ts", "-C", "2"] },
  { pattern: "needle", flags: ["--hidden", "--no-ignore"] },
  { pattern: "needle", flags: ["--max-depth=3"], path: "src" },
  { pattern: "needle", flags: ["-g", "*.ts"] },
  // Patterns that would be dangerous if they ever became an operand.
  { pattern: "/etc/passwd" },
  { pattern: "/etc/passwd", path: "src" },
  { pattern: "../../etc/hostname" },
  { pattern: "--pre=/tmp/pwn.sh" },
  { pattern: "-e" },
  { pattern: "two words" },
  { pattern: "." },
];

test("every input that builds an argv has one confined operand, and never the pattern as one", () => {
  // Nothing is skipped here: an input that fails to build is a failure of this
  // test's own premise, and is reported as one rather than silently passed over.
  for (const input of MUST_BUILD) {
    const pattern = String(input.pattern);
    const built = buildSearchArgv({
      root: ROOT,
      pattern,
      path: input.path as string | undefined,
      flags: input.flags as string[] | undefined,
    });
    expect(built.ok, `${JSON.stringify(input)} should build but was refused`).toBe(true);
    if (!built.ok) {
      continue; // unreachable given the assertion above; keeps the types honest
    }

    // There is exactly one operand, it is last, and it is inside the root.
    const operand = built.args[built.args.length - 1] ?? "";
    const absolute = operand === "." ? ROOT : operand;
    expect(
      absolute === ROOT || absolute.startsWith(`${ROOT}/`),
      `${JSON.stringify(input)} produced an operand outside the root: ${operand}`,
    ).toBe(true);
    // The pattern travels as the value of `--regexp=`, inline in one token, so it
    // cannot be re-parsed as an option or mistaken for a path.
    const regexpToken = `--regexp=${pattern}`;
    expect(built.args).toContain(regexpToken);

    // And it is the second-to-last token — which is the precise statement of
    // "there is exactly ONE operand". Counting bare tokens instead would be wrong
    // in both directions: option VALUES are bare (`-t ts`), and a pattern that
    // happens to equal the default operand (`pattern: "."`) would look like a
    // leaked pattern when it is simply the root.
    expect(
      built.args.indexOf(regexpToken),
      `${JSON.stringify(input)} has something other than the single operand after the pattern`,
    ).toBe(built.args.length - 2);
  }
});

test("every escape input is refused at build time — none of them reaches an argv", () => {
  // The claim MUST_NOT_ESCAPE actually supports. Counting them is the point: if a
  // future change makes one of these build instead of being refused, the shape
  // assertions above are not what catches it, so it has to be caught here.
  const refused: string[] = [];
  for (const input of MUST_NOT_ESCAPE) {
    const built = buildSearchArgv({
      root: ROOT,
      pattern: String(input.pattern),
      path: input.path as string | undefined,
      flags: input.flags as string[] | undefined,
    });
    expect(built.ok, `${JSON.stringify(input)} built an argv instead of being refused`).toBe(false);
    if (!built.ok) {
      expect(built.reason.length, `${JSON.stringify(input)} was refused with no reason`).toBeGreaterThan(0);
      refused.push(built.reason);
    }
  }
  expect(refused).toHaveLength(MUST_NOT_ESCAPE.length);
});

test("every invocation ends `--no-follow`, `--regexp=<pattern>`, <confined path>", () => {
  const plain = buildSearchArgv({ root: ROOT, pattern: "needle" });
  expect(plain.ok && plain.args).toEqual(["ctx", "rg", "--no-follow", "--regexp=needle", "."]);

  const withFlags = buildSearchArgv({
    root: ROOT,
    pattern: "needle",
    path: "src",
    flags: ["-t", "ts", "-C", "2"],
  });
  expect(withFlags.ok && withFlags.args).toEqual([
    "ctx",
    "rg",
    "-t",
    "ts",
    "-C",
    "2",
    "--no-follow",
    "--regexp=needle",
    "/proj/src",
  ]);

  // The order is the guarantee: ripgrep resolves the LAST occurrence of a
  // boolean, so `--no-follow` has to come after anything the caller supplied.
  const caller = buildSearchArgv({ root: ROOT, pattern: "needle", flags: ["--hidden"] });
  const args = caller.ok ? caller.args : [];
  for (const forced of SEARCH_TOOL_FORCED_OPTIONS) {
    expect(args.indexOf(forced)).toBeGreaterThan(args.indexOf("--hidden"));
    expect(args.indexOf(forced)).toBeLessThan(args.indexOf("--regexp=needle"));
  }
});

test("`--follow` is refused with a reason rather than silently neutralised", () => {
  const built = buildSearchArgv({ root: ROOT, pattern: "x", flags: ["--follow"] });
  expect(built.ok).toBe(false);
  expect(built.ok === false && built.reason).toMatch(/not accepted here/);
});

test("the escapes are refused on every branch that builds an argv", async () => {
  const argvSeen: string[][] = [];
  const record = async (args: string[]): Promise<{ output: string; isError: boolean }> => {
    argvSeen.push(args);
    return { output: "", isError: false };
  };
  const failingPort = {
    async searchCode(input: { pattern: string }) {
      return { pattern: input.pattern, output: "unavailable", isError: true };
    },
  } as unknown as MetaprojectPort;

  const branches = [
    ["no-port", builtinMetaprojectTools(ROOT, record)],
    ["port-fallback", builtinMetaprojectTools(ROOT, record, failingPort)],
  ] as const;

  for (const input of MUST_NOT_ESCAPE) {
    for (const [label, tools] of branches) {
      argvSeen.length = 0;
      const tool = tools.find((candidate) => candidate.definition.name === "search_code");
      const result = await tool?.invoke(input);
      if (result?.isError === true) {
        expect(argvSeen.length, `${label} refused but still spawned`).toBe(0);
        continue;
      }
      for (const args of argvSeen) {
        for (const arg of args) {
          expect(
            arg.startsWith("/etc") || arg.includes(".."),
            `${label} ${JSON.stringify(input)} produced ${arg}`,
          ).toBe(false);
        }
      }
    }
  }
});

test("the descriptor refuses the flag-borne cases before the port sees them", async () => {
  // The descriptor is port-bound and root-agnostic, so PATH confinement belongs
  // to the port implementation. What the descriptor owns is the flags, and the
  // flags are where both escapes lived.
  const descriptor = METAPROJECT_OPERATIONS.find((op) => op.name === "search_code");
  let reachedPort = false;
  const port = {
    async searchCode() {
      reachedPort = true;
      return { pattern: "", output: "", isError: false };
    },
  } as unknown as MetaprojectPort;

  for (const input of MUST_NOT_ESCAPE.filter((candidate) => Array.isArray(candidate.flags))) {
    reachedPort = false;
    const result = await descriptor?.invoke(port, input);
    expect(result?.isError, `${JSON.stringify(input)} must be refused by the descriptor`).toBe(true);
    expect(reachedPort, `${JSON.stringify(input)} must not reach the port`).toBe(false);
  }
});

test("END TO END: a symlink out of the project cannot be read, with or without --follow", async () => {
  // The round-3 finding, against real ripgrep. A symlink inside the project
  // pointing outside it is ordinary — a pnpm/bun store, `npm link`, a monorepo.
  // This checkout happens not to have one, which is luck rather than a barrier.
  const base = mkdtempSync(path.join(tmpdir(), "keryx-follow-"));
  const root = path.join(base, "proj");
  const outside = path.join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "secret.txt"), "SUPERSECRET-TOKEN-9f3a\n", "utf8");
  writeFileSync(path.join(root, "inside.txt"), "ordinary content\n", "utf8");
  symlinkSync(outside, path.join(root, "vendor"));

  try {
    const run = async (args: string[]): Promise<{ output: string; isError: boolean }> => {
      // The real `rg`, assembled exactly as `keryx ctx rg` assembles it.
      const rgArgs = args.slice(2);
      const proc = Bun.spawn(["rg", "--with-filename", "--no-heading", ...rgArgs], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      return { output: out, isError: (await proc.exited) !== 0 };
    };

    const tools = builtinMetaprojectTools(root, run);
    const search = tools.find((tool) => tool.definition.name === "search_code");

    // Sanity: the tool works, and finds what is genuinely inside.
    const inside = await search?.invoke({ pattern: "ordinary" });
    expect(inside?.output ?? "").toContain("inside.txt");

    // The secret is not reachable by default…
    const plain = await search?.invoke({ pattern: "SUPERSECRET" });
    expect(plain?.output ?? "").not.toContain("SUPERSECRET");

    // …nor by asking to follow the symlink (refused outright)…
    const followed = await search?.invoke({ pattern: "SUPERSECRET", flags: ["--follow"] });
    expect(followed?.isError).toBe(true);
    expect(followed?.output ?? "").not.toContain("SUPERSECRET");

    // …nor by naming the symlink as the path…
    const viaPath = await search?.invoke({ pattern: "SUPERSECRET", path: "vendor" });
    expect(viaPath?.output ?? "").not.toContain("SUPERSECRET");

    // …nor with any other flag that widens the walk.
    for (const flags of [["--hidden"], ["--no-ignore"], ["--max-depth", "9"], ["-g", "**"]]) {
      const widened = await search?.invoke({ pattern: "SUPERSECRET", flags });
      expect(widened?.output ?? "", `flags ${flags.join(" ")} leaked the secret`).not.toContain(
        "SUPERSECRET",
      );
    }

    expect(existsSync(path.join(outside, "secret.txt"))).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
