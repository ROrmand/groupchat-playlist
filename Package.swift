// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TrackResolverEngine",
    products: [.library(name: "TrackResolverEngine", targets: ["TrackResolverEngine"])],
    targets: [
        .target(name: "TrackResolverEngine"),
        .testTarget(name: "TrackResolverEngineTests", dependencies: ["TrackResolverEngine"], resources: [.copy("Fixtures")])
    ],
    swiftLanguageModes: [.v6]
)
