import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { actualOf, estimateActualLine, packageEstimateLine, readEstimateVsActual, upsertEstimateLine } from "./estimate-actual";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 20, 10, 0, 0);

async function pkg(options: { plan?: { min: number; max: number; dispatches: number } | "confirmation"; planAt?: number; raws?: number[] }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-estimate-actual-"));
  roots.push(dir);
  if (options.plan === "confirmation") {
    const file = path.join(dir, "plan-confirmation.json");
    await writeFile(file, JSON.stringify({ planKey: "k", dispatches: 88, minutes: [44, 110], quote: "ok", confirmedVia: "terminal", at: "2026-10-20T10:00:00Z" }));
    await utimes(file, new Date(options.planAt ?? T0 - MIN), new Date(options.planAt ?? T0 - MIN));
  } else if (options.plan !== undefined) {
    const file = path.join(dir, "plan.json");
    await writeFile(file, JSON.stringify({ dispatches: options.plan.dispatches, minutes: { min: options.plan.min, max: options.plan.max } }));
    await utimes(file, new Date(options.planAt ?? T0 - MIN), new Date(options.planAt ?? T0 - MIN));
  }
  if (options.raws !== undefined) {
    await mkdir(path.join(dir, "raw"), { recursive: true });
    for (const [index, at] of options.raws.entries()) {
      const file = path.join(dir, "raw", `r${index}.txt`);
      await writeFile(file, "x");
      await utimes(file, new Date(at), new Date(at));
    }
  }
  return dir;
}

const spread = (minutes: number, count: number, gapsAfter: Record<number, number> = {}): number[] => {
  const out: number[] = [];
  let at = T0;
  for (let i = 0; i < count; i += 1) {
    out.push(at);
    at += i in gapsAfter ? (gapsAfter[i] as number) * MIN : (minutes * MIN) / (count - 1);
  }
  return out;
};

describe("actualOf", () => {
  test("no pause: calendar and active time are the same", () => {
    const actual = actualOf(spread(43, 67));
    expect(actual).toMatchObject({ replies: 67, calendarMinutes: 43, pauseCount: 0, pauseMinutes: 0, activeMinutes: 43 });
  });

  test("a gap over 10 minutes is a pause and is taken out of the active time", () => {
    const actual = actualOf([0, 2, 61, 63, 70, 78, 86, 94, 101, 106].map((m) => T0 + m * MIN));
    expect(actual.calendarMinutes).toBe(106);
    expect(actual.pauseCount).toBe(1);
    expect(actual.pauseMinutes).toBe(59);
    expect(actual.activeMinutes).toBe(47);
  });

  test("a gap of exactly 10 minutes is not a pause", () => {
    expect(actualOf([T0, T0 + 10 * MIN, T0 + 20 * MIN]).pauseCount).toBe(0);
  });
});

describe("the line", () => {
  test("plan.json and the raw replies of an uninterrupted round", async () => {
    const dir = await pkg({ plan: { min: 28, max: 70, dispatches: 54 }, raws: spread(43, 67) });
    expect(await packageEstimateLine(dir)).toBe("Plan estimate vs actual: plan 28-70 min (54 dispatches); actual 43 min from first to last raw reply (67 replies); pauses over 10 min: 0");
  });

  test("a round with a pause names it and the time without it", async () => {
    const dir = await pkg({ plan: { min: 44, max: 110, dispatches: 88 }, raws: [T0, T0 + 20 * MIN, T0 + 79 * MIN, T0 + 106 * MIN, T0 + 107 * MIN, T0 + 108 * MIN] });
    const line = await packageEstimateLine(dir);
    expect(line).toContain("plan 44-110 min (88 dispatches)");
    expect(line).toContain("actual 108 min");
    expect(line).toContain("pauses over 10 min: 3");
  });

  test("an open round says so far", async () => {
    const dir = await pkg({ plan: { min: 28, max: 70, dispatches: 54 }, raws: spread(20, 6) });
    expect(await packageEstimateLine(dir, { open: true })).toContain("actual so far 20 min");
  });

  test("plan-confirmation.json is the plan when plan.json is absent", async () => {
    const dir = await pkg({ plan: "confirmation", raws: spread(30, 8) });
    expect(await packageEstimateLine(dir)).toContain("plan 44-110 min (88 dispatches)");
  });

  test("raw replies without a plan name the missing plan", async () => {
    const dir = await pkg({ raws: spread(30, 8) });
    expect(await packageEstimateLine(dir)).toContain("no recorded plan estimate; actual 30 min");
  });

  test("a plan without raw replies names the missing replies", async () => {
    const dir = await pkg({ plan: { min: 28, max: 70, dispatches: 54 } });
    expect(await packageEstimateLine(dir)).toBe("Plan estimate vs actual: plan 28-70 min (54 dispatches); no raw replies recorded");
    expect(await packageEstimateLine(dir, { open: true })).toContain("no raw replies yet");
  });

  test("a package with neither gets no line", async () => {
    const dir = await pkg({});
    expect(await packageEstimateLine(dir)).toBeUndefined();
    expect(await readEstimateVsActual(dir)).toBeUndefined();
  });
});

