---
Title: Module src/harness/web
Version: 0.2.0
Type: component
Status: draft
Summary: "`src/harness/web` owns the harness web-access boundary: sandboxed page transport, web worker execution contracts, content normalization, and policy limits. It groups 8 files, depends on process sandboxing, search, and security detection, and exposes 10 public symbols."
---

# Module src/harness/web

## Summary

`src/harness/web` provides the web-facing execution boundary for the harness. It defines contracts for web page requests and worker execution, wraps web access in a sandboxed transport, normalizes page content, and enforces basic safety limits such as redirect counts and maximum returned text size.

The module depends on `src/harness/process/sandbox`, `src/harness/search`, `src/security/detect`, and broader `src/security` utilities. It is consumed primarily by `src/harness/tool/builtin` and by `src/harness/search`.

## Overview

This module is responsible for letting harness components interact with web resources without exposing raw network or worker behavior directly. Its main concern is containment: web requests and worker workloads should pass through explicit request/response shapes, configurable limits, and sandboxed execution paths.

The public surface combines interfaces and implementations. Interfaces such as `WebPageRequest`, `WebWorkerRequest`, `WebWorkerResponse`, and `WebWorkerRunner` describe the expected shapes for web and worker operations. Classes and functions such as `SandboxedWebTransport`, `SystemWebWorkerRunner`, and `createSystemWebWorkerRunner` provide concrete mechanisms for running those operations through controlled boundaries.

The module also contributes policy and content handling primitives. `web-policy` and `web-content` appear to define the rules and transformations around fetched web material, while `WEB_MAX_REDIRECTS` and `WEB_MAX_TEXT_BYTES` provide shared operational limits.

## How it works

The module is organized around three related concerns: request contracts, isolated execution, and content handling.

At the contract layer, `WebPageRequest` and `SandboxedWebTransportOptions` describe what a web fetch should target and how it should be constrained. Worker-related contracts, including `WebWorkerRequest`, `WebWorkerResponse`, and `WebWorkerRunner`, describe the expected input and output of web worker execution.

At the transport layer, `SandboxedWebTransport` is the primary class for performing web page operations through a sandboxed boundary. Its name and configuration type indicate that transport behavior is parameterized and constrained rather than raw. The dependency on `src/harness/process/sandbox` implies that execution or access paths may be wrapped by process-level sandboxing, while the dependency on `src/security/detect` and `src/security` implies that security checks are applied somewhere in the request or content path.

At the worker layer, `SystemWebWorkerRunner` and `createSystemWebWorkerRunner` provide a system-backed implementation of the `WebWorkerRunner` contract. This likely gives callers a standard way to start and manage web worker workloads through an approved runner abstraction rather than using platform-specific worker code directly.

At the content and policy layer, `web-content` and `web-policy` handle the shape and safety of web material. The constants `WEB_MAX_REDIRECTS` and `WEB_MAX_TEXT_BYTES` suggest that transport and content handling are intentionally bounded to reduce runaway requests and oversized payloads.

## Key concepts

### Web page request

A `WebPageRequest` is the normalized description of a web page operation that the transport layer can understand. It gives callers a standard way to express a page-oriented request without depending on low-level network details.

### Sandboxed web transport

`SandboxedWebTransport` is the module’s primary boundary for web access. Instead of exposing direct network calls, it provides a transport object configured through `SandboxedWebTransportOptions`. The sandboxed name indicates that execution context, request behavior, or returned data should be constrained by harness policy.

### Worker runner contract

`WebWorkerRunner` abstracts the execution of web worker tasks. Callers can program against the interface rather than against a particular worker implementation. `WebWorkerRequest` and `WebWorkerResponse` define the data passed into and produced by those tasks.

### System web worker runner

`SystemWebWorkerRunner` and `createSystemWebWorkerRunner` are the concrete system-backed worker implementation. They likely allow the harness to run worker-like operations using an approved environment while still presenting the `WebWorkerRunner` interface to consumers.

### Content policy and limits

The module includes shared policy constants, notably `WEB_MAX_REDIRECTS` and `WEB_MAX_TEXT_BYTES`. These concepts indicate that web access is subject to explicit operational ceilings, especially around redirect chains and the amount of textual content returned or processed.

## Main flows

### Flow: builtin tool performs a bounded web fetch

1. A consumer in `src/harness/tool/builtin` prepares a web operation.
2. The request is represented through the web-facing contracts exposed by this module, such as `WebPageRequest` and transport options.
3. `SandboxedWebTransport` performs the operation inside the module’s controlled boundary.
4. Policy limits such as redirect count and maximum returned text size constrain the outcome.
5. Security detection utilities may evaluate the request or returned content before it is treated as safe harness input.
6. The caller receives a result shaped by the module’s contracts rather than by raw transport internals.

### Flow: caller starts a web worker task

1. A caller constructs a `WebWorkerRequest` describing the worker task.
2. The caller obtains a runner through `createSystemWebWorkerRunner` or uses `SystemWebWorkerRunner` directly.
3. The runner executes the worker task through the `WebWorkerRunner` contract.
4. The result is returned as a `WebWorkerResponse`, allowing the caller to handle success, failure, or partial output without knowing the underlying system worker mechanics.

### Flow: search consumes normalized web content

1. `src/harness/search` depends on this module for web-facing behavior.
2. Web page or worker output is normalized and constrained by the web content layer.
3. Policy limits help ensure that indexed or processed text stays within expected size bounds.
4. Search integrations receive predictable web-derived content without directly managing transport or worker execution details.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `WEB_MAX_REDIRECTS`
- `WEB_MAX_TEXT_BYTES`
- `WebWorkerRequest` (interface)
- `WebWorkerResponse` (interface)
- `WebWorkerRunner` (interface)
- `WebPageRequest` (interface)
- `SandboxedWebTransportOptions` (interface)
- `SandboxedWebTransport` (class)
- `SystemWebWorkerRunner` (class)
- `createSystemWebWorkerRunner` (function)

### Key files

- `src/harness/web/sandboxed-web-transport.ts` - imported by 5, imports 3
- `src/harness/web/web-worker-runner.ts` - imported by 3, imports 4
- `src/harness/web/web-content.ts` - imported by 3, imports 3
- `src/harness/web/web-policy.ts` - imported by 5, imports 0
- `src/harness/web/sandboxed-web-transport.test.ts` - imported by 0, imports 1
- `src/harness/web/web-content.test.ts` - imported by 0, imports 1

### Depends on

- `src/harness/process/sandbox` - 2 import(s)
- `src/harness/search` - 1 import(s)
- `src/security/detect` - 1 import(s)
- `src/security` - 1 import(s)

### Depended on by

- `src/harness/tool/builtin` - 5 import(s)
- `src/harness/search` - 2 import(s)

### Graph signals

- Files: 8
- Cross-module imports: 5

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/process/sandbox](src-harness-process-sandbox.md)
- [Module src/harness/search](src-harness-search.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/security](src-security.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 0.2.0 - Enriched draft documentation into component documentation; status promoted to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections were drafts for the gdwiki enrich workflow.
