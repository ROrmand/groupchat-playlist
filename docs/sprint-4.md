# Sprint 4: identity, connections, invites, and provisioning

## Implementation status

The backend now includes migration `004_identity_and_provisioning.sql`, database-backed sessions,
provider authorization, group/invite APIs, and the `provision-membership` queue worker. Swift and
Darwin integrations remain unchanged. See `sprint-4-verification.md` for the runtime configuration,
HTTP contract, local walkthrough, and live checks required before rollout.

## Accepted scope

Sprint 4 establishes the authenticated onboarding path from a Baton user to an active group
playlist membership:

- Verify Sign in with Apple authorization codes and issue Baton sessions.
- Connect Spotify and YouTube through OAuth Authorization Code with PKCE.
- Register an Apple Music User Token obtained by the Darwin client.
- Create group playlists, issue and accept invitations, and select a member's streaming connection.
- Provision one downstream playlist per membership through the Sprint 3 provider registry.
- Persist the selected connection and external playlist before activating a membership.
- Record enough provisioning state for Sprint 6 to backfill the playlist safely.

This sprint is backend-only. It does not add Swift, MusicKit, entitlements, Universal Link handling,
native sign-in or connect UI, APNs, historical-track backfill, playlist recreation, or Apple Music
client reconciliation. The HTTP contracts are intended for those later Darwin adapters.

## Delivery sequence

Implementation should land in reviewable slices:

1. Migration and identity/session infrastructure.
2. Streaming connection authorization and credential storage.
3. Group creation and invitation APIs.
4. Provisioning worker, recovery semantics, and end-to-end offline tests.

Do not begin platform-bound implementation without a separate accepted Darwin specification.

## Identity and sessions

The server exchanges a Sign in with Apple authorization code; it does not trust identity fields sent
directly by a client. Verification must validate Apple's signature against its published keys and
validate issuer, audience, expiry, the required server-issued nonce, and the authorization-code exchange response.
The stable Apple subject is the external identity key. Email and display name are optional profile
data and must not be used as identity keys.

On successful authentication, issue a short-lived Baton access token and an opaque rotating refresh
token. Store only a hash of each refresh token. Rotation invalidates the previous token atomically;
reuse of an invalidated token revokes that session family. Logout revokes the selected session, while
account-wide revocation invalidates every session for the user. The existing development session
helper remains local administration tooling and is not a production authentication endpoint.

## Streaming connections

Spotify and YouTube use Authorization Code with PKCE. OAuth state must be random, expiring,
single-use, bound to the authenticated Baton user, provider, PKCE verifier, and an allowlisted client
return target. Callback handling consumes state atomically before creating or updating a connection.
Request only the minimum playlist-read/write and identity scopes needed by the provider adapter.

Apple Music authorization occurs on a Darwin client. The authenticated client may register its Music
User Token over the Baton API; the server validates it with a bounded provider request before storing
it. The Apple developer token remains server configuration and is never accepted from a client.

All provider access and refresh tokens must be encrypted with the existing `TokenVault`, using the
connection ID as authenticated context. Never return stored credentials through an API or include
tokens, OAuth codes, provider bodies, or raw exceptions in logs. A user may have at most one current
connection per provider. Reconnecting updates that logical connection safely and changes its status
to `active`; disconnecting sets it to `revoked` and pauses memberships that selected it.

## Groups and invitations

An authenticated user may create a group playlist. Creation atomically creates the owner membership
in `invited` state; the owner follows the same connection-selection and provisioning path as every
other member.

Invitation secrets must be high-entropy, stored only as hashes, expiring, and revocable. They are
domain-separated keyed HMAC derivations from random invite IDs, allowing idempotent responses without
persisting the secret itself. Invitations allow multiple users until expiry (seven days) or owner
revocation; use is recorded once per user. A preview
may expose only the group name and inviter-safe presentation data. Acceptance requires an authenticated
session, consumes or records use of the invite transactionally, and is idempotent for an existing
membership. Concurrent acceptance must not create duplicate memberships. Invite links are transport
details; native Universal Link handling remains outside this sprint.

## Provisioning lifecycle

Provisioning begins only after the member explicitly selects one of their own active connections.
The state transition is:

`invited` -> `provisioning` -> `active`

