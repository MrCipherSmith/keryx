import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadProjectSandboxPolicy,
  projectSandboxPolicyPath,
  projectSandboxPolicySkeleton,
  sanitizeProjectSandboxPolicy,
  writeProjectSandboxPolicySkeletonIfMissing,
} from "./project-sandbox-policy";

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
test("skeleton has no secret values; write if missing only", () => {
  const skeleton = projectSandboxPolicySkeleton();
  expect(skeleton).toContain("/connect");
  expect(skeleton).not.toMatch(/sk-[a-zA-Z0-9]/);
  expect(skeleton.toLowerCase()).not.toContain("api_key\":");

  const root = tempProject();
  expect(writeProjectSandboxPolicySkeletonIfMissing(root)).toBe(true);
  expect(existsSync(projectSandboxPolicyPath(root))).toBe(true);
  const first = readFileSync(projectSandboxPolicyPath(root), "utf8");
  expect(writeProjectSandboxPolicySkeletonIfMissing(root)).toBe(false);
  expect(readFileSync(projectSandboxPolicyPath(root), "utf8")).toBe(first);

  // Loadable after strip of _comment
  const loaded = loadProjectSandboxPolicy(root);
  expect(loaded.maskMode).toBe("manual");
});

test("policy path is under project git root .keryx/", () => {
  const root = tempProject();
  const nested = path.join(root, "packages", "app");
  mkdirSync(nested, { recursive: true });
  expect(projectSandboxPolicyPath(nested)).toBe(path.join(root, ".keryx", "sandbox-policy.json"));
});
