import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  makeNerSpec,
  piiNerSpec,
  nerMatchesFrom,
  PII_NER_ID,
  type NerEntity,
} from "./ner-adapter";
import { runDetectors, runDetectorsAsync } from "../index";
import { mergeSecurityConfig } from "../../config";
import { resetWarnOnce, hasWarned } from "../../../capability/warn-once";
import type { SecurityConfig } from "../../types";

let root: string;

beforeEach(async () => {
  resetWarnOnce();
  root = await mkdtemp(path.join(tmpdir(), "gd-metapro-nermodel-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeManifest(enabled: boolean): Promise<void> {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      schemaVersion: 1,
      modules: {
        security: {
          enabled: true,
          capabilities: [{ id: PII_NER_ID, enabled, kind: "ceiling" }],
        },
      },
    }),
    "utf8",
  );
}

// A deterministic recognizer: flags the token "Ada Lovelace" as a PERSON.
function seededRecognizer(text: string): NerEntity[] {
  const idx = text.indexOf("Ada Lovelace");
  if (idx < 0) return [];
  return [{ start: idx, end: idx + "Ada Lovelace".length, value: "Ada Lovelace", label: "PERSON" }];
}

function nerEnabledConfig(): SecurityConfig {
  const config = mergeSecurityConfig({});
  config.backends.piiModel.enabled = true;
  return config;
}

// AC4.3 — availability-true: NER category:"pii" findings merge with deterministic PII.
test("AC4.3: NER backend available ⇒ merges person findings as category pii", async () => {
  await writeManifest(true);
  const spec = makeNerSpec({ recognizer: seededRecognizer });
  const content = "The lead engineer Ada Lovelace reviewed the design.";
  const merged = await runDetectorsAsync(root, content, nerEnabledConfig(), {
    piiNer: spec,
  });
  const ner = merged.find((m) => m.policyId === "pii.ner");
  expect(ner).toBeDefined();
  expect(ner?.category).toBe("pii");
  expect(ner?.mask).toBe("name");
});

// AC4.3 / AC-F.2 — availability-false (asset missing) = deterministic PII,
// byte-identical, warn once, exit 0 (adapter never throws).
test("AC4.3: NER backend unavailable ⇒ byte-identical deterministic PII + warn-once", async () => {
  await writeManifest(true);
  const spec = piiNerSpec("node:util", "pii-ner"); // asset absent offline ⇒ degrade
  const content = "Contact jane.roe@example.com about Ada Lovelace's account.";
  const merged = await runDetectorsAsync(root, content, nerEnabledConfig(), {
    piiNer: spec,
  });
  const base = runDetectors(content, mergeSecurityConfig({}));
  expect(JSON.stringify(merged)).toBe(JSON.stringify(base));
  expect(hasWarned(PII_NER_ID)).toBe(true);
});

// AC4.3 — disabled backend ⇒ deterministic PII only, no adapter, no warning.
test("AC4.3: NER backend disabled ⇒ deterministic PII only (no warning)", async () => {
  await writeManifest(false);
  const content = "Ada Lovelace and jane.roe@example.com";
  const merged = await runDetectorsAsync(root, content, mergeSecurityConfig({}));
  const base = runDetectors(content, mergeSecurityConfig({}));
  expect(JSON.stringify(merged)).toBe(JSON.stringify(base));
  expect(hasWarned(PII_NER_ID)).toBe(false);
});

test("nerMatchesFrom maps location labels to the address mask", () => {
  const matches = nerMatchesFrom([
    { start: 0, end: 5, value: "Paris", label: "LOCATION" },
    { start: 6, end: 9, value: "Bob", label: "PERSON" },
  ]);
  expect(matches[0]?.mask).toBe("address");
  expect(matches[1]?.mask).toBe("name");
});
