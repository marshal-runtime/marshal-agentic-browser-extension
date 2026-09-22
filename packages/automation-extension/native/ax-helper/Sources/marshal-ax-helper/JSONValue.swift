import Foundation

/// Minimal JSON object/array helpers on top of `JSONSerialization`. The
/// protocol is JSON Lines of loosely-typed objects, so we work with
/// `[String: Any]` / `[Any]` rather than Codable structs everywhere.
enum JSONValue {
  static func parseObject(_ line: String) -> [String: Any]? {
    guard let data = line.data(using: .utf8) else { return nil }
    guard let obj = try? JSONSerialization.jsonObject(with: data) else { return nil }
    return obj as? [String: Any]
  }

  static func serialize(_ object: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
      return "{\"ok\":false,\"error\":\"serialize-failed\"}"
    }
    return String(data: data, encoding: .utf8) ?? "{\"ok\":false,\"error\":\"encode-failed\"}"
  }
}

func errorResponse(_ id: Any?, _ message: String) -> [String: Any] {
  ["id": id ?? NSNull(), "ok": false, "error": message]
}

func okResponse(_ id: Any?, _ payload: [String: Any] = [:]) -> [String: Any] {
  var out = payload
  out["id"] = id ?? NSNull()
  out["ok"] = true
  return out
}
