// Flow 338, AC1.
import { expect, test } from "bun:test";
import { NullClassifier } from "./classifier";

test("NullClassifier: always refuses, never guesses a category", async () => {
  const result = await new NullClassifier().classify("do something", ["quick", "review"]);
  expect(result).toEqual({ ok: false, reason: "no classifier configured" });
});
