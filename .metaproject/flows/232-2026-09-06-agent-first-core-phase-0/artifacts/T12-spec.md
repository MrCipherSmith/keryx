# Description-based worker contract correction
Version: 0.1.0

Task T12/T14: flow init supports a description without a GitHub issue, but task-implementer input requires a positive issue_number. This blocks valid user-authorized flow workers unless an issue is fabricated. Allow omission while retaining positive integer validation when supplied. Keep codebase_path and branch mandatory. Update bundled and project-local schema/prose parity; external compiled keryx is not replaced. Validate modified input through source CLI when needed. No GitHub issue is created and no fake identifier supplied.

Acceptance: issue-backed requests still pass; description-based requests pass without issue_number; supplied zero/negative/string/null issue_number and missing branch/path fail. All skill builds describe optional issue reference. This prerequisite supports phase 0 AC6; no frozen acceptance rewrite.

TDD: independent tests-creator produces failing fixture first, then minimal contract/prose repair; independent verifier checks both cases. Root may repair this orchestration bootstrap before task-implementer can accept its own input.
