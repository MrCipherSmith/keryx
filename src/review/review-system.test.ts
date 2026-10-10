import { afterEach, expect, test } from "bun:test";
import type { ApprovalMeta } from "../commands/agent";
import { parseShellCliFlags } from "../commands/shell";
import {
  ENV_REVIEW_SYSTEM,
  asksForReviewAuto,
  getReviewSystem,
  parseReviewSystem,
  reviewAutoActive,
  reviewAutoGrants,
  setReviewSystem,
} from "./review-system";

afterEach(() => setReviewSystem("inherit"));

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

test("--review-system parses to a flag and refuses an unknown value", () => {
  expect(parseShellCliFlags(["--trust", "--review-system", "review-auto"]).reviewSystemFlag).toBe("review-auto");
  expect(parseShellCliFlags(["--review-system", "inherit"]).reviewSystemFlag).toBe("inherit");
  expect(parseShellCliFlags(["--trust"]).reviewSystemFlag).toBeUndefined();
  expect(() => parseShellCliFlags(["--review-system", "yolo"])).toThrow(/review-auto/);
});
