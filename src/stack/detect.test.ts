// Flow 309 (W1, Lane A): `detectStack` unit tests — W1-AC1/AC2/AC3, the
// per-signal-uncertain-contribution case, and multiple ecosystems.

import { describe, expect, test } from "bun:test";
import { STACK_DETECT_TAGS, detectStack, hasNestedPackageJson, isInsideRoot, type StackDetectFs, type StackDirEntry } from "./detect";

/** In-memory fs: a flat map of absolute path -> text content, plus explicit directories. */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): StackDetectFs {
  // An entry is a directory when it is listed in `dirs` or holds a file.
  const isDir = (full: string): boolean => full in dirs || Object.keys(files).some((file) => file.startsWith(`${full}/`));
  return {
    async readTextFile(path: string): Promise<string> {
      if (path in files) {
        return files[path] as string;
      }
      throw new Error(`ENOENT: ${path}`);
    },
    async readDir(path: string): Promise<StackDirEntry[]> {
      if (path in dirs) {
        return dirs[path]!.map((name) => ({ name, isDirectory: isDir(`${path}/${name}`) }));
      }
      // Derive a root listing from the flat file map when no explicit dir given.
      const prefix = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
      const names = new Set<string>();
      for (const filePath of Object.keys(files)) {
        // Files directly here, and the first segment of deeper files (their directories).
        if (filePath.startsWith(prefix)) names.add(filePath.slice(prefix.length).split("/")[0]!);
      }
      if (names.size === 0 && !(path in dirs)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return [...names].sort().map((name) => ({ name, isDirectory: isDir(`${path}/${name}`) }));
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
    expect(result.tags.storybook).toBe(false);
  });
});

