---
name: java-kotlin-spring-implementation
description: "Use when writing new endpoint, service, or repository code in a Java or Kotlin backend built on Spring Boot -- wiring dependencies through a class's own constructor, splitting request handling across layers, marshaling a request payload into a validated object, deciding where a transaction boundary starts, and authoring a new Spring Data repository method. Covers new/extended code, not an existing diff's risks (that's the pack's own review skill) or fixing a broken build (that's its own build-fix skill)."
triggers:
  - "implement this feature in a Spring Boot service"
  - "add a new REST endpoint to this Java Spring controller"
  - "add a Kotlin Spring service that calls this repository"
  - "wire this DTO with jakarta.validation annotations"
  - "add a @Transactional method to this Spring service"
  - "implement this Spring Data JPA repository query"
  - "add constructor injection to this Spring @Service"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Java/Kotlin + Spring implementation (Spring Boot 3.x)

Implement or extend a feature in a Java or Kotlin Spring Boot codebase:
constructor injection, controller/service/repository layering, DTO
boundaries, transaction boundaries, Spring Data JPA queries, and Bean
Validation. Scoped to Java, Kotlin, and Spring Boot specifically —
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
carry the full stack-specific rule set this skill's checklist is built
from; read them before writing code, not just this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `pom.xml` or `build.gradle`/`build.gradle.kts` for the Spring
   Boot version, the build tool in use, and whether the module is Java or
   Kotlin (or mixed) — a `kotlin("jvm")`/`org.jetbrains.kotlin` plugin
   means Kotlin idiom applies alongside Java.
2. Find the existing layout: where controllers, services, repositories,
   and DTOs/entities live (`controller`/`service`/`repository`/`dto`/
   `entity` packages, or a feature-sliced layout). Match it; do not
   invent a different layout for one change.
3. Read 1-2 neighboring classes in the package you are touching for:
   dependency injection style already in use (constructor vs. field —
   flag field injection as a deviation from `rules/coding-style.mdc`
   rather than copying it into new code), the assertion/validation
   library already wired up, and whether the project uses Lombok,
   records, or Kotlin data classes for DTOs.

### Step 2: Design before writing

- Decide the layering for the change: does it need a new controller
  endpoint, a new/extended service method, a new repository query, or
  some combination? Keep each layer's responsibility narrow
  (`rules/patterns.mdc`).
- Decide the DTO shape for the API boundary — never expose the `@Entity`
  directly; map between entity and DTO in the service layer.
- For anything touching persistence, decide the transaction boundary up
  front: which method owns `@Transactional`, and does any call inside it
  risk the self-invocation pitfall (a call to another `@Transactional`
  method on `this`)? If so, plan to extract that method into a separate,
  constructor-injected bean instead.
- For a Spring Data JPA query touching a lazy association, decide the
  fetch strategy (`@EntityGraph`, `JOIN FETCH`, or a projection) before
  writing the repository method, not after profiling an N+1 in
  production.

### Step 3: Implement

1. Constructor-inject dependencies as `private final` fields (Java) or
   constructor `val` properties (Kotlin); never add a field-level
   `@Autowired`.
2. Keep the controller thin: parse/validate input (`@Valid` on the DTO
   parameter), delegate to the service, map the service's result/DTO to
   an HTTP response.
3. Put the `@Transactional` boundary on the service method that defines
   the unit of work; annotate Bean Validation constraints
   (`jakarta.validation`) on request DTO fields.
4. Write the Spring Data JPA repository method as a derived query name or
   a parameterized `@Query`, with `@EntityGraph`/`JOIN FETCH` when the
   query will touch a lazy association that would otherwise N+1.
5. Handle expected failure paths with a typed exception mapped by a
   `@ControllerAdvice`/`@ExceptionHandler`, not a broad try/catch that
   swallows the error in the service.
6. Kotlin: prefer `data class` for DTOs, avoid `!!`, use `?:`/`requireNotNull`
   for a value that must be present.

### Step 4: Verify

```bash
./gradlew build      # or: mvn verify
./gradlew test        # or: mvn test
./gradlew check       # or the project's configured lint/static-analysis task
```

Use whichever the project's own build tool is (check for `pom.xml` vs.
`build.gradle`/`build.gradle.kts`). Fix findings at the root cause per
`rules/coding-style.mdc` and `rules/security.mdc`; a build failure here
that is purely dependency/module-resolution related, unrelated to the
feature logic, is a signal to reach for `java-kotlin-spring-build-fix`
instead of debugging it as part of this skill's scope.

### Step 5: Report

```
Implemented: OrderController, OrderService, OrderRepository, OrderRequest/OrderResponse DTOs
  - Constructor injection throughout; @Transactional on OrderService.placeOrder
  - OrderRepository.findWithItems uses @EntityGraph to avoid N+1 on order items
  - ./gradlew build/test/check all pass
```

## Rules

- ALWAYS constructor-inject dependencies (`private final` in Java, `val`
  in Kotlin) — never add a field-level `@Autowired`.
- ALWAYS expose a DTO at the API boundary, never a JPA `@Entity` directly.
- NEVER call another `@Transactional` method on `this` from inside a
  `@Transactional` method and rely on the annotation firing — the
  self-invocation proxy pitfall means it will not.
- NEVER access a lazy association in a loop without an `@EntityGraph`/
  `JOIN FETCH`/projection to avoid N+1.
- ALWAYS annotate request DTO fields with `jakarta.validation`
  constraints and mark the controller parameter `@Valid`.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just use field `@Autowired` here, it's quicker to write" | Field injection hides the dependency graph and prevents `final`/`val`; constructor injection costs one line more and makes the class testable without the Spring container |
| "I'll call `this.processPayment()` from inside this `@Transactional` method, they're in the same class so it's fine" | Spring's declarative transactions are proxy-based; a same-class call bypasses the proxy and the inner `@Transactional` is silently a no-op |
| "This lazy collection is small in practice, I won't bother with @EntityGraph" | "Small in practice" during development is exactly what N+1 looks like once the collection grows in production; fix the fetch strategy at write time |
| "I'll just return the entity from the controller, mapping to a DTO is extra work" | An entity leaks persistence internals and lazy proxies into the HTTP response, and can throw `LazyInitializationException` outside the transaction |

## Verification

Do not report the work done until all of the following hold:

- The project's build/test/check tasks all exit 0.
- Every new Spring-managed dependency is constructor-injected, not field-
  injected.
- No new code calls a `@Transactional` method on `this` from within
  another method of the same class.
- Every new/changed lazy-association access path has an explicit fetch
  strategy (`@EntityGraph`, `JOIN FETCH`, or a projection).
- Every new request DTO field that should be validated carries a
  `jakarta.validation` constraint, and the controller parameter is
  `@Valid`.
