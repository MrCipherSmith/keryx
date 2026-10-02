// Flow 390, AC8 — the TUI shows where a flow came from. The flow inspector and
// `/product` (the same lines `product open` prints) show the origin kind, quote
// and source; the shell command `/flow origin` shows the origin and sets it with
// `<kind> --reason ...`.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { buildIntentIndex } from "../product/corpus";
import { copyFixtureRepo } from "../product/fixtures/repo";
import { buildOpenReport, writeIntentIndex, type OpenLoad } from "../product/service";
import { formatFlowDetailLines, isFlowsCommand } from "./flow-inspector";
import { FLOW_ORIGIN_COMMAND, isFlowOriginCommand, runFlowOriginForShell, splitShellWords } from "./flow-origin-command";
import { loadInspectorFlows } from "./inspector-sources";
import { presentProductOpen } from "./product-open-surface";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const QUOTE = "каждый раз, когда создаётся flow, агент определяет откуда он";

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-origin-tui-"));
  dirs.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

function service() {
  return createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-10-02T10:00:00Z"),
  });
}

describe("the flow inspector", () => {
  test("shows the origin kind, quote and source, and origin: unknown for a flow without one", async () => {
    const root = await projectRoot();
    const flows = service();
    await flows.init({ cwd: root, title: "From a request", slug: "from-request", origin: "human-request", originQuote: QUOTE, originSource: "chat 7" });
    await flows.init({ cwd: root, title: "From a check", slug: "from-check", origin: "agent-finding", originSource: "lint run 12" });
    await flows.init({ cwd: root, title: "No origin", slug: "no-origin" });

    const items = await loadInspectorFlows(root);
    const byTitle = new Map(items.map((item) => [item.title, item]));
    const request = byTitle.get("From a request");
    const check = byTitle.get("From a check");
    const none = byTitle.get("No origin");
    if (request === undefined || check === undefined || none === undefined) throw new Error("a seeded flow did not load");

    const requestText = formatFlowDetailLines(request).join("\n");
    expect(requestText).toContain("origin: human-request");
    expect(requestText).toContain(`«${QUOTE}»`);
    expect(requestText).toContain("source: chat 7");

    const checkText = formatFlowDetailLines(check).join("\n");
    expect(checkText).toContain("origin: agent-finding");
    expect(checkText).toContain("source: lint run 12");

    expect(formatFlowDetailLines(none).join("\n")).toContain("origin: unknown");
  });

  test("an origin recorded with --reason after the fact shows up in the inspector", async () => {
    const root = await projectRoot();
    const flows = service();
    const created = await flows.init({ cwd: root, title: "Later", slug: "later" });
    await flows.originSet({ cwd: root, id: created.flow.id, kind: "agent-proposal", source: "design talk", reason: "agent's own idea" });
    const [item] = await loadInspectorFlows(root);
    if (item === undefined) throw new Error("the flow did not load");
    expect(formatFlowDetailLines(item).join("\n")).toContain("origin: agent-proposal");
  });
});

