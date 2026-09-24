import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadProjectSandboxPolicy,
  PROJECT_SANDBOX_POLICY_REL,
  projectSandboxPolicyPath,
  projectSandboxPolicySkeleton,
  sanitizeProjectSandboxPolicy,
  writeProjectSandboxPolicySkeletonIfMissing,
} from "./project-sandbox-policy";
import { initCommand } from "../commands/init";
import { withCwd } from "./test-cwd";

function tempProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-proj-sbx-"));
  // Fake git root so resolveProjectRoot stops here.
  mkdirSync(path.join(root, ".git"));
  return root;
}

// AC-P2-1
test("missing policy file → empty object, no throw", () => {
  const root = tempProject();
  expect(loadProjectSandboxPolicy(root)).toEqual({});
  expect(existsSync(projectSandboxPolicyPath(root))).toBe(false);
});

// AC-P2-4
test("sanitize drops secret keys and invalid extraMasks", () => {
  const dirty = {
    maskMode: "auto",
    DEEPSEEK_API_KEY: "sk-nope",
    apiKey: "x",
    extraMasks: ["DEEPSEEK_API_KEY@api.deepseek.com", "NOHOST", "TOKEN=secret", "OK@host.com"],
    allowedDomains: ["api.deepseek.com", ""],
    tlsTerminate: true,
  };
  const clean = sanitizeProjectSandboxPolicy(dirty);
  expect(clean.maskMode).toBe("auto");
  expect(clean.tlsTerminate).toBe(true);
  expect(clean.extraMasks).toEqual(["DEEPSEEK_API_KEY@api.deepseek.com", "OK@host.com"]);
  expect(clean.allowedDomains).toEqual(["api.deepseek.com"]);
  expect(JSON.stringify(clean)).not.toContain("sk-nope");
  expect(JSON.stringify(clean)).not.toContain("apiKey");
});

test("load drops secrets already on disk", () => {
  const root = tempProject();
  const file = projectSandboxPolicyPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      maskMode: "off",
      OPENROUTER_API_KEY: "sk-leak",
      extraMasks: ["GH_TOKEN@api.github.com"],
    }),
  );
  const loaded = loadProjectSandboxPolicy(root);
  expect(loaded).toEqual({
    maskMode: "off",
    extraMasks: ["GH_TOKEN@api.github.com"],
  });
  expect(JSON.stringify(loaded)).not.toContain("sk-leak");
});

// AC-P2-5
test("skeleton has no secret values; write if missing only", async () => {
  const skeleton = projectSandboxPolicySkeleton();
  expect(skeleton).toContain("/connect");
  expect(skeleton).not.toMatch(/sk-[a-zA-Z0-9]/);
  expect(skeleton.toLowerCase()).not.toContain("api_key\":");

  const root = tempProject();
  expect(await writeProjectSandboxPolicySkeletonIfMissing(root)).toBe(true);
  expect(existsSync(projectSandboxPolicyPath(root))).toBe(true);
  const first = readFileSync(projectSandboxPolicyPath(root), "utf8");
  expect(await writeProjectSandboxPolicySkeletonIfMissing(root)).toBe(false);
  expect(readFileSync(projectSandboxPolicyPath(root), "utf8")).toBe(first);

  // Loadable after strip of _comment
  const loaded = loadProjectSandboxPolicy(root);
  expect(loaded.maskMode).toBe("manual");
});

// Flow 315 T11 (R5-F1-style follow-up): this writer used to be a raw
// `mkdirSync` + `writeFileSync` pair that followed an in-project symlink
// escaping the project — a symlinked `.keryx/` directory (or a symlinked
// `.keryx/sandbox-policy.json` file) took the skeleton write and landed it
// wherever the link pointed, outside the project. Routed through
// `writeContained` (see project-sandbox-policy.ts), the write is now
// refused instead of followed, and the wrapper's own `try/catch` turns that
// refusal into `false` ("did not write") rather than throwing — this proves
// BOTH the escaping-symlink refusal AND that the outside target is left
// untouched.
test("writeProjectSandboxPolicySkeletonIfMissing refuses a directory symlink that escapes the project", async () => {
  const root = tempProject();
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "keryx-sbx-escape-dir-"));
  try {
    symlinkSync(outsideRoot, path.join(root, ".keryx"));

    const wrote = await writeProjectSandboxPolicySkeletonIfMissing(root);

    expect(wrote).toBe(false);
    expect(existsSync(path.join(outsideRoot, "sandbox-policy.json"))).toBe(false);
    // The symlink itself, and everything outside it, is left exactly as it was.
    expect(existsSync(projectSandboxPolicyPath(root))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

// A DANGLING file symlink, not one pointing at an existing file: the old
// `existsSync(file)` "if missing" check follows symlinks and reports a
// dangling one as missing, so it did not even gate the raw write on this
// path — `writeFileSync` itself follows the (non-existent-target) symlink
// and creates the file at whatever it points to. A symlink to an EXISTING
// outside file is caught even pre-fix (existsSync sees it as present and
// skips the write), so it would not distinguish the two implementations;
// the dangling case does.
test("writeProjectSandboxPolicySkeletonIfMissing refuses a dangling file symlink that escapes the project", async () => {
  const root = tempProject();
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "keryx-sbx-escape-file-"));
  const outsideTarget = path.join(outsideRoot, "victim.json");
  try {
    mkdirSync(path.join(root, ".keryx"), { recursive: true });
    symlinkSync(outsideTarget, path.join(root, PROJECT_SANDBOX_POLICY_REL));

    const wrote = await writeProjectSandboxPolicySkeletonIfMissing(root);

    expect(wrote).toBe(false);
    expect(existsSync(outsideTarget)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("keryx init does not write the sandbox policy skeleton through an escaping symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-sbx-escape-"));
  const outsideRoot = mkdtempSync(path.join(tmpdir(), "keryx-init-sbx-escape-outside-"));
  try {
    symlinkSync(outsideRoot, path.join(root, ".keryx"));

    await withCwd(root, async () => {
      await initCommand([
        "--yes",
        "--no-gdgraph",
        "--no-gdctx",
        "--no-gdwiki",
        "--no-health",
        "--no-testing",
        "--no-memory",
        "--no-tasks",
        "--no-security",
      ]);
    });

    expect(existsSync(path.join(outsideRoot, "sandbox-policy.json"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
}, 120_000);

test("policy path is under project git root .keryx/", () => {
  const root = tempProject();
  const nested = path.join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  expect(projectSandboxPolicyPath(nested)).toBe(path.join(root, ".keryx", "sandbox-policy.json"));
});
