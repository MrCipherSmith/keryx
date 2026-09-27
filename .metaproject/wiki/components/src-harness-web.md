---
Title: Module src/harness/web
Version: 0.2.0
Type: component
Status: draft
Summary: "`src/harness/web` provides the web-facing execution boundary for the harness. It defines contracts for web page requests and worker execution, wraps web access in a sandboxed transport, normalizes page content, and enforces basic safety limits such as redirect counts and maximum returned text size."
---

# Module src/harness/web

## Summary

`src/harness/web` provides the web-facing execution boundary for the harness. It defines contracts for web page requests and worker execution, wraps web access in a sandboxed transport, normalizes page content, and enforces basic safety limits such as redirect counts and maximum returned text size.

The module depends on [src/harness/process/sandbox](src-harness-process-sandbox.md) for process-level isolation, [src/harness/search](src-harness-search.md) for search integration, and [src/security/detect](src-security-detect.md) along with broader [src/security](src-security.md) utilities for security checks. It is consumed primarily by [src/harness/tool/builtin](src-harness-tool-builtin.md) and by `src/harness/search`.

## Overview

This module is responsible for letting harness components interact with web resources without exposing raw network or worker behavior directly. Its main concern is containment: web requests and worker workloads pass through explicit request/response shapes, configurable limits, and sandboxed execution paths.

The public surface combines interfaces and implementations:

- **Interfaces**: `WebPageRequest`, `WebWorkerRequest`, `WebWorkerResponse`, `WebWorkerRunner`, and `SandboxedWebTransportOptions` describe the expected shapes for web and worker operations.
- **Implementations**: `SandboxedWebTransport`, `SystemWebWorkerRunner`, and `createSystemWebWorkerRunner` provide concrete mechanisms for running those operations through controlled boundaries.
- **Policy and content handling**: `web-policy` and `web-content` define rules and transformations for fetched web material, while `WEB_MAX_REDIRECTS` and `WEB_MAX_TEXT_BYTES` enforce shared operational limits.

## How it works

The module is organized around three concerns: request contracts, isolated execution, and content handling.

### Contract layer

`WebPageRequest` and `SandboxedWebTransportOptions` describe what a web fetch should target and how it should be constrained. Worker-related contracts—`WebWorkerRequest`, `WebWorkerResponse`, and `WebWorkerRunner`—describe the expected input and output of web worker execution.

### Transport layer

`SandboxedWebTransport` is the primary class for performing web page operations through a sandboxed boundary. The dependency on [src/harness/process/sandbox](src-harness-process-sandbox.md) implies that execution or access paths are wrapped by process-level sandboxing, while the dependency on [src/security/detect](src-security-detect.md) and [src/security](src-security.md) implies that security checks are applied to requests or content.

### Worker layer

`SystemWebWorkerRunner` and `createSystemWebWorkerRunner` provide a system-backed implementation of the `WebWorkerRunner` contract. Callers can start and manage web worker workloads through an approved runner abstraction rather than using platform-specific worker code directly.

### Content and policy layer

`web-content` and `web-policy` handle the shape and safety of web material. The constants `WEB_MAX_REDIRECTS` and `WEB_MAX_TEXT_BYTES` bound transport and content handling to reduce runaway requests and oversized payloads.

## Key concepts

### Web page request

A `WebPageRequest` is the normalized description of a web page operation that the transport layer can understand. It gives callers a standard way to express a page-oriented request without depending on low-level network details.

### Sandboxed web transport

`SandboxedWebTransport` is the module's primary boundary for web access. Instead of exposing direct network calls, it provides a transport object configured through `SandboxedWebTransportOptions`. The sandboxed name indicates that execution context, request behavior, or returned data is constrained by harness policy.

### Worker runner contract

`WebWorkerRunner` abstracts the execution of web worker tasks. Callers can program against the interface rather than against a particular worker implementation. `WebWorkerRequest` and `WebWorkerResponse` define the data passed into and produced by those tasks.

### System web worker runner

`SystemWebWorkerRunner` and `createSystemWebWorkerRunner` are the concrete system-backed worker implementation. They allow the harness to run worker-like operations using an approved environment while still presenting the `WebWorkerRunner` interface to consumers.

### Content policy and limits

The module includes shared policy constants: `WEB_MAX_REDIRECTS` and `WEB_MAX_TEXT_BYTES`. These ensure web access is subject to explicit operational ceilings, especially around redirect chains and the amount of textual content returned or processed.

## Main flows

### Flow: builtin tool performs a bounded web fetch

1. A consumer in [src/harness/tool/builtin](src-harness-tool-builtin.md) prepares a web operation.
2. The request is represented through the web-facing contracts exposed by this module, such as `WebPageRequest` and transport options.
3. `SandboxedWebTransport` performs the operation inside the module's controlled boundary.
4. Policy limits such as redirect count and maximum returned text size constrain the outcome.
5. Security detection utilities may evaluate the request or returned content before it is treated as safe harness input.
6. The caller receives a result shaped by the module's contracts rather than by raw transport internals.

### Flow: caller starts a web worker task

1. A caller constructs a `WebWorkerRequest` describing the worker task.
2. The caller obtains a runner through `createSystemWebWorkerRunner` or uses `SystemWebWorkerRunner` directly.
3. The runner executes the worker task through the `WebWorkerRunner` contract.
4. The result is returned as a `WebWorkerResponse`, allowing the caller to handle success, failure, or partial output without knowing the underlying system worker mechanics.

### Flow: search consumes normalized web content

1. [src/harness/search](src-harness-search.md) depends on this module for web-facing behavior.
2. Web page or worker output is normalized and constrained by the web content layer.
3. Policy limits help ensure that indexed or processed text stays within expected size bounds.
4. Search integrations receive predictable web-derived content without directly managing transport or worker execution details.

---

## Reference

### Public API

- `WEB_MAX_REDIRECTS`
- `WEB_MAX_TEXT_BYTES`
- `WebPageRequest` (interface)
- `SandboxedWebTransportOptions` (interface)
- `SandboxedWebTransport` (class)
- `WebWorkerRequest` (interface)
- `WebWorkerResponse` (interface)
- `WebWorkerRunner` (interface)
- `SystemWebWorkerRunner` (class)
- `createSystemWebWorkerRunner` (function)

### Key files

| File | Imports | Exports |
|------|---------|---------|
| `src/harness/web/sandboxed-web-transport.ts` | 3 | 5 |
| `src/harness/web/web-worker-runner.ts` | 4 | 3 |
| `src/harness/web/web-content.ts` | 3 | 3 |
| `src/harness/web/web-policy.ts` | 0 | 5 |
| `src/harness/web/sandboxed-web-transport.test.ts` | 1 | 0 |
| `src/harness/web/web-content.test.ts` | 1 | 0 |

### Dependencies

- [src/harness/process/sandbox](src-harness-process-sandbox.md) — process-level sandboxing
- [src/harness/search](src-harness-search.md) — search integration
- [src/security/detect](src-security-detect.md) — security detection
- [src/security](src-security.md) — security utilities

### Dependents

- [src/harness/tool/builtin](src-harness-tool-builtin.md) — 5 imports
- [src/harness/search](src-harness-search.md) — 2 imports

## Related

- [Wiki Index](../index.md)
- [Module src/harness/process/sandbox](src-harness-process-sandbox.md)
- [Module src/harness/search](src-harness-search.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/security](src-security.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)