describe("/product", () => {
  test("paints the origin kind, quote and source of a flow, as `product open` prints them", async () => {
    const root = await copyFixtureRepo();
    dirs.push(root);
    const file = path.join(root, ".metaproject", "flows", "001-2026-01-01-stated-outcome", "flow.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    raw["origin"] = { kind: "human-request", quote: QUOTE, source: "chat 7" };
    await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    const index = await buildIntentIndex(root);
    await writeIntentIndex(root, index);
    const load: OpenLoad = { ok: true, report: buildOpenReport(index) };

    let painted = "";
    presentProductOpen(
      (_otui, _chrome, input) => {
        input.renderTab("open", {
          add: (child: { content: string }) => {
            painted = child.content;
          },
        });
        return { close: () => undefined, setTab: () => {}, activeTab: () => "open" };
      },
      {
        TextRenderable: class {
          content: string;
          constructor(_r: unknown, opts: { content: string }) {
            this.content = opts.content;
          }
        },
      },
      {},
      { load, visibleRows: 60, onKeypress: () => () => undefined },
    );
    expect(painted).toContain("origin: human-request");
    expect(painted).toContain(`«${QUOTE}»`);
    expect(painted).toContain("source: chat 7");
    expect(painted).toContain("origin: unknown");
  });
});

describe("/flow origin", () => {
  test("is its own command, not the /flows browser", () => {
    expect(FLOW_ORIGIN_COMMAND).toBe("/flow");
    expect(isFlowOriginCommand("/flow")).toBe(true);
    expect(isFlowOriginCommand("/flows")).toBe(false);
    expect(isFlowsCommand("/flow")).toBe(false);
  });

  test("splits quoted words and keeps spaces inside quotes", () => {
    expect(splitShellWords('/flow origin 390 human-request --reason "the operator said so" --quote \'a "b" c\'')).toEqual([
      "/flow",
      "origin",
      "390",
      "human-request",
      "--reason",
      "the operator said so",
      "--quote",
      'a "b" c',
    ]);
  });

  test("shows one flow's origin, and every flow's when no id is given", async () => {
    const root = await projectRoot();
    const flows = service();
    const a = await flows.init({ cwd: root, title: "A", slug: "a", origin: "human-request", originQuote: QUOTE, originSource: "chat 7" });
    await flows.init({ cwd: root, title: "B", slug: "b" });

    const one = await runFlowOriginForShell(root, `/flow origin ${a.flow.id}`, flows);
    expect(one).toContain("origin: human-request");
    expect(one).toContain(`«${QUOTE}»`);
    expect(one).toContain("source: chat 7");

    const all = await runFlowOriginForShell(root, "/flow origin", flows);
    expect(all).toContain("origin: human-request");
    expect(all).toContain("origin: unknown");
  });

  test("sets the origin with a reason and journals it", async () => {
    const root = await projectRoot();
    const flows = service();
    const created = await flows.init({ cwd: root, title: "Set me", slug: "set-me" });
    const out = await runFlowOriginForShell(
      root,
      `/flow origin ${created.flow.id} human-request --reason "operator confirmed" --quote "${QUOTE}" --source "chat 9"`,
      flows,
    );
    expect(out).toContain("origin unknown -> human-request");
    expect(out).toContain(`«${QUOTE}»`);
    const flow = JSON.parse(await readFile(path.join(root, created.dir, "flow.json"), "utf8")) as { origin?: unknown };
    expect(flow.origin).toEqual({ kind: "human-request", quote: QUOTE, source: "chat 9" });
    expect(await readFile(path.join(root, created.dir, "journal.md"), "utf8")).toContain("operator confirmed");
  });

  test("a set without --reason writes nothing and says what is needed", async () => {
    const root = await projectRoot();
    const flows = service();
    const created = await flows.init({ cwd: root, title: "No reason", slug: "no-reason" });
    const out = await runFlowOriginForShell(root, `/flow origin ${created.flow.id} agent-finding --source ci`, flows);
    expect(out).toContain("needs --reason");
    const flow = JSON.parse(await readFile(path.join(root, created.dir, "flow.json"), "utf8")) as { origin?: unknown };
    expect(flow.origin).toBeUndefined();
  });

  test("missing evidence is reported, not thrown, and nothing is written", async () => {
    const root = await projectRoot();
    const flows = service();
    const created = await flows.init({ cwd: root, title: "No evidence", slug: "no-evidence" });
    const out = await runFlowOriginForShell(root, `/flow origin ${created.flow.id} human-request --reason "try"`, flows);
    expect(out).toContain("needs a verbatim --quote");
    expect(out).toContain("Nothing written");
    expect(out).toContain("origin: unknown");
  });

  test("anything else than `origin` gets the usage line", async () => {
    const root = await projectRoot();
    expect(await runFlowOriginForShell(root, "/flow", service())).toStartWith("Usage: /flow origin");
  });
});
