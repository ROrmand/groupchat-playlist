CREATE INDEX idx_canonical_duration_lookup
    ON canonical_tracks(normalized_title, normalized_artist, duration_ms);

CREATE UNIQUE INDEX idx_provider_external_track
    ON track_provider_mappings(provider, storefront, external_track_id);
