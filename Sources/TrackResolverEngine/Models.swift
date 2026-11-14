import Foundation

public enum MembershipStatus: String, Sendable, Codable, Hashable {
    case invited, provisioning, active, recreating, paused, removed
}

public enum PlaylistEventType: String, Sendable, Codable, Hashable {
    case trackAdded = "TRACK_ADDED"
    case trackRemoved = "TRACK_REMOVED"
}

public enum DeliveryStatus: String, Sendable, Codable, Hashable {
    case pending, delivered
    case pendingClientReconcile = "pending_client_reconcile"
    case skippedUnavailable = "skipped_unavailable"
    case failedRetryable = "failed_retryable"
    case failedTerminal = "failed_terminal"
}

public struct CanonicalTrack: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let isrc: String?
    public let title: String
    public let artist: String
    public let album: String?
    public let durationMs: Int
    public let fallbackDedupKey: String

    public init(
        id: UUID,
        isrc: String?,
        title: String,
        artist: String,
        album: String?,
        durationMs: Int,
        fallbackDedupKey: String
    ) {
        self.id = id
        self.isrc = isrc
        self.title = title
        self.artist = artist
        self.album = album
        self.durationMs = durationMs
        self.fallbackDedupKey = fallbackDedupKey
    }
}

public struct TrackProviderMapping: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let canonicalTrackId: UUID
    public let provider: String
    public let storefront: String
    public let externalTrackId: String

    public init(
        id: UUID,
        canonicalTrackId: UUID,
        provider: String,
        storefront: String,
        externalTrackId: String
    ) {
        self.id = id
        self.canonicalTrackId = canonicalTrackId
        self.provider = provider
        self.storefront = storefront
        self.externalTrackId = externalTrackId
    }
}

public struct GroupPlaylist: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let name: String
    public let ownerId: UUID
    public let inviteCode: String
    public let currentSequence: Int
    public let createdAt: Date

    public init(
        id: UUID,
        name: String,
        ownerId: UUID,
        inviteCode: String,
        currentSequence: Int,
        createdAt: Date
    ) {
        self.id = id
        self.name = name
        self.ownerId = ownerId
        self.inviteCode = inviteCode
        self.currentSequence = currentSequence
        self.createdAt = createdAt
    }
}

public struct PlaylistMembership: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let groupPlaylistId: UUID
    public let userId: UUID
    public let externalPlaylistId: String?
    public let lastSyncedSequence: Int
    public let status: MembershipStatus

    public init(
        id: UUID,
        groupPlaylistId: UUID,
        userId: UUID,
        externalPlaylistId: String?,
        lastSyncedSequence: Int,
        status: MembershipStatus
    ) {
        self.id = id
        self.groupPlaylistId = groupPlaylistId
        self.userId = userId
        self.externalPlaylistId = externalPlaylistId
        self.lastSyncedSequence = lastSyncedSequence
        self.status = status
    }
}

public struct PlaylistItem: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let groupPlaylistId: UUID
    public let canonicalTrackId: UUID
    public let addedByUserId: UUID
    public let position: Int
    public let addedAt: Date
    public let removedAt: Date?
    public let removedByUserId: UUID?

    public init(
        id: UUID,
        groupPlaylistId: UUID,
        canonicalTrackId: UUID,
        addedByUserId: UUID,
        position: Int,
        addedAt: Date,
        removedAt: Date?,
        removedByUserId: UUID?
    ) {
        self.id = id
        self.groupPlaylistId = groupPlaylistId
        self.canonicalTrackId = canonicalTrackId
        self.addedByUserId = addedByUserId
        self.position = position
        self.addedAt = addedAt
        self.removedAt = removedAt
        self.removedByUserId = removedByUserId
    }
}

public struct PlaylistEvent: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let groupPlaylistId: UUID
    public let sequenceNumber: Int
    public let eventType: PlaylistEventType
    public let canonicalTrackId: UUID
    public let actorUserId: UUID
    public let createdAt: Date

    public init(
        id: UUID,
        groupPlaylistId: UUID,
        sequenceNumber: Int,
        eventType: PlaylistEventType,
        canonicalTrackId: UUID,
        actorUserId: UUID,
        createdAt: Date
    ) {
        self.id = id
        self.groupPlaylistId = groupPlaylistId
        self.sequenceNumber = sequenceNumber
        self.eventType = eventType
        self.canonicalTrackId = canonicalTrackId
        self.actorUserId = actorUserId
        self.createdAt = createdAt
    }
}

public struct SyncDeliveryLog: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let playlistEventId: UUID
    public let userId: UUID
    public let providerItemHandle: String?
    public let status: DeliveryStatus
    public let attemptCount: Int
    public let lastError: String?
    public let deliveredAt: Date?

    public init(
        id: UUID,
        playlistEventId: UUID,
        userId: UUID,
        providerItemHandle: String?,
        status: DeliveryStatus,
        attemptCount: Int,
        lastError: String?,
        deliveredAt: Date?
    ) {
        self.id = id
        self.playlistEventId = playlistEventId
        self.userId = userId
        self.providerItemHandle = providerItemHandle
        self.status = status
        self.attemptCount = attemptCount
        self.lastError = lastError
        self.deliveredAt = deliveredAt
    }
}
