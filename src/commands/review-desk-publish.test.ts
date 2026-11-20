import { describe, expect, test } from "bun:test";
import { parsePublicationRequest, publicationArgs } from "./review-desk-publish";

const id = "01234567-89ab-cdef-0123-456789abcdef";
const target = { repo: "org/repo", repositoryId: "R_42", viewer: "reviewer", number: 42 };
const settings = {
  inline: true, general: true, keryxTemplate: false, overlay: false, verdict: "suggestions",
  answers: { "round#reviewer:F-001": "uphold" },
} as const;

describe("Desktop publication requests", () => {
  test("only preview uses the read lane, and submit forwards the reviewed form as one argument", () => {
    expect(publicationArgs(target, { kind: "preview", id }).readOnly).toBe(true);
    expect(publicationArgs(target, { kind: "save", id, settings }).readOnly).toBe(false);
    const action = { kind: "submit", id, settings, digest: "a".repeat(64) };
    const submit = publicationArgs(target, action);
    expect(submit.readOnly).toBe(false);
    expect(submit.args).toEqual([
      "review", "desk-publish", "--json", "--repo", "org/repo", "--repository-id", "R_42",
      "--viewer", "reviewer", "--number", "42", "--request", JSON.stringify(action),
    ]);
  });

  test("accepts a concrete option ID in the draft settings", () => {
    const action = { kind: "save", id, settings: { ...settings, answers: { "F-001": `option:${"a".repeat(64)}` } } } as const;
    expect(parsePublicationRequest(JSON.stringify(action))).toEqual(action);
  });

  test("rejects unknown actions, invalid scopes, and incomplete or oversize forms", () => {
    for (const input of [
      { kind: "worker", id },
      { kind: "preview", id: "../package" },
      { kind: "preview", id, path: "report.md" },
      { kind: "submit", id, settings },
      { kind: "submit", id, settings, digest: "too-short" },
      { kind: "save", id, settings: { ...settings, answers: { constructor: "dismiss" } } },
      { kind: "save", id, settings: { ...settings, answers: { "F-001": "accept" } } },
      { kind: "save", id, settings: { ...settings, answers: { "F-001": "option:1" } } },
    ]) {
      expect(() => parsePublicationRequest(JSON.stringify(input))).toThrow("Invalid Review publication request.");
    }
    expect(() => parsePublicationRequest(" ".repeat(32 * 1024 + 1))).toThrow("request is too large");
    expect(() => publicationArgs({ ...target, repo: "--request" }, { kind: "preview", id })).toThrow("Invalid Review publication target");
  });
});
