import Foundation

public enum TokenRefreshMode: String, Sendable, Codable, Hashable {
    case serverSide, onDevice, none
}

public enum ProviderSyncError: Error, Sendable, Equatable {
    case tokenExpired(provider: String, refreshMode: TokenRefreshMode)
    case trackUnavailable(provider: String, storefront: String)
    case playlistNotFound(provider: String, externalPlaylistId: String)
    case rateLimited(retryAfterSeconds: Int?)
    case transientNetworkError(underlyingError: String)
    case unsupportedOperation(description: String)
    case terminalError(message: String)

    public var isRetryable: Bool {
        switch self {
        case .tokenExpired(_, .serverSide), .playlistNotFound, .rateLimited, .transientNetworkError: true
        default: false
        }
    }

    public var requiresReauth: Bool {
        if case .tokenExpired(_, let mode) = self { return mode != .serverSide }
        return false
    }

    public var requiresRecreation: Bool {
        if case .playlistNotFound = self { return true }
        return false
    }
}
