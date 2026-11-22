// JSON Lines request/response types for marshal-ocr-helper. Mirrors the
// shape of Worker B's ax-helper protocol: one JSON object per line on
// stdin/stdout, an optional `id` echoed back for correlation.
import Foundation

struct OcrRequest: Decodable {
  let id: String?
  let op: String
  let imagePath: String?
  let cacheKey: String?
  let scale: Double?
  let level: String?
  let windowId: Int?
  let pid: Int?
}

struct OcrLineOut: Encodable {
  let text: String
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let confidence: Double
}

struct TileStats: Encodable {
  let changed: Int
  let total: Int
}

struct OcrResponse: Encodable {
  var id: String?
  let op = "ocr"
  let lines: [OcrLineOut]
  let reused: Int
  let read: Int
  let tiles: TileStats
  let ms: Double
}

struct CaptureResponse: Encodable {
  var id: String?
  let op = "capture"
  let path: String
  let w: Int
  let h: Int
  let originX: Double
  let originY: Double
  let scale: Double
}

struct ErrorResponse: Encodable {
  var id: String?
  let error: String
}

enum ProtocolIO {
  static func writeLine<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(value), let json = String(data: data, encoding: .utf8) else {
      FileHandle.standardError.write("marshal-ocr-helper: failed to encode response\n".data(using: .utf8)!)
      return
    }
    print(json)
    fflush(stdout)
  }
}
