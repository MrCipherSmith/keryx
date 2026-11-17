import { expect, test } from "bun:test";
import { renderSkippedInstallFiles } from "./skills";

// R3-1 / review F5: a rule-layer file `keryx init`/`update` publish gets the
// `keryx update` advice; everything else keeps the `--force` advice.

test("keryx-published skips and other skips are printed in their own groups with their own advice", () => {
  const lines = renderSkippedInstallFiles([
    { path: ".metaproject/rules/process/git-rules.mdc", reason: "ignored for this group", keryxPublished: true },
    { path: ".claude/rules/house.mdc", reason: "a file already exists at this destination and is not recorded in install-state" },
  ]);
  expect(lines).toEqual([
    "Skipped (keryx init/update publish these and they hold another keryx version — run keryx update first, then re-run):",
    "- .metaproject/rules/process/git-rules.mdc",
    "Skipped (existing file not recorded in install-state, or drifted — rerun with --force to overwrite):",
    "- .claude/rules/house.mdc: a file already exists at this destination and is not recorded in install-state",
  ]);
});

test("no keryx-published skip means no keryx update advice, and nothing skipped prints nothing", () => {
  const lines = renderSkippedInstallFiles([{ path: ".claude/rules/a.mdc", reason: "drift" }]);
  expect(lines.join("\n")).not.toContain("keryx update");
  expect(lines[0]).toContain("--force");
  expect(renderSkippedInstallFiles([])).toEqual([]);
});
