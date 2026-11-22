// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "marshal-ocr-helper",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "marshal-ocr-helper",
      path: "Sources/marshal-ocr-helper"
    )
  ]
)
