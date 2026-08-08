// AC4 (flow 142): the capability matrix in `keryx sandbox status` output and
// the matrix in docs/verification/linux-sandbox-verification.md must not be
// able to drift apart silently. capability-matrix.ts is the single source;
// this test is the enforcement — it parses the runbook's own Markdown table
// and asserts every row matches SANDBOX_CAPABILITY_MATRIX. A hand-edit to
// either side that stops agreeing with the other fails here.
//
// AC7 (keryx-linux-containment step 1) extends that to the THIRD state. No
// table cell ever holds `unavailable` — it is a fact about a host, not about
// the codebase — so it lives in the runbook's own "three capability states"
// section, and the second describe block below pins that section against
// `statusCellText`. A state added to the type and left undescribed for a
// reader following the runbook now fails a test.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CAPABILITY_STATUSES,
  SANDBOX_CAPABILITY_MATRIX,
  capabilityStatusFor,
  statusCellText,
  type CapabilityStatus,
  type SandboxCapabilityRow,
} from "./capability-matrix";

const DOC_PATH = path.join(import.meta.dir, "..", "..", "..", "..", "docs", "verification", "linux-sandbox-verification.md");

interface DocRow {
  label: string;
  linuxCell: string;
  macosCell: string;
}

/**
 * Parse the "## Scope on Linux" table. Deliberately narrow: only pipe-table
 * rows between that heading and the next `---` divider, header/separator rows
 * skipped, `**bold**` stripped so presentation does not count as content.
 */
function parseScopeTable(markdown: string): DocRow[] {
  const headingIndex = markdown.indexOf("## Scope on Linux");
  if (headingIndex === -1) {
    throw new Error("docs/verification/linux-sandbox-verification.md: '## Scope on Linux' heading not found");
  }
  const dividerIndex = markdown.indexOf("\n---", headingIndex);
  const section = dividerIndex === -1 ? markdown.slice(headingIndex) : markdown.slice(headingIndex, dividerIndex);

  const rows: DocRow[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim().replace(/\*\*/g, ""));
    if (cells.length !== 3) continue;
    const [label, linuxCell, macosCell] = cells as [string, string, string];
    if (label === "Capability") continue; // header row
    if (/^-+$/.test(label.replace(/[:\s]/g, ""))) continue; // separator row
    rows.push({ label, linuxCell, macosCell });
  }
  return rows;
}

/** Find the matrix row a doc row describes: by flag first (more specific), then by capability name. */
function matchingMatrixRow(docRow: DocRow): SandboxCapabilityRow | undefined {
  return SANDBOX_CAPABILITY_MATRIX.find((row) => {
    if (row.flag !== undefined) return docRow.label.includes(row.flag);
    return docRow.label.includes(row.capability);
  });
}

describe("sandbox capability matrix — doc sync (AC4)", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const docRows = parseScopeTable(markdown);

  test("the doc table has exactly the rows the matrix defines", () => {
    expect(docRows.length).toBe(SANDBOX_CAPABILITY_MATRIX.length);
  });

  test("every doc row matches a matrix row", () => {
    const unmatched = docRows.filter((docRow) => matchingMatrixRow(docRow) === undefined).map((r) => r.label);
    expect(unmatched).toEqual([]);
  });

  test("every matrix row's Linux status agrees with the doc", () => {
    for (const row of SANDBOX_CAPABILITY_MATRIX) {
      const docRow = docRows.find((r) => matchingMatrixRow(r) === row);
      expect(docRow).toBeDefined();
      expect(docRow!.linuxCell).toBe(statusCellText(capabilityStatusFor(row, "linux")));
    }
  });

  test("every matrix row's macOS status agrees with the doc", () => {
    for (const row of SANDBOX_CAPABILITY_MATRIX) {
      const docRow = docRows.find((r) => matchingMatrixRow(r) === row);
      expect(docRow).toBeDefined();
      expect(docRow!.macosCell).toBe(statusCellText(capabilityStatusFor(row, "darwin")));
    }
  });

  test("falsifiable: a row deliberately mismatched against the parsed doc is caught", () => {
    // Proves the equality assertions above are load-bearing, not vacuous: flip
    // one status and the same comparison must fail.
    const flipped: SandboxCapabilityRow = {
      capability: "Filesystem containment",
      linux: "not-implemented",
      darwin: "supported",
      linuxKernelFacility: "unprivileged-user-namespaces",
      coveredByProbe: true,
    };
    const docRow = docRows.find((r) => r.label.includes("Filesystem containment"));
    expect(docRow).toBeDefined();
    expect(docRow!.linuxCell).not.toBe(statusCellText(capabilityStatusFor(flipped, "linux")));
  });

  test("the scope table never claims the third state — it is a host fact, not a codebase fact", () => {
    // If `unavailable` ever appears in that table, someone has recorded a
    // measurement of one machine as a permanent property of the product. That
    // is the failure mode this whole package exists to remove.
    for (const row of SANDBOX_CAPABILITY_MATRIX) {
      expect(row.linux).not.toBe("unavailable");
      expect(row.darwin).not.toBe("unavailable");
    }
    for (const docRow of docRows) {
      expect(docRow.linuxCell).not.toBe(statusCellText("unavailable"));
      expect(docRow.macosCell).not.toBe(statusCellText("unavailable"));
    }
  });
});

