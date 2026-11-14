import Foundation
import Testing
import TrackResolverEngine

private struct ParserFixture: Decodable {
    let input: String
    let expected: [ParsedTrackLink]
}

@Test func sharedChatParserFixtures() throws {
    let location = try #require(Bundle.module.url(forResource: "chat-parser", withExtension: "json", subdirectory: "Fixtures"))
    let fixtures = try JSONDecoder().decode([ParserFixture].self, from: Data(contentsOf: location))
    for fixture in fixtures {
        #expect(try ChatTextParser().parse(fixture.input) == fixture.expected, "Input: \(fixture.input)")
    }
}

@Test func chatParserInputLimits() throws {
    #expect(throws: ChatParserError.inputTooLong) { try ChatTextParser().parse(String(repeating: "🔥", count: 2049)) }
    #expect(throws: ChatParserError.tooManyLinks) {
        try ChatTextParser().parse(String(repeating: "https://youtu.be/dQw4w9WgXcQ ", count: 65))
    }
}
