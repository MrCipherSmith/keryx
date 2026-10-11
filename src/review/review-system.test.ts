import { afterEach, expect, test } from "bun:test";
import type { ApprovalMeta } from "../commands/agent";
import { parseShellCliFlags } from "../commands/shell";
import {
  ENV_REVIEW_SYSTEM,
  asksForReviewAuto,
  getReviewSystem,
  operatorDenied,
  parseReviewSystem,
  recordOperatorDenial,
  refusalFingerprint,
  REFUSED_EARLIER,
  resetOperatorDenials,
  reviewAutoActive,
  reviewAutoGrants,
  reviewAutoMayAnswer,
  setReviewSystem,
} from "./review-system";

afterEach(() => {
  setReviewSystem("inherit");
  resetOperatorDenials();
});

const meta = (extra: Partial<ApprovalMeta> = {}): ApprovalMeta => ({ fingerprint: "f", destructive: false, ...extra });

test("parses the two systems and rejects anything else", () => {
  expect(parseReviewSystem("review-auto")).toBe("review-auto");
  expect(parseReviewSystem(" Review-Auto ")).toBe("review-auto");
  expect(parseReviewSystem("inherit")).toBe("inherit");
  expect(parseReviewSystem("default")).toBe("inherit");
  expect(parseReviewSystem("yolo")).toBeUndefined();
  expect(parseReviewSystem(undefined)).toBeUndefined();
});

test("inherits by default; the env or the session switch turns review-auto on", () => {
  expect(getReviewSystem({})).toBe("inherit");
  expect(reviewAutoActive({})).toBe(false);
  expect(reviewAutoActive({ [ENV_REVIEW_SYSTEM]: "review-auto" })).toBe(true);
  setReviewSystem("review-auto");
  expect(reviewAutoActive({})).toBe(true);
});

test("recognises the operator's request for an automatic review in Russian and English", () => {
  for (const line of [
    "сделай автоматическое ревью PR 7435",
    "Проведи автоматический код-ревью",
    "ревью автоматически, без вопросов",
    "run an automatic review of this PR",
    "please auto-review it",
    "review it with review-auto",
  ]) {
    expect(asksForReviewAuto(line)).toBe(true);
  }
  for (const line of ["Проведи ревью через review-orchestrator", "review this PR", "автоматизируй сборку"]) {
    expect(asksForReviewAuto(line)).toBe(false);
  }
});

test("grants a reviewer spawn even after untrusted content, but never a floor call", () => {
  expect(reviewAutoGrants("spawn_subagent", meta({ untrustedOrigin: true }))).toBe(true);
  expect(reviewAutoGrants("spawn_subagent", meta({ destructive: true }))).toBe(false);
  expect(reviewAutoGrants("spawn_subagent", meta({ credentials: true }))).toBe(false);
  expect(reviewAutoGrants("spawn_subagent", meta({ hookAsk: true }))).toBe(false);
  expect(reviewAutoGrants("spawn_subagent", meta({ alwaysAsk: true }))).toBe(false);
  expect(reviewAutoGrants("spawn_subagent", undefined)).toBe(false);
});

test("an ordinary tool is granted only when no floor applies and the origin is trusted", () => {
  expect(reviewAutoGrants("shell_exec", meta())).toBe(true);
  expect(reviewAutoGrants("shell_exec", meta({ untrustedOrigin: true }))).toBe(false);
  expect(reviewAutoGrants("shell_exec", meta({ publishLease: true }))).toBe(false);
  expect(reviewAutoGrants("shell_exec", meta({ destructive: true }))).toBe(false);
  expect(reviewAutoGrants("apply_patch", meta({ credentials: true }))).toBe(false);
});

