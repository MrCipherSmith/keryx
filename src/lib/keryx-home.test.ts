import { describe, it, expect } from "bun:test";
import os from "node:os";
import path from "node:path";
import { resolveHookHomeDir } from "../harness/hooks/config";
import {
  resolveKeryxHomeDir,
  USER_STORE_DIRNAME,
  userStoreRoot,
  userStorePaths,
} from "./keryx-home";

describe("keryx-home", () => {
  describe("resolveKeryxHomeDir", () => {
    it("explicit homeDir wins over KERYX_HOME", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/env/home" };
      const result = resolveKeryxHomeDir(env, "/explicit/home");
      expect(result).toBe("/explicit/home");
    });

    it("KERYX_HOME used when set and no explicit homeDir", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/env/home" };
      const result = resolveKeryxHomeDir(env);
      expect(result).toBe("/env/home");
    });

    it("empty KERYX_HOME falls back to os.homedir()", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "" };
      const result = resolveKeryxHomeDir(env);
      expect(result).toBe(os.homedir());
    });

    it("no KERYX_HOME falls back to os.homedir()", () => {
      const env: NodeJS.ProcessEnv = {};
      const result = resolveKeryxHomeDir(env);
      expect(result).toBe(os.homedir());
    });
  });

  describe("USER_STORE_DIRNAME", () => {
    it("is .keryx", () => {
      expect(USER_STORE_DIRNAME).toBe(".keryx");
    });
  });

  describe("userStoreRoot", () => {
    it("appends .keryx to the resolved home dir", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/test/home" };
      const result = userStoreRoot(env);
      expect(result).toBe(path.join("/test/home", ".keryx"));
    });

    it("respects explicit homeDir", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/env/home" };
      const result = userStoreRoot(env, "/explicit/home");
      expect(result).toBe(path.join("/explicit/home", ".keryx"));
    });

    it("uses os.homedir when no env or explicit homeDir", () => {
      const env: NodeJS.ProcessEnv = {};
      const result = userStoreRoot(env);
      expect(result).toBe(path.join(os.homedir(), ".keryx"));
    });
  });

  describe("userStorePaths", () => {
    it("returns all expected paths with correct structure", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/test/home" };
      const paths = userStorePaths(env);

      expect(paths.root).toBe("/test/home/.keryx");
      expect(paths.skills).toBe("/test/home/.keryx/skills");
      expect(paths.agents).toBe("/test/home/.keryx/agents");
      expect(paths.memory).toBe("/test/home/.keryx/memory");
      expect(paths.learning).toBe("/test/home/.keryx/learning");
      expect(paths.learningPatterns).toBe("/test/home/.keryx/learning/patterns");
      expect(paths.bundles).toBe("/test/home/.keryx/bundles");
      expect(paths.appliedState).toBe(
        "/test/home/.keryx/bundles/applied-state.json",
      );
      expect(paths.hooksJson).toBe("/test/home/.keryx/hooks.json");
      expect(paths.externalSkillImports).toBe(
        "/test/home/.keryx/skills/external-imports.json",
      );
    });

    it("respects explicit homeDir", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/env/home" };
      const paths = userStorePaths(env, "/explicit/home");

      expect(paths.root).toBe("/explicit/home/.keryx");
      expect(paths.skills).toBe("/explicit/home/.keryx/skills");
    });
  });

  describe("resolveHookHomeDir compatibility", () => {
    it("returns the same as resolveKeryxHomeDir for the same inputs", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/test/home" };

      const hookResult = resolveHookHomeDir(env);
      const keryxResult = resolveKeryxHomeDir(env);

      expect(hookResult).toBe(keryxResult);
    });

    it("returns the same with explicit homeDir", () => {
      const env: NodeJS.ProcessEnv = { KERYX_HOME: "/env/home" };
      const explicit = "/explicit/home";

      const hookResult = resolveHookHomeDir(env, explicit);
      const keryxResult = resolveKeryxHomeDir(env, explicit);

      expect(hookResult).toBe(keryxResult);
    });

    it("returns the same with no KERYX_HOME", () => {
      const env: NodeJS.ProcessEnv = {};

      const hookResult = resolveHookHomeDir(env);
      const keryxResult = resolveKeryxHomeDir(env);

      expect(hookResult).toBe(keryxResult);
    });
  });
});
