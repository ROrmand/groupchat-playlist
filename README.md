# Baton

Sprint 1 foundation for a collaborative, cross-service group playlist application.

## Layout

- `Sources/TrackResolverEngine`: Foundation-only Swift 6 domain models, errors, and async dependency contracts. No Apple SDK or third-party dependencies.
- `Tests/TrackResolverEngineTests`: deterministic actor-isolated network/queue mocks, catalog fixtures, model and error tests.
- `server/src`: TypeScript modular monolith (`api`, `domain`, `db`, `jobs`, `providers`).
- `server/migrations`: immutable, checksummed forward-only PostgreSQL migrations.

## Verify

Requires Node.js 22.12+, npm, Docker, and Swift 6. Install backend dependencies with `npm ci --prefix server`, then run:

```sh
bash scripts/verify.sh
```

Without a local Swift toolchain, run `SWIFT_DOCKER=1 bash scripts/verify.sh` instead. Swift 6 language mode enables complete strict concurrency; compiler warnings are errors. The script runs Swift build/tests, TypeScript checking, offline unit tests, and PostgreSQL 16 integration tests. It launches and removes its own isolated database container on an ephemeral loopback port. Alternatively, set `TEST_DATABASE_URL` to a disposable PostgreSQL 16 instance with permission to create/drop test databases. Tests never contact streaming services or require Apple credentials; installing dependencies or initially pulling containers requires internet access.

## Run the server locally

```sh
docker compose up -d --wait postgres
cd server
cp .env.example .env
set -a; source .env; set +a
npm run migrate
npm run dev
```

`GET http://127.0.0.1:3000/healthz` returns 200 when the database responds, otherwise 503. Unknown routes return 404. `npm run build && npm start` runs the compiled server. Local database credentials are development-only; production must supply its own `DATABASE_URL` and secret management. Change the Compose host port and URL if 5432 is already occupied.

Migrations run explicitly before server startup, inside a transaction protected by a PostgreSQL advisory lock. Applied files cannot be edited or removed; introduce a new numbered SQL file for changes. The schema enforces active-item deduplication, event and delivery uniqueness, foreign keys, valid statuses, nonnegative counters, and append-only event rows. Authorization and atomic event-sequence allocation belong to later application-layer sprints; uniqueness alone does not enforce those behaviors.

## Queue scaffold and scope

Startup initializes pg-boss and four typed queues with bounded worker concurrency and exponential retries. Workers register through `JobQueue.register`; no production handlers are registered yet, so jobs are not falsely acknowledged before Sprint 3 implements delivery. The integration harness registers a test handler and verifies an actual persisted job is consumed. No live provider adapter, parser/canonicalizer, authentication, fan-out behavior, iOS target, entitlements, or persistent on-device queue is implemented in Sprint 1. The Swift protocols are dependency contracts, not a finalized HTTP wire format.

The CI skeleton runs the same verification gate on Linux. Darwin adapter compilation and the full release pipeline remain later-sprint work.
