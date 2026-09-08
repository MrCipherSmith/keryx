import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendDeletionRecord,
  deletionJournalPath,
  readDeletionJournal,
  resolveGrounds,
  resolveRequestedBy,
} from "./journal";
import { discoverTargets } from "../retention/policy";
import { defaultFsDeps } from "../retention/fs-deps";

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-forget-journal-"));
}

const RECORD = {
  at: "2026-09-08T12:00:00.000Z",
  observedBy: "keryx sync --apply",
  outcome: "propagated" as const,
  removed: [
    { layer: "wiki-identity", ref: "keryx:page/billing", page: "architecture/billing.md", title: "Billing" },
  ],
  untouched: [{ layer: "memory", cause: "authored content is never deleted by a wiki removal" }],
  requestedBy: { value: "aleks", basis: "stated" as const, detail: "named on the command line (`--actor`)" },
  grounds: { value: "superseded by ADR-14", basis: "stated" as const, detail: "given with the deletion" },
  danglingAfter: 2,
  refusals: [],
};

describe("attribution: derived is never recorded as stated (flow 242 lane E, AC6)", () => {
  test("a git identity is DERIVED — it says who ran the command, not who asked", () => {
    const attribution = resolveRequestedBy({ gitIdentity: "someone@example.invalid" });
    // The guard. Reverting `resolveRequestedBy` to return `basis: "stated"` for
    // the git branch — the natural shortcut, since a value IS present — turns
    // every autonomous deletion into an audit record naming whoever happened to
    // own the checkout as the requester. This line goes red on that change.
    expect(attribution.basis).toBe("derived");
    expect(attribution.value).toBe("someone@example.invalid");
    expect(attribution.detail).toContain("who RAN the command");
  });

  test("with nobody stated and no git identity, the requester is unknown and NULL", () => {
    const attribution = resolveRequestedBy({});
    expect(attribution.basis).toBe("unknown");
    // Not "" and not a placeholder name: an invented requester is a fabricated
    // audit record, which is worse than an absent one.
    expect(attribution.value).toBeNull();
  });

  test("control: an explicitly named actor IS stated", () => {
    expect(resolveRequestedBy({ stated: "aleks" }).basis).toBe("stated");
    expect(resolveRequestedBy({ env: "ci-bot" }).basis).toBe("stated");
    // …and precedence is stated over derived, never the reverse.
    expect(resolveRequestedBy({ stated: "aleks", gitIdentity: "other@x" }).value).toBe("aleks");
  });

  test("a machine-generated reason is DERIVED, and says it is not a justification", () => {
    const grounds = resolveGrounds({ observed: "2 identities are no longer carried by the wiki" });
    expect(grounds.basis).toBe("derived");
    expect(grounds.detail).toContain("not a reason the change was wanted");
    expect(resolveGrounds({ stated: "superseded by ADR-14" }).basis).toBe("stated");
    expect(resolveGrounds({}).basis).toBe("unknown");
  });
});

describe("the trail is append-only (flow 242 lane E, AC6)", () => {
  test("a second record never rewrites the first", async () => {
    const cwd = await scratch();
    try {
      await appendDeletionRecord(cwd, RECORD);
      const afterFirst = await readFile(deletionJournalPath(cwd), "utf8");

      await appendDeletionRecord(cwd, { ...RECORD, at: "2026-09-08T13:00:00.000Z" });
      const afterSecond = await readFile(deletionJournalPath(cwd), "utf8");

      // Byte-prefix equality, not "the first record is still findable": an
      // append cannot shorten or alter a history, which is the property
      // `writeSectionRegistry` structurally cannot have, since it must rewrite
      // the whole live entry set on every call.
      expect(afterSecond.startsWith(afterFirst)).toBe(true);
      const read = await readDeletionJournal(cwd);
      expect(read.state).toBe("present");
      expect(read.state === "present" ? read.records.length : 0).toBe(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("a damaged line makes the read unreadable, not a shorter history", async () => {
    const cwd = await scratch();
    try {
      await appendDeletionRecord(cwd, RECORD);
      await writeFile(deletionJournalPath(cwd), "{not json\n", { flag: "a" });

      const read = await readDeletionJournal(cwd);
      expect(read.state).toBe("unreadable");
      expect(read.state === "unreadable" ? read.reason : "").toContain("not reported as the whole history");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("absent and unreadable are different answers", async () => {
    const cwd = await scratch();
    try {
      expect((await readDeletionJournal(cwd)).state).toBe("absent");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("the trail outlives the knowledge (flow 242 lane E, AC6)", () => {
  test("deleting the whole wiki and memory trees leaves the journal intact", async () => {
    const cwd = await scratch();
    try {
      await mkdir(path.join(cwd, ".metaproject", "wiki", "architecture"), { recursive: true });
      await mkdir(path.join(cwd, ".metaproject", "memory", "decisions"), { recursive: true });
      await writeFile(path.join(cwd, ".metaproject", "wiki", "architecture", "billing.md"), "# Billing\n");
      await writeFile(path.join(cwd, ".metaproject", "wiki", ".sections.json"), "{}\n");
      await appendDeletionRecord(cwd, RECORD);

      // The call that removes the knowledge, in every layer that holds it.
      await rm(path.join(cwd, ".metaproject", "wiki"), { recursive: true, force: true });
      await rm(path.join(cwd, ".metaproject", "memory"), { recursive: true, force: true });

      const read = await readDeletionJournal(cwd);
      expect(read.state).toBe("present");
      expect(read.state === "present" ? read.records[0]?.removed[0]?.ref : null).toBe("keryx:page/billing");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("the journal is not inside any retention target", async () => {
    // `keryx retention sweep` — and the auto-sweep now on the gdctx write path
    // — evict by age and byte volume. A trail swept away at 14 days is not a
    // trail. This pins the separation against a future target being added over
    // `.metaproject/data/` wholesale: it reads the REAL target list rather than
    // asserting a hardcoded one.
    const cwd = await scratch();
    try {
      const journal = deletionJournalPath(cwd);
      const { targets } = await discoverTargets(cwd, defaultFsDeps);
      expect(targets.length).toBeGreaterThan(0); // the check would be vacuous otherwise
      for (const target of targets) {
        const relative = path.relative(target.dir, journal);
        expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("a failed append is a named failure (flow 242 lane E, AC6)", () => {
  test("an unwritable journal directory reports failed, and says the removal is NOT recorded", async () => {
    const cwd = await scratch();
    try {
      // A real obstruction, not a stubbed error: a plain FILE where the journal
      // directory has to be, so `mkdir` genuinely cannot create it.
      await mkdir(path.join(cwd, ".metaproject", "data"), { recursive: true });
      await writeFile(path.join(cwd, ".metaproject", "data", "forgetting"), "not a directory\n");

      const append = await appendDeletionRecord(cwd, RECORD);
      expect(append.status).toBe("failed");
      expect(append.status === "failed" ? append.reason : "").toContain("must not be reported as recorded");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
