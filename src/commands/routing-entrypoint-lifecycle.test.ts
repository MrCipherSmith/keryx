import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";
import { metaprojectIndexContext } from "../ctx/orient";
import { withCwd } from "../lib/test-cwd";
import { initCommand } from "./init";
import { rulesCommand } from "./rules";
import { updateCommand } from "./update";

const MINIMAL_ROUTING_INIT_ARGS = [
  "--yes",
  "--no-gdgraph",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security-hook",
  "--no-security-agent-hook",
  "--no-mcp",
  "--no-sac",
];

type RoutingPair = {
  index: string;
  routing: string;
};

test("init and repeated rules sync preserve the short gate, full router, flags, and user content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-routing-sync-"));

  try {
    await writeFile(
      path.join(root, "AGENTS.md"),
      "# Agent Rules\n\n<!-- user-owned:begin -->\nKeep this project instruction.\n<!-- user-owned:end -->\n",
      "utf8",
    );

    await withCwd(root, async () => {
      await initCommand(MINIMAL_ROUTING_INIT_ARGS);
    });
    const initialized = await readRoutingPair(root);
    assertRoutingOwnership(initialized);

    await rulesCommand(["sync"], root);
    const firstSync = await readRoutingPair(root);
    await rulesCommand(["sync"], root);
    const secondSync = await readRoutingPair(root);

    assertRoutingOwnership(firstSync);
    assertRoutingOwnership(secondSync);
    expect(firstSync).toEqual(initialized);
    expect(secondSync).toEqual(firstSync);

    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(countOccurrences(agents, "<!-- user-owned:begin -->")).toBe(1);
    expect(countOccurrences(agents, "<!-- keryx:index -->")).toBe(1);
    expect(agents).toContain("Keep this project instruction.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distill and update repeats keep routing ownership and point orient and the router skill at the full document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-routing-distill-"));

  try {
    await writeFile(
      path.join(root, "AGENTS.md"),
      `# Agent Rules

## Communication

<!-- user-owned:begin -->
Keep summaries concise.
<!-- user-owned:end -->

## Pipeline Architecture

Keep domain services separate from command adapters and preserve module boundaries.

## Review Workflow

Use the review workflow, run focused tests, and inspect affected modules before delivery.
`,
      "utf8",
    );

    await withCwd(root, async () => {
      await initCommand(MINIMAL_ROUTING_INIT_ARGS);
    });
    await rulesCommand(["distill"], root);
    const firstDistill = await readRoutingPair(root);
    await rulesCommand(["distill"], root);
    const secondDistill = await readRoutingPair(root);

    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
    const updated = await readRoutingPair(root);
    const orientation = await metaprojectIndexContext(root);
    const routerSkill = BUNDLED_GDSKILLS.find((skill) => skill.name === "metaproject-router");

    assertRoutingOwnership(firstDistill);
    assertRoutingOwnership(secondDistill);
    assertRoutingOwnership(updated);
    expect(firstDistill.routing).toContain("| distilled-entrypoints | high |");
    expect(secondDistill).toEqual(firstDistill);
    expect(updated).toEqual(secondDistill);
    expect(orientation).toContain("routing.md");
    expect(routerSkill?.workflow).toContain(
      "Use the Intent Router in `.metaproject/routing.md` to map user intent to capability before reading broad source files.",
    );

    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
    expect(countOccurrences(agents, "<!-- user-owned:begin -->")).toBe(1);
    expect(agents).toContain("Keep summaries concise.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed routing pair publication is observable and succeeds on a clean rerun", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-routing-recovery-"));
  const metaprojectRoot = path.join(root, ".metaproject");
  const routingPath = path.join(metaprojectRoot, "routing.md");

  try {
    await mkdir(routingPath, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\nKeep user content.\n", "utf8");
    await writeFile(
      path.join(metaprojectRoot, "metaproject.json"),
      `${JSON.stringify({
        modules: {
          gdgraph: { enabled: false },
          gdctx: { enabled: true },
          gdwiki: { enabled: false },
          gdskills: { enabled: false },
          health: { enabled: false },
          testing: { enabled: false },
          memory: { enabled: false },
          tasks: { enabled: false },
          security: { enabled: true },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }, null, 2)}\n`,
      "utf8",
    );

    let publicationError: unknown;
    try {
      await rulesCommand(["sync"], root);
    } catch (error) {
      publicationError = error;
    }

    await rm(routingPath, { recursive: true, force: true });
    await rulesCommand(["sync"], root);
    const recovered = await readRoutingPair(root, { missingRouting: "" });

    expect(publicationError).toBeInstanceOf(Error);
    assertRoutingOwnership(recovered);
    expect(recovered.routing).toContain("| AGENTS.md | high |");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function readRoutingPair(
  projectRoot: string,
  options: { missingRouting?: string } = {},
): Promise<RoutingPair> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  const index = await readFile(path.join(metaprojectRoot, "index.md"), "utf8");
  const routing = await readFile(path.join(metaprojectRoot, "routing.md"), "utf8").catch((error: unknown) => {
    if (options.missingRouting !== undefined) {
      return options.missingRouting;
    }
    throw error;
  });
  return { index, routing };
}

function assertRoutingOwnership(pair: RoutingPair): void {
  expect(pair.index.length).toBeLessThan(2_000);
  expect(pair.index).toContain("routing.md");
  expect(pair.index).toContain("keryx ctx rg");
  expect(pair.index).toContain("keryx security check-output");
  expect(pair.index).not.toContain("## Enabled Modules");
  expect(pair.index).not.toContain("## Intent Router");

  expect(pair.routing).toContain("## Enabled Modules");
  expect(pair.routing).toContain("## Intent Router");
  expect(pair.routing).toContain("| gdctx |");
  expect(pair.routing).toContain("| security |");
  expect(pair.routing).not.toContain("| gdgraph |");
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
