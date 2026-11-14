# Sprint 2: ingestion and canonicalization

## Accepted scope

Implement the approved Sprint 2 specification and addendum: shared Swift/server chat parsing; bounded, SSRF-resistant metadata reads; ISRC-first catalog matching with explicit inclusive ±3,000 ms fallback matching; active-membership authorization; monotonic playlist events; and atomic pg-boss publication. The Swift target remains Foundation-only, immutable, and Swift 6 `Sendable`. No Darwin framework or core protocol changes are required.

Non-goals: Apple sign-in or user registration, OAuth/token refresh, playlist provisioning, provider playlist writes, removals, iOS UI, and production worker handlers. The development session helper is local administration tooling, not an authentication endpoint.

## Link contract

`ChatTextParser.parse` and `parseChatText` consume the same 30-case JSON fixture set in `Tests/TrackResolverEngineTests/Fixtures`. They recognize Spotify track URLs/URIs, regional Apple song/album-track URLs, and YouTube/YouTube Music watch and `youtu.be` links. Unicode slugs, markdown wrappers, emojis, repeated links, and trailing punctuation are handled. Output contains `provider`, `storefront`, `externalTrackId`, and a canonical HTTPS `url`.

Apple Music's `i` parameter is read as the song ID before generating a direct `/song/{id}` URL. Other tracking parameters, fragments, and slugs do not survive canonicalization. YouTube's `v` is retained. Storefront is lowercased for Apple Music and `global` for Spotify/YouTube source links; source catalog metadata does not prove downstream availability in every member storefront. Unsupported hosts, album-only links, non-HTTPS URLs, credentials, custom ports, encoded path separators, traversal paths, and ambiguous duplicate identity parameters are rejected. General-purpose URL shorteners are not followed; only the specified `youtu.be` form is supported.

Input is capped at 8,192 UTF-8 bytes and 64 URL candidates. The endpoint accepts exactly one distinct supported track; multiple tracks return 422 rather than silently selecting one.

## Network and provider boundaries

`MetadataIngester` only connects to configured exact hosts over HTTPS. Every hop resolves DNS anew, rejects the entire answer set if any address is non-public (including IPv6 and IPv4-mapped IPv6), and pins the selected address for the actual TLS connection. TLS SNI/certificate identity and the HTTP Host header remain the original provider hostname. Redirects are limited to three and the same origin, so authorization headers cannot be forwarded elsewhere. There is one three-second deadline across DNS, redirects, headers, and body reads. Body size is capped at 1 MiB, regardless of Content-Length; compressed responses are rejected to avoid decompression bombs. Network dependencies are injectable for deterministic offline tests.

The read-only metadata client uses:

- Apple Music catalog songs: `APPLE_MUSIC_DEVELOPER_TOKEN`.
- Spotify track API: `SPOTIFY_ACCESS_TOKEN` (refresh is deferred).
- YouTube Data video details: `YOUTUBE_API_KEY`. Only music-category, non-live videos attributed to an `Artist - Topic` channel are accepted; arbitrary uploads cannot reliably supply recording artist metadata and return 422. YouTube does not provide an ISRC in this response, so these entries require duration-verified fallback matching. Channel labels are a conservative ingestion filter, not a cryptographic assertion of artist identity.

No credentials are needed for automated tests. A missing provider credential produces a clear 503 configuration error for an uncached track, not fabricated metadata. Existing provider mappings can serve submissions without another metadata request. Full provider delivery/capability adapters remain Sprint 3.

## Catalog and concurrency decisions

ISRC is normalized and matched first. Fallback candidates must have identical normalized title/artist and a stored duration within ±3,000 ms. Different known ISRCs never merge through fallback; ambiguous candidates return 422. Missing ISRCs can be enriched later. Accents, punctuation, bracketed feature credits, deluxe labels, and remaster labels are normalized; live/acoustic/version labels remain significant.

Duration buckets are lookup keys, not equivalence proofs: adjacent durations can fall on opposite rounding boundaries, and the tolerance relation is not transitive. The key is `title::artist::roundedBucket`, with an `::isrc:{ISRC}` suffix for known recordings so distinct ISRCs with identical title/artist/duration do not violate the Sprint 1 unique-key constraint. The authoritative duration comparison uses an indexed SQL range query. Matching does not slide a canonical track's reference duration as additional providers arrive.

The Sprint 1 schema permits only one preferred external mapping per `(canonical_track_id, provider, storefront)`. Alternate external IDs resolving to the same recording reuse the canonical track without overwriting that preferred mapping; those alternate IDs may require metadata resolution again. A new unique reverse-mapping index prevents one external provider/storefront ID from being claimed by different canonical tracks.