The worker serializes work per membership and rechecks membership, connection ownership, connection
status, and current provisioning attempt immediately before provider I/O. It creates a downstream
playlist through the Sprint 3 adapter, then atomically stores `streaming_connection_id`,
`external_playlist_id`, and the group's current sequence as `provisioned_at_sequence`. Activation is
for future fan-out only: `last_synced_sequence` is initialized to that same sequence so events created
after activation are delivered in order.

Historical active tracks are not copied in Sprint 4. `provisioned_at_sequence` is the durable Sprint 6
handoff for state-based backfill; Sprint 6 must backfill the canonical active playlist snapshot through
that boundary before declaring historical synchronization complete. It must not replay old event
mutations through the normal fan-out cursor.

Provisioning requests require an idempotency key. Known failures before an external mutation may be
retried with bounded exponential backoff. A timeout, transport failure, 5xx response, or process crash
around playlist creation is an ambiguous write: preserve the membership in `provisioning`, mark the
attempt `needs_reconcile`, and do not create another playlist automatically. Invalid credentials set
the connection to `needs_reauth`; terminal permission/configuration errors record a sanitized terminal
failure. Retrying or changing the selected connection creates a new explicit attempt only after the
previous outcome is resolved.

Sprint 3's `active` -> `recreating` handoff remains unchanged. Rebuilding deleted playlists and
resuming blocked delivery are Sprint 6 work.

## Planned API surface

Exact response envelopes may follow existing server conventions, but the implementation must cover:

- Apple sign-in exchange, access-token refresh, session logout, and account-wide revocation.
- Begin and complete Spotify/YouTube connection authorization.
- Register Apple Music authorization, list connections, and revoke a connection.
- Create a group, create/revoke an invite, preview an invite, and accept an invite.
- Select a membership connection, start provisioning, and inspect provisioning status.

Authenticated mutations require authorization checks and idempotency where retries can duplicate state.
Sign-in challenge/exchange, refresh, invitation preview, and provider callbacks are public grant
boundaries: they validate their challenge, refresh token, invite secret, or bound OAuth state rather
than requiring an existing access token. All onboarding routes have bounded input, per-socket-address
rate limiting, and no-store responses; authenticated routes also have per-user rate limiting.

## Planned migration

The new immutable `004_identity_and_provisioning.sql` migration includes:

- External Apple identities without treating email as an identifier.
- Hashed rotating session refresh tokens and revocation metadata.
- Hashed, expiring OAuth state and invitation secrets.
- Provider authorization metadata needed for PKCE and safe callback completion.
- Provisioning attempts with idempotency, status, sanitized failure, and timestamps.
- `playlist_memberships.provisioned_at_sequence` and constraints tying activation to an active
  selected connection and a non-null external playlist.

Use database uniqueness and foreign keys to enforce connection ownership, one membership per user and
group, one current connection per user and provider, one idempotency result per operation scope, and
single-use token consumption under concurrency.

Existing `users.apple_sub` and connection/membership uniqueness constraints are reused. An activation
trigger rejects new active memberships or activation-field changes without a selected active connection
and external playlist. Existing legacy rows are not silently assigned connections or rewritten. Newly
provisioned memberships also require a nonnegative boundary and a cursor at or above it. Connection
eligibility is rechecked at runtime; revocation pauses selected memberships.

## Verification and acceptance

All tests are deterministic and offline. Fake Apple key sets, OAuth endpoints, and provider transports
must cover success and failure without live credentials or internet access.

Acceptance requires tests for:

- Apple issuer/audience/signature/expiry/nonce validation and authorization-code rejection.
- Refresh rotation, refresh-token replay, logout, and account-wide revocation.
- OAuth state expiry, replay, user/provider binding, PKCE, callback errors, and redirect allowlisting.
- Token encryption, reconnect rotation, connection revocation, and secret-safe logs/errors.
- Invite expiry/revocation, duplicate and concurrent acceptance, and authorization boundaries.
- Provisioning idempotency, ownership rechecks, retryable failures, ambiguous writes, and activation.
- Future events fan out after activation while historical tracks remain marked for Sprint 6 backfill.

Run the repository verification gate before completion:

```sh
npm ci --prefix server
SWIFT_DOCKER=1 bash scripts/verify.sh
npm run build --prefix server
git diff --check
```