describe("storybook (ADR-0001 P4: selects the storybook pack)", () => {
  test("the storybook CLI or any @storybook/* package sets the tag; react alone does not", async () => {
    for (const dependencies of [{ storybook: "^8.4.0" }, { "@storybook/react-vite": "^8.4.0" }, { "@storybook/test": "^8.4.0" }]) {
      const result = await detectStack("/repo", { fs: fakeFs({ "/repo/package.json": JSON.stringify({ devDependencies: dependencies }) }) });
      expect({ dependencies, storybook: result.tags.storybook }).toEqual({ dependencies, storybook: true });
      expect(result.matched).toContain(Object.keys(dependencies)[0]!);
    }
    const reactOnly = await detectStack("/repo", { fs: fakeFs({ "/repo/package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }) }) });
    expect(reactOnly.tags.storybook).toBe(false);
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
  test("hitting the file cap with no C/C++ file seen selects nothing (review R-4: every large repo got c-cpp), and says so", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      files[`/repo/file${i}.txt`] = "x";
    }
    const fs = fakeFs(files);
    const result = await detectStack("/repo", { fs, maxFiles: 3 });
    expect(result.tags["c-cpp"]).toBe(false);
    expect(result.uncertain).toBe(false);
    const scanSignal = result.perSignal.find((s) => s.signal === "scan:extensions");
    expect(scanSignal?.uncertain).toBe(false);
    expect(scanSignal?.reason).toContain("hit its file cap (3) with no C/C++ source");
  });

  test("hitting the file cap after a C/C++ file was seen still sets c-cpp", async () => {
    const fs = fakeFs({ "/repo/a.c": "int main(void) { return 0; }\n", "/repo/b.txt": "x", "/repo/c.txt": "x", "/repo/d.txt": "x" });
    const result = await detectStack("/repo", { fs, maxFiles: 2 });
    expect(result.tags["c-cpp"]).toBe(true);
  });
});

describe("JS workspace-root markers (review M1: a monorepo root names only build tooling)", () => {
  for (const marker of ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "rush.json"]) {
    test(`${marker} with no package found: the root's own dependencies decide, and a root that declares nothing is uncertain`, async () => {
      // Single-package turbo / nx standalone: the root declares the stack (review R3-2).
      const withRoot = await detectStack("/repo", {
        fs: fakeFs({ [`/repo/${marker}`]: "{}\n", "/repo/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" }, devDependencies: { typescript: "^5.0.0" } }) }),
      });
      expect({ marker, uncertain: withRoot.uncertain, react: withRoot.tags.react, vue: withRoot.tags.vue, angular: withRoot.tags.angular })
        .toEqual({ marker, uncertain: false, react: true, vue: false, angular: false });
      for (const files of [
        { [`/repo/${marker}`]: "{}\n" },
        { [`/repo/${marker}`]: "{}\n", "/repo/package.json": JSON.stringify({ private: true, scripts: { build: "turbo build" } }) },
      ]) {
        const result = await detectStack("/repo", { fs: fakeFs(files) });
        expect(result.uncertain).toBe(true);
        for (const tag of jsTags()) expect({ marker, tag, value: result.tags[tag] }).toEqual({ marker, tag, value: true });
        expect(result.tags.python).toBe(false);
        const signal = result.perSignal.find((s) => s.signal === "manifest:js-workspace");
        expect(signal?.reason).toContain(marker);
      }
    });
  }

  test("a pnpm root whose package.json declares nothing selects from the sub-packages it read (review R3-1)", async () => {
    const result = await detectStack("/repo", {
      fs: fakeFs({
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
        "/repo/package.json": JSON.stringify({ private: true, scripts: { build: "pnpm -r build" } }),
        "/repo/apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1", mobx: "^6.13.0" } }),
      }),
    });
    expect(result.uncertain).toBe(false);
    expect({ react: result.tags.react, mobx: result.tags.mobx, angular: result.tags.angular, vue: result.tags.vue }).toEqual({ react: true, mobx: true, angular: false, vue: false });
    expect(result.perSignal.some((s) => s.signal === "manifest:package.json")).toBe(false);
  });

  test("workspace reads stay in the repository: ../ globs and directories that link outside are skipped (review R3-3)", async () => {
    const files = {
      "/repo/pnpm-workspace.yaml": "packages:\n  - '../other-*'\n  - 'apps/*'\n",
      "/other-ng/package.json": JSON.stringify({ dependencies: { "@angular/core": "^17" } }),
      "/repo/apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
      "/repo/apps/linked/package.json": JSON.stringify({ dependencies: { vue: "^3" } }),
    };
    const base = fakeFs(files, { "/": ["other-ng", "repo"] });
    const fs: StackDetectFs = {
      ...base,
      async realPath(path: string): Promise<string> {
        return path === "/repo/apps/linked" ? "/elsewhere/linked" : path;
      },
    };
    const result = await detectStack("/repo", { fs });
    expect({ react: result.tags.react, angular: result.tags.angular, vue: result.tags.vue, uncertain: result.uncertain })
      .toEqual({ react: true, angular: false, vue: false, uncertain: false });
    const reason = result.perSignal.find((s) => s.signal === "manifest:js-workspace")?.reason ?? "";
    expect(reason).toContain("../other-* (outside the repository)");
    expect(reason).toContain("apps/linked (links outside the repository)");
  });

  test("a ! glob excludes the packages it names (review R3-3)", async () => {
    const result = await detectStack("/repo", {
      fs: fakeFs({
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n",
        "/repo/apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
        "/repo/apps/legacy/package.json": JSON.stringify({ dependencies: { "@angular/core": "^12" } }),
      }),
    });
    expect({ react: result.tags.react, angular: result.tags.angular }).toEqual({ react: true, angular: false });
  });

  test("packages/** reads packages below the first level, bounded (review R3-4)", async () => {
    const result = await detectStack("/repo", {
      fs: fakeFs({
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n",
        "/repo/packages/ui/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
        "/repo/packages/ui/web/node_modules/vue/package.json": JSON.stringify({ dependencies: { vue: "^3" } }),
      }),
    });
    expect({ uncertain: result.uncertain, react: result.tags.react, vue: result.tags.vue }).toEqual({ uncertain: false, react: true, vue: false });
  });

  test("a pnpm flow-style packages list is read (review R3-6)", async () => {
    const result = await detectStack("/repo", {
      fs: fakeFs({
        "/repo/pnpm-workspace.yaml": "packages: ['web/*', \"api\"]\n",
        "/repo/web/app/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
        "/repo/api/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10" } }),
      }),
    });
    expect({ uncertain: result.uncertain, react: result.tags.react, nestjs: result.tags.nestjs }).toEqual({ uncertain: false, react: true, nestjs: true });
  });

  test("one broken sub-package is skipped and named, not a reason to keep every JS tag (review R3-7)", async () => {
    const result = await detectStack("/repo", {
      fs: fakeFs({
        "/repo/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
        "/repo/apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
        "/repo/apps/broken/package.json": "{ not json",
      }),
    });
    expect({ uncertain: result.uncertain, react: result.tags.react, angular: result.tags.angular }).toEqual({ uncertain: false, react: true, angular: false });
    expect(result.perSignal.find((s) => s.signal === "manifest:js-workspace")?.reason).toContain("skipped apps/broken/package.json (not a JSON object)");
  });

  test("a turbo React+NestJS monorepo selects from its sub-packages, not every JS tag (review N-1)", async () => {
    const fs = fakeFs(
      {
        "/repo/turbo.json": "{}\n",
        "/repo/package.json": JSON.stringify({ private: true, devDependencies: { turbo: "^2.0.0", typescript: "^5.6.0" } }),
        "/repo/apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1", mobx: "^6.13.0" } }),
        "/repo/apps/api/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10.4.0" } }),
      },
      { "/repo/apps": ["api", "web"] },
    );
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(false);
    for (const tag of ["react", "mobx", "nestjs", "typescript"]) expect({ tag, value: result.tags[tag] }).toEqual({ tag, value: true });
    for (const tag of ["angular", "vue", "nextjs", "nuxt", "storybook"]) expect({ tag, value: result.tags[tag] }).toEqual({ tag, value: false });
    expect(result.perSignal.find((s) => s.signal === "manifest:js-workspace")?.reason).toContain("2 workspace packages");
  });

  test("the packages a marker names are read: pnpm-workspace.yaml globs, lerna packages, rush projectFolder, package.json workspaces", async () => {
    const cases: Array<{ files: Record<string, string>; dirs?: Record<string, string[]> }> = [
      {
        files: {
          "/repo/pnpm-workspace.yaml": "packages:\n  - 'services/*'\n  - \"!services/legacy\"\n",
          "/repo/services/api/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10.4.0" } }),
        },
        dirs: { "/repo/services": ["api"] },
      },
      {
        files: { "/repo/lerna.json": JSON.stringify({ packages: ["modules/api"] }), "/repo/modules/api/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10" } }) },
      },
      {
        files: {
          "/repo/rush.json": '// rush config\n{ "projects": [{ "packageName": "api", "projectFolder": "server/api" }] }\n',
          "/repo/server/api/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10" } }),
        },
      },
      {
        files: {
          "/repo/package.json": JSON.stringify({ private: true, workspaces: ["backend"] }),
          "/repo/backend/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10" } }),
        },
      },
    ];
    for (const { files, dirs } of cases) {
      const result = await detectStack("/repo", { fs: fakeFs(files, dirs) });
      const marker = Object.keys(files)[0];
      expect({ marker, uncertain: result.uncertain, nestjs: result.tags.nestjs, react: result.tags.react }).toEqual({ marker, uncertain: false, nestjs: true, react: false });
    }
  });

  test("a workspace glob this module cannot expand falls back to every JS tag", async () => {
    const result = await detectStack("/repo", { fs: fakeFs({ "/repo/pnpm-workspace.yaml": "packages:\n  - 'apps/*/packages/*'\n" }) });
    expect(result.uncertain).toBe(true);
    for (const tag of jsTags()) expect(result.tags[tag]).toBe(true);
    expect(result.perSignal.find((s) => s.signal === "manifest:js-workspace")?.reason).toContain("is not one this module reads");
  });

  test("packages/** stops at each package: 60 packages with 36 folders each stay under the limits (review R4-1)", async () => {
    const files: Record<string, string> = { "/repo/pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n" };
    for (let p = 0; p < 60; p += 1) {
      const deps = p === 7 ? { react: "^18.3.1" } : { lodash: "^4" };
      files[`/repo/packages/group${p % 6}/pkg${p}/package.json`] = JSON.stringify({ dependencies: deps });
      for (let d = 0; d < 36; d += 1) files[`/repo/packages/group${p % 6}/pkg${p}/src/dir${d}/index.ts`] = "export {};\n";
    }
    const result = await detectStack("/repo", { fs: fakeFs(files), workspaceLimits: { maxPackages: 100, maxVisited: 200 } });
    expect({ uncertain: result.uncertain, react: result.tags.react, vue: result.tags.vue }).toEqual({ uncertain: false, react: true, vue: false });
    expect(result.perSignal.find((s) => s.signal === "manifest:js-workspace")?.reason).toContain("60 workspace packages");
  });

  test("a packages/** tree past the limits falls back to what was found plus the first level, not every JS tag (review R4-1)", async () => {
    const files: Record<string, string> = {
      "/repo/pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n",
      "/repo/packages/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
    };
    for (let p = 0; p < 30; p += 1) files[`/repo/packages/libs/lib${p}/package.json`] = JSON.stringify({ dependencies: { lodash: "^4" } });
    const result = await detectStack("/repo", { fs: fakeFs(files), workspaceLimits: { maxPackages: 5, maxVisited: 50 } });
    expect({ uncertain: result.uncertain, react: result.tags.react, angular: result.tags.angular, vue: result.tags.vue })
      .toEqual({ uncertain: false, react: true, angular: false, vue: false });
  });

  test("containment compares real paths with path.relative, Windows paths included (review R4-2)", async () => {
    expect(isInsideRoot("C:\\repo", "C:\\repo\\apps\\web")).toBe(true);
    expect(isInsideRoot("C:\\repo", "C:\\repo")).toBe(true);
    expect(isInsideRoot("C:\\repo", "C:\\repo-other\\web")).toBe(false);
    expect(isInsideRoot("C:\\repo", "D:\\repo\\web")).toBe(false);
    expect(isInsideRoot("/repo", "/repo/apps/..web")).toBe(true);
    expect(isInsideRoot("/repo", "/repo-other/web")).toBe(false);
    const base = fakeFs({
      "/repo/pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n",
      "/repo/apps/web/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
    });
    // A win32 realPath: every package inside the repository must still be read.
    const fs: StackDetectFs = { ...base, realPath: async (path) => `C:${path.replace(/\//g, "\\")}` };
    const result = await detectStack("/repo", { fs });
    expect({ uncertain: result.uncertain, react: result.tags.react }).toEqual({ uncertain: false, react: true });
  });

  test("a pnpm flow list over several lines is read (review R4-4)", async () => {
    const result = await detectStack("/repo", {
      fs: fakeFs({
        "/repo/pnpm-workspace.yaml": "packages: [\n  'web/*', # apps\n  \"api\"\n]\n",
        "/repo/web/app/package.json": JSON.stringify({ dependencies: { react: "^18.3.1" } }),
        "/repo/api/package.json": JSON.stringify({ dependencies: { "@nestjs/core": "^10" } }),
      }),
    });
    expect({ uncertain: result.uncertain, react: result.tags.react, nestjs: result.tags.nestjs }).toEqual({ uncertain: false, react: true, nestjs: true });
  });

  test("hasNestedPackageJson is true only when it finds one, never because the tree was too large (review R4-3)", async () => {
    const big: Record<string, string> = {};
    for (let d = 0; d < 40; d += 1) big[`/repo/src/mod${d}/main.go`] = "package main\n";
    expect(await hasNestedPackageJson("/repo", fakeFs(big), { maxPackages: 10, maxVisited: 5 })).toBe(false);
    expect(await hasNestedPackageJson("/repo", fakeFs(big))).toBe(false);
    expect(await hasNestedPackageJson("/repo", fakeFs({ ...big, "/repo/web/app/package.json": "{}" }))).toBe(true);
    // The root's own package.json does not count.
    expect(await hasNestedPackageJson("/repo", fakeFs({ ...big, "/repo/package.json": "{}" }))).toBe(false);
  });

  test("a plain app with no workspace marker stays certain", async () => {
    const result = await detectStack("/repo", { fs: fakeFs({ "/repo/package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }) }) });
    expect(result.uncertain).toBe(false);
    expect(result.perSignal.some((s) => s.signal === "manifest:js-workspace")).toBe(false);
  });
});

describe("F1: fail-open on a read error other than absent", () => {
  /** An fs whose readTextFile/readDir throw a specific error `code` for one path, ENOENT otherwise. */
  function faultyFs(faultyPath: string, code: string): StackDetectFs {
    return {
      async readTextFile(path: string): Promise<string> {
        if (path === faultyPath) {
          const error = new Error(`${code}: permission denied, open '${path}'`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
      async readDir(path: string): Promise<StackDirEntry[]> {
        if (path === faultyPath) {
          const error = new Error(`${code}: permission denied, scandir '${path}'`) as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
    };
  }

  test("EACCES on package.json marks the whole js family uncertain, not absent", async () => {
    const fs = faultyFs("/repo/package.json", "EACCES");
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(true);
    for (const tag of jsTags()) {
      expect(result.tags[tag]).toBe(true);
    }
    const signal = result.perSignal.find((s) => s.signal === "manifest:package.json");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toContain("EACCES");
  });

  test("ENOENT on package.json is absent, not uncertain (control case)", async () => {
    const fs = faultyFs("/repo/nothing-matches-this-path", "EACCES");
    const result = await detectStack("/repo", { fs });
    expect(result.uncertain).toBe(false);
    for (const tag of jsTags()) {
      expect(result.tags[tag]).toBe(false);
    }
  });

  test("EIO on pyproject.toml marks python family uncertain and names the code", async () => {
    const fs = faultyFs("/repo/pyproject.toml", "EIO");
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toContain("EIO");
    expect(result.tags.python).toBe(true);
  });

  test("EACCES on Cargo.toml (markerFileSignal) marks rust uncertain", async () => {
    const fs = faultyFs("/repo/Cargo.toml", "EACCES");
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:Cargo.toml");
    expect(signal?.uncertain).toBe(true);
    expect(result.tags.rust).toBe(true);
  });

  test("EACCES on pom.xml (jvmManifestSignal) marks jvm-family tags uncertain", async () => {
    const fs = faultyFs("/repo/pom.xml", "EACCES");
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pom.xml");
    expect(signal?.uncertain).toBe(true);
    expect(result.tags.java).toBe(true);
  });

  test("EACCES readDir on the repository root marks dotnet, terraform, and sql uncertain", async () => {
    const fs = faultyFs("/repo", "EACCES");
    const result = await detectStack("/repo", { fs });
    for (const id of ["manifest:dotnet-project", "marker:terraform", "marker:sql"]) {
      const signal = result.perSignal.find((s) => s.signal === id);
      expect(signal?.uncertain).toBe(true);
      expect(signal?.reason).toContain("EACCES");
    }
    expect(result.tags.csharp).toBe(true);
    expect(result.tags.dotnet).toBe(true);
    expect(result.tags.terraform).toBe(true);
    expect(result.tags.sql).toBe(true);
    // The extension scan also reads the repo root, so c-cpp goes uncertain too.
    expect(result.tags["c-cpp"]).toBe(true);
  });

  test("EACCES readDir on .github/workflows marks github-actions uncertain", async () => {
    const fs = faultyFs("/repo/.github/workflows", "EACCES");
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "marker:github-workflows");
    expect(signal?.uncertain).toBe(true);
    expect(result.tags["github-actions"]).toBe(true);
  });

  test("EACCES readDir on a nested subdirectory during the extension scan marks c-cpp uncertain", async () => {
    const fs: StackDetectFs = {
      async readTextFile(path: string): Promise<string> {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
      async readDir(path: string): Promise<StackDirEntry[]> {
        if (path === "/repo") {
          return [{ name: "locked", isDirectory: true }];
        }
        if (path === "/repo/locked") {
          const error = new Error(`EACCES: permission denied, scandir '${path}'`) as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
    };
    const result = await detectStack("/repo", { fs });
    expect(result.tags["c-cpp"]).toBe(true);
    const signal = result.perSignal.find((s) => s.signal === "scan:extensions");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toContain("EACCES");
  });
});

describe("F12: empty repo reason has no absolute path", () => {
  test("'no known stack signals' reason names no path at all", async () => {
    const fs = fakeFs({});
    const result = await detectStack("/repo", { fs });
    expect(result.reason).toBe("no known stack signals found at the repository root");
    expect(result.reason).not.toContain("/repo");
  });
});

describe("F14: pyproject broken-TOML heuristic tolerates valid multi-line/nested arrays", () => {
  test("a valid multi-line array of arrays is not flagged broken", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml":
        '[tool.poetry]\nname = "app"\nmatrix = [\n    [1, 2],\n    [3, 4],\n]\n',
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(false);
    expect(result.uncertain).toBe(false);
    expect(result.tags.python).toBe(true);
  });

  test("a valid multi-line array with an inline table element is not flagged broken", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml":
        '[tool.poetry]\nname = "app"\nauthors = [\n    { name = "A", email = "a@example.com" },\n]\n',
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(false);
  });

  test("a double quote inside a single-quoted string does not unbalance the quote count", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": "[tool.poetry]\nname = 'a \"quoted\" word'\n",
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(false);
  });

  test("a genuinely unterminated table header is still flagged uncertain", async () => {
    const fs = fakeFs({ "/repo/pyproject.toml": '[tool.poetry\nname = "broken"\n' });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toMatch(/structurally broken/);
  });

  test("a genuinely unterminated array is still flagged uncertain", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": '[tool.poetry]\nname = "app"\nmatrix = [\n    [1, 2],\n    [3, 4],\n',
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(true);
  });

  test("an odd number of real unbalanced double quotes is still flagged uncertain", async () => {
    const fs = fakeFs({ "/repo/pyproject.toml": '[tool.poetry]\nname = "unterminated\n' });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toMatch(/unbalanced quotes/);
  });
});

describe("R2-9: escaped backslashes and triple-quoted strings", () => {
  test("an escaped backslash right before the closing quote does not unbalance the string", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": '[tool.poetry]\nname = "app"\nwin = "C:\\\\"\n',
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(false);
  });

  // R3-5 (flow 309 review round 3): the original fixture ("[docs]") has
  // BALANCED brackets, so it doesn't discriminate — the pre-fix code (no
  // `"""` tracking; brackets/quotes scanned in "normal" state at all times,
  // and a bare `\n` inside a `"` string silently resets to "normal" rather
  // than flagging anything) also nets depth 0 for a balanced `[`...`]` pair,
  // regardless of whether it understands triple-quoted strings at all.
  // Rewritten with an UNBALANCED `[` (no closing `]`) inside the `"""`
  // body: the fixed state machine must recognize this is string content
  // (not table/array syntax) to still report `uncertain: false`; the
  // pre-fix code counts the stray `[` in "normal" state and reports
  // `uncertain: true` (verified against detect.ts@358c8d70, restored in a
  // scratch copy).
  test("an unbalanced '[' inside a triple-quoted \"\"\" string is content, not a table header (R3-5: discriminating fixture)", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml":
        '[tool.poetry]\nname = "app"\ndescription = """\nSee [docs for more.\n"""\n',
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(false);
  });

  // R3-5: a basic (single-line) string that ends in an escaped backslash
  // pair, immediately followed on the SAME line by a genuinely unbalanced
  // `[`. The pre-fix code's closing-quote check only looked at the single
  // PRECEDING character (`text[i - 1] !== "\\"`), so the last of a `\\`
  // pair reads as "this quote is escaped" and the string never closes —
  // everything after it, including the real stray `[`, is silently
  // swallowed as (mistaken) string content until the next bare newline
  // resets to "normal" with nothing flagged. The fixed code consumes an
  // escape pair (`\\`) two characters at a time, so it closes the string
  // correctly and then genuinely finds the unterminated `[` that follows.
  test("an escaped-backslash-terminated string followed by a real unbalanced '[' on the same line is still caught (R3-5: discriminating fixture)", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": '[tool.poetry]\nname = "app"\nwin = "C:\\\\" extra = [\n',
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toMatch(/unterminated table header or array/);
  });

  test("a valid triple-quoted ''' literal string spanning lines is not flagged broken", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": "[tool.poetry]\nname = 'app'\npattern = '''\nC:\\Users\\[name]\n'''\n",
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(false);
  });

  test("a triple-quoted \"\"\" string never closed by EOF is flagged uncertain", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": '[tool.poetry]\nname = "app"\ndescription = """\nSee [docs\n',
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toMatch(/unterminated string/);
  });

  test("a triple-quoted ''' string never closed by EOF is flagged uncertain", async () => {
    const fs = fakeFs({
      "/repo/pyproject.toml": "[tool.poetry]\nname = 'app'\npattern = '''\nC:\\Users\\open\n",
    });
    const result = await detectStack("/repo", { fs });
    const signal = result.perSignal.find((s) => s.signal === "manifest:pyproject.toml");
    expect(signal?.uncertain).toBe(true);
    expect(signal?.reason).toMatch(/unterminated string/);
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
