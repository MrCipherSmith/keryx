// Flow 481 T7 (AC7): `keryx shell "<task>"` — one positional argument is the
// first turn of the interactive session (herdr-core starts agents this way).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseShellCliFlags, withInitialLine } from "./shell";

describe("parseShellCliFlags initial prompt", () => {
  test("one positional argument becomes initialPrompt", () => {
    expect(parseShellCliFlags(["Fix the failing test"]).initialPrompt).toBe("Fix the failing test");
  });

  test("a positional mixes with flags in any order", () => {
    const flags = parseShellCliFlags(["--no-tui", "fix it", "--name", "fix"]);
    expect(flags.initialPrompt).toBe("fix it");
    expect(flags.wantTui).toBe(false);
    expect(flags.name).toBe("fix");
  });

  test("no positional leaves initialPrompt unset", () => {
    expect(parseShellCliFlags(["--no-tui"]).initialPrompt).toBeUndefined();
  });

  test("-- ends flags so a prompt may start with a dash", () => {
    expect(parseShellCliFlags(["--", "-v flag is broken"]).initialPrompt).toBe("-v flag is broken");
    expect(parseShellCliFlags(["--no-tui", "--", "-v flag is broken"]).initialPrompt).toBe("-v flag is broken");
  });

  test("a second positional fails and names the fix", () => {
    expect(() => parseShellCliFlags(["fix", "the", "test"])).toThrow(/one initial prompt.*quote it as a single argument/);
  });

  test("a second positional after -- also fails", () => {
    expect(() => parseShellCliFlags(["--", "a", "b"])).toThrow(/one initial prompt/);
  });

  test("an empty positional is an error, not an empty turn", () => {
    expect(() => parseShellCliFlags([""])).toThrow(/empty/);
    expect(() => parseShellCliFlags(["   "])).toThrow(/empty/);
  });

  test("a positional together with -p/--print is refused", () => {
    expect(() => parseShellCliFlags(["task", "-p", "other"])).toThrow(/--print/);
    expect(() => parseShellCliFlags(["--print", "other", "task"])).toThrow(/alternatives|cannot be combined/);
  });

  test("a positional with --chat is refused with a message", () => {
    expect(() => parseShellCliFlags(["--chat", "task"])).toThrow(/--chat/);
  });

  test("an unknown dash flag still errors as before", () => {
    expect(() => parseShellCliFlags(["--bogus"])).toThrow(/Unknown shell argument/);
    expect(() => parseShellCliFlags(["-x", "task"])).toThrow(/Unknown shell argument/);
  });

  test("-p alone is unchanged", () => {
    const flags = parseShellCliFlags(["-p", "hello"]);
    expect(flags.printPrompt).toBe("hello");
    expect(flags.initialPrompt).toBeUndefined();
  });

  test("a bare -r keeps taking the next word as the session (titles may hold spaces)", () => {
    const flags = parseShellCliFlags(["-r", "Parser cleanup"]);
    expect(flags.resumeId).toBe("Parser cleanup");
    expect(flags.initialPrompt).toBeUndefined();
  });

  test("a prompt goes with the resume picker when written before -r or after --", () => {
    for (const args of [["fix it", "-r"], ["-r", "--", "fix it"]]) {
      const flags = parseShellCliFlags(args);
      expect(flags.initialPrompt).toBe("fix it");
      expect(flags.resumePick).toBe(true);
      expect(flags.resumeId).toBeUndefined();
    }
  });

  test("a lone `help` prints help instead of becoming a one-word first turn", () => {
    expect(parseShellCliFlags(["help"]).help).toBe(true);
    expect(parseShellCliFlags(["help me fix the parser"]).initialPrompt).toBe("help me fix the parser");
  });
});

