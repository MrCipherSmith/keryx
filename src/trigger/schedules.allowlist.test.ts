// Flow 301 (AC9): the `/schedule` and `schedule_create` confirmation card shows
// `network: allowlist` with its domains, through `cardSafe`, and states that it
// governs only the agent's shell commands — never silently rendered as off or full.
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { draftSchedule } from "./schedules";

const RATES = { inputUsdPerMTok: 3, outputUsdPerMTok: 15 };

describe("draftSchedule card — network: allowlist (flow 301)", () => {
  test("the card names the mode, every domain, and that it governs only shell commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-card-"));
    try {
      const drafted = await draftSchedule(
        {
          name: "check-github",
          cadence: "every 4 hours",
          prompt: "check github",
          provider: "anthropic",
          model: "m",
          rates: RATES,
          ceilingUsd: 1,
          network: "allowlist",
          domains: ["api.github.com", "*.githubusercontent.com"],
        },
        { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) } },
      );
      expect(drafted.ok).toBe(true);
      if (!drafted.ok) return;
      const card = drafted.draft.card.join("\n");
      expect(card).toContain("network: allowlist - api.github.com, *.githubusercontent.com");
      expect(card).toContain("governs ONLY the agent's shell commands");
      expect(card).not.toContain("off (the agent's shell has no network)");
      expect(card).not.toContain("NETWORK ON");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an empty domains list still renders (never crashes) and says nothing is reachable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-card-"));
    try {
      const drafted = await draftSchedule(
        {
          name: "check-github",
          cadence: "every 4 hours",
          prompt: "check github",
          provider: "anthropic",
          model: "m",
          rates: RATES,
          ceilingUsd: 1,
          network: "allowlist",
          domains: [],
        },
        { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) } },
      );
      // Validation happens in config.ts's loader (`triggerEntryProblems`), which
      // `draftSchedule` runs too — an empty domains list is refused at draft time,
      // same as at load time (flow 301 AC1), so the operator never confirms a
      // schedule that would deny every request.
      expect(drafted.ok).toBe(false);
      if (drafted.ok) return;
      expect(drafted.problems.join(" ")).toContain('required and non-empty when network is "allowlist"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("flow 301 F2 (security review): the card shows the default port restriction, and the grant's own ports when set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-card-"));
    try {
      const defaulted = await draftSchedule(
        {
          name: "check-github",
          cadence: "every 4 hours",
          prompt: "check github",
          provider: "anthropic",
          model: "m",
          rates: RATES,
          ceilingUsd: 1,
          network: "allowlist",
          domains: ["api.github.com"],
        },
        { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) } },
      );
      expect(defaulted.ok).toBe(true);
      if (defaulted.ok) expect(defaulted.draft.card.join("\n")).toContain("443 (CONNECT) / 80 (HTTP) default");

      const withPorts = await draftSchedule(
        {
          name: "check-github-2",
          cadence: "every 4 hours",
          prompt: "check github",
          provider: "anthropic",
          model: "m",
          rates: RATES,
          ceilingUsd: 1,
          network: "allowlist",
          domains: ["api.github.com"],
          ports: [443, 8443],
        },
        { projectRoot: root, host: { backend: "cron", run: async () => ({ code: 0, stdout: "", stderr: "" }) } },
      );
      expect(withPorts.ok).toBe(true);
      if (withPorts.ok) expect(withPorts.draft.card.join("\n")).toContain("port 443/8443");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
