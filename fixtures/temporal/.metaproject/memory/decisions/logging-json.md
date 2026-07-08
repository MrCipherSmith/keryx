# Structured JSON logging

Version: 1.0.0
Type: decision
Status: accepted
Confidence: high

## Summary

All services emit structured JSON logs to stdout.

## Details

A control entry with no bitemporal fields — must always be current and must
parse identically to a pre-Block-C entry.

## Related Scopes

- Module: platform

## Tags

- logging
- observability

## Changelog

- 1.0.0 - Initial decision.
