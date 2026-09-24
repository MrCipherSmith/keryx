import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  assertInsideLearningRoot,
  assertValidLearningId,
  candidatesDir,
  decisionsLogPath,
  graduationDir,
  learningDataDir,
  LearningPathError,
  observationFilePath,
  observationsDir,
  projectLockPath,
  projectPatternPath,
  userDecisionsLogPath,
  userIndexPath,
  userLearningDir,
  userLockPath,
  userPatternPath,
  userPatternsDir,
} from "./paths";

const ROOT = "/proj";

describe("project-scope paths", () => {
  test("learningDataDir / observationsDir / candidatesDir / graduationDir", () => {
    expect(learningDataDir(ROOT)).toBe(path.join(ROOT, ".metaproject", "data", "learning"));
    expect(observationsDir(ROOT)).toBe(path.join(learningDataDir(ROOT), "observations"));
    expect(candidatesDir(ROOT)).toBe(path.join(learningDataDir(ROOT), "candidates"));
    expect(graduationDir(ROOT)).toBe(path.join(learningDataDir(ROOT), "graduation"));
  });

  test("observationFilePath / projectPatternPath / projectLockPath / decisionsLogPath", () => {
    expect(observationFilePath(ROOT, "2026-09-24")).toBe(path.join(observationsDir(ROOT), "2026-09-24.jsonl"));
    expect(projectPatternPath(ROOT, "testing.foo-ab12")).toBe(path.join(candidatesDir(ROOT), "testing.foo-ab12.json"));
    expect(projectLockPath(ROOT)).toBe(path.join(learningDataDir(ROOT), "learn.lock"));
    expect(decisionsLogPath(ROOT)).toBe(path.join(learningDataDir(ROOT), "decisions.jsonl"));
  });
});

describe("user-scope paths", () => {
  const env = { KERYX_HOME: "/home/tester" };

  test("userLearningDir honors KERYX_HOME", () => {
    expect(userLearningDir(env)).toBe(path.join("/home/tester", ".keryx", "learning"));
  });

  test("userLearningDir honors an explicit homeDir override", () => {
    expect(userLearningDir({}, "/explicit/home")).toBe(path.join("/explicit/home", ".keryx", "learning"));
  });

  test("userPatternsDir / userPatternPath / userIndexPath / userLockPath / userDecisionsLogPath", () => {
    expect(userPatternsDir(env)).toBe(path.join(userLearningDir(env), "patterns"));
    expect(userPatternPath("testing.foo-ab12", env)).toBe(path.join(userPatternsDir(env), "testing.foo-ab12.json"));
    expect(userIndexPath(env)).toBe(path.join(userLearningDir(env), "index.json"));
    expect(userLockPath(env)).toBe(path.join(userLearningDir(env), "learn.lock"));
    expect(userDecisionsLogPath(env)).toBe(path.join(userLearningDir(env), "decisions.jsonl"));
  });
});

describe("assertValidLearningId", () => {
  test("accepts a schema-shaped id", () => {
    expect(() => assertValidLearningId("testing.repeated-correction-ab12cd34")).not.toThrow();
  });

  test.each(["../escape", "has/slash", "UPPER", "", "-leading-dash", "a".repeat(200)])(
    "rejects %s",
    (id) => {
      expect(() => assertValidLearningId(id)).toThrow(LearningPathError);
    },
  );

  test("path-construction helpers refuse a traversal id before touching disk", () => {
    expect(() => projectPatternPath(ROOT, "../../etc/passwd")).toThrow(LearningPathError);
    expect(() => userPatternPath("../../etc/passwd", {})).toThrow(LearningPathError);
  });
});

describe("assertInsideLearningRoot", () => {
  test("passes for a target inside an allowed root", () => {
    expect(() => assertInsideLearningRoot(path.join(ROOT, "a.json"), [ROOT])).not.toThrow();
  });

  test("throws LearningPathError with reason learning-path-outside-root otherwise", () => {
    try {
      assertInsideLearningRoot("/elsewhere/a.json", [ROOT]);
      throw new Error("expected assertInsideLearningRoot to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LearningPathError);
      expect((error as LearningPathError).reason).toBe("learning-path-outside-root");
    }
  });

  test("passes when inside any of several allowed roots", () => {
    expect(() => assertInsideLearningRoot("/b/x.json", ["/a", "/b"])).not.toThrow();
  });
});
