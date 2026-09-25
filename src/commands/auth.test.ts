import { afterEach, beforeEach, expect, test } from "bun:test";
import { authCommand } from "./auth";

let originalExit: typeof process.exitCode;
beforeEach(() => { originalExit = process.exitCode; process.exitCode = 0; });

afterEach(() => {
  process.exitCode = originalExit ?? 0;
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

test("canonical subscription login uses the device endpoint and preserves safe failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors: string[] = [];
  const urls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => { urls.push(String(url)); return Response.json({error:"denied"},{status:403}); }) as typeof fetch;
  console.error = (value?: unknown) => { errors.push(String(value)); };
  try { await authCommand(["login","openai-codex"]); }
  finally { globalThis.fetch=originalFetch; console.error=originalError; }
  expect(urls).toEqual(["https://auth.openai.com/api/accounts/deviceauth/usercode"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join()).toContain("HTTP 403");
});

test("repeated Ctrl+C remains handled until login settles and then removes its listener", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const listenersBefore = process.listenerCount("SIGINT");
  const errors: string[] = [];
  const listenerCounts: number[] = [];
  globalThis.fetch = Object.assign(async (): Promise<Response> => {
    listenerCounts.push(process.listenerCount("SIGINT"));
    process.emit("SIGINT");
    listenerCounts.push(process.listenerCount("SIGINT"));
    process.emit("SIGINT");
    listenerCounts.push(process.listenerCount("SIGINT"));
    throw new Error("cancelled synthetic request");
  }, { preconnect: originalFetch.preconnect });
  console.error = (value?: unknown) => { errors.push(String(value)); };
  try {
    await authCommand(["login", "openai-codex"]);
    expect(listenerCounts).toEqual(Array(3).fill(listenersBefore + 1));
    expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
    expect(process.exitCode).toBe(1);
    expect(errors.join()).toContain("cancelled");
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
});

test("canonical CLI status and logout preserve the independent Platform key", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveOAuthGrant, loadOAuthGrant } = await import("../lib/oauth/grants");
  const { saveApiKey, loadShellConfig } = await import("../lib/shell-config");
  const root=mkdtempSync(join(tmpdir(),"keryx-auth-cli-"));
  const originalXdg=process.env.XDG_DATA_HOME;
  const originalAppData=process.env.APPDATA;
  const originalLog=console.log;
  const output: string[]=[];
  process.env.XDG_DATA_HOME=root;
  process.env.APPDATA=root;
  console.log=(value?: unknown)=>{output.push(String(value));};
  try {
    saveOAuthGrant("openai-codex",{method:"device-code",access:"synthetic",accountId:"fixture",obtainedAt:new Date().toISOString()});
    saveApiKey("OPENAI_API_KEY","synthetic-platform");
    await authCommand(["status","openai-codex","--json"]);
    expect(JSON.parse(output[0]!).status).toMatchObject({provider:"openai-codex",state:"active"});
    expect(output[0]).not.toContain("synthetic");
    await authCommand(["logout","openai-codex"]);
    expect(loadOAuthGrant("openai-codex")).toBeUndefined();
    expect(loadShellConfig().apiKeys?.OPENAI_API_KEY).toBe("synthetic-platform");
  } finally {
    console.log=originalLog;
    if(originalXdg===undefined)delete process.env.XDG_DATA_HOME;else process.env.XDG_DATA_HOME=originalXdg;
    if(originalAppData===undefined)delete process.env.APPDATA;else process.env.APPDATA=originalAppData;
    rmSync(root,{recursive:true,force:true});
  }
});
