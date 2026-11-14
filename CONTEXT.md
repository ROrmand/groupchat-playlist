# APP NAME: BATON

## 1. One-Page Product Description
**Concept:** A collaborative music-sharing bridge that connects group chats directly to every member's preferred streaming service (Apple Music, Spotify, YouTube Music, and extensible to future services). Instead of sharing links that get buried in chat threads or break across platforms, any member shares a song once from any app via the iOS Share Sheet, picks a group playlist, and the server resolves the track and automatically updates every member's personal playlist on their respective streaming platform.

**Core Workflow:**
1. **Passwordless Sign-In & Invite Provisioning:** Users sign in with Apple (Face ID, zero passwords), connect their streaming service, and create or join a shared playlist via a Universal Link. The server automatically provisions a matching playlist in each member's connected streaming library and backfills existing tracks.
2. **1-Tap iOS Share Extension:** Whenever a track or link is shared in iMessage, WhatsApp, Discord, Instagram, or Safari, any member taps **Share → App Extension**, chooses the group playlist, and confirms in under a second.
3. **Cross-Platform Two-Way Sync (Additions & In-App Removals):** The server canonicalizes tracks (keyed by ISRC with duration-checked fallback matching), records immutable playlist mutations (`TRACK_ADDED`, `TRACK_REMOVED`), and asynchronously updates every member's connected streaming account through a pluggable provider adapter registry.

---

## 2. Core Source of Truth
* **Server Database (Master Source of Truth):** PostgreSQL owns the canonical `GroupPlaylist`, ordered `PlaylistItem` state, immutable `PlaylistEvent` ledger, `CanonicalTrack` registry (keyed by **ISRC**), cached cross-platform track IDs, member subscriptions, and sync delivery states.
* **Streaming Platform Playlists (Downstream Replicas):** Each member's personal playlist on Apple Music, Spotify, or YouTube Music is a downstream projection updated asynchronously by your server—never the master record.

### Global Catalog vs. Group Playlist State
* **Shared song metadata:** `CanonicalTrack` and `TrackProviderMapping` form a reusable server-wide catalog. If a song has already been resolved for one group, the server may reuse its metadata and provider IDs for another group instead of resolving it again.
* **Playlist-scoped inclusion:** A song belongs to a group only through that group's `PlaylistItem` and `PlaylistEvent` records. Adding a song to one group never adds it to any other group.
* **Playlist-scoped fan-out:** Each accepted event is delivered only to active members of the selected `GroupPlaylist` and only to the downstream playlist provisioned for each of those members.
* **Playlist-scoped deduplication:** The same recording may appear once in each of several group playlists, but cannot appear twice as an active item within the same group playlist.

---

## 3. Initial Invariants & Trust Boundaries

### Invariants (Unbreakable Rules)
1. **Idempotent Fan-Out (Additions & Removals):** A `(playlist_event_id, user_id)` delivery pair can be executed against a member's downstream streaming playlist **at most once**. Retrying a failed background worker must never double-add or re-trigger a mutation.
2. **Canonical Deduplication:** Within a single `GroupPlaylist`, the same active recording (matched by ISRC or normalized title + artist + $\pm 3\text{s}$ duration bucket) cannot be appended twice, even if two members share the same song simultaneously from different platforms.
3. **Membership & Removal Authorization Gate:** Only `active` members of a `GroupPlaylist` can append tracks or receive fan-out updates. Only the **original track contributor** or the **playlist owner** can trigger a `TRACK_REMOVED` event. Removing a member immediately halts all future writes to their streaming account.
4. **Monotonic Event Sequence:** Every accepted addition or removal appends an immutable `PlaylistEvent` with a monotonically increasing `sequence_number` (`v1 -> v2 -> v3`), and each member's sync cursor tracks the exact `last_synced_sequence` confirmed by their streaming provider.
5. **Identity vs. Service Decoupling:** Primary user identity (`Sign in with Apple`) is strictly decoupled from linked `StreamingConnection` records so users can switch streaming services (e.g., Spotify → Apple Music) without losing group memberships or track history.

