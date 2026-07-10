# Authentication via stateless JWT

Version: 1.0.0
Type: decision
Class: semantic
Status: superseded
Confidence: high
Valid-From: 2026-03-01
Valid-To: 2026-06-01
Recorded-At: 2026-03-01
Supersedes: decisions/auth-sessions.md
Superseded-By: decisions/auth-oauth.md

## Summary

Authentication uses stateless JWT bearer tokens signed with RS256.

## Details

Replaced session cookies to support horizontal scaling.

## Related Scopes

- Module: auth

## Tags

- authentication
- auth

## Changelog

- 1.0.0 - Initial decision.
- Superseded by decisions/auth-oauth.md on 2026-06-01.
