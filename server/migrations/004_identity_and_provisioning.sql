CREATE TABLE auth_challenges (
    secret_hash TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
CREATE TABLE auth_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE session_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES auth_sessions(id),
    used_at TIMESTAMPTZ
);
CREATE TABLE connection_authorizations (
    state_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL CHECK (provider IN ('spotify', 'youtube_music')),
    encrypted_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);
ALTER TABLE streaming_connections ADD COLUMN provider_account_id TEXT;
CREATE TABLE playlist_invites (
    id UUID PRIMARY KEY,
    group_playlist_id UUID NOT NULL REFERENCES group_playlists(id),
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id)
);
CREATE TABLE invite_acceptances (
    invite_id UUID NOT NULL REFERENCES playlist_invites(id),
    user_id UUID NOT NULL REFERENCES users(id),
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (invite_id, user_id)
);
CREATE TABLE onboarding_requests (
    user_id UUID NOT NULL REFERENCES users(id),
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result JSONB NOT NULL,
    PRIMARY KEY (user_id, operation, idempotency_key)
);
ALTER TABLE playlist_memberships ADD COLUMN provisioned_at_sequence INTEGER CHECK (provisioned_at_sequence >= 0);
ALTER TABLE playlist_memberships ADD CONSTRAINT provisioned_membership_ready CHECK (
    provisioned_at_sequence IS NULL OR (
        streaming_connection_id IS NOT NULL AND external_playlist_id IS NOT NULL
        AND length(external_playlist_id) > 0 AND last_synced_sequence >= provisioned_at_sequence
    )
);
CREATE TABLE provisioning_attempts (
    id UUID PRIMARY KEY,
    membership_id UUID NOT NULL REFERENCES playlist_memberships(id),
    connection_id UUID NOT NULL REFERENCES streaming_connections(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'creating', 'succeeded', 'failed_retryable', 'failed_terminal', 'needs_reconcile')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    external_playlist_id TEXT,
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provisioning_one_unresolved ON provisioning_attempts(membership_id)
    WHERE status IN ('pending', 'creating', 'failed_retryable', 'needs_reconcile');
CREATE FUNCTION check_provisioning_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'active' THEN
        IF NEW.external_playlist_id IS NULL OR length(NEW.external_playlist_id) = 0 OR NOT EXISTS (SELECT 1 FROM streaming_connections WHERE id = NEW.streaming_connection_id
            AND status = 'active') THEN
            RAISE EXCEPTION 'activation requires an active owned connection' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER membership_provisioning_activation BEFORE INSERT OR UPDATE OF status, streaming_connection_id, external_playlist_id
    ON playlist_memberships FOR EACH ROW EXECUTE FUNCTION check_provisioning_activation();
