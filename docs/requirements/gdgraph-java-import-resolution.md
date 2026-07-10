# gdgraph Java Import Resolution

## Status
draft

## Overview
Extend gdgraph's import resolution to support Java projects by integrating with Maven/Gradle build configs. Currently, Java source files are scanned and imports are extracted, but cannot be resolved to actual file paths due to lack of package-to-directory mapping.

## Problem
After Java language support was added to gdgraph (file scanning, import extraction), the import resolution layer fails to resolve Java imports:
- Example: `import io.dev.admin.dto.FixReplicaRequest;` cannot be mapped to `src/main/java/io/dev/admin/dto/FixReplicaRequest.java`
- Root cause: `resolveImport()` uses only `tsconfig.json` (TypeScript/JavaScript specific)
- Result: Java graphs have 0 edges despite thousands of nodes and valid imports

## Requirements

### Functional
1. **Maven support** (pom.xml):
   - Parse `pom.xml` to extract source directories (sourceDirectory, testSourceDirectory)
   - Build package-to-directory mappings from project structure
   - Resolve `io.dev.admin.dto.FixReplicaRequest` → `src/main/java/io/dev/admin/dto/FixReplicaRequest.java`

2. **Gradle support** (build.gradle):
   - Parse `build.gradle` to extract source directories (sourceSets)
   - Similar package-to-directory mapping logic
   - Support both Groovy and Kotlin DSL syntax

3. **Import resolution**:
   - Update `importCandidateBases()` to handle Java fully-qualified names
   - Create `loadMavenResolver()` and `loadGradleResolver()` functions (similar to `loadTsconfigResolver`)
   - Integrate into existing `resolveImport()` call site

### Non-Functional
- Zero breaking changes to existing TS/JS resolution
- Fallback gracefully if pom.xml or build.gradle missing
- Performance: resolve once per build, cache result
- Test coverage: unit tests for Maven and Gradle parsers

## Success Criteria
- vantage-backend Java graph build shows `> 0 edges` (currently 0)
- At least 80% of extractable imports resolve to actual files
- All existing tests pass
- No performance regression on TS/JS projects

## Related
- Feature: [gdgraph] Add Java and Python language support (merged)
- Blocker: Java import resolution prevents dependency analysis

## Notes
- Java packages use `.` separator; directory structure mirrors packages (io/dev/admin/dto/)
- May need to handle multi-module Maven projects (aggregators)
- Consider caching resolved mappings to avoid re-parsing on each build
