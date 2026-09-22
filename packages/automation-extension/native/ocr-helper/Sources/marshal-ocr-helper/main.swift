// marshal-ocr-helper: a long-lived JSON-Lines process exposing Vision-backed
// OCR (`ocr`) with a tile-diff cache, and frontmost-window capture
// (`capture`), plus a `--selftest <png>` one-shot mode for manual verification.
import Foundation

func handleOcr(_ request: OcrRequest) -> Encodable {
  guard let imagePath = request.imagePath else {
    return ErrorResponse(id: request.id, error: "ocr requires imagePath")
  }
  let start = Date()
  do {
    let result = try OCREngine.shared.run(
      imagePath: imagePath, cacheKey: request.cacheKey, scale: request.scale ?? 1.0,
      level: request.level ?? "accurate"
    )
    let ms = Date().timeIntervalSince(start) * 1000
    let lines = result.lines.map {
      OcrLineOut(
        text: $0.text, x: $0.rect.minX, y: $0.rect.minY, w: $0.rect.width, h: $0.rect.height,
        confidence: $0.confidence
      )
    }
    return OcrResponse(
      id: request.id, lines: lines, reused: result.reused, read: result.read,
      tiles: TileStats(changed: result.tilesChanged, total: result.tilesTotal), ms: ms
    )
  } catch {
    return ErrorResponse(id: request.id, error: "\(error)")
  }
}

func handleCapture(_ request: OcrRequest) -> Encodable {
  do {
    let result = try WindowCapture.captureToTempFile(windowId: request.windowId, pid: request.pid)
    return CaptureResponse(
      id: request.id, path: result.path, w: result.w, h: result.h, originX: result.originX,
      originY: result.originY, scale: result.scale
    )
  } catch {
    return ErrorResponse(id: request.id, error: "\(error)")
  }
}

func runSelfTest(imagePath: String) {
  let start = Date()
  let first = handleOcr(OcrRequest(id: "1", op: "ocr", imagePath: imagePath, cacheKey: "selftest", scale: 1, level: nil, windowId: nil, pid: nil))
  let firstMs = Date().timeIntervalSince(start) * 1000
  ProtocolIO.writeLine(first)
  print("selftest: first pass \(String(format: "%.1f", firstMs))ms")

  let start2 = Date()
  let second = handleOcr(OcrRequest(id: "2", op: "ocr", imagePath: imagePath, cacheKey: "selftest", scale: 1, level: nil, windowId: nil, pid: nil))
  let secondMs = Date().timeIntervalSince(start2) * 1000
  ProtocolIO.writeLine(second)
  print("selftest: second pass (same cacheKey, unchanged image) \(String(format: "%.1f", secondMs))ms")
  if let response = second as? OcrResponse {
    print("selftest: reused=\(response.reused) read=\(response.read) tiles=\(response.tiles.changed)/\(response.tiles.total)")
  }
  if let response = first as? OcrResponse {
    print("selftest: sample lines (first pass):")
    for line in response.lines.prefix(5) {
      print("  conf=\(String(format: "%.2f", line.confidence)) \"\(line.text)\"")
    }
  }
}

let arguments = CommandLine.arguments
if arguments.count >= 3, arguments[1] == "--selftest" {
  runSelfTest(imagePath: arguments[2])
  exit(0)
}

let decoder = JSONDecoder()
while let line = readLine(strippingNewline: true) {
  let trimmed = line.trimmingCharacters(in: .whitespaces)
  if trimmed.isEmpty { continue }
  guard let data = trimmed.data(using: .utf8), let request = try? decoder.decode(OcrRequest.self, from: data) else {
    ProtocolIO.writeLine(ErrorResponse(id: nil, error: "invalid JSON request"))
    continue
  }
  switch request.op {
  case "ocr":
    ProtocolIO.writeLine(handleOcr(request))
  case "capture":
    ProtocolIO.writeLine(handleCapture(request))
  default:
    ProtocolIO.writeLine(ErrorResponse(id: request.id, error: "unknown op: \(request.op)"))
  }
}
