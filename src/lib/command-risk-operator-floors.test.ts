import { describe, expect, test } from "bun:test";
import { hcAgentLaunchOf, touchesAgentCredentials, touchesHcDialogControl, touchesHumanConfirmation, touchesOperatorDecision, touchesSacConfirmReview } from "./command-risk";

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
