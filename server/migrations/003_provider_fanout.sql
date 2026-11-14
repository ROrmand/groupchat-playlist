ALTER TABLE streaming_connections ADD CONSTRAINT streaming_connections_id_user UNIQUE (id, user_id);
ALTER TABLE playlist_memberships ADD COLUMN streaming_connection_id UUID;
ALTER TABLE playlist_memberships ADD CONSTRAINT membership_connection_owner
    FOREIGN KEY (streaming_connection_id, user_id) REFERENCES streaming_connections(id, user_id);
ALTER TABLE sync_delivery_logs DROP CONSTRAINT sync_delivery_logs_status_check;
ALTER TABLE sync_delivery_logs ADD CONSTRAINT sync_delivery_logs_status_check CHECK (status IN (
    'pending', 'delivering', 'delivered', 'pending_client_reconcile', 'skipped_unavailable',
    'failed_retryable', 'failed_terminal', 'needs_reconcile'
));
ALTER TABLE sync_delivery_logs ADD COLUMN connection_id UUID REFERENCES streaming_connections(id);
ALTER TABLE sync_delivery_logs ADD COLUMN external_playlist_id TEXT;
ALTER TABLE sync_delivery_logs ADD COLUMN next_attempt_at TIMESTAMPTZ;
CREATE INDEX idx_memberships_fanout ON playlist_memberships(group_playlist_id) WHERE status = 'active';
CREATE INDEX idx_delivery_user_event ON sync_delivery_logs(user_id, playlist_event_id);
CREATE FUNCTION reject_cursor_regression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.last_synced_sequence < OLD.last_synced_sequence THEN
        RAISE EXCEPTION 'membership cursor cannot regress' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER membership_cursor_monotonic BEFORE UPDATE OF last_synced_sequence ON playlist_memberships
    FOR EACH ROW EXECUTE FUNCTION reject_cursor_regression();
