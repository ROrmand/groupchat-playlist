CREATE TABLE users (
    id UUID PRIMARY KEY,
    apple_sub TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE streaming_connections (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    encrypted_access_token TEXT NOT NULL,
    encrypted_refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    storefront TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'needs_reauth', 'revoked')),
    UNIQUE (user_id, provider)
);
CREATE TABLE canonical_tracks (
    id UUID PRIMARY KEY,
    isrc TEXT UNIQUE,
    normalized_title TEXT NOT NULL,
    normalized_artist TEXT NOT NULL,
    fallback_dedup_key TEXT UNIQUE NOT NULL,
    album TEXT,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0)
);
CREATE TABLE track_provider_mappings (
    id UUID PRIMARY KEY,
    canonical_track_id UUID NOT NULL REFERENCES canonical_tracks(id),
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    storefront TEXT NOT NULL,
    external_track_id TEXT NOT NULL,
    UNIQUE (canonical_track_id, provider, storefront)
);
CREATE TABLE group_playlists (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id UUID NOT NULL REFERENCES users(id),
    invite_code TEXT UNIQUE NOT NULL,
    current_sequence INTEGER NOT NULL DEFAULT 0 CHECK (current_sequence >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE playlist_memberships (
    id UUID PRIMARY KEY,
    group_playlist_id UUID NOT NULL REFERENCES group_playlists(id),
    user_id UUID NOT NULL REFERENCES users(id),
    external_playlist_id TEXT,
    last_synced_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_synced_sequence >= 0),
    status TEXT NOT NULL CHECK (status IN ('invited', 'provisioning', 'active', 'recreating', 'paused', 'removed')),
    UNIQUE (group_playlist_id, user_id)
);
CREATE TABLE playlist_items (
    id UUID PRIMARY KEY,
    group_playlist_id UUID NOT NULL REFERENCES group_playlists(id),
    canonical_track_id UUID NOT NULL REFERENCES canonical_tracks(id),
    added_by_user_id UUID NOT NULL REFERENCES users(id),
    position INTEGER NOT NULL CHECK (position >= 0),
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ,
    removed_by_user_id UUID REFERENCES users(id),
    CHECK ((removed_at IS NULL) = (removed_by_user_id IS NULL)),
    CHECK (removed_at IS NULL OR removed_at >= added_at)
);
CREATE UNIQUE INDEX idx_unique_active_track
    ON playlist_items(group_playlist_id, canonical_track_id) WHERE removed_at IS NULL;
CREATE TABLE playlist_events (
    id UUID PRIMARY KEY,
    group_playlist_id UUID NOT NULL REFERENCES group_playlists(id),
    sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('TRACK_ADDED', 'TRACK_REMOVED')),
    canonical_track_id UUID NOT NULL REFERENCES canonical_tracks(id),
    actor_user_id UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (group_playlist_id, sequence_number)
);
CREATE FUNCTION reject_playlist_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'playlist_events is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER playlist_events_append_only
    BEFORE UPDATE OR DELETE ON playlist_events
    FOR EACH ROW EXECUTE FUNCTION reject_playlist_event_mutation();
CREATE TABLE sync_delivery_logs (
    id UUID PRIMARY KEY,
    playlist_event_id UUID NOT NULL REFERENCES playlist_events(id),
    user_id UUID NOT NULL REFERENCES users(id),
    provider_item_handle TEXT,
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'delivered', 'pending_client_reconcile', 'skipped_unavailable',
        'failed_retryable', 'failed_terminal'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    UNIQUE (playlist_event_id, user_id)
);
