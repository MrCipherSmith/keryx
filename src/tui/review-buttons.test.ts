// Flow: review Accept/Decline BUTTONS (mouse + keyboard) on the Detail tab.
//
// Integration tests over the REAL modal-host + review-inspector wiring:
// buttons are mounted as clickable BoxRenderables, mouse click arms, arrows
// move the highlight, Enter arms and Enter/y confirms. Optional
// `@opentui/core` is loaded only here; without it these skip.
import { expect, test } from "bun:test";
import type { CatchUpItem, CatchUpProposalItem } from "../sac/catch-up";
import { commandsForMode } from "../commands/agent-commands";
import { createShellChrome, type ShellChrome, type ShellChromeOptions } from "./shell-chrome";
import { destroyModalHost, openModal } from "./modal-host";
import { openReview } from "./review-inspector";
import { applyThemeId, getThemeId } from "./theme";

async function loadOpenTui(): Promise<{
  core: typeof import("@opentui/core");
  testing: typeof import("@opentui/core/testing");
} | undefined> {
  try {
    const core = await import("@opentui/core");
    const testing = await import("@opentui/core/testing");
    return { core, testing };
  } catch {
    return undefined;
  }
}

type OtuiBundle = NonNullable<Awaited<ReturnType<typeof loadOpenTui>>>;
type TestSetup = Awaited<ReturnType<OtuiBundle["testing"]["createTestRenderer"]>>;

const OTUI = await loadOpenTui();
const otuiTest = test.skipIf(OTUI === undefined);

function requireOtui(): OtuiBundle {
  if (OTUI === undefined) {
    throw new Error("unreachable: otuiTest skips without OpenTUI");
  }
  return OTUI;
}

const PROPOSAL: CatchUpProposalItem = {
  type: "proposal",
  workspaceId: "ws-1",
  proposalId: "proposal-abc123",
  fresh: true,
  kind: "decision",
  author: "user:local-1",
  createdAt: "2026-08-14T00:00:00.000Z",
  note: undefined,
};

const BLOCKED: CatchUpItem = {
  type: "blocked",
  sessionId: "sess-1",
  terminalState: {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: {},
    anchorsSnapshot: { root: "/tmp", touched: [] },
    occurredAt: "2026-08-16T00:00:00.000Z",
  },
};

async function mountChrome(
  otui: OtuiBundle,
  opts: { width?: number; height?: number; chrome?: Partial<ShellChromeOptions> } = {},
): Promise<TestSetup & { chrome: ShellChrome; destroy: () => void }> {
  const setup = await otui.testing.createTestRenderer({ width: opts.width ?? 120, height: opts.height ?? 40 });
  const chrome = await createShellChrome(otui.core, setup.renderer, {
    title: "keryx · chrome",
    status: "s/m",
    footerHint: "/ commands",
    placeholder: "ask keryx",
    commands: commandsForMode("agent"),
    ...opts.chrome,
  });
  await setup.flush();
  return {
    ...setup,
    chrome,
    destroy: () => {
      chrome.destroy();
      setup.renderer.destroy();
    },
  };
}

/** Open /review on the Detail tab of the first item, with real key wiring. */
async function openReviewOnDetail(
  otui: OtuiBundle,
  h: TestSetup & { chrome: ShellChrome },
  items: readonly CatchUpItem[],
  opts: { accept?: () => Promise<{ ok: true } | { ok: false; message: string }>; decline?: () => Promise<{ ok: true } | { ok: false; message: string }> } = {},
) {
  const handle = openReview(otui.core, h.chrome, {
    items,
    acceptProposal: opts.accept ?? (async () => ({ ok: true })),
    declineProposal: opts.decline ?? (async () => ({ ok: true })),
    onKeypress: (handler) => {
      // Real keypress stream: modal-host and review share one renderer.
      const r = h.renderer as unknown as {
        _internalKeyInput: {
          onInternal: (event: string, cb: (k: { name: string; sequence: string }) => void) => void;
          offInternal: (event: string, cb: (k: { name: string; sequence: string }) => void) => void;
        };
      };
      r._internalKeyInput.onInternal("keypress", handler);
      return () => r._internalKeyInput.offInternal("keypress", handler);
    },
  });
  expect(handle).toBeDefined();
  // Enter on the Review list opens the Detail tab.
  await h.mockInput.pressKeys(["\r"]);
  await h.flush();
  expect(handle?.activeTab()).toBe("detail");
  return handle;
}

otuiTest("buttons render on a proposal's Detail tab and are mouse-clickable", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  let accepted = 0;
  await openReviewOnDetail(otui, h, [PROPOSAL], {
    accept: async () => {
      accepted += 1;
      return { ok: true };
    },
  });
  const acceptBtn = h.renderer.root.findDescendantById("review-accept") as unknown as {
    x: number;
    y: number;
    backgroundColor: unknown;
  } | undefined;
  const declineBtn = h.renderer.root.findDescendantById("review-decline") as unknown as {
    x: number;
    y: number;
  } | undefined;
  expect(acceptBtn).toBeDefined();
  expect(declineBtn).toBeDefined();
  // Accept is the default focused button: highlighted.
  expect(acceptBtn?.backgroundColor).toBeTruthy();

  // Mouse click arms Accept (status becomes armed -> the detail hint shows it).
  await h.mockMouse.click((acceptBtn as { x: number; y: number }).x + 1, (acceptBtn as { x: number; y: number }).y);
  await h.flush();
  expect(h.captureCharFrame()).toContain("CONFIRM accept");

  // Enter confirms -> acceptProposal runs.
  await h.mockInput.pressKeys(["\r"]);
  await h.flush();
  expect(accepted).toBe(1);
  h.destroy();
});

otuiTest("arrows move the button highlight; Enter arms; y confirms", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  let declined = 0;
  await openReviewOnDetail(otui, h, [PROPOSAL], {
    decline: async () => {
      declined += 1;
      return { ok: true };
    },
  });
  const declineBtn = h.renderer.root.findDescendantById("review-decline") as unknown as {
    backgroundColor: unknown;
  };
  // Right arrow moves the highlight from Accept (default) to Decline.
  await h.mockInput.pressKeys(["\u001b[C"]);
  await h.flush();
  expect(declineBtn.backgroundColor).toBeTruthy();

  // Enter arms Decline; y confirms it.
  await h.mockInput.pressKeys(["\r"]);
  await h.flush();
  expect(h.captureCharFrame()).toContain("CONFIRM decline");
  await h.mockInput.pressKeys(["y"]);
  await h.flush();
  expect(declined).toBe(1);
  h.destroy();
});

otuiTest("Enter on a non-proposal Detail tab does not arm (no buttons)", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 100, height: 30 });
  await openReviewOnDetail(otui, h, [BLOCKED]);
  const acceptBtn = h.renderer.root.findDescendantById("review-accept");
  expect(acceptBtn).toBeUndefined();
  h.destroy();
});

otuiTest("destroyModalHost cleans up theme listeners across real renderer teardown", async () => {
  const otui = requireOtui();
  const h = await mountChrome(otui, { width: 90, height: 24 });
  const previous = getThemeId();
  try {
    await openReviewOnDetail(otui, h, [PROPOSAL]);
    destroyModalHost(h.renderer);
    applyThemeId("grokday");
    await h.flush();
  } finally {
    applyThemeId(previous);
    h.destroy();
  }
});
