---
name: php-laravel-build-fix
description: "Use when composer install/update fails, PHP fatal errors block a Laravel app from booting, phpstan/larastan reports a failing analysis, or a previously-passing test suite is now failing -- resolves dependency conflicts, autoload issues, config/service-provider errors, and static-analysis findings with the smallest root-cause fix."
triggers:
  - "composer install is failing"
  - "this Laravel app throws a fatal error on boot"
  - "phpstan is failing on this file"
  - "fix this class not found autoload error"
  - "the service provider isn't registering correctly"
  - "php artisan test is failing after this change"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# PHP / Laravel build fix

Resolve a `composer install`/`update` failure, a PHP fatal error blocking
a Laravel app from booting, a `phpstan`/Larastan analysis failure, an
autoload/class-not-found error, a misconfigured service provider, or a
newly-failing test suite — with the smallest change that fixes the actual
root cause. `rules/coding-style.mdc` and `rules/security.mdc` govern what
a "correct" fix looks like; this skill never reaches for a suppression
instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
composer install
php artisan config:clear && php artisan cache:clear
./vendor/bin/phpstan analyse   # if configured (Larastan)
php artisan test
```

Read the exact error text and classify it:

- **Dependency conflict** (`composer install`/`update` reports a version
  constraint that cannot be satisfied, or a platform requirement
  mismatch against the installed PHP version).
- **Autoload/class-not-found** (`Class "App\..." not found`, usually a
  PSR-4 namespace/path mismatch, or `composer dump-autoload` needed after
  a new class).
- **Boot-time fatal** (a service provider throwing during `register()`/
  `boot()`, a missing `.env` value a config file requires, a stale cached
  config/route/view referencing something that moved).
- **Static-analysis finding** (`phpstan`/Larastan reporting a real type
  mismatch, an undefined property, or a missing return type).
- **Test failure** introduced by the change under investigation (not a
  pre-existing flaky test — confirm by re-running in isolation).

### Step 2: Fix by category

**Dependency conflict:** run `composer why <package>`/`composer why-not
<package> <version>` before bumping anything by hand; resolve the actual
constraint mismatch (a package requiring a PHP version, or two packages
requiring incompatible versions of a shared dependency) rather than
force-installing with `--ignore-platform-reqs` or blindly widening a
`composer.json` constraint.

**Autoload/class-not-found:** check the class's namespace matches its
file path under the PSR-4 mapping in `composer.json`; run `composer
dump-autoload` after adding a new class if the error persists with a
correct namespace/path. Do not "fix" this by adding a manual `require`
for an autoloaded class.

**Boot-time fatal:** read the actual exception and trace it to the
service provider/config file it originates from; run `php artisan
config:clear`/`route:clear`/`view:clear` first when the error looks stale
(references something already renamed/removed) before changing code. Fix
a missing required `.env` value by documenting it in `.env.example`
rather than hard-coding a fallback secret in code.

**Static-analysis finding:** fix the type mismatch, missing return type,
or undefined-property access the finding names. Never add
`@phpstan-ignore-next-line`/`@psalm-suppress`/a blanket
`ignoreErrors` entry in `phpstan.neon` to silence a finding without
addressing what it found.

**Test failure:** read the actual assertion failure; fix the source
change that broke the contract the test verifies, unless the test itself
is asserting the wrong thing for a deliberate behavior change (say so in
the report rather than silently loosening the assertion).

### Step 3: Verify

```bash
composer install
./vendor/bin/phpstan analyse   # if configured
php artisan test
```

All must exit 0 before reporting done.

### Step 4: Report

```
Fixed: composer.json version constraint mismatch (guzzlehttp/guzzle)
  - Root cause: a new dependency required guzzle ^7.8, composer.json pinned ^6.0
  - composer install / phpstan analyse / php artisan test all pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER add `@phpstan-ignore-next-line`, `@psalm-suppress`, or a blanket
  `ignoreErrors` entry to silence a static-analysis finding instead of
  fixing what it found.
- NEVER widen `$fillable` to a catch-all allowlist, or set `$guarded = []`
  on a model, just to make a mass-assignment error disappear.
- NEVER install with `--ignore-platform-reqs` to route around a real
  version conflict without confirming it is an intentional, documented
  override.
- NEVER delete or skip a failing test to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `@phpstan-ignore-next-line` here so the analysis passes" | Silences the finding without fixing the type mismatch/undefined access it caught; fix the actual code instead |
| "I'll just run composer with `--ignore-platform-reqs`" | Installs a dependency the running PHP version does not actually satisfy, deferring the real failure to runtime instead of fixing the constraint |
| "This model's mass-assignment error goes away if I set `$guarded = []`" | Disables mass-assignment protection entirely for every attribute, trading a build error for a security defect |
| "This test is flaky after my change, I'll skip it for now" | Hides a real regression instead of fixing the change that broke the contract the test verifies |

## Verification

Do not report the fix done until all of the following hold:

- `composer install`, the project's static analysis (if configured), and
  `php artisan test` all exit 0.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- No `@phpstan-ignore-next-line`/`@psalm-suppress`/`ignoreErrors` entry
  was added to silence a finding.
- The report states the root cause in one sentence, not just "build now
  passes."
