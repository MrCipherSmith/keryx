---
name: java-kotlin-spring-build-fix
description: "Use when a Gradle or Maven build for a Java/Kotlin Spring Boot project fails -- compile errors, dependency/version conflicts, Spring context startup failures (missing bean, ambiguous bean, circular dependency), Kotlin/Java interop issues, checkstyle/ktlint/detekt findings, and a failing test run."
triggers:
  - "./gradlew build is failing"
  - "mvn compile is failing with a dependency conflict"
  - "Spring context fails to start -- no qualifying bean"
  - "resolve this circular bean dependency in Spring"
  - "ktlint is failing on this Kotlin file"
  - "this Spring Boot test run is failing to build"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Java/Kotlin + Spring build fix

Resolve a Gradle/Maven build failure for a Java or Kotlin Spring Boot
project — a compile error, a dependency/version conflict, a Spring
context startup failure (missing/ambiguous bean, circular dependency), a
Kotlin/Java interop issue, a checkstyle/ktlint/detekt finding, or a
failing test run — with the smallest change that fixes the actual root
cause. `rules/coding-style.mdc` and `rules/security.mdc` govern what a
"correct" fix looks like; this skill never reaches for a suppression
instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
./gradlew build      # or: mvn verify
```

Run the project's configured static-analysis task if present
(`./gradlew check`, `checkstyle`, `ktlint`, `detekt`). Read the exact
error text and classify it:

- **Compile error** (undefined symbol, type mismatch, wrong arg count,
  Kotlin/Java interop nullability mismatch).
- **Dependency/version conflict** (Gradle/Maven resolution failure,
  transitive version clash, a missing dependency declaration).
- **Spring context startup failure** — `NoSuchBeanDefinitionException`
  (no qualifying bean), `NoUniqueBeanDefinitionException` (ambiguous
  bean, needs `@Qualifier`/`@Primary`), or a circular bean dependency
  (`BeanCurrentlyInCreationException`).
- **Static-analysis finding** (checkstyle/ktlint/detekt rule violation).
- **Failing test run** (a test failure surfaced through the build task).

### Step 2: Fix by category

**Dependency/version conflict:** check the build tool's own dependency
tree (`./gradlew dependencies` or `mvn dependency:tree`) to see what is
actually pulling in the conflicting version before bumping anything by
hand. Align on the version the project's dependency-management/BOM
(`spring-boot-dependencies`, a Gradle platform) already declares when one
exists, rather than pinning an arbitrary version that happens to compile.

**Missing/ambiguous bean:** for "no qualifying bean," check that the
class is actually component-scanned (package location, `@Component`/
`@Service`/`@Repository`/`@Configuration` present) and that any required
`@ConditionalOn...` conditions are met. For "no unique bean," add
`@Qualifier`/`@Primary` to disambiguate rather than deleting one of the
legitimate implementations.

**Circular bean dependency:** find the actual cycle (two beans each
requiring the other in their constructors) and break it by extracting
the shared behavior into a third bean, or by refactoring so one
dependency is no longer needed at construction time — do not reach for
`@Lazy` as a first resort; it defers the problem rather than fixing the
design that created the cycle, though it is an acceptable last resort
when the cycle is genuinely unavoidable and the reason is stated in the
report.

**Kotlin/Java interop:** a platform type (`String!`) flowing from Java
into Kotlin that later NPEs, or a Kotlin nullable type mismatching a
Java `@NonNull`/`@Nullable` annotation — fix by making the Kotlin side's
nullability match what the Java API actually guarantees (check for
JSR-305/`@NonNull` annotations on the Java side), not by adding a blanket
`!!` at the interop boundary.

**Static-analysis finding:** fix the underlying issue the finding names.
Never add a suppression (`// noinspection`, `@SuppressWarnings`, a
ktlint/detekt `// ktlint-disable`/baseline entry) whose only purpose is
to make the checker stop complaining without addressing what it found.

**Failing test run:** read the actual assertion failure or stack trace;
fix the root cause in test or source per the failure's own evidence — do
not delete or `@Disabled` the test to reach a green build.

### Step 3: Verify

```bash
./gradlew build      # or: mvn verify
./gradlew test        # or: mvn test
```

Re-run the project's static-analysis task if it was part of the original
failure. All must exit 0 before reporting done.

### Step 4: Report

```
Fixed: NoUniqueBeanDefinitionException for PaymentGateway (two implementations)
  - Root cause: StripeGateway and MockGateway both @Component-scanned with no @Primary
  - Added @Primary to StripeGateway; ./gradlew build/test both pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER add a suppression annotation/comment/baseline entry to silence a
  static-analysis finding instead of fixing what it found.
- NEVER delete or `@Disabled` a failing test to reach a green build.
- NEVER pin an arbitrary dependency version to make a conflict disappear
  without checking the dependency tree/BOM first.
- Reach for `@Lazy` on a circular bean dependency only as a last resort,
  with the reason stated in the report — prefer breaking the actual cycle.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `@SuppressWarnings` here so the linter stops complaining" | Silences the finding without fixing the issue it caught; check what it actually found instead |
| "I'll just mark the failing test `@Disabled` for now" | Hides a real regression or a genuinely broken feature; fix the root cause or say explicitly why the test itself is wrong |
| "I'll add `@Lazy` to break this bean cycle, it's the fastest fix" | Defers bean initialization instead of fixing the design that created a two-way dependency; acceptable only as a stated last resort, not the default |
| "I'll bump this dependency to whatever version compiles" | Picks a version by trial and error instead of checking what the project's BOM/dependency tree actually resolves to, risking a different conflict later |

## Verification

Do not report the fix done until all of the following hold:

- `./gradlew build`/`mvn verify` and the test task both exit 0.
- The project's static-analysis task (if configured) exits 0.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
