import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncCommand } from "./sync";
import { readDeletionJournal } from "../forgetting/journal";
import { readSectionRegistryState } from "../wiki/section-tombstone";
import { withCwd } from "../lib/test-cwd";

// `keryx sync` is the FULL RECONCILE — what the post-merge / post-checkout
// hooks run. Measured on a scratch project before this stage existed: a wiki
// page, a memory entry and a graph node all described the same thing; the page
// and its source file were deleted; `keryx sync --apply` printed three module
// sections mentioning only `src/billing.ts`, said nothing whatsoever about the
// deleted page, and left `wiki sections resolve` answering `pending-tombstone`
// AFTER a full reconcile. Deletions under `.metaproject/` are filtered out by
// `codeOnly`, and nothing here had ever called `syncSectionRegistry`.

const PAGE = [
  '<!-- keryx:page id="architecture-billing-charges" v=1 -->',
  "# Billing Charges",
  "",
  "Version: 1.0.0",
  "Type: architecture",
  "Status: accepted",
  "",
  "## Summary",
  "",
  "How a placed order becomes a charge.",
  "",
  '<!-- keryx:section id="constraints" v=1 -->',
  "## Constraints",
  "",
  "A charge is issued once per order and never retried automatically.",
  "<!-- /keryx:section -->",
  "",
].join("\n");

const ENTRY = [
  "# Charge once per order",
  "",
  "Version: 1.0.0",
  "Type: decision",
  "Status: accepted",
  "Confidence: high",
  "",
  "## Summary",
  "",
  "We charge exactly once per order.",
  "",
  "## Details",
  "",
  "The rationale lives in [billing charges](../../wiki/architecture/billing-charges.md),",
  "section `keryx:page/architecture-billing-charges#constraints`.",
  "",
  "## Provenance",
  "",
  "- Created: 2026-09-01",
  "",
].join("\n");

const REGISTERED = `${JSON.stringify(
  {
    version: 2,
    entries: [
      {
        kind: "page",
        ref: "keryx:page/architecture-billing-charges",
        page: "architecture/billing-charges.md",
        title: "Billing Charges",
        digest: "0".repeat(64),
        registeredAt: "2026-09-01T00:00:00.000Z",
      },
      {
        kind: "section",
        ref: "keryx:page/architecture-billing-charges#constraints",
        page: "architecture/billing-charges.md",
        title: "Constraints",
        digest: "1".repeat(64),
        registeredAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    tombstones: [],
    lifted: [],
  },
  null,
  2,
)}\n`;

let logged: string[] = [];
const realLog = console.log;

beforeEach(() => {
  logged = [];
  console.log = (...parts: unknown[]) => {
    logged.push(parts.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
});

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }
}

/**
 * A committed project holding the knowledge in three layers, from which the
 * page has been deleted with `rm` and the registry still names it as live —
 * the interruption window a deletion actually leaves behind.
 */
async function deletedKnowledgeProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-sync-forget-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "fixture@example.invalid"]);
  await git(cwd, ["config", "user.name", "fixture"]);

  await mkdir(path.join(cwd, ".metaproject", "wiki", "architecture"), { recursive: true });
  await mkdir(path.join(cwd, ".metaproject", "memory", "decisions"), { recursive: true });
  await writeFile(path.join(cwd, ".metaproject", "memory", "decisions", "charge-once.md"), ENTRY, "utf8");
  await writeFile(path.join(cwd, ".metaproject", "wiki", ".sections.json"), REGISTERED, "utf8");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "orders.ts"), 'import "./billing";\n', "utf8");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "fixture"]);
  return cwd;
}

