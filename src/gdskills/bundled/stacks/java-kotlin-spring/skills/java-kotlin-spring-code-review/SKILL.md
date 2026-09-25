---
name: java-kotlin-spring-code-review
description: "Use when reviewing a Java or Kotlin Spring Boot change for framework-specific risks -- field injection, @Transactional self-invocation, entities leaked across the API boundary, N+1 query patterns, missing Bean Validation, and overly permissive Spring Security configuration. Read-only, no edits."
triggers:
  - "review this Spring Boot diff for field injection"
  - "audit this Spring service for a @Transactional self-invocation pitfall"
  - "review this Spring controller for entity leakage"
  - "audit this Spring Data JPA repository for N+1 queries"
  - "review this Kotlin Spring change for missing validation"
  - "review this Spring Security configuration"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Java/Kotlin + Spring code review

Read-only review of a Java or Kotlin Spring Boot change for
framework-specific risks: field injection, `@Transactional`
self-invocation, entity leakage across the API boundary, N+1 query
patterns, missing Bean Validation, and permissive Spring Security
configuration. This skill never edits code — it reports findings.
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.java`/`*.kt`/`*.kts` files in the diff, not the whole
   repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed class against the focus list

**Dependency injection**
- A `@Component`/`@Service`/`@Repository`/`@Controller` with a field-level
  `@Autowired` — flag it, direction: constructor injection with a
  `private final` field (Java) or constructor `val` (Kotlin).

**Transaction boundaries**
- A call from one method to another `@Transactional` method on `this`
  within the same class (e.g. `this.chargePayment()`) — flag as the
  self-invocation proxy pitfall; the inner annotation is silently
  ignored. Fix direction: extract into a separate, constructor-injected
  bean.
- A `@Transactional` method performing unrelated blocking I/O (an
  outbound HTTP call, file access) that holds the transaction open longer
  than necessary — flag as worth confirming.

**API boundary**
- A controller or service method returning a JPA `@Entity` directly
  instead of a DTO — flag as leaking persistence internals and a
  `LazyInitializationException` risk once serialized outside the
  transaction.

**Spring Data JPA queries**
- A lazy association accessed inside a loop with no `@EntityGraph`/
  `JOIN FETCH`/projection — flag as an N+1 risk.
- Query text built by string concatenation/`String.format` with any
  user-influenced value instead of a parameterized `@Query` or derived
  method — flag as an injection risk.

**Validation**
- A request DTO field with no `jakarta.validation` constraint where the
  field is clearly meant to be required/bounded, or a controller
  parameter missing `@Valid`/`@Validated` — flag as a validation gap.

**Spring Security**
- Extending `WebSecurityConfigurerAdapter` — flag as targeting a removed
  Spring Security 5-era API; fix direction: a `SecurityFilterChain` bean.
- An authorization rule wider than the endpoint needs (a broad
  `permitAll()` covering more than intended), or CSRF disabled on a
  session-cookie-authenticated endpoint — flag with the specific rule/line.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (correctness,
leak, security), and the fix direction — but do not apply it.

```
src/main/java/billing/InvoiceService.java:52 — generateInvoice() calls
  this.applyLateFee() (also @Transactional) from inside another
  @Transactional method. Risk: proxy-based AOP means the inner
  @Transactional is silently ignored on a same-class call -- no separate
  transaction/rollback boundary for applyLateFee(). Fix direction:
  extract applyLateFee() into its own bean and call it through an
  injected reference.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag field injection, `@Transactional` self-invocation, entity leakage,
  N+1 query patterns, missing Bean Validation, and permissive/outdated
  Spring Security configuration; do not report generic style nits already
  covered by the project's formatter (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected N+1 is not certain from reading alone, say "confirm
  with a query log or a repository test asserting query count" rather
  than asserting it without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This is a small self-invocation, it probably still runs in the outer transaction anyway" | It does run inside whatever transaction the outer method already opened, but the inner method's own @Transactional settings (propagation, rollback rules) are silently skipped -- that's still a real finding to report |
| "It's just a config bean, field @Autowired here is harmless" | Field injection hides the dependency graph and blocks final/val regardless of the bean's role; report it the same way |
| "I'll just fix the missing @Valid myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "The entity being returned here is only used internally, it's fine to skip a DTO" | "Internal for now" drifts; the API boundary rule catches this before it becomes an external leak or a LazyInitializationException surprise |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.java`/`*.kt`/`*.kts` file in the diff was read, not
  just files named in the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
