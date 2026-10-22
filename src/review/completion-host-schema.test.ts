import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { validateAgainstSchemaObject } from "../contracts/validator";
import { HOST_QUESTION_SOURCES } from "./types";

test("manifest completion and waiver host sources match the runtime contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../../docs/requirements/managed-review-feedback-loop/schemas/managed-review-package.schema.json", import.meta.url), "utf8"));
  const shapes = [schema.properties.completionConfirmations.items, schema.properties.readiness_waivers.items.properties.hostQuestion];
  for (const shape of shapes) {
    expect(shape.properties.source.enum).toEqual([...HOST_QUESTION_SOURCES]);
    for (const source of HOST_QUESTION_SOURCES) {
      expect(validateAgainstSchemaObject(shape, {
        source, ref: "operator-question", questionText: "Complete this round?",
        answerText: "yes", time: "2026-10-22T10:00:00Z",
      }).errors).toEqual([]);
    }
    for (const source of ["claude", "gemini", "unknown"]) {
      expect(validateAgainstSchemaObject(shape, {
        source, ref: "operator-question", questionText: "Complete this round?",
        answerText: "yes", time: "2026-10-22T10:00:00Z",
      }).valid).toBe(false);
    }
  }
});
