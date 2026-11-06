import { describe, expect, test } from "bun:test";
import { HC_UNKNOWN_AGENT, hcAgentLaunchOf, hcAgentLaunchesOf, hcGrantableLaunchesOf, touchesAgentCredentials, touchesHcDialogControl, touchesHumanConfirmation, touchesOperatorDecision, touchesSacConfirmReview } from "./command-risk";

describe("SAC confirm-review floor is decided on parsed words (review-security-code-w12:F-001)", () => {
  const spellings: Array<[string, string]> = [
    ["plain", "keryx workspace confirm-review W P --decision accepted"],
    ["split quote", "keryx workspace confirm-rev''iew W P"],
    ["backslash", "keryx workspace confirm-revie\\w W P"],
    ["double space", "keryx workspace  review W P --decision accepted --confirm-token T"],
    ["quoted verb", "keryx workspace 'review' W P"],
    ["ANSI-C word", "keryx workspace $'\\x72eview' W P"],
    ["tab separated", "keryx workspace\treview W P"],
    ["bash -c", `bash -c "keryx workspace confirm-rev''iew W P"`],
    ["variable verb", "keryx workspace $V W P"],
    ["pty wrapper", "script -q /dev/null keryx workspace confirm-rev''iew W P"],
  ];
  for (const [name, command] of spellings) {
    test(name, () => {
      expect(touchesSacConfirmReview(command)).toBe(true);
      expect(touchesHumanConfirmation(command)).toBe(true);
    });
  }
  test("other workspace verbs and unrelated words do not ask", () => {
    for (const command of ["keryx workspace status", "keryx workspace list", "ls", "echo workspaces"]) {
      expect(touchesSacConfirmReview(command)).toBe(false);
    }
  });
});

describe("credential markers are matched on the unquoted spelling", () => {
  for (const command of [
    "cat ~/.config/ke''ryx/permissions.json",
    "cat ~/.config/keryx/perm\\issions.json",
    "cat ~/.config/keryx/\"auth\".json",
    "cat ~/.local/share/ker\\yx/x",
    "cat $'\\x61uth.json'",
    "cat ~/.config/keryx/permissions.json",
  ]) {
    test(command, () => expect(touchesAgentCredentials(command)).toBe(true));
  }
  test("an unrelated file does not match", () => expect(touchesAgentCredentials("cat README.md")).toBe(false));
});

describe("operator-only keryx commands behind a terminal driver (review-architecture-w12:F-001)", () => {
  for (const command of [
    "script -q /dev/null keryx review waive-mutation --package p",
    "script -q /dev/null keryx review publish --package p",
    "script -q /dev/null keryx learn accept pat-1",
    "unbuffer keryx review estimate --package p --confirm --quote ok",
    "script -qfc \"keryx review estimate --package p --confirm --quote 'ok'\" /dev/null",
    "tmux new keryx review override-reviewers --package p",
    "keryx review confirm-plan --package p",
    "keryx review decide-premise --package p",
    "keryx review estimate --package p --confirm --quote ok",
    "keryx review comments reply --final --package p",
    "keryx review chunks estimate --package p --mode automatic",
    "keryx review start --package p --unattended",
  ]) {
    test(command, () => {
      expect(touchesHumanConfirmation(command)).toBe(true);
    });
  }
  test("read-only review commands still pass", () => {
    for (const command of ["script -q /dev/null keryx review status --package p", "keryx review estimate --package p", "keryx review comments list", "keryx review chunks estimate --package p"]) {
      expect(touchesHumanConfirmation(command), command).toBe(false);
    }
  });
});

