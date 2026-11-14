# Baton

Track ingestion and provider fan-out for a collaborative, cross-service group playlist application.

The server now accepts authenticated track submissions, resolves configured provider metadata, deduplicates canonical recordings, and atomically stores playlist items, events, and fan-out jobs. See `docs/sprint-2.md` for the accepted implementation decisions and a local testing walkthrough.

Sprint 3 adds streaming write adapters, encrypted token handling, and ordered per-member delivery. See `docs/sprint-3.md` for setup, offline verification, and reconciliation limitations.

Sprint 4 adds backend Apple identity verification, revocable sessions, streaming connections, invitations, and downstream-playlist provisioning. Historical backfill remains a Sprint 6 handoff. See `docs/sprint-4.md` for the accepted scope and `docs/sprint-4-verification.md` for configuration, HTTP contracts, and provider-account verification.

Future native onboarding, historical backfill, recreation, reconciliation, and production rollout are subject
to the provider-specific acceptance criteria in `docs/provider-compliance-roadmap.md`. That roadmap assigns
consent and legal surfaces to Sprint 5, data lifecycle and compliant backfill to Sprint 6, and requires a
dated Spotify, Apple Music, and YouTube Music review before production release.

## Layout

- `Sources/TrackResolverEngine`: Foundation-only Swift 6 domain models, errors, async dependency contracts, and chat link parser. No Apple SDK or third-party dependencies.
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

The environment-loading line above is for Bash-compatible shells. In Fish, use:

```fish
cd server
for line in (string match -r '^[A-Za-z_][A-Za-z0-9_]*=.*' < .env)
    set -gx (string split -m 1 = $line)
end
npm run migrate
npm run dev
```

`GET http://127.0.0.1:3000/healthz` returns 200 when the database responds, otherwise 503. Unknown routes return 404. `npm run build && npm start` runs the compiled server. Local database credentials are development-only; production must supply its own `DATABASE_URL` and secret management. If 5432 is occupied, run `POSTGRES_PORT=5433 docker compose up -d --wait postgres` and use `localhost:5433` in `DATABASE_URL`.

Migrations run explicitly before server startup, inside a transaction protected by a PostgreSQL advisory lock. Applied files cannot be edited or removed; introduce a new numbered SQL file for changes. The schema enforces active-item deduplication, event and delivery uniqueness, foreign keys, valid statuses, nonnegative counters, and append-only event rows. The ingestion service verifies active membership, locks playlist state, and commits the next sequence, item, event, and queue job in one PostgreSQL transaction.

## Queue workers and scope

Startup initializes pg-boss and six typed queues with bounded worker concurrency and exponential retries. Setting `TOKEN_ENCRYPTION_KEY` enables addition/removal planners and the per-member delivery worker; without it ingestion jobs remain queued. Adding `SESSION_JWT_SECRET` enables Sprint 4 onboarding and the provisioning worker. Configure Apple sign-in keys and provider OAuth redirect URIs to enable those authorization routes. Active memberships require an explicitly selected connection and an external playlist. Metadata reads use separate credentials from playlist-write adapters. iOS targets, entitlements, persistent on-device queues, historical backfill, recreation, and client reconciliation remain later work. The Swift protocols are dependency contracts, not a finalized HTTP wire format.

The CI skeleton runs the same verification gate on Linux. Darwin adapter compilation and the full release pipeline remain later-sprint work.
