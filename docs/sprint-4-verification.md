# Sprint 4: configuration and verification

## Automated gate

Run from the repository root with Node.js 22.12+, npm, Docker, and Swift 6:

```sh
npm ci --prefix server
bash scripts/verify.sh
npm run build --prefix server
git diff --check
```

If Swift is not installed locally, use `SWIFT_DOCKER=1 bash scripts/verify.sh`. The gate runs Swift
build/tests with warnings as errors, TypeScript checking, offline unit tests, and PostgreSQL 16
migration/integration tests in an isolated disposable database. Provider transports and Apple key
sets are mocked. Tests never authenticate real accounts or create real streaming playlists.

## Configuration

Use `server/.env.example`; never commit populated credentials. Apply migrations before startup.

| Configuration | Purpose |
| --- | --- |
| `SESSION_JWT_SECRET` | At least 32 random bytes; Baton access-token signing. Keep issuer/audience stable. |
| `TOKEN_ENCRYPTION_KEY` | Canonical base64 encoding of 32 random bytes; provider credentials, PKCE verifier encryption, and invitation derivation. |
| `APPLE_SIGNIN_CLIENT_ID`, `APPLE_SIGNIN_TEAM_ID`, `APPLE_SIGNIN_KEY_ID`, `APPLE_SIGNIN_PRIVATE_KEY` | Sign in with Apple identity. Separate from the Apple Music signing configuration. Escaped PEM newlines are accepted. |
| `APPLE_SIGNIN_REDIRECT_URI` | Optional exact registered HTTPS redirect URI, only when used to issue the Apple authorization code. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` | Spotify authorization and refresh; callback must be the exact registered HTTPS `/api/connections/spotify/callback` URL. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google authorization and refresh; callback must be the exact registered HTTPS `/api/connections/youtube_music/callback` URL. |
| `OAUTH_RETURN_TARGETS` | Comma-separated exact HTTPS client return URLs; no wildcards, credentials, or fragments. |
| `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` or `APPLE_MUSIC_DEVELOPER_TOKEN` | Existing Apple Music server developer-token configuration. |

Onboarding requires both session signing and token encryption configuration. An OAuth provider also
needs its redirect URI before authorization-begin is enabled. Apple sign-in is independently disabled
until all its signing fields are present. A partially specified signing configuration fails startup.

Access tokens expire after 15 minutes. Refresh families have a fixed 30-day lifetime; refresh tokens
rotate, and reuse of an old token revokes that family. Authenticated API calls check database revocation.
Logout and revoke-all affect Baton sessions, not provider consent. Disconnecting a streaming connection
revokes it locally, erases its stored credentials, and pauses selected memberships; it does not call
the provider's consent-revocation endpoint.

Preserve the encryption key across restarts. Changing it without a migration loses access to encrypted
credentials and changes derived invitation secrets. Invitation and idempotency tables retain only IDs,
metadata, and token hashes, not plaintext invitation secrets. Key rotation is a separate migration task.

The local `npm run session -- <existing-user-uuid>` helper creates a database-backed, revocable
15-minute session with no refresh token; run migrations first. It refuses `NODE_ENV=production`.
With onboarding enabled, old stateless tokens are rejected: generate a new local token after upgrading.
When onboarding is disabled, legacy stateless ingestion authentication requires explicit
`ALLOW_DEV_SESSIONS=1`; production startup rejects this flag.

## HTTP contract

POST bodies must be JSON objects, at most 16 KiB, with unknown fields rejected. Bearer requests use
`Authorization: Bearer <accessToken>`. Group creation, invite creation, and provisioning also require
an `Idempotency-Key` of 8–128 ASCII letters, digits, underscores, or hyphens. Reuse a key only with the
same body and operation; conflicting reuse returns `409 idempotency_conflict`.

| Method and path | Body / result | Authentication |
| --- | --- | --- |
| `POST /api/auth/apple/challenge` | `{}` -> `challenge`, `nonce`, `expiresIn: 300` | Public, rate-limited |
| `POST /api/auth/apple` | `code`, `challenge` -> `userId`, `accessToken`, `refreshToken`, `expiresIn: 900` | Single-use challenge + Apple code |
| `POST /api/auth/refresh` | `refreshToken` -> rotated access/refresh pair | Refresh grant |
| `POST /api/auth/logout` | `{}` -> `revoked: true` | Bearer; current session |
| `POST /api/auth/revoke-all` | `{}` -> `revoked: true` | Bearer; all Baton sessions |
| `POST /api/connections/spotify/authorize` | `returnTo` -> `authorizationUrl`, `expiresIn: 600` | Bearer |
| `POST /api/connections/youtube_music/authorize` | Same as Spotify | Bearer |
| `GET /api/connections/spotify/callback` | Query `state` + `code` or `error` -> safe connection metadata | Single-use OAuth state |
| `GET /api/connections/youtube_music/callback` | Same as Spotify | Single-use OAuth state |
| `POST /api/connections/apple_music` | `musicUserToken` -> safe connection metadata | Bearer |
| `GET /api/connections` | Safe connection metadata only | Bearer |
| `DELETE /api/connections/{connectionId}` | Local revocation and membership pause | Connection owner's bearer |
| `POST /api/playlists` | `name` (1–200 UTF-8 bytes) -> `groupId`, `membershipId`, `status`; HTTP 201 | Bearer + idempotency key |
| `POST /api/playlists/{groupId}/invites` | `{}` -> `inviteId`, `token`, `expiresAt` | Owner bearer + idempotency key |
| `DELETE /api/playlists/{groupId}/invites/{inviteId}` | Revokes invite | Owner bearer |
| `POST /api/invites/preview` | `token` -> group `name` only | Invite secret |
| `POST /api/invites/accept` | `token` -> `groupId`, `membershipId`, `status` | Bearer + invite secret |
| `POST /api/memberships/{membershipId}/provisioning` | `connectionId` -> `attemptId`; HTTP 202 | Member bearer + idempotency key |
| `GET /api/memberships/{membershipId}/provisioning` | Membership state, connection/external IDs, sequence boundary, latest attempt | Member bearer |

Callbacks return JSON containing connection metadata and the validated `returnTo`; they do not redirect
or return provider credentials. Client callback presentation and Universal Link handling remain later
work. Invites support multiple authenticated members until expiry (seven days) or owner revocation.
Acceptance never revives a removed membership. Legacy `group_playlists.invite_code` is an internal
placeholder, not an invitation accepted by these endpoints.

## Local walkthrough

Start PostgreSQL, apply migrations, and start the server as described in the README. Use the local
session helper for an existing test user if a native Apple sign-in harness is not available.
The README includes separate Bash and Fish environment-loading commands; do not source the dotenv
file directly in Fish.

1. Begin Spotify or YouTube authorization with an allowlisted `returnTo`. Open `authorizationUrl` and
   grant consent. The registered callback must reach the server through HTTPS. List connections and
   retain the selected connection ID. These provider consent checks do not need a native Baton app.
2. Create a group and retain its `membershipId`. Create an invite and accept it using a second user's
   session; repeating acceptance must return the same membership ID.
3. POST the connection ID to that membership's provisioning endpoint. Poll GET until the membership
   is `active` and its attempt is `succeeded`. Each member, including the owner, provisions separately.
4. Confirm exactly one initially empty private downstream playlist exists. Submit a new track through
   the ingestion endpoint and verify fan-out appends it. Historical group tracks are intentionally
   absent until Sprint 6; status reports `historicalBackfill: deferred_sprint_6`.
5. Revoke the connection; selected memberships must become `paused`. Reconnecting replaces encrypted
   credentials but does not resume paused memberships or repair blocked delivery. Switching an existing
   Spotify/YouTube connection to a different external account is rejected with
   `provider_account_change_requires_reconcile`.

`needs_reconcile` is a safety stop. Inspect provider state before an operator resolves an attempt; do
not reset `creating` / `needs_reconcile` to `pending` or blindly request another playlist. A known
external ID is retained if creation succeeded but activation could not commit. Sprint 4 has no operator
reconciliation UI or general repair API.

## Live checks you must perform

Use disposable private playlists and test users. These checks require your provider-console access
and accounts and are not covered by the offline suite:

1. Configure the Apple App ID / Sign in with Apple key and matching client ID. In a signed native
   harness, fetch a challenge, set the Apple request's nonce to the returned nonce exactly, then submit
   its authorization code plus challenge to Baton. Confirm stable user identity, rejected challenge
   replay, refresh rotation, and logout. The native client/entitlements are not delivered in Sprint 4;
   defer this certification until a suitable harness exists. A development session does not certify it.
2. Register the exact Spotify/Google callbacks, enable YouTube Data API, configure provider test users
   and consent/review settings, and exercise successful and denied consent. Confirm callback replay
   and edited state fail. Verify granted scopes and durable refresh access for the actual app/account
   mode. Spotify requests private playlist read/write plus profile country; Google requests
   `youtube.force-ssl`. YouTube catalog searches currently use `us`, not a verified playback region.
3. For Apple Music, obtain a Music User Token from a subscribed account using a signed MusicKit-capable
   Darwin harness. Register it and verify playlist creation and a future track addition. Apple Music
   capability and developer-token setup are external prerequisites, not backend-sprint implementation.
4. Perform the two-user group/invite/provisioning walkthrough for each enabled provider. Confirm
   privacy, exactly-one creation on request retry, membership isolation, and future-only delivery.
5. Check deployment secret storage, HTTPS termination, and distributed edge rate limits. Proxy headers
   are not trusted by the in-process limiter. Redact callback query strings from access logs: they
   contain OAuth codes/state. Never log request bodies, bearer tokens, authorization URLs, invite
   secrets, or provider error bodies.

Define a deployment retention policy for expired grants and session audit rows. Keep used refresh
hashes for the whole family lifetime so replay detection continues to work. Passing automated tests
does not certify real provider permissions, app review, subscriptions, or native authorization.