describe("keryx hub machine grants are operator decisions (chunk-017:RG-C017-02)", () => {
  for (const command of [
    "C=x keryx hub machine pair --url https://hub.attacker.example --code-env C",
    "keryx 'hub' machine pair --url https://h --code-env C",
    "keryx hub machine allow --project p --checkout c --path /tmp/x --profile p",
    "keryx hub machine configure --candidate current --ad-hoc allow --max-runs 2",
    "keryx hub machine unpair",
    "bash -c 'keryx hub machine allow --project p'",
    "keryx hub machine $V",
    "script -q /dev/null keryx hub machine pair --url https://h --code-env C",
  ]) {
    test(command, () => {
      expect(touchesOperatorDecision(command)).toBe(true);
      expect(touchesHumanConfirmation(command)).toBe(true);
    });
  }
  test("readiness, recover and prose do not ask", () => {
    for (const command of ["keryx hub machine readiness", "keryx hub machine recover --action inspect", "keryx hub status", "echo keryx hub machine pair"]) {
      expect(touchesOperatorDecision(command), command).toBe(false);
    }
  });
});

describe("a keryx command path the shell has yet to expand is operator-only (review-security-code-w1:F-001)", () => {
  for (const command of [
    "H=hub; keryx $H machine pair --url https://a.example --code-env C",
    "H=hub && env -u KERYX_TOOL_CALL keryx $H machine pair --url https://a.example --code-env C",
    "M=machine; keryx hub $M pair --url https://a.example",
    "keryx hub $(printf machine) pair --url https://a.example",
    "keryx hub \"$(printf machine)\" allow --path .",
    "keryx ${H} machine unpair",
    "keryx `printf hub` machine configure --candidate current",
    "keryx $X",
    "bun src/cli.ts $H machine pair --url https://a.example",
    "$K $H machine pair --url https://a.example",
    "keryx agents $E apply --id x",
    "keryx review comments $V --final",
  ]) {
    test(command, () => {
      expect(touchesOperatorDecision(command)).toBe(true);
      expect(touchesHumanConfirmation(command)).toBe(true);
    });
  }
  test("an expansion in a flag value, or in a command that is not keryx, does not ask", () => {
    for (const command of [
      "keryx review status --package $P",
      "keryx hub machine readiness --hub $H",
      "keryx ctx rg \"$PATTERN\" src",
      "$PY $SCRIPT",
      "\"$VENV/bin/python\" \"$ROOT/x.py\"",
      "echo $H machine pair",
    ]) {
      expect(touchesOperatorDecision(command), command).toBe(false);
    }
  });
});

describe("review operator floors match what the handlers refuse (review-regression-w4:F-001)", () => {
  test("forms the handlers allow without a terminal do not ask", () => {
    for (const command of [
      "keryx review comments reply --final --dry-run --package P",
      "keryx review comments reply --final --fixtures f.json --package P",
      "keryx review chunks estimate --mode manual --package P",
      "keryx review chunks estimate --mode=manual --package P",
      "keryx review chunks plan --mode automatic --package P",
      "keryx review ingest --unattended --package P",
      "keryx review status --unattended --package P",
    ]) {
      expect(touchesOperatorDecision(command), command).toBe(false);
      expect(touchesHumanConfirmation(command), command).toBe(false);
    }
  });
  test("the operator acts stay gated", () => {
    for (const command of [
      "keryx review comments reply --final --package P",
      "keryx review comments reply --final --fixtures $F --package P",
      "keryx review chunks estimate --mode automatic --package P",
      "keryx review chunks estimate --mode=Automatic --package P",
      "keryx review chunks estimate --mode $M --package P",
      "keryx review start --unattended --package P",
      "keryx review attach --unattended --package P",
      "keryx review plan --target x --unattended",
      "keryx review estimate --package P --confirm --quote ok",
    ]) {
      expect(touchesOperatorDecision(command), command).toBe(true);
    }
  });
});

