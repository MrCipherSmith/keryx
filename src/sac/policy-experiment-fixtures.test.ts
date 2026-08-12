import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { generateSacPolicyExperimentFixtures } from "../../scripts/generate-sac-policy-experiment-fixtures";
import {
  hashPolicySandboxExecutionReceipt,
  hashPolicySandboxObservation,
  verifyPolicyCorpus,
  type PolicyCorpus,
  type PolicyEvaluationReport,
  type PolicySandboxExecutionReceiptBody,
} from "./policy-experiment";

type ArtifactManifest = Readonly<{
  schemaVersion: "1.0";
  artifacts: Readonly<Record<string, Readonly<{ ref: string; sha256: string }>>>;
}>;

test("published policy experiment artifacts are pinned to their exact committed bytes", async () => {
  const repositoryRoot = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readFile(
    new URL("fixtures/sac-policy-experiment/artifact-manifest.json", repositoryRoot),
    "utf8",
  )) as ArtifactManifest;

  expect(manifest.schemaVersion).toBe("1.0");
  expect(Object.keys(manifest.artifacts).sort()).toEqual([
    "allowedControl", "baseline", "candidate", "deniedEscapeControl", "executionReceipts",
  ]);
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    expect(artifact.ref.startsWith("./fixtures/sac-policy-experiment/"), name).toBe(true);
    const bytes = await readFile(new URL(artifact.ref.slice(2), repositoryRoot));
    expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(artifact.sha256);
  }

  const corpus = JSON.parse(await readFile(
    new URL("fixtures/sac-policy-experiment/corpus.json", repositoryRoot), "utf8",
  )) as PolicyCorpus;
  const report = JSON.parse(await readFile(
    new URL("fixtures/sac-policy-experiment/evaluation-report.json", repositoryRoot), "utf8",
  )) as PolicyEvaluationReport;
  expect(verifyPolicyCorpus(corpus)).toBe(true);
  expect(report.corpusDigest).toBe(corpus.manifest.corpusDigest);
  expect(report.baselineDigest).toBe(manifest.artifacts.baseline!.sha256);
  expect(report.candidateDigest).toBe(manifest.artifacts.candidate!.sha256);
  const { reportDigest, ...reportBody } = report;
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]))
      : value;
  expect(createHash("sha256").update(JSON.stringify(stable(reportBody))).digest("hex")).toBe(reportDigest);

  const executionReceipts = JSON.parse(await readFile(
    new URL("fixtures/sac-policy-experiment/sandbox/execution-receipts.json", repositoryRoot), "utf8",
  )) as Array<Record<string, unknown>>;
  expect(executionReceipts).toHaveLength(corpus.rows.length * 2);
  for (const receipt of executionReceipts) {
    expect(receipt.authenticated).toBe(true);
    expect(receipt.candidateDigest).toBe(report.candidateDigest);
    expect(receipt.profileDigest).toBe(report.sandboxProfileDigest);
    const { authenticated: _authenticated, artifactContent, integrity, ...body } = receipt as Record<string, unknown> & {
      artifactContent: string;
      integrity: { recordHash: string };
    };
    expect(createHash("sha256").update(artifactContent).digest("hex")).toBe(body.artifactHash as string);
    expect(hashPolicySandboxObservation(body.observation as never)).toBe(body.observationDigest as string);
    expect(hashPolicySandboxExecutionReceipt(body as PolicySandboxExecutionReceiptBody)).toBe(integrity.recordHash);
  }

  const regenerated = await generateSacPolicyExperimentFixtures();
  for (const [relative, expected] of Object.entries(regenerated)) {
    expect(await readFile(new URL(`fixtures/sac-policy-experiment/${relative}`, repositoryRoot), "utf8"), relative).toBe(expected);
  }
});
