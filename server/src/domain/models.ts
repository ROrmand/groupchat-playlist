export interface CanonicalTrack {
  readonly id: string;
  readonly isrc: string | null;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly durationMs: number;
  readonly fallbackDedupKey: string;
}

export type MembershipStatus = 'invited' | 'provisioning' | 'active' | 'recreating' | 'paused' | 'removed';
export type EventType = 'TRACK_ADDED' | 'TRACK_REMOVED';
export type DeliveryStatus = 'pending' | 'delivered' | 'pending_client_reconcile' | 'skipped_unavailable' | 'failed_retryable' | 'failed_terminal';

export interface PlaylistEvent {
  readonly id: string;
  readonly groupPlaylistId: string;
  readonly sequenceNumber: number;
  readonly eventType: EventType;
  readonly canonicalTrackId: string;
  readonly actorUserId: string;
  readonly createdAt: string;
}
