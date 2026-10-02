// Flow 387, AC3: /model gives buttons for the current provider's models, at most 8 rows, paged
// beyond that. A press switches the model and the topic gets a one-line confirmation.

import { describe, expect, it } from "bun:test";
import { PICKER_PAGE_SIZE } from "./command-router";
import { commandHarness, waitFor } from "./command.test-helpers";

function models(count: number, currentIndex = 0) {
  return Array.from({ length: count }, (_, index) => ({ id: `m${index}`, label: `Model ${index}`, ...(index === currentIndex ? { current: true } : {}) }));
}

function withModels(count: number, extra: { switched?: Array<[string, string | undefined]>; output?: string; ok?: boolean } = {}) {
  const switched = extra.switched ?? [];
  return commandHarness({
    listModels: async (providerId) => ({ provider: providerId ?? "acme", models: models(count) }),
    switchModel: async (id, providerId) => {
      switched.push([id, providerId]);
      return { output: extra.output ?? `Model: ${id}`, ok: extra.ok ?? true };
    },
  });
}

describe("/model buttons (AC3)", () => {
  it("shows the current provider's models as buttons, one per row", async () => {
    const h = withModels(3);
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    const choice = h.client().choices[0];
    expect(choice?.rows).toEqual([["* Model 0"], ["Model 1"], ["Model 2"]]);
    expect(choice?.text).toContain("acme");
    expect(choice?.text).toContain("Now: Model 0");
    choice?.answer(undefined);
    await h.bridge.idle();
  });

  it("never shows more than 8 rows, and pages beyond that", async () => {
    const h = withModels(20);
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the first page");
    const first = h.client().choices[0];
    expect(first?.rows.length).toBeLessThanOrEqual(8);
    expect(first?.rows.length).toBe(PICKER_PAGE_SIZE + 1);
    expect(first?.rows.at(-1)).toEqual(["More"]);
    expect(first?.text).toContain("Page 1 of 3");
    first?.answer(PICKER_PAGE_SIZE); // More
    await waitFor(() => h.client().choices.length === 2, "the second page");
    const second = h.client().choices[1];
    expect(second?.rows.length).toBeLessThanOrEqual(8);
    expect(second?.rows[0]).toEqual([`Model ${PICKER_PAGE_SIZE}`]);
    expect(second?.rows.at(-1)).toEqual(["Previous", "More"]);
    second?.answer(PICKER_PAGE_SIZE); // Previous (first nav button)
    await waitFor(() => h.client().choices.length === 3, "the first page again");
    expect(h.client().choices[2]?.rows[0]).toEqual(["* Model 0"]);
    h.client().choices[2]?.answer(undefined);
    await h.bridge.idle();
  });

  it("switches to the model on the last page when it is pressed", async () => {
    const switched: Array<[string, string | undefined]> = [];
    const h = withModels(10, { switched });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the first page");
    h.client().choices[0]?.answer(PICKER_PAGE_SIZE); // More
    await waitFor(() => h.client().choices.length === 2, "the second page");
    h.client().choices[1]?.answer(1); // the second model on page two: m8
    await h.bridge.idle();
    expect(switched).toEqual([["m8", undefined]]);
  });

  it("switches the model on a press and confirms in one line", async () => {
    const switched: Array<[string, string | undefined]> = [];
    const h = withModels(4, { switched, output: "Model: Model 2" });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(2);
    await h.bridge.idle();
    expect(switched).toEqual([["m2", undefined]]);
    expect(h.client().replies).toEqual(["Model: Model 2"]);
    expect(h.client().replies[0]?.includes("\n")).toBe(false);
  });

  it("writes its own confirmation when the shell printed nothing", async () => {
    const h = withModels(3, { output: "" });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
    expect(h.client().replies).toEqual(["Model: Model 1."]);
  });

  it("changes nothing when nobody presses in time", async () => {
    const switched: Array<[string, string | undefined]> = [];
    const h = withModels(3, { switched });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(undefined);
    await h.bridge.idle();
    expect(switched).toEqual([]);
    expect(h.client().replies).toEqual([]);
  });

  it("says so when the shell reports the switch failed", async () => {
    const h = withModels(3, { output: "", ok: false });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
    expect(h.client().replies).toEqual(["The model was not changed."]);
  });

  it("tells the topic when there is nothing to pick from", async () => {
    const h = commandHarness({ listModels: async () => ({ provider: "acme", models: [] }), switchModel: async () => ({ output: "", ok: true }) });
    await h.bridge.enable();
    await h.say("/model");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.client().replies[0]).toContain("no models");
  });

  it("is not run when the shell is busy", async () => {
    const h = commandHarness({ busy: true, listModels: async () => ({ provider: "acme", models: models(2) }), switchModel: async () => ({ output: "", ok: true }) });
    await h.bridge.enable();
    await h.say("/model");
    await h.bridge.idle();
    expect(h.client().choices).toEqual([]);
    expect(h.client().replies[0]).toContain("/model was not run");
  });

  it("does not switch if the shell became busy while the picker was open", async () => {
    const switched: Array<[string, string | undefined]> = [];
    const h = withModels(3, { switched });
    await h.bridge.enable();
    await h.say("/model");
    await waitFor(() => h.client().choices.length === 1, "the picker");
    h.state.busy = true;
    h.client().choices[0]?.answer(1);
    await h.bridge.idle();
    expect(switched).toEqual([]);
    expect(h.client().replies[0]).toContain("/model was not run");
  });
});
