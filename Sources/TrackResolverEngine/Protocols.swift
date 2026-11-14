import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol MusicCatalogProvider: Sendable {
    func resolveTrack(url: URL, storefront: String) async throws -> CanonicalTrack?
    func searchTracks(title: String, artist: String, storefront: String) async throws -> [CanonicalTrack]
    func isrc(externalTrackId: String, storefront: String) async throws -> String?
}

public protocol PlaylistRepository: Sendable {
    func playlists(userId: UUID) async throws -> [GroupPlaylist]
    func save(playlist: GroupPlaylist) async throws
    func items(groupPlaylistId: UUID) async throws -> [PlaylistItem]
    func membership(groupPlaylistId: UUID, userId: UUID) async throws -> PlaylistMembership?
}

public protocol NetworkSession: Sendable {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct PendingAction: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let groupPlaylistId: UUID
    public let rawInput: String
    public let createdAt: Date

    public init(id: UUID, groupPlaylistId: UUID, rawInput: String, createdAt: Date) {
        self.id = id
        self.groupPlaylistId = groupPlaylistId
        self.rawInput = rawInput
        self.createdAt = createdAt
    }
}

public protocol LocalQueueStore: Sendable {
    func enqueue(_ action: PendingAction) async throws
    func pendingActions(limit: Int) async throws -> [PendingAction]
    func remove(id: UUID) async throws
}

public protocol PlaylistSyncClient: Sendable {
    func submit(_ action: PendingAction) async throws -> PlaylistEvent
    func events(groupPlaylistId: UUID, after sequence: Int, limit: Int) async throws -> [PlaylistEvent]
}