test("a permission-style menu is the operator's once they have refused an action; other menus are still answered", () => {
  const allowMenu = { question: "Разрешить проверку портов?", options: [{ id: "a", label: "Разрешить", description: "" }, { id: "d", label: "Запретить", description: "" }] };
  const planMenu = { question: "Which slicing plan?", options: [{ id: "a", label: "Eight slices", description: "default" }] };
  expect(reviewAutoMayAnswer(allowMenu)).toBe(true);
  recordOperatorDenial("fp1");
  expect(operatorDenied("fp1")).toBe(true);
  expect(operatorDenied("fp2")).toBe(false);
  expect(reviewAutoMayAnswer(allowMenu)).toBe(false);
  expect(reviewAutoMayAnswer({ question: "Allow it?", options: [{ id: "a", label: "Yes", description: "" }] })).toBe(false);
  expect(reviewAutoMayAnswer(planMenu)).toBe(true);
  expect(reviewAutoMayAnswer({ ...planMenu, irreversible: true })).toBe(false);
  resetOperatorDenials();
  expect(reviewAutoMayAnswer(allowMenu)).toBe(true);
});

test("--review-system parses to a flag and refuses an unknown value", () => {
  expect(parseShellCliFlags(["--trust", "--review-system", "review-auto"]).reviewSystemFlag).toBe("review-auto");
  expect(parseShellCliFlags(["--review-system", "inherit"]).reviewSystemFlag).toBe("inherit");
  expect(parseShellCliFlags(["--trust"]).reviewSystemFlag).toBeUndefined();
  expect(() => parseShellCliFlags(["--review-system", "yolo"])).toThrow(/review-auto/);
});

const shell = (command: string): string => JSON.stringify({ command });

test("AC4: the refused-earlier message is the frozen sentence", () => {
  expect(REFUSED_EARLIER).toBe("refused earlier: choose another path");
});

test("AC4: spellings of one command normalize to one fingerprint", () => {
  const key = (command: string): string => refusalFingerprint("shell_exec", shell(command), "fallback");
  const base = key("keryx harness wave --spec tier.json");
  expect(key("keryx   harness   wave --spec tier.json")).toBe(base);
  expect(key('keryx harness wave "--spec" \'tier.json\'')).toBe(base);
  expect(key("keryx harness wave --spec=tier.json")).toBe(base);
  expect(key("keryx harness wave --spec tier.json --json")).toBe(base);
  expect(key("keryx harness wave --json --spec tier.json")).toBe(base);
  expect(key("keryx harness wave --spec tier.json --help")).toBe(base);
  expect(key("keryx harness wave --spec tier.json --format json --no-color")).toBe(base);
});

test("AC4: argument order of flag pairs does not matter, but their pairing does", () => {
  const key = (command: string): string => refusalFingerprint("shell_exec", shell(command), "fallback");
  expect(key("keryx review run --base main --head feat")).toBe(key("keryx review run --head feat --base main"));
  expect(key("keryx review run --base main --head feat")).not.toBe(key("keryx review run --base feat --head main"));
});

test("AC4: different commands, subcommands and values keep different fingerprints", () => {
  const key = (command: string): string => refusalFingerprint("shell_exec", shell(command), "fallback");
  const base = key("keryx harness wave --spec tier.json");
  expect(key("keryx harness wave --spec other.json")).not.toBe(base);
  expect(key("keryx harness status --spec tier.json")).not.toBe(base);
  expect(key("keryx harness wave")).not.toBe(base);
  expect(key("keryx harness wave --spec tier.json && rm -rf build")).not.toBe(base);
  expect(key("keryx harness wave --spec tier.json; rm -rf build")).not.toBe(base);
});

test("AC4: a call without a command falls back to the exact fingerprint", () => {
  expect(refusalFingerprint("apply_patch", JSON.stringify({ patch: "x" }), "exact-fp")).toBe("exact-fp");
  expect(refusalFingerprint("shell_exec", "not json", "exact-fp")).toBe("exact-fp");
  expect(refusalFingerprint("shell_exec", JSON.stringify({ command: "" }), "exact-fp")).toBe("exact-fp");
});
