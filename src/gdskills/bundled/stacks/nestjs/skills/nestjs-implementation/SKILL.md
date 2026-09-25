---
name: nestjs-implementation
description: "Use when building or extending a NestJS module, controller, guard, interceptor, pipe, or exception filter -- choosing provider scope and registering a cross-cutting concern globally via APP_GUARD/APP_INTERCEPTOR/APP_PIPE/APP_FILTER, and keeping controllers thin with business rules delegated downstream. Scoped to authoring new behavior in an app that already boots; excludes selecting field-level checks on a request body, a finished-diff review pass, and diagnosing why an already-written module stops the app from starting."
triggers:
  - "add a new NestJS module for this feature"
  - "wire this provider into the NestJS DI container"
  - "implement a NestJS guard for this route"
  - "register a global interceptor in NestJS"
  - "create an exception filter for this NestJS app"
  - "should this NestJS provider be request-scoped"
  - "move this logic out of the controller into a dedicated provider"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# NestJS implementation (modules, providers, DI, request pipeline)

Build or extend a NestJS module: controllers, services, and the
guards/interceptors/pipes/filters that make up the request pipeline around
them, wired through Nest's dependency injection. See `rules/patterns.mdc`
for the module/provider design this skill applies, `rules/coding-style.mdc`
for naming and typing, and `rules/security.mdc` for the AuthN/AuthZ and
input-validation shape a new endpoint must satisfy. DTO decorator choice is
the existing `nestjs-dto.mdc` rule's ground, not repeated here.

## Workflow

### Step 1: Discover the project's own conventions

Read the nearest existing feature module (a sibling `<feature>/` directory
under `src/`) before writing a new one. Match its file-splitting convention
(one module per feature vs. sub-modules), its DTO/validation setup, its
exception-filter and guard registration style (global via `APP_GUARD`/
`APP_FILTER` vs. per-controller `@UseGuards`), and its provider-scope
choices. Do not introduce a different pattern in one module without a
concrete reason stated in the change.

### Step 2: Design the module shape

- Identify what the new module owns: which controller(s), which
  service(s), which providers a service needs (repository, HTTP client,
  config).
- Decide what the module needs to `import` from other feature modules, and
  what it needs to `export` if another module will consume one of its
  providers.
- Default every new provider to the framework's default (Singleton) scope
  unless it genuinely needs per-request state — see `rules/patterns.mdc`
  on `Scope.REQUEST`'s real cost.

### Step 3: Implement the controller-service split

- The controller method: validate input via a typed DTO class (see the
  existing `nestjs-dto.mdc` rule for the decorator set), call exactly one
  service method for the actual work, and shape the response.
- The service method: an explicit return type, business logic, and a typed
  NestJS `HttpException` subclass (or a domain error the controller/filter
  translates) on failure — never a controller that reaches into a
  repository directly (see `rules/patterns.mdc`, "Controllers vs.
  services").

### Step 4: Add cross-cutting concerns at the right layer

- A concern that applies to (nearly) every route in the app (auth, request
  logging, response shaping) goes in a guard/interceptor/pipe registered
  globally as an `APP_GUARD`/`APP_INTERCEPTOR`/`APP_PIPE`/`APP_FILTER`
  provider in a module's `providers` array, not `app.useGlobalGuards()` on
  the bootstrapped instance -- the `APP_*` token form keeps the provider
  inside Nest's own DI graph so it can inject other providers (e.g. a
  guard that injects `Reflector` or a `UsersService`).
- A concern scoped to one controller or route goes on that controller/
  method with `@UseGuards()`/`@UseInterceptors()`/`@UsePipes()`.
- When a global guard protects most routes, mark the deliberate exceptions
  with a custom decorator backed by `SetMetadata` and read via `Reflector`
  in the guard (e.g. a `@Public()` decorator) rather than leaving some
  controllers undecorated.

### Step 5: Verify

Run the project's own build/type-check/test scripts (see Verification
below) and confirm the new module compiles into the app's DI graph with no
`UnknownDependenciesException`/circular-dependency warning at startup --
not just that `tsc` is clean.

## Rules

- Follow `rules/coding-style.mdc` for naming, file-per-role layout, and
  typing; `rules/patterns.mdc` for module/provider/guard design; and
  `rules/security.mdc` for what a new endpoint's validation and auth must
  cover before it is considered done.
- ALWAYS keep the controller thin: parse/validate, delegate to one service
  call, shape the response.
- ALWAYS register a cross-cutting concern once (globally via an `APP_*`
  token, or via a reusable decorator), never copy-pasted into every
  controller that needs it.
- NEVER inject a `REQUEST`-scoped or `TRANSIENT` provider into a Singleton
  provider -- it silently makes the Singleton request-scoped too (Nest
  propagates scope up the injection graph) or throws at resolution time,
  and either way defeats the point of a Singleton service.
- NEVER put a repository/ORM call directly in a controller method.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just call the repository from the controller, it's one line" | It's untestable without the HTTP stack and duplicates the service's job the next time this logic is needed elsewhere |
| "I'll decorate every controller with this guard instead of making it global" | Any new controller anyone adds later silently starts unprotected; a global `APP_GUARD` with an explicit `@Public()` opt-out fails safe instead |
| "This provider doesn't need DI, I'll just `new` it inline in the service" | It bypasses testability via `overrideProvider` and any lifecycle hooks (`OnModuleInit`/`OnModuleDestroy`) the class relies on |
| "I'll make this provider REQUEST-scoped just in case" | Request scope re-instantiates the whole injection subtree per request; only reach for it when per-request state is a genuine requirement |

## Verification

Do not report the implementation done until all of the following hold:

- The project's build command (`nest build` or its `package.json`
  equivalent) and `tsc --noEmit` both exit 0.
- The app boots locally (or the project's e2e bootstrap test passes) with
  no `UnknownDependenciesException`, circular-dependency warning, or
  missing-export error at startup.
- Every new/changed controller method that accepts user input has a
  validated DTO and, where the endpoint should not be public, a guard --
  either explicit or inherited from a global `APP_GUARD`.
- No business logic or direct repository/ORM call was added to a
  controller.
- `git status` shows changes confined to the module(s) the feature
  actually touches.