describe("withInitialLine (readline fallback)", () => {
  async function collect(lines: AsyncIterable<string>): Promise<string[]> {
    const out: string[] = [];
    for await (const line of lines) out.push(line);
    return out;
  }
  async function* source(...items: string[]): AsyncGenerator<string> {
    for (const item of items) yield item;
  }

  test("yields the prompt first, then the rest of stdin", async () => {
    const it = source("second", "third")[Symbol.asyncIterator]();
    expect(await collect(withInitialLine("first", it))).toEqual(["first", "second", "third"]);
  });

  test("with no prompt it is the plain iterator", async () => {
    const it = source("a")[Symbol.asyncIterator]();
    expect(await collect(withInitialLine(undefined, it))).toEqual(["a"]);
  });

  test("stdin is not consumed before the prompt is read", async () => {
    let pulled = 0;
    const it: AsyncIterator<string> = {
      next: async () => {
        pulled += 1;
        return { done: true, value: undefined };
      },
    };
    const iter = withInitialLine("first", it)[Symbol.asyncIterator]();
    expect((await iter.next()).value).toBe("first");
    expect(pulled).toBe(0);
  });

  test("the prompt is delivered once in total, even to a second iterator", async () => {
    const it = source("typed")[Symbol.asyncIterator]();
    const lines = withInitialLine("task", it);
    expect((await lines[Symbol.asyncIterator]().next()).value).toBe("task");
    expect((await lines[Symbol.asyncIterator]().next()).value).toBe("typed");
  });
});

describe("TUI wiring (source audit)", () => {
  const tui = readFileSync(path.join(__dirname, "../tui/tui-shell.ts"), "utf8");
  const shell = readFileSync(path.join(__dirname, "shell.ts"), "utf8");

  test("launchTuiAgentShell takes the prompt once and shell.ts hands it over", () => {
    expect(tui).toMatch(/takeInitialPrompt\?: \(\) => string \| undefined;/);
    expect(shell).toMatch(/flags\.initialPrompt !== undefined \? \{ takeInitialPrompt \}/);
    // Taking empties it: a readline fallback after a TUI failure gets nothing to re-run.
    expect(shell).toMatch(/const prompt = pendingInitialPrompt;\s+pendingInitialPrompt = undefined;/);
  });

  test("the prompt is submitted after markReady, through the normal submit path", () => {
    const ready = tui.indexOf("hostStatus.markReady();");
    const submit = tui.indexOf("opts.takeInitialPrompt?.()");
    expect(ready).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(ready);
    // The same `runLine` the composer's onSubmit handler calls, registered before it.
    const onSubmit = tui.indexOf("chrome.onSubmit((line) => {");
    expect(onSubmit).toBeGreaterThan(ready);
    expect(submit).toBeGreaterThan(onSubmit);
    expect(tui).toMatch(/runLine\(initialPrompt\)/);
  });

  test("the readline fallback feeds the prompt to the REPL alone, never to a picker", () => {
    expect(shell).toMatch(/const readlineInitialPrompt = oneShotPrompt === undefined \? takeInitialPrompt\(\) : undefined;/);
    expect(shell).toMatch(/const replLines: AsyncIterable<string> =\s+oneShotPrompt === undefined \? withInitialLine\(readlineInitialPrompt, lineIterator\) : sharedLines;/);
    expect(shell).toMatch(/await runAgentRepl\(replLines, /);
    // The pickers read `io.lines`, which stays the plain shared iterator.
    expect(shell).toMatch(/createRichIo\(sharedLines, versionCheck\)/);
    expect(shell).toMatch(/\? \{ \[Symbol\.asyncIterator\]: \(\) => lineIterator \}/);
  });

  test("with a prompt the readline agent/chat question is skipped, so chat cannot drop it (AC7)", () => {
    // Only the agent REPL reads `replLines`; the chat REPL reads `io.lines`. Picking chat after
    // the prompt was taken used to lose it without a word.
    expect(shell).toMatch(
      /if \(modeFlag === undefined\) \{\s+if \(readlineInitialPrompt !== undefined\) \{\s+modeFlag = true;\s+io\.write\("Agent mode: the initial prompt runs as the first turn\.\\n"\);\s+\} else \{\s+modeFlag = await pickAgentMode\(io\);/,
    );
    // pickAgentMode has exactly one call site, the guarded one above.
    expect(shell.match(/await pickAgentMode\(/g)?.length).toBe(1);
  });

  test("help text mentions the positional prompt", () => {
    expect(shell).toMatch(/Usage: keryx shell \[options\] \[prompt\]/);
  });
});
