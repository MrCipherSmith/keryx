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
  reason: "no-resolution-recorded",
};

const UNKNOWN_WITH_OUTCOME: CatchUpUnknownItem = {
  type: "unknown",
  sessionId: "sess-unknown-2",
  lastSeenAt: "2026-08-19T00:05:00.000Z",
  reason: "wrap-up-failed",
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
    "Why unknown: Slate engagement with no proposal, terminal state, unbound-candidate or wrap-up-outcome artifact recorded.",
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

test("an 'unknown' row names its reason, so two different unknowns are told apart at a glance", () => {
  // This row used to be byte-identical for both fixtures ("— last seen <ts>"),
  // which is exactly the opacity the reason field removes: a wrap-up that ran
  // and FAILED and a session that recorded nothing looked the same here.
  const linesWithout = formatReviewListLines([UNKNOWN_NO_OUTCOME], 0);
  expect(linesWithout[0]).toBe("> UNKNOWN  sess-unknown-1 — no resolution recorded (last seen 2026-08-19T00:00:00.000Z)");

  const linesWith = formatReviewListLines([UNKNOWN_WITH_OUTCOME], 0);
  expect(linesWith[0]).toBe("> UNKNOWN  sess-unknown-2 — wrap-up failed (last seen 2026-08-19T00:05:00.000Z)");
});

test("detail reflects armed / running / done accept status", () => {
  expect(formatReviewDetailLines(PROPOSAL, { kind: "armed", decision: "accept" }).join("\n")).toContain("CONFIRM accept");
  expect(formatReviewDetailLines(PROPOSAL, { kind: "running", decision: "accept" }).join("\n")).toContain("Accepting…");
  expect(formatReviewDetailLines(PROPOSAL, { kind: "done", decision: "accept", outcome: { ok: true } }).join("\n")).toContain("✓ Accepted.");
  expect(
    formatReviewDetailLines(PROPOSAL, { kind: "done", decision: "accept", outcome: { ok: false, message: "boom" } }).join("\n"),
  ).toContain("✗ Accept failed: boom");
});

test("detail reflects armed / running / done decline status, and unavailable on a non-proposal item", () => {
  expect(formatReviewDetailLines(PROPOSAL, { kind: "armed", decision: "decline" }).join("\n")).toContain("CONFIRM decline");
  expect(formatReviewDetailLines(PROPOSAL, { kind: "running", decision: "decline" }).join("\n")).toContain("Declining…");
  expect(formatReviewDetailLines(PROPOSAL, { kind: "done", decision: "decline", outcome: { ok: true } }).join("\n")).toContain("✓ Declined.");
  expect(
    formatReviewDetailLines(PROPOSAL, { kind: "done", decision: "decline", outcome: { ok: false, message: "boom" } }).join("\n"),
  ).toContain("✗ Decline failed: boom");

  const unavailable = formatReviewDetailLines(BLOCKED, { kind: "unavailable", decision: "accept" }).join("\n");
  expect(unavailable).toContain("does nothing here");
  expect(unavailable).toContain("only apply to a pending proposal");
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

test("[a] then [y] runs acceptProposal, removes the item locally, and fires onResolved", async () => {
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
      onResolved: (item) => {
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

test("[d] then [y] runs declineProposal (--decision rejected), separately from acceptProposal", async () => {
  let active = "detail";
  let node: { content: string } | undefined;
  let declined: CatchUpProposalItem | undefined;
  let acceptCalls = 0;
  let resolveDecline: (() => void) | undefined;
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
      declineProposal: (item) =>
        new Promise((resolve) => {
          resolveDecline = () => resolve({ ok: true });
          expect(item.proposalId).toBe(PROPOSAL.proposalId);
        }),
      onResolved: (item) => {
        declined = item;
      },
      onKeypress: (handler) => {
        handler({ name: "d", sequence: "d" });
        expect(node?.content).toContain("CONFIRM decline");
        handler({ name: "y", sequence: "y" });
        expect(node?.content).toContain("Declining…");
        return () => {};
      },
    },
  );
  expect(resolveDecline).toBeDefined();
  resolveDecline?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(node?.content).toContain("✓ Declined.");
  expect(declined?.proposalId).toBe(PROPOSAL.proposalId);
  // The other decision's handler was never touched.
  expect(acceptCalls).toBe(0);
});

test("[s] then [y] runs acceptProposalWithAcknowledgement (--acknowledge-security), never the plain accept", async () => {
  let active = "detail";
  let node: { content: string } | undefined;
  let acceptCalls = 0;
  let ackCalls = 0;
  let resolveAck: (() => void) | undefined;
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
      acceptProposalWithAcknowledgement: (item) =>
        new Promise((resolve) => {
          ackCalls += 1;
          resolveAck = () => resolve({ ok: true });
          expect(item.proposalId).toBe(PROPOSAL.proposalId);
        }),
      onKeypress: (handler) => {
        handler({ name: "s", sequence: "s" });
        expect(node?.content).toContain("CONFIRM accept-acknowledged (--acknowledge-security)");
        // The acknowledgement is the operator's own statement, so the arm step
        // says out loud what pressing y claims.
        expect(node?.content).toContain("have READ the evidence");
        handler({ name: "y", sequence: "y" });
        expect(node?.content).toContain("acknowledging the security findings");
        return () => {};
      },
    },
  );
  expect(resolveAck).toBeDefined();
  resolveAck?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(node?.content).toContain("✓ Accepted (security findings acknowledged).");
  expect(ackCalls).toBe(1);
  // The plain accept is a DIFFERENT action: the acknowledged path must never be
  // reachable through it, and this one must never fall back to it.
  expect(acceptCalls).toBe(0);
});

test("[s] with no acknowledgement handler wired reports 'unavailable' instead of silently accepting", () => {
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
        handler({ name: "s", sequence: "s" });
        expect(node?.content).not.toContain("CONFIRM accept-acknowledged");
        expect(node?.content).toContain("no accept-acknowledged handler is configured");
        // Never silently downgraded to the plain, unacknowledged accept.
        expect(acceptCalls).toBe(0);
        return () => {};
      },
    },
  );
});

