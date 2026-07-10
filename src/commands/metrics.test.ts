import { expect, test } from "bun:test";
import { printMetricsHelp } from "./metrics";

test("metrics help exposes canonical record, latest, lightweight, and benchmark commands", () => {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    printMetricsHelp();
  } finally {
    console.log = original;
  }
  const help = lines.join("\n");
  expect(help).toContain("metrics collect");
  expect(help).toContain("metrics latest");
  expect(help).toContain("metrics plan --profile lightweight");
  expect(help).toContain("metrics benchmark validate");
});
