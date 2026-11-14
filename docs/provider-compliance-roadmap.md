# Provider Compliance Roadmap

This roadmap applies to future work that uses Spotify, Apple Music, or YouTube Music APIs. It does not
retroactively expand the accepted implementation scope of Sprints 2–4. Provider terms change over time,
so the release owner must review the then-current agreements, policies, branding rules, API documentation,
and app-review requirements before each production release. Repository checks are engineering evidence,
not legal approval or a guarantee that a provider will approve the application.

## Product boundary

Baton is a user-directed, non-streaming playlist synchronization product. It transfers playlist metadata
and resolves a recording independently in each connected catalog. It must not download, rebroadcast,
mix, or expose provider audio; combine playback from multiple services; manufacture plays or engagement;
sell provider data; train models with provider content; or present itself as endorsed by a provider.

Provider data is used only to authenticate the user, create and maintain the user's Baton playlist, resolve
tracks for that playlist, and show the user the resulting status. Adding analytics, recommendations,
advertising, public playback, or another use of provider data is a scope change requiring a new compliance
review before implementation.

## Sprint 5 — native onboarding, consent, and legal surfaces

Sprint 5 must make the provider connection understandable and reversible before native onboarding ships.

Acceptance criteria:

- Publish an accessible privacy policy and end-user agreement before enabling production provider login.
  Identify Baton as the data controller/operator, describe each requested data category and purpose,
  identify processors, state retention periods, explain deletion, and provide a support contact.
- Present provider-specific consent copy before leaving Baton for OAuth or MusicKit authorization. Do not
  imply Spotify, Apple, Google, or YouTube endorsement.
- Request only scopes used by the implementation. Maintain a checked-in scope-to-feature inventory and
  fail CI or release review when code and the inventory diverge.
- Provide an in-app disconnect control for every provider and an account-deletion flow. Explain the
  difference between disconnecting Baton and revoking access at the provider, with a link or instructions
  for provider-side revocation where applicable.
- Use provider-approved names, marks, buttons, attribution, and links. Metadata or artwork displayed from
  a provider must be identified and linked as that provider requires; do not present it as Baton's catalog.
- Never place client secrets, developer tokens, refresh tokens, or Music User Tokens in logs, analytics,
  crash reports, screenshots, or the App Group container. The Share Extension receives only the minimum
  Baton session and playlist data it needs.
- Add accessibility-tested consent, disconnect, deletion, and reauthorization states. Denying or revoking
  one provider must not prevent the user from deleting their Baton account.

Provider-specific checks:

| Provider | Sprint 5 evidence |
| --- | --- |
| Spotify | Document why each Spotify scope is necessary; remove `playlist-read-private` unless a shipped feature reads private playlists. Include the Spotify-required end-user disclaimers and third-party-beneficiary language, an easily accessible disconnect mechanism, attribution, and links back wherever Spotify content is displayed. Keep Baton non-streaming and describe cross-service behavior as user-directed playlist-metadata transfer. |
| Apple Music | Use MusicKit authorization and Apple-issued developer/user tokens only for documented music-library operations. Add the required MusicKit/Apple Music attribution and branding, handle authorization denial and restriction, and keep Apple credentials in the Darwin adapter or protected server storage—not the Linux core or Share Extension cache. Confirm the current Apple Developer Program, MusicKit, and Apple Media Services requirements during release review. |
| YouTube Music | Use Google OAuth consent and the narrowest YouTube Data API scope that supports playlist management. Publish the disclosures and links required by the YouTube API Services Terms, including Google's privacy policy where required. Provide revocation and deletion controls, show required YouTube attribution, and do not download audiovisual content or treat the API as an unofficial YouTube Music playback API. |

## Sprint 6 — backfill, recreation, and data lifecycle

Sprint 6 may implement historical backfill, playlist recreation, and reconciliation only after the Sprint 5
consent and legal surfaces are accepted. Backfill is a playlist-state operation, not permission to build an
indefinite provider-content warehouse.

Acceptance criteria:

- Backfill only the active snapshot the user asked Baton to synchronize. Bound batches, honor provider
  quotas and retry guidance, and never replay historical events merely to generate remote activity.
- Re-resolve destination tracks through that destination provider. Do not copy provider-only audio,
  artwork, analytics, or private user data from one service into another. Cross-service records must contain
  only the minimum identifiers and normalized metadata needed for user-directed playlist transfer.
- Define retention classes for OAuth credentials, provider account IDs, storefronts, playlist IDs, track
  mappings, metadata, artwork, delivery logs, and audit/security records. Each class needs a purpose,
  retention period, deletion trigger, and owner.
- Disconnect immediately stops new provider access and deletes credentials. A bounded deletion job removes
  or irreversibly de-identifies provider personal data and provider-derived data that is no longer necessary,
  within the provider's required deadline. Spotify disconnection must meet Spotify's then-current deletion
  deadline; the May 15, 2025 terms specify five days for applicable Spotify Personal Data.
- Account deletion cascades through connections and user-linked provider data without corrupting the shared
  playlist ledger. Any narrowly retained security or financial record must be documented and separated from
  provider content.
- Refresh stored metadata only when needed to operate the product; expire stale cache entries and avoid
  indefinite storage of provider content. Shared canonical data needs documented provenance so deletion can
  remove a user's contribution without deleting independently obtained data needed by another active user.
- Reconciliation must stop when membership, connection, authorization, or account-deletion state changes.
  Tests must cover a revoke/delete race while backfill and recreation jobs are running.
- All network tests remain deterministic and offline. Add contract tests for least-privilege scopes,
  disconnect, deletion deadlines, cache expiry, attribution/link models, quota handling, and redacted logs.

## Production release gate

Production access is blocked until a named release owner records dated evidence for all three providers in
a release checklist:

1. URLs and versions/effective dates of the terms, developer policies, branding rules, and API documentation
   reviewed; material changes are summarized.
2. Production app registration, redirect URLs, declared use case, requested scopes, authorized domains,
   support contact, privacy-policy URL, and deletion instructions match the shipped application.
3. Provider sandbox/test accounts prove connect, consent denial, token expiry, reauthorization, disconnect,
   provider-side revocation, Baton account deletion, playlist creation, append/remove, quota behavior, and
   deletion-job completion without exposing credentials or another user's data.
4. Screenshots or recordings demonstrate accurate attribution, links, consent, and non-endorsement language.
5. Any required provider review, quota extension, or Apple capability/entitlement approval is complete.
   Development-mode success is not production approval.
6. Security review confirms encrypted secrets, key rotation, least privilege, processor inventory, incident
   response, and the provider-specific breach notification path.

If a provider's current rules conflict with this roadmap, the stricter current rule controls and the sprint
must stop for an updated written specification. A new feature that changes the product boundary also requires
a written compliance update before code changes.
