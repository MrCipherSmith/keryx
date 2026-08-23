// Shared fakes for the games modal headless tests: fake providers, fake
// OpenTUI renderables, the fake modal host, and tree-walking helpers.
// No OpenTUI, no TTY — @opentui/core is only referenced structurally.
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../harness/provider/types";
import type { ProviderFactory } from "../../harness/provider/single-turn";
import type { OpenModalInput } from "../modal-host";
import { presentGamesModal } from "./modal";
import type { GamesModalHandle } from "./modal";

export const CAPABILITIES = {
  streaming: true,
  toolCalls: false,
  parallelToolCalls: false,
  structuredOutput: false,
  reasoningMetadata: false,
  promptCaching: false,
  vision: false,
  tokenCounting: false,
  modelListing: false,
} as const;

export function stubProvider(reply: string): ProviderPort {
  return {
    describe() {
      return { capabilities: { ...CAPABILITIES }, descriptor: { providerId: "stub" } };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

export function usageProvider(reply: string): ProviderPort {
  return {
    describe() {
      return { capabilities: { ...CAPABILITIES }, descriptor: { providerId: "stub" } };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "reasoning_delta", sequence: 0, attemptId: opts.attemptId, text: "think" };
      yield {
        kind: "usage_update", sequence: 1, attemptId: opts.attemptId,
        usage: { inputTokens: 40, outputTokens: 3, totalTokens: 43, exact: true },
      };
      yield { kind: "text_delta", sequence: 2, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 3, attemptId: opts.attemptId };
    },
  };
}

export function hangingProvider(): ProviderPort {
  return {
    describe() {
      return { capabilities: { ...CAPABILITIES }, descriptor: { providerId: "stub-hang" } };
    },
    async *stream(): AsyncIterable<NormalizedEvent> {
      await new Promise<never>(() => {});
    },
  };
}

export function factoryFor(provider: () => ProviderPort): ProviderFactory {
  return () => provider();
}

export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

export class FakeBox {
  children: unknown[] = [];
  readonly opts: Record<string, unknown>;
  constructor(_renderer?: unknown, opts: Record<string, unknown> = {}) {
    this.opts = opts;
  }
  add(child: unknown): void {
    this.children.push(child);
  }
  getChildren(): unknown[] {
    return this.children;
  }
  remove(child: unknown): void {
    this.children = this.children.filter((c) => c !== child);
  }
}

export class FakeText {
  content: unknown;
  fg: unknown;
  readonly id: string | undefined;
  constructor(_renderer: unknown, opts: Record<string, unknown>) {
    this.content = opts.content;
    this.fg = opts.fg;
    this.id = typeof opts.id === "string" ? opts.id : undefined;
  }
}

export const fakeOtui = { BoxRenderable: FakeBox, TextRenderable: FakeText };

export interface CapturedModal {
  tabs?: readonly { id: string; label: string }[];
  body?: FakeBox;
  /** The full modal input handed to the host — lets tests exercise onArrowKeys. */
  input?: OpenModalInput;
}

export function fakeHost(captured: CapturedModal) {
  return (_otui: unknown, _chrome: unknown, input: OpenModalInput) => {
    captured.tabs = input.tabs;
    captured.input = input;
    const body = new FakeBox();
    captured.body = body;
    input.renderTab("tic-tac-toe", body, { width: 80 });
    return {
      close: () => {
        input.onClose?.();
      },
      setTab: () => {},
      activeTab: () => "tic-tac-toe",
    };
  };
}

export function textsOf(root: FakeBox): Map<string, FakeText> {
  const texts = new Map<string, FakeText>();
  const walk = (node: FakeBox): void => {
    for (const child of node.children) {
      if (child instanceof FakeBox) {
        walk(child);
      } else if (child instanceof FakeText && child.id !== undefined) {
        texts.set(child.id, child);
      }
    }
  };
  walk(root);
  return texts;
}

export function openWith(
  captured: CapturedModal,
  providerFactory: ProviderFactory,
  extra: { timeoutMs?: number } = {},
): { press: (key: { name: string; sequence: string }) => void; handle: GamesModalHandle | undefined } {
  let keyHandler: ((key: { name: string; sequence: string }) => void) | undefined;
  const handle = presentGamesModal(fakeHost(captured), fakeOtui, {}, {
    providerFactory,
    env: {},
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    onKeypress: (handler) => {
      keyHandler = handler;
      return () => {};
    },
  });
  return {
    press: (key) => keyHandler?.(key),
    handle,
  };
}