test("a non-proposal selection never arms accept/decline, even with both handlers present — and says why instead of doing nothing", () => {
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
      declineProposal: async () => ({ ok: true }),
      onKeypress: (handler) => {
        handler({ name: "a", sequence: "a" });
        expect(node?.content).not.toContain("CONFIRM accept");
        expect(node?.content).toContain("does nothing here");
        handler({ name: "d", sequence: "d" });
        expect(node?.content).not.toContain("CONFIRM decline");
        expect(node?.content).toContain("does nothing here");
        return () => {};
      },
    },
  );
});

test("[a] with no acceptProposal wired reports 'unavailable' instead of silently doing nothing", () => {
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
      items: [PROPOSAL],
      visibleRows: 20,
      onKeypress: (handler) => {
        handler({ name: "a", sequence: "a" });
        expect(node?.content).not.toContain("CONFIRM accept");
        expect(node?.content).toContain("no accept handler is configured");
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

test("AC8: empty /review modal renders a compact dialog and hides action hotkeys (a, d, y, arm) from footer hints", () => {
  let capturedInput: any;
  presentReview(
    (_otui, _chrome, input) => {
      capturedInput = input;
      return {
        close: () => {},
        setTab: () => {},
        activeTab: () => "list",
      };
    },
    fakeOtui(),
    {},
    {
      items: [],
      visibleRows: 20,
    },
  );

  expect(capturedInput).toBeDefined();
  expect(capturedInput.contentRows).toBe(3);
  const footerStr = capturedInput.footer?.map((f: any) => `${f.key} ${f.label}`).join(" ") ?? "";
  // Must hide action hotkeys (a, d, y, arm)
  expect(footerStr).not.toContain(" a ");
  expect(footerStr).not.toContain(" d ");
  expect(footerStr).not.toContain(" y ");
  expect(footerStr).not.toContain("arm");
  expect(footerStr).toContain("esc");
});