describe("times that cannot be the round's", () => {
  test("raw replies older than plan.json are not printed as a duration", async () => {
    const dir = await pkg({ plan: { min: 28, max: 70, dispatches: 54 }, planAt: T0 + 500 * MIN, raws: spread(43, 67) });
    const line = (await packageEstimateLine(dir)) ?? "";
    expect(line).toContain("actual not shown");
    expect(line).toContain("copied or restored");
    expect(line).not.toContain("43 min");
  });

  test("many replies within a minute of each other are a copy", async () => {
    const dir = await pkg({ raws: [T0, T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000, T0 + 5000] });
    expect((await packageEstimateLine(dir)) ?? "").toContain("actual not shown");
  });

  test("few replies close together are a short round, not a copy", async () => {
    const dir = await pkg({ raws: [T0, T0 + 20_000, T0 + 40_000] });
    expect((await packageEstimateLine(dir)) ?? "").not.toContain("actual not shown");
  });
});

describe("upsertEstimateLine", () => {
  const line = "Plan estimate vs actual: plan 28-70 min; actual 43 min";

  test("goes after the evidence level line", () => {
    const report = "# Report\n\nEvidence level: ran — tests\n\nFindings\n";
    expect(upsertEstimateLine(report, line)).toBe(`# Report\n\nEvidence level: ran — tests\n${line}\n\nFindings\n`);
  });

  test("is appended when there is no evidence level line", () => {
    expect(upsertEstimateLine("# Report\n", line)).toBe(`# Report\n\n${line}\n`);
  });

  test("a second write replaces the first and leaves one line", () => {
    const once = upsertEstimateLine("# Report\n\nEvidence level: ran — tests\n", line);
    const twice = upsertEstimateLine(once, "Plan estimate vs actual: plan 28-70 min; actual 50 min");
    expect(twice.match(/^Plan estimate vs actual:/gm)?.length).toBe(1);
    expect(twice).toContain("actual 50 min");
    expect(upsertEstimateLine(twice, "Plan estimate vs actual: plan 28-70 min; actual 50 min")).toBe(twice);
  });

  test("no line leaves the report as it was", async () => {
    expect(upsertEstimateLine("# Report\n", undefined)).toBe("# Report\n");
  });
});

test("estimateActualLine does not read the files", () => {
  expect(estimateActualLine({ replies: 0 })).toBe("Plan estimate vs actual: no recorded plan estimate; no raw replies recorded");
});

test("the line survives a round trip through a file", async () => {
  const dir = await pkg({ plan: { min: 28, max: 70, dispatches: 54 }, raws: spread(43, 67) });
  const file = path.join(dir, "report.md");
  await writeFile(file, "# Report\n\nEvidence level: ran — x\n");
  const next = upsertEstimateLine(await readFile(file, "utf8"), await packageEstimateLine(dir));
  expect(next).toContain("Plan estimate vs actual: plan 28-70 min (54 dispatches)");
});
