import { expect, test } from "bun:test";
import type { CatchUpBlockedItem, CatchUpItem, CatchUpProposalItem, CatchUpUnknownItem } from "../sac/catch-up";
import {
  clampScroll,
  formatReviewDetailLines,
  formatReviewListLines,
  isReviewCommand,
  presentReview,
  windowLines,
} from "./review-inspector";

const PROPOSAL: CatchUpProposalItem = {
  type: "proposal",
  workspaceId: "ws-1",
  proposalId: "proposal-abc123",
  fresh: true,
  kind: "decision",
  author: "user:local-1",
  createdAt: "2026-08-14T00:00:00.000Z",
  note: "WorktreePort is the real create/remove/merge seam.",
};

const PROPOSAL_NO_NOTE: CatchUpProposalItem = { ...PROPOSAL, proposalId: "proposal-no-note", note: undefined };

const BLOCKED: CatchUpBlockedItem = {
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

const UNKNOWN_NO_OUTCOME: CatchUpUnknownItem = {
  type: "unknown",
  sessionId: "sess-unknown-1",
  lastSeenAt: "2026-08-19T00:00:00.000Z",
};

const UNKNOWN_WITH_OUTCOME: CatchUpUnknownItem = {
  type: "unknown",
  sessionId: "sess-unknown-2",
  lastSeenAt: "2026-08-19T00:05:00.000Z",
  wrapUpOutcome: {
    trigger: "explicit",
    generatedAt: "2026-08-19T00:04:00.000Z",
    groups: [
      { kind: "decision", outcome: "error", message: "model provider unavailable" },
      { kind: "risk", outcome: "no_credential" },
      { kind: "follow-up", outcome: "conflict" },
    ],
  },
};

test("isReviewCommand accepts only /review", () => {
  expect(isReviewCommand("/review")).toBe(true);
  expect(isReviewCommand("  /review  ")).toBe(true);
  expect(isReviewCommand("/reviews")).toBe(false);
  expect(isReviewCommand("/workspace")).toBe(false);
});

test("list highlights the selected row and labels each item by type", () => {
  const lines = formatReviewListLines([PROPOSAL, BLOCKED], 0);
  expect(lines[0]?.startsWith(">")).toBe(true);
  expect(lines[0]).toContain("PROPOSAL");
  expect(lines[0]).toContain("proposal-abc123");
  // Its kind is visible at a glance, before ever opening the Detail tab.
  expect(lines[0]).toContain("decision");
  expect(lines[1]?.startsWith(" ")).toBe(true);
  expect(lines[1]).toContain("BLOCKED");
});

test("list on an empty report says so instead of an empty body", () => {
  expect(formatReviewListLines([], 0)).toEqual(["Nothing needs review right now."]);
});

test("detail includes the recommended command and, for a proposal, the accept hint", () => {
  const idle = formatReviewDetailLines(PROPOSAL, { kind: "idle" }).join("\n");
  expect(idle).toContain("proposal-abc123");
  expect(idle).toContain("ws-1");
  expect(idle).toContain("[a] Accept this proposal");

  const blocked = formatReviewDetailLines(BLOCKED, { kind: "idle" }).join("\n");
  expect(blocked).toContain("budget_exhausted");
  expect(blocked).toContain("keryx shell -r sess-1");
  // Non-proposal items never offer an accept action.
  expect(blocked).not.toContain("[a] Accept");
});

test("a proposal's detail shows what was actually proposed — kind, author, created, and the propose-time note", () => {
  const lines = formatReviewDetailLines(PROPOSAL, { kind: "idle" });
  expect(lines).toContain("Kind       decision");
  expect(lines).toContain("Author     user:local-1");
  expect(lines).toContain("Created    2026-08-14T00:00:00.000Z");
  expect(lines).toContain("Note       WorktreePort is the real create/remove/merge seam.");
});

test("a proposal with no propose-time note omits the Note line instead of showing a placeholder", () => {
  const lines = formatReviewDetailLines(PROPOSAL_NO_NOTE, { kind: "idle" });
  expect(lines.some((line) => line.startsWith("Note"))).toBe(false);
});

test("flow 173: 'unknown' detail without wrapUpOutcome shows exactly today's unchanged generic message", () => {
  const lines = formatReviewDetailLines(UNKNOWN_NO_OUTCOME, { kind: "idle" });
  expect(lines).toEqual([
    "Session    sess-unknown-1",
    "Last seen  2026-08-19T00:00:00.000Z",
    "No proposal, terminal state, or unbound-candidate artifact recorded.",
    "",
    "Investigate: keryx sessions list / keryx shell -r sess-unknown-1",
  ]);
});

test("flow 173: 'unknown' detail with wrapUpOutcome shows the real trigger/timestamp/per-group failure reason", () => {
  const lines = formatReviewDetailLines(UNKNOWN_WITH_OUTCOME, { kind: "idle" });
  expect(lines).toEqual([
    "Session    sess-unknown-2",
    "Last seen  2026-08-19T00:05:00.000Z",
    "Wrap-up dispatch (explicit, 2026-08-19T00:04:00.000Z) did not produce a proposal or unbound-candidate:",
    "  decision: model provider unavailable",
    "  risk: no model credential available",
    "  follow-up: a concurrent proposal already claimed this slot",
    "",
    "Investigate: keryx sessions list / keryx shell -r sess-unknown-2",
  ]);
});

test("flow 173: 'unknown' detail shows the workspace suffix regardless of wrapUpOutcome presence", () => {
  const withWorkspace: CatchUpUnknownItem = { ...UNKNOWN_WITH_OUTCOME, workspaceId: "ws-unknown" };
  const lines = formatReviewDetailLines(withWorkspace, { kind: "idle" });
  expect(lines[0]).toBe("Session    sess-unknown-2  (workspace ws-unknown)");
});

test("flow 173/AC8: 'unknown' list-row text is unchanged regardless of wrapUpOutcome presence", () => {
  const linesWithout = formatReviewListLines([UNKNOWN_NO_OUTCOME], 0);
  expect(linesWithout[0]).toBe("> UNKNOWN  sess-unknown-1 — last seen 2026-08-19T00:00:00.000Z");

  const linesWith = formatReviewListLines([UNKNOWN_WITH_OUTCOME], 0);
  expect(linesWith[0]).toBe("> UNKNOWN  sess-unknown-2 — last seen 2026-08-19T00:05:00.000Z");
});

test("detail reflects armed / running / done accept status", () => {
  expect(formatReviewDetailLines(PROPOSAL, { kind: "armed" }).join("\n")).toContain("CONFIRM accept");
  expect(formatReviewDetailLines(PROPOSAL, { kind: "running" }).join("\n")).toContain("Accepting…");
  expect(formatReviewDetailLines(PROPOSAL, { kind: "done", outcome: { ok: true } }).join("\n")).toContain("✓ Accepted.");
  expect(
    formatReviewDetailLines(PROPOSAL, { kind: "done", outcome: { ok: false, message: "boom" } }).join("\n"),
  ).toContain("✗ Accept failed: boom");
});

test("windowLines and clampScroll keep a viewport over long bodies", () => {
  const lines = ["a", "b", "c", "d", "e"];
  expect(windowLines(lines, 0, 3)).toEqual(["a", "b", "c"]);
  expect(clampScroll(99, 5, 3)).toBe(2);
});

test("presentReview opens list+detail and Enter switches to Detail", () => {
  const calls: { title: string; tabs: readonly { id: string }[] }[] = [];
  let active = "list";
  presentReview(
    (_otui, _chrome, input) => {
      calls.push(input);
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    {},
    {},
    {
      items: [PROPOSAL],
      onKeypress: (handler) => {
        handler({ name: "enter", sequence: "\r" });
        return () => {};
      },
    },
  );
  expect(calls[0]?.title).toBe("/review");
  expect(calls[0]?.tabs.map((tab) => tab.id)).toEqual(["list", "detail"]);
  expect(active).toBe("detail");
});

function fakeOtui(): { TextRenderable: new (r: unknown, opts: { content: string }) => { content: string } } {
  return {
    TextRenderable: class {
      content: string;
      constructor(_r: unknown, opts: { content: string }) {
        this.content = opts.content;
      }
    },
  };
}

test("[a] arms accept only on the Detail tab for a proposal; any non-y key cancels the arm", () => {
  let active = "detail";
  let node: { content: string } | undefined;
  let acceptCalls = 0;
  presentReview(
    (_otui, _chrome, input) => {
      input.renderTab("detail", {
        add: (child: { content?: string }) => {
          node = child as { content: string };
        },
      });
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    fakeOtui(),
    {},
    {
      items: [PROPOSAL],
      visibleRows: 20,
      acceptProposal: async () => {
        acceptCalls += 1;
        return { ok: true };
      },
      onKeypress: (handler) => {
        handler({ name: "a", sequence: "a" });
        expect(node?.content).toContain("CONFIRM accept");
        handler({ name: "x", sequence: "x" });
        expect(node?.content).not.toContain("CONFIRM accept");
        expect(node?.content).toContain("[a] Accept this proposal");
        expect(acceptCalls).toBe(0);
        return () => {};
      },
    },
  );
});

test("[a] then [y] runs acceptProposal, removes the item locally, and fires onAccepted", async () => {
  let active = "detail";
  let node: { content: string } | undefined;
  let accepted: CatchUpProposalItem | undefined;
  let resolveAccept: (() => void) | undefined;
  presentReview(
    (_otui, _chrome, input) => {
      input.renderTab("detail", {
        add: (child: { content?: string }) => {
          node = child as { content: string };
        },
      });
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    fakeOtui(),
    {},
    {
      items: [PROPOSAL],
      visibleRows: 20,
      acceptProposal: (item) =>
        new Promise((resolve) => {
          resolveAccept = () => resolve({ ok: true });
          expect(item.proposalId).toBe(PROPOSAL.proposalId);
        }),
      onAccepted: (item) => {
        accepted = item;
      },
      onKeypress: (handler) => {
        handler({ name: "a", sequence: "a" });
        handler({ name: "y", sequence: "y" });
        expect(node?.content).toContain("Accepting…");
        return () => {};
      },
    },
  );
  expect(resolveAccept).toBeDefined();
  resolveAccept?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(node?.content).toContain("✓ Accepted.");
  expect(accepted?.proposalId).toBe(PROPOSAL.proposalId);
});

test("a non-proposal selection never arms accept, even with acceptProposal present", () => {
  let active = "detail";
  let node: { content: string } | undefined;
  presentReview(
    (_otui, _chrome, input) => {
      input.renderTab("detail", {
        add: (child: { content?: string }) => {
          node = child as { content: string };
        },
      });
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    fakeOtui(),
    {},
    {
      items: [BLOCKED],
      visibleRows: 20,
      acceptProposal: async () => ({ ok: true }),
      onKeypress: (handler) => {
        handler({ name: "a", sequence: "a" });
        expect(node?.content).not.toContain("CONFIRM accept");
        return () => {};
      },
    },
  );
});

test("[ ]/p n switch the selected item; detail scroll (j/k) never changes selection", () => {
  const other: CatchUpItem = { ...PROPOSAL, proposalId: "proposal-def456" };
  let active = "detail";
  let node: { content: string } | undefined;
  presentReview(
    (_otui, _chrome, input) => {
      input.renderTab("detail", {
        add: (child: { content?: string }) => {
          node = child as { content: string };
        },
      });
      return {
        close: () => input.onClose?.(),
        setTab: (id) => {
          active = id;
        },
        activeTab: () => active,
      };
    },
    fakeOtui(),
    {},
    {
      items: [PROPOSAL, other],
      visibleRows: 20,
      onKeypress: (handler) => {
        expect(node?.content).toContain("proposal-abc123");
        handler({ name: "j", sequence: "j" });
        expect(node?.content).toContain("proposal-abc123");
        handler({ name: "]", sequence: "]" });
        expect(node?.content).toContain("proposal-def456");
        expect(node?.content).not.toContain("proposal-abc123");
        return () => {};
      },
    },
  );
});