// Block 1 round 4 (review-regression-w3:F-001, review-degradation-w3:F-001): an expansion makes the command path unknown
// only where the literal words before it can still start an operator command; single-quoted text is literal.
describe("an expansion after a literal non-operator command path does not ask", () => {
  test("routine keryx commands with an expanded operand", () => {
    for (const command of [
      'keryx ctx read "$FILE" --mode compact',
      'keryx ctx read "$F"',
      "keryx flow show $ID",
      'keryx wiki ask "$Q"',
      'keryx gdgraph affected "$f"',
      'keryx test related "$F"',
      "keryx test related $f",
      'keryx memory search "$Q"',
      "keryx wiki ask 'what does {x} mean'",
      "keryx hub status $X",
      "keryx review status $P",
      "keryx learn list $X",
      "keryx agents list $X",
      "keryx hub '$M' pair",
      "keryx '$X'",
      "bun src/cli.ts wiki ask \"$Q\"",
      "keryx gdgraph affected src/a.ts",
    ]) {
      expect(touchesOperatorDecision(command), command).toBe(false);
      expect(touchesHumanConfirmation(command), command).toBe(false);
    }
  });
  test("an expansion that can still complete an operator command keeps asking", () => {
    for (const command of [
      "keryx hub $M pair",
      "keryx $H machine pair",
      "keryx hub $(printf machine) pair",
      "$K $H machine pair",
      "keryx `printf hub` machine pair",
      "keryx learn $V p-1",
      "keryx agents external $V",
      "keryx review chunks $V --mode automatic",
      "keryx hub machine $V",
      "bash -c 'keryx hub $M pair'",
      "keryx \"$H\" machine pair",
    ]) {
      expect(touchesOperatorDecision(command), command).toBe(true);
      expect(touchesHumanConfirmation(command), command).toBe(true);
    }
  });
});

describe("hc dialog control is a human-confirmation floor (flow 486 AC3)", () => {
  for (const command of [
    "hc keys t7 enter",
    "/usr/local/bin/hc keys t7 enter",
    "hc --json keys t7 enter",
    "hc send t7 ok --force",
    "hc send --force t7 ok",
    "hc send t7 --force ok",
    "hc send --force=true t7 ok",
    "hc send t7 ok --for''ce",
    "hc send t7 ok --forc\\e",
    "HC_TERMINAL_ID=t3 hc send t7 hello",
    "HC_TERMINAL_ID='t3' hc ls",
    "env HC_TERMINAL_ID=t3 hc send t7 hello",
    "env -u X HC_TERMINAL_ID=t3 /opt/bin/hc read t7",
    "sudo env HC_TERMINAL_ID=t3 hc wait t7",
    `sh -c "hc keys t7 enter"`,
    `bash -c 'HC_TERMINAL_ID=t3 hc send t7 hi'`,
    `sh -c "sh -c 'hc send t7 ok --force'"`,
    "echo ok; hc keys t7 enter",
    "true && hc send t7 ok --force",
    "nohup hc keys t7 y &",
    `hc 'keys' t7 enter`,
    `h''c keys t7 enter`,
    "hc $'\\x6beys' t7 enter",
  ]) {
    test(command, () => {
      expect(touchesHcDialogControl(command)).toBe(true);
      expect(touchesHumanConfirmation(command)).toBe(true);
    });
  }
  for (const command of [
    "hc send t7 hello",
    "hc send t7 'about the --force flag'",
    "hc read t7",
    "hc wait t7",
    "hc interrupt t7",
    "hc ls",
    "hc run cargo test",
    "hc run --bg --name w claude 'task'",
    "grep hc README.md",
    "echo hc keys",
    "ls keys",
    "git log --force",
    "env FOO=1 ls",
  ]) {
    test(`no match: ${command}`, () => {
      expect(touchesHcDialogControl(command)).toBe(false);
    });
  }
});

