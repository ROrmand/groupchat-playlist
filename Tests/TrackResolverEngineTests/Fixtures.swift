import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import TrackResolverEngine

enum Fixtures {
    static let trackId = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    static let userId = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
    static let groupId = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!
    static let date = Date(timeIntervalSince1970: 1_700_000_000)
    static let track = CanonicalTrack(
        id: trackId, isrc: "USAAA2300001", title: "Test Song", artist: "Test Artist",
        album: "Test Album", durationMs: 180_000, fallbackDedupKey: "test song|test artist|60"
    )
}

actor MockNetworkSession: NetworkSession {
    enum Stub: Sendable {
        case response(status: Int, data: Data)
        case failure(ProviderSyncError)
    }

    private var stubs: [Stub]
    private(set) var requests: [URLRequest] = []

    init(stubs: [Stub]) { self.stubs = stubs }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        guard !stubs.isEmpty else { throw ProviderSyncError.terminalError(message: "No stub configured") }
        switch stubs.removeFirst() {
        case .response(let status, let data):
            guard let url = request.url,
                  let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)
            else { throw ProviderSyncError.terminalError(message: "Invalid mock request") }
            return (data, response)
        case .failure(let error): throw error
        }
    }
}

struct MockMusicCatalogProvider: MusicCatalogProvider {
    func resolveTrack(url: URL, storefront: String) async throws -> CanonicalTrack? { Fixtures.track }
    func searchTracks(title: String, artist: String, storefront: String) async throws -> [CanonicalTrack] {
        title == Fixtures.track.title && artist == Fixtures.track.artist ? [Fixtures.track] : []
    }
    func isrc(externalTrackId: String, storefront: String) async throws -> String? { Fixtures.track.isrc }
}

actor MockLocalQueueStore: LocalQueueStore {
    private var actions: [PendingAction] = []
    func enqueue(_ action: PendingAction) async throws {
        if !actions.contains(where: { $0.id == action.id }) { actions.append(action) }
    }
    func pendingActions(limit: Int) async throws -> [PendingAction] { Array(actions.prefix(max(0, limit))) }
    func remove(id: UUID) async throws { actions.removeAll { $0.id == id } }
}