Authorization is checked before metadata lookup and again under a membership row lock before writes. The playlist row is locked to allocate exactly one sequence per accepted addition. Catalog advisory locks serialize matching identities across different playlists. Active duplicates return 200 without advancing the sequence or publishing another job. New additions commit their catalog changes, item, `TRACK_ADDED` event, sequence, and pg-boss job together using the same PostgreSQL client. Any failure rolls everything back. No in-memory or post-commit publication gap exists.

Migration `002_catalog_ingestion.sql` only adds duration-search and reverse-mapping indexes; the initial migration stays unchanged. pg-boss initializes its own schema on server startup before requests are accepted. No production consumers acknowledge ingestion jobs until Sprint 3.

## API and sessions

```http
POST /api/playlists/{playlist-uuid}/items
Authorization: Bearer {session-jwt}
Content-Type: application/json

{"rawInput":"check this out https://music.apple.com/us/album/example/123?i=456"}
```

Only `rawInput` is accepted in the body; identity comes exclusively from the verified JWT subject. JSON bodies are capped at 16 KiB. Sessions require an HS256 signature, the configured issuer/audience, UUID subject, issuance time, expiration, and a maximum age of one hour. Configure a random `SESSION_JWT_SECRET` of at least 32 bytes; without it, ingestion fails closed with 503 while `/healthz` remains available. Each process bounds its per-user rate-limit storage to 10,000 identities and allows 60 authenticated ingestion requests per minute per user. Distributed/global rate limiting is not implemented.

Responses:

| Status | Meaning |
| --- | --- |
| 202 | New track: canonicalTrackId plus committed event |
| 200 | Already active: canonicalTrackId, null event, no new sequence/job |
| 400 / 413 / 415 | Invalid JSON/input/playlist ID, size limit, or wrong content type |
| 401 / 403 | Invalid session or no active membership |
| 422 | Unsupported/ambiguous input, unavailable track, unsafe URL/DNS, or unresolved metadata |
| 429 | Per-user request limit; Retry-After header supplied |
| 502 / 504 | Invalid/provider/network metadata failure or total metadata deadline exceeded |
| 503 | Missing configuration, provider throttling, or transactional ingestion unavailable |

Responses never include internal exception messages, provider credentials, or database connection strings. `/healthz` continues to check database availability, not provider credentials or actual fan-out delivery.

## Automated verification

From the Sprint 2 worktree:

```sh
npm ci --prefix server
SWIFT_DOCKER=1 bash scripts/verify.sh
npm run build --prefix server
```

Use `bash scripts/verify.sh` if Swift 6 is installed locally. The gate runs Swift build/tests with warnings as errors, shared parser fixtures, JWT/HTTP/SSRF/timeout/size/provider-reader tests, and PostgreSQL 16 migrations and integration tests. Database tests prove concurrent duplicates, cross-playlist ISRC convergence, different known recordings, exact duration boundaries, ISRC enrichment, unauthorized/revoked membership, gap-free event sequences, and rollback after the queued job insert. They use disposable databases and fake provider metadata, never live streaming accounts.

## Manual local test

These commands assume Bash (run `bash` first if your login shell is Fish). Start a local database, install dependencies, and migrate following the root README. If port 5432 is occupied, change the Compose host port and DATABASE_URL first.

In `server/.env`, configure the session secret and the credential for the provider you will test. Export the environment and create a local-only fixture user/group from the repository root:

```sh
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U baton -d baton <<'SQL'
INSERT INTO users (id, apple_sub, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'local-sprint2-user', 'Local Tester')
ON CONFLICT DO NOTHING;
INSERT INTO group_playlists (id, name, owner_id, invite_code)
VALUES ('00000000-0000-0000-0000-000000000002', 'Sprint 2 Test',
        '00000000-0000-0000-0000-000000000001', 'local-sprint2-invite')
ON CONFLICT DO NOTHING;
INSERT INTO playlist_memberships (id, group_playlist_id, user_id, status)
VALUES ('00000000-0000-0000-0000-000000000003',
        '00000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000001', 'active')
ON CONFLICT DO NOTHING;
SQL
cd server
set -a; source .env; set +a
npm run dev
```

In another Bash terminal, from `server`, load the same environment and mint a development-only 15-minute session for that existing user:

```sh
set -a; source .env; set +a
SESSION_TOKEN="$(npm run --silent session -- 00000000-0000-0000-0000-000000000001)"
curl -i http://127.0.0.1:3000/api/playlists/00000000-0000-0000-0000-000000000002/items \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"rawInput":"PASTE A REAL TRACK LINK FOR YOUR CONFIGURED PROVIDER HERE"}'
```

Replace the placeholder with a real song link. The first submission should return 202 with an event; repeating it returns 200 and a null event. Queued work will not write to any streaming playlist yet. The fixture inserts modify only your local development database; do not run them against production. The session helper cannot register users, create memberships, or run when NODE_ENV is production. Treat generated tokens as secrets and do not commit your `.env`.
