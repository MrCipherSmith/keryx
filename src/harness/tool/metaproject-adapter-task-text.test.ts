import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { createMetaprojectAdapter } from "./metaproject-adapter";

// Flow 462: the native adapter must pass the task text to the resolver, or a keyword never promotes a reference.
test("skillsResolveContext passes taskText to the resolver: a keyword promotes the declared document, no text does not", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-adapter-task-text-"));
  try {
    await mkdir(path.join(root, ".metaproject", "rules", "project"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{}\n", "utf8");
    await writeFile(path.join(root, "THEMING.md"), "# Theming\n\n## Tokens\n\nColour roles come from semantic tokens only.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "rules", "project", "references.json"),
      JSON.stringify({
        schema: 1,
        references: [{ path: "THEMING.md", when: { keywords: ["dark mode"] }, anchor: "Tokens", description: "Theme tokens and dark mode, read before touching a colour." }],
      }),
      "utf8",
    );
    const adapter = createMetaprojectAdapter(root);
    const withText = await adapter.skillsResolveContext?.({ files: ["src/a.ts"], for: "implement", taskText: "Add a dark mode switch" });
    expect(withText?.entries.find((entry) => entry.path === "THEMING.md")).toMatchObject({ tier: "must_read", reason: "condition:keyword:dark mode" });
    const without = await adapter.skillsResolveContext?.({ files: ["src/a.ts"], for: "implement" });
    expect(without?.entries.find((entry) => entry.path === "THEMING.md")).toMatchObject({ tier: "on_demand" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
