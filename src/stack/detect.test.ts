// Flow 309 (W1, Lane A): `detectStack` unit tests — W1-AC1/AC2/AC3, the
// per-signal-uncertain-contribution case, and multiple ecosystems.

import { describe, expect, test } from "bun:test";
import { STACK_DETECT_TAGS, detectStack, type StackDetectFs, type StackDirEntry } from "./detect";

/** In-memory fs: a flat map of absolute path -> text content, plus explicit directories. */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): StackDetectFs {
  return {
    async readTextFile(path: string): Promise<string> {
      if (path in files) {
        return files[path] as string;
      }
      throw new Error(`ENOENT: ${path}`);
    },
    async readDir(path: string): Promise<StackDirEntry[]> {
      if (path in dirs) {
        return dirs[path]!.map((name) => ({ name, isDirectory: false }));
      }
      // Derive a root listing from the flat file map when no explicit dir given.
      const prefix = `${path.replace(/\/$/, "")}/`;
      const names = new Set<string>();
      for (const filePath of Object.keys(files)) {
        if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) {
          names.add(filePath.slice(prefix.length));
        }
      }
      if (names.size === 0 && !(path in dirs)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return [...names].sort().map((name) => ({ name, isDirectory: false }));
    },
  };
}

function jsTags(): string[] {
  return STACK_DETECT_TAGS.filter((entry) => entry.family === "js").map((entry) => entry.tag);
}

function pythonTags(): string[] {
  return STACK_DETECT_TAGS.filter((entry) => entry.family === "python").map((entry) => entry.tag);
}

describe("W1-AC1: package.json declaring react only", () => {
  test("tags.react true, uncertain false, matched contains react", async () => {
    const fs = fakeFs({
      "/repo/package.json": JSON.stringify({ name: "app", dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } }),
    });
    const result = await detectStack("/repo", { fs });
    expect(result.tags.react).toBe(true);
    expect(result.uncertain).toBe(false);
    expect(result.matched).toContain("react");
    expect(result.tags.vue).toBe(false);
    expect(result.tags.python).toBe(false);
  });
});

describe("W1-AC2: unparseable package.json", () => {
  test("uncertain true, every JS-family tag true, non-JS tags false, reason names the parse failure", async () => {
    const fs = fakeFs({ "/repo/package.json": "{ not json" });
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(true);
    for (const tag of jsTags()) {
      expect(result.tags[tag]).toBe(true);
    }
    expect(result.tags.python).toBe(false);
    expect(result.tags.go).toBe(false);
    expect(result.reason).toMatch(/did not parse as JSON/);
  });
});

describe("W1-AC3: workspace-root package.json", () => {
  test("uncertain true for every JS-family tag, reason names the declared workspace globs", async () => {
    const fs = fakeFs({
      "/repo/package.json": JSON.stringify({
        name: "root",
        private: true,
        workspaces: ["packages/*", "apps/*"],
        devDependencies: { typescript: "^5.0.0" },
      }),
    });
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(true);
    for (const tag of jsTags()) {
      expect(result.tags[tag]).toBe(true);
    }
    expect(result.reason).toContain("packages/*");
    expect(result.reason).toContain("apps/*");
  });
});

describe("per-signal uncertain contribution", () => {
  test("broken pyproject.toml + clean react package.json: python-family true+uncertain, JS tags as declared", async () => {
    const fs = fakeFs({
      "/repo/package.json": JSON.stringify({ dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } }),
      "/repo/pyproject.toml": '[tool.poetry\nname = "broken"\n',
    });
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(true);
    for (const tag of pythonTags()) {
      expect(result.tags[tag]).toBe(true);
    }
    expect(result.tags.react).toBe(true);
    expect(result.tags.vue).toBe(false);

    const pySignal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(pySignal?.uncertain).toBe(true);
    expect(pySignal?.reason).toMatch(/structurally broken/);

    const jsSignal = result.perSignal.find((s) => s.signal === "manifest:package.json");
    expect(jsSignal?.uncertain).toBe(false);
  });

  test("a failing signal never marks another family's tags", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": '[tool.poetry\n',
      "/repo/go.mod": "module example.com/app\n\ngo 1.22\n",
    });
    const result = await detectStack("/repo", { fs });
    expect(result.tags.go).toBe(true);
    const goSignal = result.perSignal.find((s) => s.signal === "manifest:go.mod");
    expect(goSignal?.uncertain).toBe(false);
  });
});

describe("clean multi-ecosystem manifests", () => {
  test("pyproject.toml declaring django", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": '[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^5.0"\n',
    });
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(false);
    expect(result.tags.python).toBe(true);
    expect(result.tags.django).toBe(true);
    expect(result.tags.fastapi).toBe(false);
  });

  test("Cargo.toml", async () => {
    const fs = fakeFs({ "/repo/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n' });
    const result = await detectStack("/repo", { fs });
    expect(result.tags.rust).toBe(true);
    expect(result.uncertain).toBe(false);
  });

  test("Dockerfile", async () => {
    const fs = fakeFs({ "/repo/Dockerfile": "FROM node:20\n" });
    const result = await detectStack("/repo", { fs });
    expect(result.tags.docker).toBe(true);
  });

  test(".github/workflows", async () => {
    const fs = fakeFs(
      {},
      { "/repo/.github/workflows": ["ci.yml", "release.yaml"], "/repo": [] },
    );
    const result = await detectStack("/repo", { fs });
    expect(result.tags["github-actions"]).toBe(true);
  });

  test("*.tf at root", async () => {
    const fs = fakeFs({ "/repo/main.tf": 'resource "null_resource" "x" {}\n' });
    const result = await detectStack("/repo", { fs });
    expect(result.tags.terraform).toBe(true);
  });

  test("*.sql at root", async () => {
    const fs = fakeFs({ "/repo/schema.sql": "CREATE TABLE t (id INT);\n" });
    const result = await detectStack("/repo", { fs });
    expect(result.tags.sql).toBe(true);
  });

  test("pom.xml with spring-boot", async () => {
    const fs = fakeFs({
      "/repo/pom.xml": "<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>",
    });
    const result = await detectStack("/repo", { fs });
    expect(result.tags.java).toBe(true);
    expect(result.tags.spring).toBe(true);
  });
});

describe("no signal for a family", () => {
  test("empty repo: every tag false, uncertain false, reason non-empty", async () => {
    const fs = fakeFs({});
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(false);
    expect(Object.values(result.tags).every((v) => v === false)).toBe(true);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.matched).toEqual([]);
  });
});

describe("bounded extension scan", () => {
  test("hitting the file cap marks c-cpp uncertain", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      files[`/repo/file${i}.txt`] = "x";
    }
    const fs = fakeFs(files);
    const result = await detectStack("/repo", { fs, maxFiles: 3 });
    expect(result.tags["c-cpp"]).toBe(true);
    expect(result.uncertain).toBe(true);
    const scanSignal = result.perSignal.find((s) => s.signal === "scan:extensions");
    expect(scanSignal?.uncertain).toBe(true);
  });
});

describe("determinism of output shape", () => {
  test("tags object has every known tag key, and perSignal is sorted by signal id", async () => {
    const fs = fakeFs({
      "/repo/go.mod": "module x\n",
      "/repo/Cargo.toml": "[package]\n",
    });
    const result = await detectStack("/repo", { fs });
    const knownTags = STACK_DETECT_TAGS.map((entry) => entry.tag).sort();
    expect(Object.keys(result.tags).sort()).toEqual(knownTags);

    const ids = result.perSignal.map((s) => s.signal);
    expect(ids).toEqual([...ids].sort());
  });
});
