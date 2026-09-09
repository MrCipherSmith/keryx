import { afterEach, expect, test } from "bun:test";
import { authCommand } from "./auth";

const originalExit = process.exitCode;

afterEach(() => {
  process.exitCode = originalExit;
});

test("auth login anthropic refuses Claude Pro and does not call the network", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    await authCommand(["login", "anthropic"]);
  } finally {
    console.error = orig;
  }
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("Claude Pro/Max");
});

test("auth login gemini refuses Google-account OAuth", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    await authCommand(["login", "gemini"]);
  } finally {
    console.error = orig;
  }
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("GEMINI_API_KEY");
});

test("auth login deepseek refuses a non-existent subscription grant", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    await authCommand(["login", "deepseek"]);
  } finally {
    console.error = orig;
  }
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("DEEPSEEK_API_KEY");
});