/**
 * The runbook's prose for the three states, whitespace-collapsed so a Markdown
 * line wrap is not treated as a difference in wording, and `**bold**`/`*em*`
 * markers stripped so presentation is not content — the same rule the table
 * parser above follows.
 */
function parseStatesSection(markdown: string): string {
  const headingIndex = markdown.indexOf("## The three capability states");
  if (headingIndex === -1) {
    throw new Error(
      "docs/verification/linux-sandbox-verification.md: '## The three capability states' heading not found — " +
        "the third capability state must stay documented where a reader following the runbook will meet it",
    );
  }
  const dividerIndex = markdown.indexOf("\n---", headingIndex);
  const section = dividerIndex === -1 ? markdown.slice(headingIndex) : markdown.slice(headingIndex, dividerIndex);
  return section.replace(/\*+/g, "").replace(/\s+/g, " ");
}

describe("sandbox capability matrix — the third state is documented (AC7)", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const states = parseStatesSection(markdown);

  test("every CapabilityStatus the type defines has its cell text in the runbook", () => {
    // Iterates the exported values rather than a hand-written list, so a fourth
    // state cannot be added to the type and silently skipped here.
    const undocumented = CAPABILITY_STATUSES.filter((status) => !states.includes(statusCellText(status)));
    expect(undocumented).toEqual([]);
  });

  test("every CapabilityStatus is named by its identifier too, not only by its prose", () => {
    const unnamed = CAPABILITY_STATUSES.filter((status) => !states.includes(`\`${status}\``));
    expect(unnamed).toEqual([]);
  });

  test("the runbook says the third state is measured on a host, and names the kernel as the Linux reason", () => {
    // The two claims that make `unavailable` different from the other two, and
    // that a future edit could quietly drop while leaving the word in place.
    expect(states).toContain("trial contained command");
    expect(states).toContain("kernel release and the kernel facility");
  });

  test("R8: the runbook's states section never offers the machine-wide sysctl", () => {
    expect(states).not.toContain("apparmor_restrict_unprivileged_userns");
  });

  test("falsifiable: the same check run against a runbook missing the third state REPORTS it missing", () => {
    // The previous two tests here asserted that a string nobody produces is
    // absent from the runbook — true under every implementation, including a
    // totally broken one. A mutation run proved it: changing
    // `statusCellText("unavailable")` to a wrong string failed only the
    // positive test above, while both tests *named* "falsifiable" stayed green.
    //
    // So falsify the real thing instead: remove the third state's cell text
    // from the parsed section and assert the identical filter that returns `[]`
    // above now returns `["unavailable"]`.
    //
    // The doctoring is applied to the PARSED section rather than to the raw
    // markdown deliberately — the runbook wraps that phrase across two lines,
    // so the exact string exists only after whitespace collapsing, and a
    // `markdown.split(...)` here would silently remove nothing and pass for the
    // wrong reason. (It did, on the first attempt.)
    const doctored = states.split(statusCellText("unavailable")).join("REMOVED");
    const undocumented = CAPABILITY_STATUSES.filter((status) => !doctored.includes(statusCellText(status)));
    expect(undocumented).toEqual(["unavailable"]);
  });

  test("falsifiable: the parse produces real content, so `includes` is not passing on an empty haystack", () => {
    // Every assertion in this block is a substring test against `states`. A
    // parse that silently returned "" would make the negative ones vacuous and
    // the positive ones fail loudly — this pins the half that would go quiet.
    expect(states.length).toBeGreaterThan(200);
    expect(states).toContain("The three capability states");
  });

  test("falsifiable: a heading rename is caught rather than silently skipping the section", () => {
    expect(() => parseStatesSection(markdown.replace("## The three capability states", "## Renamed"))).toThrow(
      /three capability states/,
    );
  });
});

/** Compile-time exhaustiveness: CAPABILITY_STATUSES must list every member of the union. */
const _everyStatusListed: Record<CapabilityStatus, true> = {
  supported: true,
  "not-implemented": true,
  unavailable: true,
};
void _everyStatusListed;