### Trust Boundaries
1. **iOS Share Extension / App → Backend API:** Authenticate every request with a verified session JWT stored in the **Shared Keychain Access Group** (never trust client-supplied `sender_id` headers), validate URL schemes (`https://` only), bound input lengths, and enforce per-user rate limits.
2. **Backend Resolver → External Web / Metadata Endpoints:** Block private/loopback IP ranges (SSRF protection), enforce strict HTTP timeouts (≤ 3s) and response size caps, and sanitize scraped OpenGraph metadata.
3. **Backend Worker → Streaming Provider APIs:** Encrypt OAuth refresh tokens and Apple Music User Tokens at rest (never expose them to the client), isolate each member's fan-out delivery in an independent job boundary, and normalize all provider errors via `ProviderSyncError`.
4. **Main iOS App ↔ iOS Share Extension:** Store authentication tokens in a scoped **Shared Keychain Access Group** and lightweight group playlist lists + pending removal queues in an **App Group** container so the extension operates cleanly within iOS's ~120 MB memory limit.

---

## 4. Principal Entities & State Transitions

### Principal Entities
* **`User`**: `id`, `apple_sub` (unique), `display_name`, `created_at`
* **`StreamingConnection`**: `id`, `user_id`, `provider` (`apple_music` | `spotify` | `youtube_music` | extensible), `encrypted_access_token`, `encrypted_refresh_token`, `token_expires_at`, `storefront` (e.g., `'us'`, `'gb'`, `'global'`), `status` (`active` | `needs_reauth` | `revoked`)
* **`GroupPlaylist`**: `id`, `name`, `owner_id`, `invite_code` (unique), `current_sequence` (integer), `created_at`
* **`PlaylistMembership`**: `id`, `group_playlist_id`, `user_id`, `external_playlist_id`, `last_synced_sequence`, `status` (`invited` | `provisioning` | `active` | `recreating` | `paused` | `removed`)
* **`CanonicalTrack`**: `id`, `isrc` (unique, nullable), `normalized_title`, `normalized_artist`, `fallback_dedup_key` (unique composite of normalized title + artist + 3s duration bucket), `album`, `duration_ms`
* **`TrackProviderMapping`**: `id`, `canonical_track_id`, `provider`, `storefront`, `external_track_id` *(decoupled lookup table so adding new services requires zero schema migrations)*
* **`PlaylistItem`** *(Materialized Active View)*: `id`, `group_playlist_id`, `canonical_track_id`, `added_by_user_id`, `position`, `added_at`, `removed_at` (nullable), `removed_by_user_id` (nullable)
* **`PlaylistEvent`** *(Immutable Append-Only Ledger)*: `id`, `group_playlist_id`, `sequence_number`, `event_type` (`TRACK_ADDED` | `TRACK_REMOVED`), `canonical_track_id`, `actor_user_id`, `created_at`
* **`SyncDeliveryLog`**: `id`, `playlist_event_id`, `user_id`, `provider_item_handle` (nullable — stores platform-specific entry IDs like YouTube's `playlistItemId` needed for subsequent deletions), `status` (`pending` | `delivered` | `pending_client_reconcile` | `skipped_unavailable` | `failed_retryable` | `failed_terminal`), `attempt_count`, `last_error`, `delivered_at`

### Key State Transitions
* **`PlaylistMembership.status`**:
  `invited` → *(completes Sign in with Apple + links streaming service)* → `provisioning` → *(external playlist created + active items backfilled)* → `active`
  * On `PLAYLIST_NOT_FOUND` (user deleted the playlist inside Spotify/Apple Music): `active` → `recreating` → *(new external playlist created & active items replayed)* → `active`.
  * On leave or removal: `active` → `removed`.
* **`SyncDeliveryLog.status` (Driven by Normalized `ProviderSyncError`)**:
  * **Additions (`TRACK_ADDED`):** `pending` → `delivered` (HTTP 200/201, saving `provider_item_handle`) | `skipped_unavailable` (`TRACK_UNAVAILABLE` in user's region/service) | `failed_retryable` (`RATE_LIMITED` / `TRANSIENT_ERROR`) | `failed_terminal` (`TOKEN_EXPIRED` on on-device SDK → sets `StreamingConnection.status = needs_reauth`).
  * **Removals (`TRACK_REMOVED`):**
    * *Spotify / YouTube Music:* `pending` → `delivered` (via server REST API `DELETE /v1/playlists/{id}/items` or `playlistItems.delete` using stored `provider_item_handle`).
    * *Apple Music:* `pending` → `pending_client_reconcile` (because Apple's REST API does not expose a single-track DELETE endpoint for library playlists; reconciled on-device via `MusicKit` `MusicLibrary.shared` on next app open or background refresh) → `delivered`.

---

## 5. Primary User Journeys & Failure Paths

### Journey A: 3-Tap Invite Onboarding & Auto-Provisioning
* **Happy Path:** User A creates `"The Boys GC"` → Server provisions `"The Boys GC"` on User A's Apple Music and generates a Universal Link (`yourapp.link/invite/abc123`). User B taps the link in iMessage → **Tap 1:** *Continue with Apple* (Face ID) → **Tap 2:** *Connect Spotify* (OAuth PKCE) → Server provisions `"The Boys GC"` on User B's Spotify, sets membership to `active`, and backfills all currently active tracks.
* **Failure Path:** User B signs in with Apple but closes the app before linking Spotify → Membership stays in `invited` until OAuth completes; fan-out jobs skip unlinked members without blocking the group and trigger backfill once linked.

### Journey B: Sharing & Removing Tracks
* **Happy Path (Add):** User A opens a song's Share Sheet and taps **Baton** → Baton displays only the group playlists where User A is an active member → User A selects one group playlist → the Share Extension sends `{ group_playlist_id, raw_input }` using the Shared Keychain JWT → Server resolves the song, inserts `PlaylistItem` + `PlaylistEvent` (`TRACK_ADDED`, `v1`), and returns `202 Accepted` → Baton closes with a success state → the fan-out worker resolves per-storefront IDs (caching them in `TrackProviderMapping`) and automatically appends the track to every active member's provisioned playlist when that recording is available on the member's service.
* **Happy Path (In-App Remove):** User A swipes to delete a track they added in the app → Server validates authorization, soft-deletes `PlaylistItem`, appends `PlaylistEvent` (`TRACK_REMOVED`, `v2`), removes the track immediately on Spotify/YouTube via REST API, and queues on-device `MusicKit` removal for Apple Music members.
* **Failure Paths:**
  * *Unresolvable Link/Text:* Resolver cannot match an ISRC or $\pm 3\text{s}$ duration-verified track → API returns `422 Unprocessable Entity` with a clear Share Sheet prompt.
  * *Duplicate Track:* Active song already exists in `GroupPlaylist` → API returns `200 OK` ("Already in playlist") without incrementing `current_sequence` or re-triggering fan-out.
  * *Unavailable on a Member's Service:* The canonical song remains in the group playlist, but that member's delivery is marked `skipped_unavailable`. Other available services continue syncing, and the group library displays the unavailable service/song combination rather than hiding the song or failing the entire fan-out.
  * *Offline on iPhone:* Share Extension writes payload to an App Group `PendingShare` queue and flushes automatically when connectivity returns.
  * *Member's Token Expired:* Worker catches `TOKEN_EXPIRED` for User B; if `tokenRefreshMode === 'server_oauth'` (Spotify/YouTube), refreshes silently and retries; if `'on_device_sdk'` (Apple Music), marks `needs_reauth`, sends an APNs prompt to User B, and continues delivering to Users C and D.

---

## 6. Architecture Style: Modular Monolith + Pluggable Provider Registry
Build a **modular monolith** backed by **PostgreSQL** and a Postgres-backed job queue (`pg-boss` or `Graphile Worker`), paired with a shared **Swift Package (`TrackResolverEngine`)** on the client.
* **Pluggable Provider Registry:** Core workers interact exclusively with a uniform `StreamingProviderAdapter` interface (`createPlaylist`, `resolveTrackId`, `appendTracks`, optional `removeTracks`, optional `refreshAuth`) plus capability flags (`supportsISRC`, `supportsServerSideDelete`, `supportsBatchAppend`, `maxTracksPerRequest`, `tokenRefreshMode`).
* **Adding Future Services:** Adding Tidal, SoundCloud, or Deezer later requires only implementing a new `StreamingProviderAdapter` class, registering it in `ProviderRegistry`, and adding an OAuth connect button in iOS—zero changes to database schemas, deduplication logic, or worker queues.
* **Scope Boundary (MVP):** Support **In-App Removals** via event-sourced fan-out; defer native-app polling two-way deletion (detecting removals made directly inside Spotify/Apple Music apps) until post-MVP to avoid quota burn and accidental playlist wipes.

---

## 7. Isolating High-Value Domain Logic from Frameworks
* **On iOS / Swift (`TrackResolverEngine` SwiftPM Library):** Isolate URL extraction, noisy chat text parsing, offline queue models, and client-side reconciliation diffing using pure Swift `Foundation` + async protocols (`PlaylistSyncClient`, `LocalQueueStore`, `MusicCatalogProvider`, `PlaylistRepository`). Never import `UIKit`, `SwiftUI`, or `MusicKit` inside the core package so it compiles and unit-tests natively on Linux (`swift test`).
* **On Backend:** Isolate `TrackCanonicalizer` (ISRC extraction, title/artist normalization, and $\pm 3\text{s}$ duration-tolerance matching) and `FanOutPlanner` (diffing `GroupPlaylist.current_sequence` against `PlaylistMembership.last_synced_sequence`) from HTTP routing and provider SDK details.

---

## 8. Database Constraints & Migration Workflow
Enforce invariants at the PostgreSQL schema level so concurrency races cannot corrupt playlist state:
* `UNIQUE (apple_sub)` on `users`
* `UNIQUE (user_id, provider)` on `streaming_connections`
* `UNIQUE (isrc)` on `canonical_tracks`
* `UNIQUE (fallback_dedup_key)` on `canonical_tracks`
* `UNIQUE (canonical_track_id, provider, storefront)` on `track_provider_mappings`
* `UNIQUE (group_playlist_id, canonical_track_id) WHERE removed_at IS NULL` on `playlist_items` *(partial unique index: prevents duplicate active songs while allowing a previously removed song to be re-added later)*
* `UNIQUE (group_playlist_id, sequence_number)` on `playlist_events`
* `UNIQUE (group_playlist_id, user_id)` on `playlist_memberships`
* `UNIQUE (playlist_event_id, user_id)` on `sync_delivery_logs` *(guarantees idempotent fan-out for both additions and removals)*
* `CHECK (last_synced_sequence >= 0)` on `playlist_memberships`
* **Migrations:** Forward-only, versioned SQL migrations checked into Git and executed automatically in CI against a fresh Postgres container prior to integration tests.

---

## 9. Thin Vertical Slice (First End-to-End Milestone)
Complete **one end-to-end vertical slice** before adding secondary features:
1. **Auth & Provisioning:** Sign in with Apple + connect **Apple Music** (User A) and **Spotify** (User B) → auto-create `"Test GC"` on both services.
2. **iOS Share Extension UI:** Accept a URL/text from the iOS Share Sheet, read cached group playlists from the App Group, and POST `{ group_playlist_id, raw_input }` with the Shared Keychain JWT.
3. **Backend Ingest & Pluggable Fan-Out:** Resolve ISRC, append `PlaylistEvent` (`TRACK_ADDED`), cache `TrackProviderMapping` entries, and deliver via `AppleMusicAdapter` and `SpotifyAdapter` (plus verify `TRACK_REMOVED` propagation).
4. **Verification:** Share a track link from iMessage on iPhone → confirm the track appears in both User A's Apple Music playlist and User B's Spotify playlist within 5 seconds.

---

## 10. Risk-Driven Test Suite
Focus automated testing on the high-risk boundaries exposed by the slice:
* **Parser & Normalization Unit Tests (Swift & Backend):** Noisy group chat strings (`"yo listen to <url> fire"`), tracking query params (`?si=`, `?i=`), regional storefronts, ISRC misses, and $\pm 3\text{s}$ duration-tolerance fallback matching.
* **Concurrency & Idempotency Tests (Backend + Postgres):** Simulate two members sharing the same track at the exact same millisecond (verify partial `UNIQUE` constraint handling), re-run the same addition/removal fan-out job twice (verify downstream adapter executes once), and verify unauthorized users receive `403 Forbidden` when attempting to delete another member's track.
* **Adapter Contract & Error Simulation Tests:** Run a shared contract test suite against every `StreamingProviderAdapter` verifying standardized mapping of HTTP `401` (`TOKEN_EXPIRED`), `404` (`PLAYLIST_NOT_FOUND` auto-recreation), `429` (`RATE_LIMITED` backoff), and `supportsServerSideDelete === false` (`pending_client_reconcile` routing for Apple Music).

---

## 11. CI, Staging, Deployment & Smoke Checks
* **CI Pipeline (GitHub Actions):**
  * Run `swift build` and `swift test` on Linux for `TrackResolverEngine`.
  * Run backend type-checks, forward SQL migrations against a disposable Postgres container, adapter contract tests, and integration tests on every PR.
* **Environments:** Separate `staging` (sandbox Apple Music Developer Token + Spotify Dev Mode app) and `production` (encrypted token vault, automated daily Postgres backups).
* **Post-Deploy Smoke Check:** Automated `/healthz` check verifying Postgres connectivity, background job worker heartbeat, and valid Apple Music ES256 JWT generation.

---

## 12. Observability & Evidence-Driven Evolution
Instrument real usage metrics before expanding scope:
* **Key Metrics to Track:**
  * *Share-to-Sync Latency (`p50` / `p95`):* End-to-end time from Share Sheet tap to downstream provider confirmation.
  * *`TrackProviderMapping` Cache Hit Rate:* Percentage of fan-out writes satisfied from cached `(canonical_track_id, provider, storefront)` mappings without extra search API calls.
  * *Resolution Miss & `TRACK_UNAVAILABLE` Rate:* Identifies regional catalog gaps or weak link-parsing heuristics.
  * *Pending Apple Music Reconciliation Lag:* Time between an in-app track removal and on-device `MusicKit` reconciliation completing.
  * *Token Churn Rate:* Tracks how often Apple Music User Tokens hit `needs_reauth` to optimize push-notification refresh prompts.
* **Evidence-Driven Roadmap:** Once the 3 core adapters (Apple Music, Spotify, YouTube Music) run reliably for real friend groups, plug in additional `StreamingProviderAdapter` modules (Tidal, SoundCloud, Deezer), song reactions/upvoting, smart cover art generation, and opt-in two-way native polling sync.

---

## 13. Group Playlist Library & Service Availability
The in-app library is scoped to the selected `GroupPlaylist`. It shows only that group's active songs and only the streaming services currently connected by at least one active member of that group. It must not display empty columns for every service Baton supports.

### Layout
* The first column contains the song title with the album name beneath it.
* Each remaining column is headed by a streaming-service logo (for example, Apple Music or Spotify).
* Each song/service cell indicates whether Baton found a playable provider mapping for the relevant member storefronts:
  * **Available:** show a clear available/check state and permit opening the song in that service when a link is available.
  * **Unavailable:** show a clear unavailable state. Keep the song visible because it remains part of the canonical group playlist.
  * **Pending:** show a temporary resolving/syncing state while provider lookup or delivery is still in progress.
* If multiple members use the same streaming service, render one service column rather than one column per user. Availability reflects the song's catalog availability on that service; storefront-specific exceptions may be exposed in a detail view.

```text
| Song / Album       | [Service logo] | [Service logo] |
|--------------------|----------------|----------------|
| Song title         | Available      | Unavailable    |
| Album title        |                |                |
```

The service-column set is recalculated from active group membership when a member connects, switches, disconnects, or loses access to a streaming service. A service column disappears only when no active member in that group uses that service; this does not remove any song from the group playlist.