describe("hcAgentLaunchOf (flow 486 AC4)", () => {
  const launches: Array<[string, string]> = [
    ["hc run claude", "claude"],
    ["hc run keryx shell", "keryx"],
    ["hc run codex 'fix it'", "codex"],
    ["hc run opencode", "opencode"],
    ["hc run gemini", "gemini"],
    ["hc run agy", "agy"],
    ["hc run /usr/local/bin/claude", "claude"],
    ["/opt/bin/hc run ~/.local/bin/codex", "codex"],
    [`hc run --bg --name x --cwd y claude "task"`, "claude"],
    ["hc run --name x --label a=b --parent t1 --timeout 5 --on m1 opencode", "opencode"],
    ["hc run --rm --keep --no-parent --outlive-parent --no-notify --json gemini", "gemini"],
    ["hc run -- env X=1 claude", "claude"],
    ["hc run env X=1 /bin/claude -p hi", "claude"],
    ["hc run --bg -- sudo -u me claude", "claude"],
    [`hc run sh -c "claude --resume"`, "claude"],
    [`hc run -- bash -c 'env A=1 codex'`, "codex"],
    ["hc run bun src/cli.ts shell", "keryx"],
    ["hc run npx keryx shell", "keryx"],
    [`sh -c "hc run --bg claude"`, "claude"],
    ["HC_FOO=1 hc run claude", "claude"],
    ["cd /tmp && hc run --bg codex", "codex"],
    ["hc --json run claude", "claude"],
    ["hc run CLAUDE", "claude"],
  ];
  for (const [command, agent] of launches) {
    test(command, () => expect(hcAgentLaunchOf(command)).toBe(agent));
  }
  for (const command of [
    "hc run cargo test",
    "hc run --bg --name claude cargo build",
    "hc run -- env X=1 cargo test",
    "hc run bun test",
    "hc run",
    "hc send t7 claude",
    "hc read claude",
    "echo hc run claude",
    "claude",
    "hc run --cwd claude ls",
  ]) {
    test(`undefined: ${command}`, () => expect(hcAgentLaunchOf(command)).toBeUndefined());
  }
});

/** Every shell shape that puts a command somewhere other than the first word of a `;`-cut segment. */
const hiddenBySyntax = (hc: string): string[] => [
  `if hc wait t7; then ${hc}; fi`,
  `if ${hc}; then echo ok; fi`,
  `if false; then :; elif ${hc}; then :; else echo no; fi`,
  `if false; then :; else ${hc}; fi`,
  `for t in a b; do ${hc}; done`,
  `while ${hc}; do sleep 1; done`,
  `until ${hc}; do sleep 1; done`,
  `(${hc})`,
  `( ${hc} )`,
  `((${hc}))`,
  `{ ${hc}; }`,
  `! ${hc}`,
  `sleep 1 & ${hc}`,
  `echo $(${hc})`,
  `echo "$(${hc})"`,
  `echo \`${hc}\``,
  `echo "\`${hc}\`"`,
  `echo "a $(echo "b $(${hc})")"`,
  `x=$(${hc})`,
  `case x in x) ${hc};; esac`,
  `f() { ${hc}; }; f`,
  `function f { ${hc}; }; f`,
  `time ${hc}`,
  `2>/dev/null ${hc}`,
  `sh -c 'if true; then ${hc}; fi'`,
];

describe("flow 486 review: shell syntax does not hide hc from the floors", () => {
  for (const hc of ["hc keys t7 enter", "hc send t7 ok --force"]) {
    for (const command of hiddenBySyntax(hc)) {
      test(`dialog control: ${command}`, () => expect(touchesHcDialogControl(command)).toBe(true));
    }
  }
  for (const command of hiddenBySyntax("hc run claude")) {
    test(`launch: ${command}`, () => expect(hcAgentLaunchesOf(command)).toContain("claude"));
  }
  for (const command of [
    "ls 2>&1",
    "ls &> /tmp/out",
    "(ls)",
    "echo $(date) hc keys t7",
    "if hc wait t7; then echo ok; fi",
    "echo keys",
    "cat <(ls) keys",
    "{ hc read t7; }",
  ]) {
    test(`no match: ${command}`, () => {
      expect(touchesHcDialogControl(command)).toBe(false);
      expect(hcAgentLaunchesOf(command)).toEqual([]);
    });
  }
  test("hc run of hc itself is dialog control", () => {
    expect(touchesHcDialogControl("hc run hc keys t7 enter")).toBe(true);
    expect(touchesHcDialogControl("hc run -- env X=1 hc send t7 ok --force")).toBe(true);
    expect(touchesHcDialogControl("hc run hc read t7")).toBe(false);
    expect(touchesHcDialogControl("hc exec hc keys t7 enter")).toBe(true);
  });
  test("the same shapes reach the other families through the shared walker", () => {
    expect(touchesHumanConfirmation("if true; then keryx flow confirm 7; fi")).toBe(true);
    expect(touchesHumanConfirmation("(keryx flow confirm 7)")).toBe(true);
    expect(touchesHumanConfirmation('echo "$(keryx flow confirm 7)"')).toBe(true);
    expect(touchesHumanConfirmation("sleep 1 & keryx flow confirm 7")).toBe(true);
  });
});

