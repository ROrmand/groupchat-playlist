# Repository Agent Guide

## Scope and workflow
- Read this file at the start of every agent session; project agents discover root `AGENTS.md` automatically.
- One thread handles one explicit task on one dedicated worktree branch. Do not mix unrelated fixes.
- Confirm the task, acceptance criteria, and permitted files before editing.
- Prefer targeted inspection with `rg`, `rg --files`, and SourceKit-LSP; never load full trees into context.
- Keep diffs surgical. Do not rewrite whole files when a focused edit is sufficient.
- Never inspect, paste, commit, or otherwise add `.build`, `.swiftpm`, or worktree artifacts to context.
- Preserve user changes and unrelated dirty files. Do not use destructive Git commands without explicit approval.

## Architecture boundaries
- `Sources/TrackResolverEngine` must remain 100% Linux-compatible.
- Core may import only `Foundation` and, where required on Linux, `FoundationNetworking`.
- Never import `MusicKit`, `UIKit`, or `SwiftUI` in the core SwiftPM target.
- Put MusicKit, SwiftUI, UIKit, entitlements, and Share Extension integration in a Darwin adapter layer.
- Expose platform capabilities to core through async protocols: `MusicCatalogProvider`, `PlaylistRepository`, and `NetworkSession`.
- Keep dependencies directed inward: iOS adapters depend on core protocols; core never depends on Apple UI or MusicKit types.
- Keep the Share Extension lightweight: avoid eager media/artwork loading, unbounded buffers, and long-lived caches; target <120 MB RSS.

## Swift 6 concurrency
- Compile under Swift 6 strict concurrency.
- Models and errors crossing isolation boundaries must conform to `Sendable`.
- Protocols used across tasks must be `Sendable`; async dependencies must declare `async` and appropriate error behavior.
- Prefer immutable value types, actors for shared mutable state, and explicit isolation for UI-bound code.
- Do not add `@unchecked Sendable` unless the safety invariant is documented and verified.

## Verification gate
- Before declaring a task complete, run `swift build` and `swift test` from the active worktree.
- Treat compiler and test warnings as failures; report and resolve every warning introduced or encountered.
- Network behavior must be covered by deterministic mocked/offline tests; tests must not require live Apple Music or internet access.
- If a required command cannot run, state the exact command, failure, and remaining risk; do not claim completion.

## Architecture handoff
- For MusicKit/entitlements design, platform-boundary changes, or broad multi-file refactors, obtain a written external specification first.
- Execute only the accepted specification in the active worktree; surface scope changes before implementing them.
