# Sprint 3: provider adapters and fan-out

## Accepted scope

This implements the Sprint 3 plan with the approved delivery-safety addendum:

- Server-side Apple Music, Spotify, and YouTube adapters share a registry and async contract.
- Membership delivery is ordered, independently retryable, and protected against concurrent replay.
- Connection tokens are encrypted at rest; OAuth refresh persists rotated credentials.
- Apple removals are handed off as `pending_client_reconcile`.
- Playlist-not-found transitions enqueue the existing recreation job. Actual playlist rebuilding and on-device reconciliation remain Sprint 6 work.
- No Swift core, MusicKit, entitlement, UI, sign-in, or provisioning changes are included.

## Runtime setup

Run migrations before starting the server. Migration `003_provider_fanout.sql` adds an explicit
`playlist_memberships.streaming_connection_id` selection, constrained to the same user. Existing
memberships are not silently assigned a provider. Sprint 4 provisioning must set this ID and
`external_playlist_id` before marking a membership active.

Set `TOKEN_ENCRYPTION_KEY` to a canonical base64-encoded 32-byte random key from secret management.
Without it, startup leaves fan-out handlers disabled and ingestion jobs stay queued. Existing
metadata credential configuration remains independent. Never commit secrets or put real tokens in fixtures.

Use `TokenVault.encrypt(token, connectionId)` for both connection token columns. The versioned
AES-256-GCM envelope uses a fresh nonce and authenticates the connection ID, so ciphertext cannot
be moved between connections. Plaintext legacy token columns are rejected; this is not a legacy
token migration. Keep the key backed up: changing it without re-encrypting stored tokens makes them
unreadable. The environment key is a single-key deployment interface, not a managed rotation service.

Provider settings:

| Provider | Configuration | Credentials stored per connection |
| --- | --- | --- |
| Apple Music | `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (PKCS#8 PEM; escaped newlines accepted), or `APPLE_MUSIC_DEVELOPER_TOKEN` | Music User Token |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` for refresh | OAuth access and refresh tokens |
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` for refresh | Google OAuth access and refresh tokens |

OAuth consent, scopes, and user connection provisioning remain Sprint 4. Provider write credentials
are not the shared Sprint 2 metadata access tokens. Tests use fake transports and need no live credentials.

## Provider behavior

Spotify uses the current `/v1/me/playlists` and `/v1/playlists/{id}/items` endpoints, rather than the
older routes in the original plan. It searches by exact ISRC when present and otherwise checks normalized
title, artist, and inclusive ±3,000 ms duration. Apple uses catalog ISRC filtering or the same conservative
metadata fallback; its developer JWT is ES256-signed and cached with a short expiry.

YouTube's Data API is the supported integration surface, not a private YouTube Music API. It has no
structured ISRC search. Candidate videos must match title, Topic-channel artist, duration, music
category, non-live state, and region restrictions. Ambiguous or missing results return unavailable.
Each insertion records the returned playlist-item ID, not the video ID, for deletion.

The contract supports batches, with conservative limits of 100 for Spotify/Apple and one for YouTube.
The fan-out worker intentionally delivers one event at a time. Transport requests are HTTPS-only to
fixed API origins, reject redirects, have a ten-second deadline, and cap response bodies at 1 MiB.
Provider bodies, raw exceptions, and credentials are not persisted as delivery errors.

## Delivery and failure semantics

Event fan-out handlers plan only active memberships with active selected connections and existing
external playlists. Planner log creation and per-member queue insertion share one transaction.
Delivery workers load authoritative events from PostgreSQL rather than trusting the job's track fields.

A dedicated session advisory lock serializes a membership; a second lock serializes use of the same
connection across groups, including token rotation. No database transaction or row lock is held during
provider I/O. Membership and connection eligibility are rechecked immediately before each provider write,
including after refresh. A remote request already in flight cannot be revoked atomically by PostgreSQL.

Workers drain from `last_synced_sequence + 1`, including newly arrived events after an earlier retry.
They yield to another job after 20 events. Only `delivered` and `skipped_unavailable` advance the cursor,
and log completion and cursor advancement commit together. A database trigger also prevents regression.

| Failure/state | Result |
| --- | --- |
| Null resolution / known unavailable | `skipped_unavailable`; advance contiguously |
| 401 with server OAuth | Refresh once, encrypt and persist tokens, retry the rejected call once |
| Non-refreshable/exhausted 401 | Mark connection `needs_reauth`; block cursor |
| 429 / safe transient read failure | Persist a retry deadline and enqueue only this membership with exponential backoff; honor Retry-After; at most five delivery attempts |
| Missing downstream playlist | Mark membership `recreating`; enqueue recreation handoff; block cursor |
| Apple removal | `pending_client_reconcile`; block cursor until client acknowledgment is implemented |
| Timeout, transport failure, or 5xx during mutation | `needs_reconcile`; do not automatically repeat the write |
| Persisted `delivering` after a crash | `needs_reconcile` on the next job; do not repeat the write |
| Invalid configuration / permission / exhausted retry | `failed_terminal`; block cursor |

The unique event/user log constraint prevents duplicate records; it does **not** make an external write
transactional. A crash after provider success but before database acknowledgment cannot be resolved
by retrying blindly. The persisted `delivering` marker deliberately trades automatic liveness for
duplicate prevention, including when a crash happens before the request is sent. Ambiguous writes
need operator/provider reconciliation; Sprint 3 does not provide a reconciliation UI or an automatic
cross-provider snapshot diff. Do not reset such rows to `pending` without confirming downstream state.

Reauthorization, playlist recreation, and client acknowledgment must explicitly repair/resume blocked
delivery state. This sprint records those handoffs; it does not claim they already recover themselves.
Successful provider writes are covered by offline contract tests, not live provider certification.

## Verification

```sh
npm ci --prefix server
SWIFT_DOCKER=1 bash scripts/verify.sh
npm run build --prefix server
git diff --check
```

The gate covers Swift 6 build/tests, backend type checking, mocked provider contracts, and isolated
PostgreSQL 16 migrations/delivery tests. Integration tests remain serial, create unique databases,
and close clients before dropping them without forced socket termination.
