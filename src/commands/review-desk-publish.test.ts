import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLICATION_REQUEST_LIMIT } from "../review/desk-publication-types";
import { parsePublicationRequest, publicationArgs, runReviewDeskPublish } from "./review-desk-publish";

const id = "01234567-89ab-cdef-0123-456789abcdef";
const target = { repo: "org/repo", repositoryId: "R_42", viewer: "reviewer", number: 42 };
const settings = {
  inline: true, general: true, keryxTemplate: false, overlay: false, verdict: "suggestions",
  answers: { "round#reviewer:F-001": "uphold" },
} as const;

describe("Desktop publication requests", () => {
  test("forwards scoped target and request file as individual arguments", () => {
    expect(publicationArgs(target, "/tmp/test request")).toEqual([
      "review", "desk-publish", "--json", "--repo", "org/repo", "--repository-id", "R_42",
      "--viewer", "reviewer", "--number", "42", "--request-file", "/tmp/test request",
    ]);
  });

  test("submit requires an interactive terminal on either input path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keryx-publish-test-"));
    try {
      const file = join(dir, "request.json");
      const action = { kind: "submit", id, settings, digest: "a".repeat(64) };
      await writeFile(file, JSON.stringify(action));
      const fileArgs = publicationArgs(target, file).slice(2);
      const inlineArgs = [...fileArgs.slice(0, -2), "--request", JSON.stringify(action)];
      const child = Bun.spawn([process.execPath, "src/cli.ts", "review", "desk-publish", ...fileArgs], {
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(stderr).toContain("requires an interactive terminal");
      const inline = Bun.spawn([process.execPath, "src/cli.ts", "review", "desk-publish", ...inlineArgs], {
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      expect(await new Response(inline.stderr).text()).toContain("requires an interactive terminal");
      expect(await inline.exited).toBe(1);
      await expect(runReviewDeskPublish([...fileArgs, "--request", JSON.stringify(action)])).rejects.toThrow("--request-file");
      await writeFile(file, Buffer.alloc(PUBLICATION_REQUEST_LIMIT + 1));
      await expect(runReviewDeskPublish(fileArgs)).rejects.toThrow("request is too large");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves an explicit verdict override and refresh in preview", () => {
    for (const verdictOverride of [null, "changes"] as const) {
      const action = { kind: "preview", id, refresh: true, settings: { ...settings, verdictOverride } } as const;
      expect(parsePublicationRequest(JSON.stringify(action))).toEqual(action);
    }
  });

  test("accepts concrete option IDs for more than 100 held findings", () => {
    const answers = Object.fromEntries(Array.from({ length: 160 }, (_, index) => [
      `F-${index}-${"f".repeat(150)}`, `option:${"a".repeat(64)}` as const,
    ]));
    const action = { kind: "save", id, settings: { ...settings, answers } } as const;
    const raw = JSON.stringify(action);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(32 * 1024);
    expect(parsePublicationRequest(raw)).toEqual(action);
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
    expect(() => parsePublicationRequest(" ".repeat(PUBLICATION_REQUEST_LIMIT + 1))).toThrow("request is too large");
    expect(() => publicationArgs({ ...target, repo: "--request" }, "/tmp/request")).toThrow("Invalid Review publication target");
  });
});