/** The same project with the page still present. */
async function livingKnowledgeProject(): Promise<string> {
  const cwd = await deletedKnowledgeProject();
  await writeFile(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"), PAGE, "utf8");
  return cwd;
}

describe("keryx sync reports the deletion it used to pass over (flow 242 lane E, AC1)", () => {
  test("the report names the removed identity and what the system now answers for it", async () => {
    const cwd = await deletedKnowledgeProject();
    try {
      await withCwd(cwd, () => syncCommand([]));
      const output = logged.join("\n");

      expect(output).toContain("## forgetting");
      expect(output).toContain("removed: keryx:page/architecture-billing-charges#constraints");
      // AC7: the confirmation is the OBSERVED RESPONSE, not a count of files.
      expect(output).toContain("looked up now, it resolves to");
      expect(output).toContain('not "never existed"');
      // Every layer, each with a cause — including the one not inspected.
      expect(output).toContain("· memory: NOT propagated");
      expect(output).toContain("· graph:");
      expect(output).toContain("not examined: sac-evidence");
      // The memory entry's dangling citation, named with the file and the line.
      expect(output).toContain("decisions/charge-once.md:15");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--apply writes the tombstone the full reconcile never used to write", async () => {
    const cwd = await deletedKnowledgeProject();
    try {
      // Before: the registry names both identities as LIVE, with no tombstone —
      // this is the state a full `keryx sync --apply` used to leave untouched.
      const before = await readSectionRegistryState(cwd);
      expect(before.state === "present" ? before.registry.tombstones.length : -1).toBe(0);

      await withCwd(cwd, () =>
        syncCommand(["--apply", "--reason", "superseded by ADR-14", "--actor", "aleks"]),
      );

      const after = await readSectionRegistryState(cwd);
      expect(after.state).toBe("present");
      const tombstones = after.state === "present" ? after.registry.tombstones : [];
      expect(tombstones.map((tombstone) => tombstone.ref).sort()).toEqual([
        "keryx:page/architecture-billing-charges",
        "keryx:page/architecture-billing-charges#constraints",
      ]);
      // `--reason` reaches the tombstone: `syncSectionRegistry` has always
      // accepted one and no CLI surface ever passed it, so every tombstone in
      // existence carried a machine-generated restatement of the observation.
      expect(tombstones[0]?.reason).toBe("superseded by ADR-14");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--apply leaves a trail carrying what, when, at whose request and on what basis", async () => {
    const cwd = await deletedKnowledgeProject();
    try {
      await withCwd(cwd, () =>
        syncCommand(["--apply", "--reason", "superseded by ADR-14", "--actor", "aleks"]),
      );

      const journal = await readDeletionJournal(cwd);
      expect(journal.state).toBe("present");
      const record = journal.state === "present" ? journal.records[0] : undefined;
      expect(record?.observedBy).toBe("keryx sync --apply");
      expect(record?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record?.removed.map((item) => item.ref)).toContain("keryx:page/architecture-billing-charges");
      expect(record?.requestedBy).toMatchObject({ value: "aleks", basis: "stated" });
      expect(record?.grounds).toMatchObject({ value: "superseded by ADR-14", basis: "stated" });
      // Every untouched layer carries its own cause, as AC1 requires.
      expect(record?.untouched.every((layer) => layer.cause.length > 0)).toBe(true);
      expect(record?.untouched.map((layer) => layer.layer)).toContain("memory");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("without --actor the requester is unknown, never the local git identity", async () => {
    const cwd = await deletedKnowledgeProject();
    const previous = process.env["KERYX_ACTOR"];
    delete process.env["KERYX_ACTOR"];
    try {
      // The fixture has a git identity configured (`fixture@example.invalid`),
      // so a "fill in whatever we can find" implementation would record it as
      // the requester and produce an audit line naming someone who never asked.
      await withCwd(cwd, () => syncCommand(["--apply"]));

      const journal = await readDeletionJournal(cwd);
      const record = journal.state === "present" ? journal.records[0] : undefined;
      expect(record?.requestedBy.basis).toBe("derived");
      expect(record?.requestedBy.value).toBe("fixture@example.invalid");
      expect(record?.requestedBy.detail).toContain("who RAN the command");
      // …and the machine-generated basis is marked as derived, so nothing reads
      // it as a reason a human gave.
      expect(record?.grounds.basis).toBe("derived");
    } finally {
      if (previous !== undefined) {
        process.env["KERYX_ACTOR"] = previous;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("the trail survives the call that deletes the knowledge", async () => {
    const cwd = await deletedKnowledgeProject();
    try {
      await withCwd(cwd, () => syncCommand(["--apply", "--actor", "aleks"]));
      // The registry — where the only previous record of a removal lived, in the
      // same file as the live entries — is destroyed outright.
      await rm(path.join(cwd, ".metaproject", "wiki"), { recursive: true, force: true });

      const journal = await readDeletionJournal(cwd);
      expect(journal.state).toBe("present");
      expect(journal.state === "present" ? journal.records.length : 0).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("control: with the knowledge present, nothing is reported as removed", async () => {
    // The negative control for the whole stage. Without it, every assertion
    // above could be satisfied by a stage that always prints a removal.
    const cwd = await livingKnowledgeProject();
    try {
      await withCwd(cwd, () => syncCommand([]));
      const output = logged.join("\n");
      expect(output).toContain("## forgetting");
      expect(output).not.toContain("looked up now, it resolves to");
      expect(output).not.toContain("· memory: NOT propagated\n      NOT PROPAGATED");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("unresolved references this run cannot attribute are counted, not hidden", async () => {
    // `src/orders.ts` imports `./billing`, which is not in this fixture and was
    // not deleted in any window this run can see. It is neither a reference into
    // removed knowledge (claiming that would be a fabrication) nor nothing
    // (dropping it would be the silence). The short "nothing to report" line
    // must not swallow it.
    const cwd = await livingKnowledgeProject();
    try {
      const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
      await mkdir(storage, { recursive: true });
      await writeFile(
        path.join(storage, "nodes.jsonl"),
        `${JSON.stringify({ id: "src/orders.ts", kind: "file", path: "src/orders.ts", language: "typescript" })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(storage, "edges.jsonl"),
        `${JSON.stringify({
          id: "edge:1",
          from: "src/orders.ts",
          to: "./billing",
          kind: "unresolved",
          specifier: "./billing",
        })}\n`,
        "utf8",
      );

      await withCwd(cwd, () => syncCommand([]));
      const output = logged.join("\n");
      expect(output).toContain("unclassified");
      expect(output).not.toContain("no removed knowledge on record, and no layer holds a reference");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("the deletion window is the state sync FOUND (flow 242 lane E, AC1)", () => {
  test("an import of a just-deleted file is attributed to the deletion, not left unclassified", async () => {
    // The ordering bug this pins, found by running the real command on a real
    // fixture: `applyModule` advances gdgraph's provenance to HEAD, so a
    // deletion window computed AFTER the module loop is always empty. With it
    // empty, `src/orders.ts → ./billing` came back as one of the unattributable
    // "resolves to nothing for some other reason" count — for a file that had
    // demonstrably just been deleted, in the same command run that deleted the
    // graph node for it.
    const cwd = await mkdtemp(path.join(tmpdir(), "keryx-sync-window-"));
    try {
      await git(cwd, ["init", "-q"]);
      await git(cwd, ["config", "user.email", "fixture@example.invalid"]);
      await git(cwd, ["config", "user.name", "fixture"]);
      await mkdir(path.join(cwd, "src"), { recursive: true });
      await writeFile(path.join(cwd, "src", "orders.ts"), 'import "./billing";\n', "utf8");
      await writeFile(path.join(cwd, "src", "billing.ts"), "export const charge = 1;\n", "utf8");
      await git(cwd, ["add", "-A"]);
      await git(cwd, ["commit", "-q", "-m", "before"]);

      const head = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" });
      const before = (await new Response(head.stdout).text()).trim();
      await mkdir(path.join(cwd, ".metaproject", "data", "gdgraph"), { recursive: true });
      await writeFile(
        path.join(cwd, ".metaproject", "data", "gdgraph", ".provenance.json"),
        `${JSON.stringify({ commit: before, branch: "main", builtAt: "2026-09-01T00:00:00.000Z" })}\n`,
        "utf8",
      );

      await rm(path.join(cwd, "src", "billing.ts"));
      await git(cwd, ["add", "-A"]);
      await git(cwd, ["commit", "-q", "-m", "delete billing"]);

      await withCwd(cwd, () => syncCommand(["--apply"]));
      const output = logged.join("\n");

      expect(output).toContain("src/orders.ts → ./billing [unresolved-import]");
      expect(output).toContain("names a file deleted in this window");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("one object, three layers, one reconcile (flow 242 lane E, AC1)", () => {
  /**
   * AC1 is explicit that it is "измеряется на объекте, реально присутствующем
   * минимум в трёх слоях" — measured on an object genuinely present in at
   * least three layers. Every other test in this file exercises one or two.
   * This one puts the SAME knowledge in three at once and deletes it:
   *
   *   wiki    `architecture/billing-charges.md`, registered as a page identity
   *           and a section identity in `.sections.json`.
   *   memory  `decisions/charge-once.md`, which links the page and cites the
   *           section ref in its prose.
   *   graph   `src/billing.ts`, imported by `src/orders.ts`, with the graph
   *           built from the commit before the deletion.
   *
   * Then the page and the source file are both removed with `rm` — which is
   * how knowledge is deleted in this codebase, there being no delete command
   * for it anywhere — and the reconcile has to account for all three, plus the
   * fourth it does not inspect.
   */
  async function threeLayerProject(): Promise<string> {
    const cwd = await mkdtemp(path.join(tmpdir(), "keryx-sync-three-"));
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["config", "user.email", "fixture@example.invalid"]);
    await git(cwd, ["config", "user.name", "fixture"]);

    await mkdir(path.join(cwd, ".metaproject", "wiki", "architecture"), { recursive: true });
    await mkdir(path.join(cwd, ".metaproject", "memory", "decisions"), { recursive: true });
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"), PAGE, "utf8");
    await writeFile(path.join(cwd, ".metaproject", "wiki", ".sections.json"), REGISTERED, "utf8");
    await writeFile(path.join(cwd, ".metaproject", "memory", "decisions", "charge-once.md"), ENTRY, "utf8");
    await writeFile(path.join(cwd, "src", "orders.ts"), 'import "./billing";\n', "utf8");
    await writeFile(path.join(cwd, "src", "billing.ts"), "export const charge = 1;\n", "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "all three layers"]);

    // The graph, as `keryx gdgraph build` left it at that commit — and its
    // provenance, which is the window every later deletion is judged against.
    const head = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe" });
    const commit = (await new Response(head.stdout).text()).trim();
    const storage = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
    await mkdir(storage, { recursive: true });
    await writeFile(
      path.join(storage, "nodes.jsonl"),
      `${JSON.stringify({ id: "src/orders.ts", kind: "file", path: "src/orders.ts", language: "typescript" })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(storage, "edges.jsonl"),
      `${JSON.stringify({
        id: "edge:1",
        from: "src/orders.ts",
        to: "./billing",
        kind: "unresolved",
        specifier: "./billing",
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(cwd, ".metaproject", "data", "gdgraph", ".provenance.json"),
      `${JSON.stringify({ commit, branch: "main", builtAt: "2026-09-01T00:00:00.000Z" })}\n`,
      "utf8",
    );

    // The deletion itself: `rm`, in both layers, committed.
    await rm(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"));
    await rm(path.join(cwd, "src", "billing.ts"));
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "delete billing"]);
    return cwd;
  }

  test("every layer is accounted for, each with a cause, and none is silently dangling", async () => {
    const cwd = await threeLayerProject();
    try {
      await withCwd(cwd, () => syncCommand([]));
      const output = logged.join("\n");

      // Not `clean`: three layers hold a reference into knowledge that is gone.
      expect(output).toContain("status: dangling");

      // LAYER 1 — the identity. AC7's requirement: the confirmation is what the
      // system ANSWERS when the removed identity is looked up, not a count.
      expect(output).toContain("removed: keryx:page/architecture-billing-charges#constraints");
      expect(output).toContain("looked up now, it resolves to");

      // LAYER 2 — memory. The citation is named with its file and line, and the
      // layer says it was deliberately not propagated into.
      expect(output).toContain("· memory: NOT propagated");
      expect(output).toContain("decisions/charge-once.md:15");

      // LAYER 3 — the graph. The import of the deleted file is attributed to
      // THIS deletion window, not left in the unclassified count.
      expect(output).toContain("src/orders.ts → ./billing [unresolved-import]");
      expect(output).toContain("names a file deleted in this window");

      // LAYER 4 — named, not omitted. AC1 requires a cause for every layer left
      // untouched, and a layer missing from the report reads exactly like a
      // layer that was checked and found clean.
      expect(output).toContain("· sac-evidence: NOT propagated [not-examined]");
      expect(output).toContain("not examined: sac-evidence");
      expect(output).toContain('"not checked" must not read as "checked and clean"');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("control: with all three layers intact, no layer is reported as dangling", async () => {
    // The negative control for the three-layer measurement. Without it, the
    // test above passes against a stage that reports every layer as dangling
    // always — which would be a report nobody can act on rather than evidence.
    const cwd = await threeLayerProject();
    try {
      // Put both deleted things back, exactly where they were.
      await writeFile(path.join(cwd, ".metaproject", "wiki", "architecture", "billing-charges.md"), PAGE, "utf8");
      await writeFile(path.join(cwd, "src", "billing.ts"), "export const charge = 1;\n", "utf8");
      await git(cwd, ["add", "-A"]);
      await git(cwd, ["commit", "-q", "-m", "restore"]);
      // …and the graph edge resolves again, so nothing dangles in that layer.
      await writeFile(
        path.join(cwd, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl"),
        `${JSON.stringify({
          id: "edge:1",
          from: "src/orders.ts",
          to: "src/billing.ts",
          kind: "import",
          specifier: "./billing",
        })}\n`,
        "utf8",
      );

      await withCwd(cwd, () => syncCommand([]));
      const output = logged.join("\n");

      expect(output).not.toContain("status: dangling");
      expect(output).not.toContain("[unresolved-import]");
      expect(output).not.toContain("looked up now, it resolves to");
      // The fourth layer is still named, deletion or no deletion.
      expect(output).toContain("not examined: sac-evidence");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("a refusal is a named outcome, not a silent success (flow 242 lane E, AC3/AC6)", () => {
  test("an unreadable registry refuses the write, says so, and records the refusal", async () => {
    const cwd = await deletedKnowledgeProject();
    const registry = path.join(cwd, ".metaproject", "wiki", ".sections.json");
    try {
      // A genuinely unreadable store, not a substituted error.
      await chmod(registry, 0o000);

      await withCwd(cwd, () => syncCommand(["--apply", "--actor", "aleks"]));
      const output = logged.join("\n");

      expect(output).toContain("the identity layer REFUSED to record the removal");
      expect(output).toContain("status: undecidable");

      const journal = await readDeletionJournal(cwd);
      const record = journal.state === "present" ? journal.records[0] : undefined;
      // The refusal is in the trail. Recording `propagated` here would be the
      // exact defect: a write that did not happen, filed as one that did.
      expect(record?.outcome).toBe("refused");
      expect(record?.refusals.length).toBeGreaterThan(0);
    } finally {
      await chmod(registry, 0o600).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
