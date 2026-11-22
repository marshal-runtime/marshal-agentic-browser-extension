// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "marshal-ax-helper",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "marshal-ax-helper",
      path: "Sources/marshal-ax-helper"
    )
  ]
)
