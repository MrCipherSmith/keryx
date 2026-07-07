import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatGuardWarning,
  guardOutput,
  isSecurityEnabled,
  redactRaw,
  securityFlowGate,
} from "./guard";
import type { SecurityMode } from "./types";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

// Create a temp workspace. `security` controls whether the module is enabled in
// metaproject.json; `mode` (when given) writes a security.config.json so the
// engine loads advisory/enforced/ci as requested.
async function makeWorkspace(opts: {
  security?: boolean;
  mode?: SecurityMode;
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-guard-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (opts.security !== undefined) {
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: opts.security } } }),
      "utf8",
    );
  }
  if (opts.mode) {
    await writeFile(
      path.join(root, ".metaproject", "security.config.json"),
      JSON.stringify({ mode: opts.mode }),
      "utf8",
    );
  }
  return root;
}

test("disabled module: guardOutput is a no-op allow with no findings", async () => {
  const root = await makeWorkspace({ security: false, mode: "enforced" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `token = ${AWS_KEY}`,
      target: "memory",
    });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings).toEqual([]);
    expect(result.reason).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no manifest at all: security is disabled and guardOutput is a no-op", async () => {
  const root = await makeWorkspace({});
  try {
    expect(await isSecurityEnabled(root)).toBe(false);
    const result = await guardOutput({ cwd: root, content: AWS_KEY, target: "wiki" });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("empty content short-circuits to allow even when enabled+enforced", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    const result = await guardOutput({ cwd: root, content: "", target: "memory" });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("advisory: allowed:true even with a planted secret (report-only)", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    expect(result.allowed).toBe(true);
    expect(result.decision.findings.length).toBeGreaterThan(0);
    expect(result.decision.findings.some((f) => f.category === "secret")).toBe(true);
    // A secret must never appear raw in the returned decision.
    expect(JSON.stringify(result.decision)).not.toContain(AWS_KEY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforced: allowed:false on a planted secret, with a leak-safe reason", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    expect(result.allowed).toBe(false);
    expect(result.decision.gate).toBe("fail");
    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain(AWS_KEY);
    expect(result.reason).toContain("secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ci mode also blocks a failing decision", async () => {
  const root = await makeWorkspace({ security: true, mode: "ci" });
  try {
    const result = await guardOutput({ cwd: root, content: AWS_KEY, target: "report" });
    expect(result.allowed).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatGuardWarning summarizes by category+count and never leaks raw content", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const result = await guardOutput({
      cwd: root,
      content: `aws_key = ${AWS_KEY}`,
      target: "memory",
    });
    const warning = formatGuardWarning(result.decision, "memory");
    expect(warning).toBeString();
    expect(warning).not.toContain(AWS_KEY);
    expect(warning).toContain("secret");
    expect(warning).toContain("[memory]");
    // No findings -> null.
    expect(formatGuardWarning({ gate: "pass", action: "allow", findings: [] })).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactRaw: disabled -> byte-identical, no findings", async () => {
  const root = await makeWorkspace({ security: false });
  try {
    const content = `token = ${AWS_KEY}\nplain line`;
    const out = await redactRaw({ cwd: root, content });
    expect(out.content).toBe(content);
    expect(out.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactRaw: no secret -> byte-identical", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const content = "just some normal log output\nnothing sensitive here\n";
    const out = await redactRaw({ cwd: root, content });
    expect(out.content).toBe(content);
    expect(out.findings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redactRaw: secret is masked and the raw value is gone", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const content = `aws_key = ${AWS_KEY}\ntrailing`;
    const out = await redactRaw({ cwd: root, content });
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.content).not.toContain(AWS_KEY);
    expect(out.content).toContain("trailing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("securityFlowGate: disabled -> null (gate omitted)", async () => {
  const root = await makeWorkspace({ security: false });
  try {
    expect(await securityFlowGate(root)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("securityFlowGate: advisory -> informational pass", async () => {
  const root = await makeWorkspace({ security: true, mode: "advisory" });
  try {
    const gate = await securityFlowGate(root);
    expect(gate?.status).toBe("pass");
    expect(gate?.detail).toContain("advisory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("securityFlowGate: enforced with a failing scan report -> fail", async () => {
  const root = await makeWorkspace({ security: true, mode: "enforced" });
  try {
    const artifactsDir = path.join(root, ".metaproject", "data", "security", "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      path.join(artifactsDir, "latest.json"),
      JSON.stringify({ gate: "fail", findings: [] }),
      "utf8",
    );
    const gate = await securityFlowGate(root);
    expect(gate?.status).toBe("fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
