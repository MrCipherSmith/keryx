---
name: java-kotlin-spring-testing
description: "Use when a Java or Kotlin Spring Boot test suite needs writing, extending, or fixing -- JUnit 5, Mockito/MockK, the narrowest Spring test slice (@WebMvcTest/@DataJpaTest/@SpringBootTest), MockMvc, Awaitility instead of Thread.sleep, and Testcontainers for repository tests."
triggers:
  - "write JUnit tests for this Spring service"
  - "add MockMvc tests for this Spring controller"
  - "write a @DataJpaTest for this repository"
  - "fix this failing Spring Boot test"
  - "add Mockito tests for this Java class"
  - "write MockK tests for this Kotlin Spring service"
  - "add a Testcontainers integration test for this repository"
metadata:
  origin: authored
  category: test
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Java/Kotlin + Spring testing (JUnit 5 + Spring Boot Test)

Write, extend, or fix a Java or Kotlin Spring Boot test suite: JUnit 5,
Mockito/MockK, the narrowest applicable Spring test slice, MockMvc,
Awaitility, and Testcontainers. `rules/testing.mdc` carries the full rule
set this skill's checklist is built from — read it, not just this
summary, before writing tests.

## Workflow

### Step 1: Discover the project's test conventions

1. Read `pom.xml`/`build.gradle(.kts)` to confirm the test dependencies
   already present: JUnit 5, Mockito or MockK, AssertJ, Testcontainers,
   Awaitility.
2. Find the layout: `src/test/java` or `src/test/kotlin`, mirroring the
   main package, named `<Type>Test`/`<Type>IT`. Match whichever the
   project already uses.
3. Read 1-2 neighboring test classes for: assertion style already in
   use, whether `@SpringBootTest` or a narrower slice
   (`@WebMvcTest`/`@DataJpaTest`) is the norm, and existing
   fixture/builder helpers for entities and DTOs.

### Step 2: Plan test cases and pick the right slice

**Plain unit test (no Spring container):** for a service's business
logic with mocked collaborators — the default choice when the class was
designed with constructor injection, since it can be constructed
directly with `Mockito.mock(...)`/MockK mocks passed to the constructor.

**`@WebMvcTest`:** for a controller — loads only the web layer, use
`MockMvc` to exercise request/response mapping, status codes, and
validation errors, with the service layer mocked via `@MockitoBean`
(Spring Boot's own `@MockBean` is deprecated as of Boot 3.4 and removed
in 4.x -- use `@MockitoBean` unless the project is pinned below 3.4).

**`@DataJpaTest`:** for a repository — loads only the JPA slice against
an embedded/test database, verifies query methods (including
`@EntityGraph`/`JOIN FETCH` actually avoid N+1 where that matters).

**`@SpringBootTest`:** only when the interaction across the whole wired
context is genuinely what is under test — it is the slowest option and
not a substitute for testing a service in isolation.

Cover: happy path, validation-failure cases (Bean Validation constraint
violations), the self-invocation `@Transactional` boundary if the change
touches one, and any N+1-prone query path.

### Step 3: Write

1. Create/extend the test file at the project's own convention path.
2. Construct the class under test directly when possible (Mockito
   `@Mock`/`@InjectMocks` or manual construction with mocks passed to the
   constructor); reach for `@MockitoBean` only inside a Spring test slice
   (`@MockBean` only on a project still pinned below Spring Boot 3.4).
3. For a controller test, assert status code, response body shape, and
   that a Bean Validation failure returns the expected 400 response.
4. For a repository test needing a real database, use Testcontainers
   when the project already has it wired up, rather than substituting an
   in-memory database that may not reject what production would.
5. Never wait for an async result with `Thread.sleep`/`delay` — use
   Awaitility's `await().atMost(...).until(...)`, a `CompletableFuture`
   join, or a `CountDownLatch`.

### Step 4: Run and fix

```bash
./gradlew test      # or: mvn test
```

Fix failing tests (max 3 iterations) — fix the test, not the source under
test, unless the test itself has correctly caught a real bug (say so in
the report rather than silently changing production code).

### Step 5: Report

```
Generated: OrderServiceTest, OrderControllerTest (MockMvc), OrderRepositoryTest (@DataJpaTest)
  - 9 test cases, all passing under ./gradlew test
```

## Rules

- ALWAYS match the project's existing test-slice, mocking, and assertion
  conventions found in Step 1, not a different project's style.
- NEVER modify source code — only test files.
- NEVER use `Thread.sleep`/`delay` to wait for an async result.
- ALWAYS choose the narrowest Spring test slice that covers what is being
  tested, not `@SpringBootTest` by default.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `Thread.sleep(500)` so the async call finishes before I assert" | Non-deterministic under load; use Awaitility or a real join/latch so the test cannot flake |
| "I'll just use `@SpringBootTest` for everything, it's simpler than picking a slice" | Loads the entire context for every test class, slowing the suite for no coverage benefit when a narrower slice (`@WebMvcTest`/`@DataJpaTest`) already isolates what's under test |
| "I'll swap in an in-memory H2 database instead of Testcontainers, it's faster" | An in-memory substitute can silently accept a query the real production database would reject or execute differently; use Testcontainers when the project already has it |
| "This test keeps failing intermittently, I'll just retry it in CI config" | Retrying hides a real determinism bug (often a missing join/await); fix the wait mechanism instead |

## Verification

Do not report the work done until all of the following hold:

- The test file sits at the project's own convention path, matching the
  slice/assertion style read in Step 1.
- `./gradlew test`/`mvn test` exits 0 with every generated test passing.
- `git status` shows only test files added or modified; no source file
  under test changed.
- No async wait in a new/changed test uses `Thread.sleep`/`delay`.
