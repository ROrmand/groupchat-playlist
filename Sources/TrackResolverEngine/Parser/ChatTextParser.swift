import Foundation

public enum StreamingService: String, Sendable, Codable, Hashable {
    case appleMusic = "apple_music"
    case spotify
    case youtubeMusic = "youtube_music"
}

public struct ParsedTrackLink: Sendable, Codable, Hashable {
    public let provider: StreamingService
    public let storefront: String
    public let externalTrackId: String
    public let url: String
}

public enum ChatParserError: Error, Sendable {
    case inputTooLong
    case tooManyLinks
}

public struct ChatTextParser: Sendable {
    public init() {}

    public func parse(_ input: String) throws -> [ParsedTrackLink] {
        guard input.utf8.count <= 8192 else { throw ChatParserError.inputTooLong }
        let text = input.replacingOccurrences(of: "&amp;", with: "&")
        let pattern = #"(?:https?://|spotify:track:)[\p{L}\p{M}\p{N}\-._~:/?#\[\]@!$&'()*+,;=%]+"#
        let expression = try NSRegularExpression(pattern: pattern, options: .caseInsensitive)
        let matches = expression.matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard matches.count <= 64 else { throw ChatParserError.tooManyLinks }
        var result: [ParsedTrackLink] = []
        for match in matches {
            guard let range = Range(match.range, in: text) else { continue }
            let candidate = String(text[range]).trimmingCharacters(in: CharacterSet(charactersIn: ").,!;:]}"))
            if let link = parseCandidate(candidate), !result.contains(link) { result.append(link) }
        }
        return result
    }

    private func parseCandidate(_ candidate: String) -> ParsedTrackLink? {
        if candidate.lowercased().hasPrefix("spotify:track:") {
            let identifier = String(candidate.dropFirst(14))
            guard matches(identifier, #"^[A-Za-z0-9]{22}$"#) else { return nil }
            return ParsedTrackLink(provider: .spotify, storefront: "global", externalTrackId: identifier,
                                   url: "https://open.spotify.com/track/\(identifier)")
        }
        guard let components = URLComponents(string: candidate), components.scheme?.lowercased() == "https",
              components.user == nil, components.password == nil,
              components.port == nil || components.port == 443,
              let host = components.host?.lowercased() else { return nil }
        guard components.percentEncodedPath.range(of: #"%2[fF]|%5[cC]|(?:^|/)(?:\.|%2[eE]){1,2}(?:/|$)"#, options: .regularExpression) == nil else { return nil }
        let path = components.path.split(separator: "/").map(String.init)
        let query = components.queryItems ?? []
        if host == "open.spotify.com", path.count == 2, path[0] == "track",
           matches(path[1], #"^[A-Za-z0-9]{22}$"#) {
            return ParsedTrackLink(provider: .spotify, storefront: "global", externalTrackId: path[1],
                                   url: "https://open.spotify.com/track/\(path[1])")
        }
        if host == "music.apple.com", path.count >= 3,
           matches(path[0], #"^[a-zA-Z]{2}$"#), ["song", "album"].contains(path[1]) {
            let songQueries = query.filter { $0.name == "i" }
            guard songQueries.count <= 1 else { return nil }
            let identifier = songQueries.first?.value ?? (path[1] == "song" ? path.last : nil)
            guard let identifier, matches(identifier, #"^[0-9]{1,20}$"#) else { return nil }
            let storefront = path[0].lowercased()
            return ParsedTrackLink(provider: .appleMusic, storefront: storefront, externalTrackId: identifier,
                                   url: "https://music.apple.com/\(storefront)/song/\(identifier)")
        }
        let videoHosts = ["youtube.com", "www.youtube.com", "music.youtube.com", "youtu.be"]
        if videoHosts.contains(host) {
            let videoQueries = query.filter { $0.name == "v" }
            guard videoQueries.count <= 1 else { return nil }
            let identifier: String?
            if host == "youtu.be", path.count == 1 { identifier = path[0] }
            else if host != "youtu.be", path == ["watch"] { identifier = videoQueries.first?.value }
            else { return nil }
            guard let identifier, matches(identifier, #"^[A-Za-z0-9_-]{11}$"#) else { return nil }
            return ParsedTrackLink(provider: .youtubeMusic, storefront: "global", externalTrackId: identifier,
                                   url: "https://music.youtube.com/watch?v=\(identifier)")
        }
        return nil
    }

    private func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}
