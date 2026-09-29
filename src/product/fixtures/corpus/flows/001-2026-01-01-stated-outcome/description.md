# Retry checkout on a stale token

## Problem

Checkout fails when the session token expires mid-payment. Customers then start over.

## Expected Outcome

A stale token is refreshed once and the payment goes through.

### Outcome criteria

- Checkout error rate for expired tokens, read from the payment log a week after release
- Support tickets tagged "lost cart" per week