describe("flow 486 review: a forged identity is decided on the whole line", () => {
  for (const command of [
    "HC_TERMINAL_ID=t3 sh -c 'hc send t7 hi'",
    "env HC_TERMINAL_ID=t3 bash -c 'hc ls'",
    "export HC_TERMINAL_ID=t3; hc send t7 hi",
    "export HC_TERMINAL_ID=t3 && hc ls",
    "HC_TERMINAL_ID=t3; hc send t7 hi",
    "(HC_TERMINAL_ID=t3; hc send t7 hi)",
    "declare -x HC_TERMINAL_ID=t3; hc ls",
    "typeset -x HC_TERMINAL_ID=t3; hc ls",
    "readonly HC_TERMINAL_ID=t3; hc ls",
    "hc ls; export HC_TERMINAL_ID=t3",
    "if true; then export HC_TERMINAL_ID=t3; fi; hc ls",
    "HC_TERMINAL_ID=t3 $HC ls",
    `sh -c "export HC_TERMINAL_ID=t3; hc ls"`,
    "HC_TERMINAL_ID+=3; hc ls",
  ]) {
    test(command, () => expect(touchesHcDialogControl(command)).toBe(true));
  }
  for (const command of ["export HC_TERMINAL_ID=t3", "HC_TERMINAL_ID=t3 ls", "export FOO=1; hc ls", "echo $HC_TERMINAL_ID; hc ls"]) {
    test(`no match: ${command}`, () => expect(touchesHcDialogControl(command)).toBe(false));
  }
});

describe("flow 486 review: words the shell has yet to expand", () => {
  for (const command of [
    "hc $v t7 enter",
    'hc "$v" t7 enter',
    "hc --json $v t7 enter",
    "$HC keys t7 enter",
    '"$HC" keys t7 enter',
    "$(which hc) keys t7 enter",
    "`which hc` send t7 ok --force",
    "$HC send t7 ok",
    "hc send t7 ok $FLAGS",
    "hc send $T ok",
    "env $HC --json keys t7 enter",
  ]) {
    test(command, () => expect(touchesHcDialogControl(command)).toBe(true));
  }
  for (const command of ["$PY $SCRIPT", "$HC read t7", "hc '$v' t7", "hc read $T", "hc wait $T", "$EDITOR notes", "hc send t7 '$literal'", "hc run $CMD"]) {
    test(`no match: ${command}`, () => expect(touchesHcDialogControl(command)).toBe(false));
  }

  for (const command of [
    "hc run $(which claude)",
    'hc run "$(command -v keryx)" shell "x"',
    "hc run $AGENT",
    'hc run "$AGENT" task',
    "hc run `which claude`",
    "hc run env X=1 $AGENT",
    "hc run bunx $PKG",
    'hc run sh -c "$AGENT"',
    "hc run --bg --name w $AGENT",
    "hc run ${AGENT}",
  ]) {
    test(`unknown agent, never granted: ${command}`, () => {
      expect(hcAgentLaunchesOf(command)).toContain(HC_UNKNOWN_AGENT);
      expect(hcGrantableLaunchesOf(command)).not.toContain(HC_UNKNOWN_AGENT);
    });
  }
  for (const command of ["hc run '$AGENT'", "hc run --name $N cargo test", "hc run cargo test $ARGS"]) {
    test(`not an unknown agent: ${command}`, () => expect(hcAgentLaunchesOf(command)).toEqual([]));
  }
});

