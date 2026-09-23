// Flow 300 — shared fixtures for the Governance/Triggers TUI tests: a real
// OpenTUI test renderer + shell chrome, fixture projects (triggers.json,
// runs.jsonl, a governance report written by the CLI's own functions), and
// renderable lookups. Test-only; imported by `*.test.ts` files alone.

import { mkdir, mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandsForMode } from "../commands/agent-commands";
import { buildGovernanceReport, writeGovernanceArtifacts } from "../governance/service";
import type { TriggerRunRecord } from "../trigger/record";
import { createShellChrome, themeColorToHex, type ShellChrome } from "./shell-chrome";

export async function loadOpenTui(): Promise<
  { core: typeof import("@opentui/core"); testing: typeof import("@opentui/core/testing") } | undefined
> {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

export type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
export type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;

export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
export const CLI = path.join(REPO_ROOT, "src", "cli.ts");

export interface MountedChrome extends TestSetup {
  chrome: ShellChrome;
  toasts: string[];
  destroy(): void;
}

/** A real shell chrome on a headless renderer, with `showToast` recorded. */
export async function mountChrome(
  otui: OtuiBundle,
  opts: { width?: number; height?: number; kittyKeyboard?: boolean } = {},
): Promise<MountedChrome> {
  // `kittyKeyboard`: Esc arrives as an unambiguous CSI-u sequence, so a test
  // can press it and wait on state instead of on the legacy ESC parser's timer.
  const setup = await otui.testing.createTestRenderer({
    width: opts.width ?? 120,
    height: opts.height ?? 40,
    ...(opts.kittyKeyboard === true ? { kittyKeyboard: true } : {}),
  });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · test",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
  });
  const toasts: string[] = [];
  const showToast = chrome.showToast.bind(chrome);
  chrome.showToast = (message: string) => {
    toasts.push(message);
    showToast(message);
  };
  await setup.flush();
  return {
    ...setup,
    chrome,
    toasts,
    destroy: () => {
      chrome.destroy();
      setup.renderer.destroy();
    },
  };
}

/** The renderer's own keypress stream — what the shell's `inspectorKeys` wraps. */
export function keypressSource(renderer: TestSetup["renderer"]) {
  return (handler: (key: { name: string; sequence: string }) => void): (() => void) => {
    const internal = (renderer as unknown as {
      _internalKeyInput: { onInternal(e: string, h: unknown): void; offInternal(e: string, h: unknown): void };
    })._internalKeyInput;
    internal.onInternal("keypress", handler);
    return () => internal.offInternal("keypress", handler);
  };
}

type Node = { id: string; getChildren(): Node[]; content?: unknown; onMouseDown?: (() => void) | undefined };

export function findById(root: unknown, id: string): Node | undefined {
  const node = root as Node;
  if (node.id === id) return node;
  for (const child of node.getChildren()) {
    const hit = findById(child, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A real mouse click on the middle of a laid-out renderable. */
export async function clickNode(setup: TestSetup, node: unknown): Promise<void> {
  await setup.flush();
  const box = node as { x: number; y: number; width: number };
  if (box === undefined) throw new Error("clickNode: no such renderable");
  await setup.mockMouse.click(box.x + Math.max(0, Math.floor(box.width / 2)), box.y);
  await setup.flush();
}

/** Plain text of a node's content (a string or StyledText). */
export function textOf(node: Node | undefined): string {
  const content = node?.content as { chunks?: Array<{ text: string }> } | string | undefined;
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return (content.chunks ?? []).map((c) => c.text).join("");
}

/** The hex fg of every chunk of a node's content. */
export function chunkColors(node: Node | undefined): string[] {
  const content = node?.content as { chunks?: Array<{ fg?: unknown }> } | undefined;
  return (content?.chunks ?? []).map((c) => themeColorToHex(c.fg) ?? "none");
}

/** Settle microtasks + one render pass. */
export async function settle(setup: { flush: () => Promise<void> }, rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await setup.flush();
}

export async function makeProject(prefix = "keryx-ops-"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

export async function writeTriggers(root: string, triggers: readonly unknown[]): Promise<void> {
  await writeFile(path.join(root, ".metaproject", "triggers.json"), JSON.stringify({ schemaVersion: 1, triggers }, null, 2), "utf8");
}

export async function appendRuns(root: string, records: ReadonlyArray<Omit<TriggerRunRecord, "v">>): Promise<void> {
  const dir = path.join(root, ".metaproject", "data", "trigger");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "runs.jsonl"), records.map((r) => `${JSON.stringify({ v: 1, ...r })}\n`).join(""), "utf8");
}

/** Write a governance report exactly as `keryx governance report` does. */
export async function writeReport(root: string, at: string): Promise<void> {
  const report = await buildGovernanceReport({
    cwd: root,
    filters: { flow: undefined, owner: undefined, since: undefined, until: undefined },
    allProjects: false,
    now: () => new Date(at),
  });
  await writeGovernanceArtifacts(root, report);
}

export const DISPATCH_NET = {
  provider: "anthropic",
  model: "claude-x",
  permissionMode: "ask",
  rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  ceilingUsd: 1,
  maxSeconds: 600,
  maxAttempts: 2,
  network: true,
} as const;

/** A manual interval: the test fires the tick itself. */
export function manualInterval(): { interval: (tick: () => Promise<void>, ms: number) => () => void; fire(): Promise<void> } {
  let tick: (() => Promise<void>) | undefined;
  return {
    interval: (fn) => {
      tick = fn;
      return () => {
        tick = undefined;
      };
    },
    fire: async () => {
      await tick?.();
    },
  };
}
