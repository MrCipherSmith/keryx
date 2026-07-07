export function renderTestingConfig(input: {
  postCommitRefresh: boolean;
  prePushGate: boolean;
}): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      enabled: true,
      runner: "auto",
      changedSelection: {
        strategies: ["runner", "gdgraph", "naming"],
        fallbackWhenEmpty: "warn",
      },
      hooks: {
        postCommitRefresh: input.postCommitRefresh,
        prePushGate: input.prePushGate,
      },
      artifacts: {
        keepRawLogs: true,
        historyLimit: 50,
      },
    },
    null,
    2,
  )}\n`;
}

export function renderTestingManifest(): string {
  return `# Testing Module

## Purpose

Builds project testing context, runs tests through the existing project runner,
and writes normalized test reports for agents, Code Health and gdskills.

## Commands

- \`gd-metapro test init\`
- \`gd-metapro test analyze\`
- \`gd-metapro test run [--changed]\`
- \`gd-metapro test status\`
- \`gd-metapro test context\`
- \`gd-metapro test explain <file-or-scope>\`
- \`gd-metapro test related <file>\`
- \`gd-metapro test report latest [--json]\`

## Data

- \`data/testing/context.md\`
- \`data/testing/context.json\`
- \`data/testing/recommendations.md\`
- \`data/testing/artifacts/latest.md\`
- \`data/testing/artifacts/latest.json\`

## Skills

- \`skills/testing/SKILL.md\`
`;
}

export function renderTestingCoreReadme(): string {
  return `# Testing Core

Local Testing Module service layer installed by \`gd-metapro init\`.

Responsibilities:

- detect test stack, scripts, configs, CI and test files;
- write reusable testing context under \`.metaproject/data/testing\`;
- run tests through the existing project runner;
- normalize results into JSON/Markdown artifacts;
- expose agent commands under \`gd-metapro test\`.
`;
}

export function renderTestingSkillReadme(): string {
  return `---
name: testing
description: Use before creating, changing, debugging, or reviewing tests. Read testing context and normalized reports before raw test logs.
---

# testing Skill

Use this skill by default for test-related work. The user does not need to
explicitly ask for testing context.

## Workflow

1. Read \`.metaproject/data/testing/context.md\` before creating or changing tests.
2. Use related-test discovery before broad test search:

\`\`\`bash
gd-metapro test related <file>
\`\`\`

3. For focused verification, prefer:

\`\`\`bash
gd-metapro test run --changed
\`\`\`

4. Read \`.metaproject/data/testing/artifacts/latest.md\` before raw logs.
5. Use raw log only when summary and JSON are insufficient.
6. If failures reveal a reusable lesson, feed it to gdskills:

\`\`\`bash
gd-metapro skills learn --from-test .metaproject/data/testing/artifacts/latest.json --skill <module>/<skill>
\`\`\`

## Commands

\`\`\`bash
gd-metapro test analyze
gd-metapro test run
gd-metapro test run --changed
gd-metapro test status
gd-metapro test context
gd-metapro test explain <file-or-scope>
gd-metapro test related <file>
gd-metapro test report latest
\`\`\`

## Rules

- Do not infer test conventions from one file when testing context exists.
- Do not load raw test logs first.
- Do not install dependencies or create a new test stack unless explicitly requested.
- Treat Testing Module reports as the source for test execution status; Code Health consumes them.
`;
}

export function renderTestingWikiReadme(): string {
  return `# Testing

Version: 0.1.0

Project testing knowledge base.

## References

- \`../index.md\`
- \`../../data/testing/context.md\`
- \`../../data/testing/recommendations.md\`
- \`../../skills/testing/SKILL.md\`
`;
}

export function renderTestingWikiConventions(): string {
  return `# Testing Conventions

Version: 0.1.0

This page stores human-maintained testing conventions. Machine-generated
discovery lives in \`.metaproject/data/testing/context.md\`.

## Current Conventions

- Review \`.metaproject/data/testing/context.md\` before editing this page.
- Keep project-specific testing rules here when they become stable.
`;
}

export function renderTestingPostCommitHook(): string {
  return `gd_metapro_testing_post_commit() {
  # Non-mutating: report testing context staleness after relevant commits.

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  changed_files="$(git diff-tree --no-commit-id --name-only -r --root HEAD 2>/dev/null || true)"
  if [ -z "$changed_files" ]; then
    return 0
  fi

  if ! printf '%s\\n' "$changed_files" | grep -E '(^src/|^lib/|^app/|^packages/|^services/|^tests/|^e2e/|^docs/|\\.test\\.|\\.spec\\.|package\\.json$|bun\\.lockb$|pnpm-lock\\.yaml$|yarn\\.lock$|package-lock\\.json$|vitest\\.config\\.|jest\\.config\\.|playwright\\.config\\.|cypress\\.config\\.|AGENTS\\.md$|CLAUDE\\.md$)' >/dev/null 2>&1; then
    return 0
  fi

  echo "gd-metapro post-commit: testing context may be stale; run 'gd-metapro test analyze' explicitly"
  return 0
}

gd_metapro_testing_post_commit
`;
}

export function renderTestingPrePushHook(): string {
  return `gd_metapro_testing_pre_push() {
  # Run changed-scope tests before push. Blocking on test failure.

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  if command -v gd-metapro >/dev/null 2>&1; then
    gd-metapro test run --changed --strict
    return $?
  fi

  if [ -x "$HOME/.local/bin/gd-metapro" ]; then
    "$HOME/.local/bin/gd-metapro" test run --changed --strict
    return $?
  fi

  echo "gd-metapro pre-push: gd-metapro command not found, skipped testing gate" >&2
  return 0
}

gd_metapro_testing_pre_push || exit $?
`;
}