describe("flow 486 review: launch detection", () => {
  const launches: Array<[string, string]> = [
    ["hc run npx claude", "claude"],
    ["hc run bunx codex", "codex"],
    ["hc run npx -y @openai/codex", "codex"],
    ["hc run npx --yes @openai/codex@latest exec", "codex"],
    ["hc run npx @anthropic-ai/claude-code", "claude"],
    ["hc run npx @anthropic-ai/claude-code@2.0.1 -p hi", "claude"],
    ["hc run npx @google/gemini-cli", "gemini"],
    ["hc run bunx opencode", "opencode"],
    ["hc run bunx opencode-ai", "opencode"],
    ["hc run npx -p @openai/codex codex", "codex"],
    ["hc run npx --package=@openai/codex run-it", "codex"],
    ["hc run pnpm dlx @openai/codex", "codex"],
    ["hc run yarn dlx @google/gemini-cli", "gemini"],
    ["hc run npm exec @anthropic-ai/claude-code", "claude"],
    ["hc run deno run -A npm:@anthropic-ai/claude-code", "claude"],
    ["hc run node /opt/lib/claude", "claude"],
    ["hc run script -q /dev/null claude", "claude"],
    ["hc run unbuffer claude", "claude"],
    ["hc run unbuffer npx codex", "codex"],
    ["hc run tmux new-session claude", "claude"],
    ["hc run script -qfc 'claude --resume' /dev/null", "claude"],
    ["hc run 'claude --resume'", "claude"],
    ["hc run env A=1 npx codex", "codex"],
  ];
  for (const [command, agent] of launches) {
    test(command, () => expect(hcAgentLaunchOf(command)).toBe(agent));
  }
  for (const command of ["hc run npx prettier --write .", "hc run bun test", "hc run bunx tsc", "hc run unbuffer cargo test", "hc run node server.js", "hc run 'cargo test'", "hc run npx -p typescript tsc"]) {
    test(`undefined: ${command}`, () => expect(hcAgentLaunchOf(command)).toBeUndefined());
  }
  test("hc exec starts a program too, and an expanded head may be hc", () => {
    expect(hcAgentLaunchesOf("hc exec claude -p hi")).toEqual(["claude"]);
    expect(hcAgentLaunchesOf("hc exec --on m1 codex")).toEqual(["codex"]);
    expect(hcAgentLaunchesOf("hc exec $AGENT")).toEqual([HC_UNKNOWN_AGENT]);
    expect(hcAgentLaunchesOf("hc exec ls")).toEqual([]);
    expect(hcAgentLaunchesOf("$HC run claude")).toEqual(["claude"]);
    expect(hcGrantableLaunchesOf("$HC run claude")).toEqual([]);
  });
  test("every launch in the line is named, in order, once", () => {
    expect(hcAgentLaunchesOf("hc run claude; hc run codex")).toEqual(["claude", "codex"]);
    expect(hcAgentLaunchesOf("hc run claude; hc run claude")).toEqual(["claude"]);
  });
  test("a quoted argument that reads like a command line asks but records no grant", () => {
    for (const command of ["echo 'hc run claude'", `git commit -m "hc run claude"`, "hc send t7 'hc run claude'"]) {
      expect(hcAgentLaunchesOf(command)).toEqual(["claude"]);
      expect(hcGrantableLaunchesOf(command)).toEqual([]);
    }
    expect(hcGrantableLaunchesOf("hc run codex 'hc run claude'")).toEqual(["codex"]);
  });
  test("a real launch records a grant, through wrappers, sh -c and syntax", () => {
    expect(hcGrantableLaunchesOf("hc run --bg claude 'task'")).toEqual(["claude"]);
    expect(hcGrantableLaunchesOf("hc run -- env X=1 claude")).toEqual(["claude"]);
    expect(hcGrantableLaunchesOf(`sh -c "hc run --bg claude"`)).toEqual(["claude"]);
    expect(hcGrantableLaunchesOf(`hc run sh -c "claude --resume"`)).toEqual(["claude"]);
    expect(hcGrantableLaunchesOf("if true; then hc run codex; fi")).toEqual(["codex"]);
    expect(hcGrantableLaunchesOf("hc run npx -y @openai/codex")).toEqual(["codex"]);
  });
  test("past the nesting limit the launch is unknown, not silently absent", () => {
    expect(hcAgentLaunchesOf("hc run eval eval eval claude")).toEqual(["claude"]);
    expect(hcAgentLaunchesOf("hc run eval eval eval eval eval eval claude")).toEqual([HC_UNKNOWN_AGENT]);
  });
});
