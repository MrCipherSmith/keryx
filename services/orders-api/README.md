# orders-api

The orders service behind the storefront and the operator dashboard. NestJS 10, TypeORM 0.3, PostgreSQL 15.

## Conventions

- `openapi.yaml` is the contract. Every endpoint is defined there first; clients are generated from it.
- All routes are under `/v1`. A breaking change ships as `/v2` next to `/v1`.
- `ValidationPipe` runs globally (`src/main.ts`) with `whitelist`, `forbidNonWhitelisted` and `transform`. A validation failure answers `400` with the `ApiError` envelope.
- Every error response goes through `ApiErrorFilter` and has the `ApiError` shape: `code`, `message`, optional `details`, `requestId`.
- Mutations that create state accept an `Idempotency-Key` header (`IdempotencyInterceptor`).
- Orders and customers are soft-deleted (`deleted_at`).
- Migrations run before the new code is rolled out; old pods keep serving during the rollout.

## Data volume

- `orders`: about 40 million rows, 30k inserts per hour at peak.
- `customers`: about 3 million rows.
- `GET /v1/orders` backs the dashboard order list and is called on every page load (about 50 requests per second at peak).
