// Flow 300 AC9: the Session Switcher (`/sessions`, `/resume`) marks a session
// `keryx agents external run` wrote with `acp:<agent>`, and the filter finds it.

import { expect, test } from "bun:test";
import type { SessionSummary } from "../session";
import { sessionPickerOptions } from "./tui-shell";

function summary(over: Partial<SessionSummary>): SessionSummary {
  return {
    schemaVersion: 1,
    id: "019f8070-95f5-7422-9bde-8862e9f685af",
    projectKey: "k",
    projectPath: "/p",
    title: "t",
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T11:00:00.000Z",
    messageCount: 3,
    archiveMessageCount: 3,
    compactCount: 0,
    ...over,
  } as SessionSummary;
}

test("AC9: an acp:claude row says so in its description, and `acp` / `acp:claude` filter to it", () => {
  const [external, native] = sessionPickerOptions([
    summary({ id: "019f8070-0000-7422-9bde-000000000001", provider: "acp:claude", title: "ACP claude: completed" }),
    summary({ id: "019f8070-0000-7422-9bde-000000000002", provider: "anthropic", title: "native chat" }),
  ]);
  expect(external?.description).toBe("acp:claude · updated 2026-09-22 11:00 · created 2026-09-22 10:00 · 3 messages");
  expect(native?.description).toBe("updated 2026-09-22 11:00 · created 2026-09-22 10:00 · 3 messages");
  expect(external?.search).toContain("acp:claude");
  expect(native?.search).not.toContain("acp:");
});
