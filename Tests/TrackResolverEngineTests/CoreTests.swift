import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
import TrackResolverEngine

private func roundTrip<Value: Codable & Hashable & Sendable & Identifiable>(_ value: Value) throws {
    let data = try JSONEncoder().encode(value)
    #expect(try JSONDecoder().decode(Value.self, from: data) == value)
}

@Test func domainModelsRoundTrip() throws {
    try roundTrip(Fixtures.track)
    try roundTrip(TrackProviderMapping(id: Fixtures.trackId, canonicalTrackId: Fixtures.trackId,
                                     provider: "future_service", storefront: "us", externalTrackId: "track-1"))
    try roundTrip(GroupPlaylist(id: Fixtures.groupId, name: "Test GC", ownerId: Fixtures.userId,
                               inviteCode: "test-invite", currentSequence: 1, createdAt: Fixtures.date))
    try roundTrip(PlaylistMembership(id: Fixtures.userId, groupPlaylistId: Fixtures.groupId,
                                    userId: Fixtures.userId, externalPlaylistId: nil, lastSyncedSequence: 0, status: .provisioning))
    try roundTrip(PlaylistItem(id: Fixtures.trackId, groupPlaylistId: Fixtures.groupId,
                              canonicalTrackId: Fixtures.trackId, addedByUserId: Fixtures.userId,
                              position: 0, addedAt: Fixtures.date, removedAt: nil, removedByUserId: nil))
    try roundTrip(PlaylistEvent(id: Fixtures.trackId, groupPlaylistId: Fixtures.groupId,
                               sequenceNumber: 1, eventType: .trackAdded, canonicalTrackId: Fixtures.trackId,
                               actorUserId: Fixtures.userId, createdAt: Fixtures.date))
    try roundTrip(SyncDeliveryLog(id: Fixtures.trackId, playlistEventId: Fixtures.trackId,
                                 userId: Fixtures.userId, providerItemHandle: nil, status: .pendingClientReconcile,
                                 attemptCount: 0, lastError: nil, deliveredAt: nil))
}

@Test func errorClassification() {
    let cases: [(ProviderSyncError, Bool, Bool, Bool)] = [
        (.tokenExpired(provider: "spotify", refreshMode: .serverSide), true, false, false),
        (.tokenExpired(provider: "apple_music", refreshMode: .onDevice), false, true, false),
        (.tokenExpired(provider: "other", refreshMode: .none), false, true, false),
        (.trackUnavailable(provider: "spotify", storefront: "us"), false, false, false),
        (.playlistNotFound(provider: "spotify", externalPlaylistId: "missing"), true, false, true),
        (.rateLimited(retryAfterSeconds: 30), true, false, false),
        (.transientNetworkError(underlyingError: "offline"), true, false, false),
        (.unsupportedOperation(description: "delete"), false, false, false),
        (.terminalError(message: "invalid"), false, false, false)
    ]
    for (error, retryable, reauth, recreation) in cases {
        #expect(error.isRetryable == retryable)
        #expect(error.requiresReauth == reauth)
        #expect(error.requiresRecreation == recreation)
    }
}

@Test func networkResponsesAndFailuresAreOffline() async throws {
    let payload = try JSONEncoder().encode(Fixtures.track)
    let session = MockNetworkSession(stubs: [
        .response(status: 200, data: payload), .response(status: 429, data: Data()),
        .failure(.transientNetworkError(underlyingError: "offline"))
    ])
    let request = URLRequest(url: URL(string: "https://example.invalid/track")!)
    let (data, response) = try await session.data(for: request)
    #expect(response.statusCode == 200)
    #expect(try JSONDecoder().decode(CanonicalTrack.self, from: data) == Fixtures.track)
    let (_, limited) = try await session.data(for: request)
    #expect(limited.statusCode == 429)
    await #expect(throws: ProviderSyncError.transientNetworkError(underlyingError: "offline")) {
        _ = try await session.data(for: request)
    }
    #expect(await session.requests.count == 3)
    await #expect(throws: ProviderSyncError.terminalError(message: "No stub configured")) {
        _ = try await session.data(for: request)
    }
}

@Test func catalogFixtureIsDeterministic() async throws {
    let provider: any MusicCatalogProvider = MockMusicCatalogProvider()
    #expect(try await provider.searchTracks(title: "Test Song", artist: "Test Artist", storefront: "us") == [Fixtures.track])
    #expect(try await provider.searchTracks(title: "Missing", artist: "Unknown", storefront: "us").isEmpty)
    #expect(try await provider.isrc(externalTrackId: "track-1", storefront: "us") == Fixtures.track.isrc)
}

@Test func localQueueIsBoundedAndIdempotent() async throws {
    let queue: any LocalQueueStore = MockLocalQueueStore()
    let action = PendingAction(id: Fixtures.trackId, groupPlaylistId: Fixtures.groupId,
                               rawInput: "https://example.invalid/track", createdAt: Fixtures.date)
    try roundTrip(action)
    try await queue.enqueue(action)
    try await queue.enqueue(action)
    #expect(try await queue.pendingActions(limit: 1) == [action])
    #expect(try await queue.pendingActions(limit: 0).isEmpty)
    try await queue.remove(id: action.id)
    #expect(try await queue.pendingActions(limit: 1).isEmpty)
}
