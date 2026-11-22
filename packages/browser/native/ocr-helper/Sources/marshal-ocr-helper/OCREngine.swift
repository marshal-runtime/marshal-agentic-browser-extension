// Vision-backed OCR with a per-cacheKey tile-diff cache: only the screen
// tiles whose thumbnail changed since the last call are re-read by Vision;
// unchanged tiles keep their previously recognized lines.
import CoreGraphics
import Foundation
import ImageIO
import Vision

struct RecognizedLine {
  let text: String
  /// Full-resolution pixel rect, top-left origin.
  let rect: CGRect
  let confidence: Double
}

private struct CacheEntry {
  var thumbnail: Thumbnail
  var lines: [RecognizedLine]
  /// Which tile keys (row*cols+col) each cached line belongs to, so a changed tile invalidates it.
  var lineTileKeys: [[Int]]
}

/// Single-threaded by construction: the stdin JSON-Lines loop in main.swift
/// processes one request at a time, so the mutable cache never sees concurrent access.
final class OCREngine: @unchecked Sendable {
  static let shared = OCREngine()

  private var cache: [String: CacheEntry] = [:]
  private let downscale = 8
  private let tileSizeThumb = 16  // 16 thumbnail px == 128 full-res px per tile at downscale 8
  private let tileChangeThreshold = 6.0
  private let fullRereadFraction = 0.6
  private let cropMarginPx = 24.0

  func run(imagePath: String, cacheKey: String?, scale: Double, level: String) throws -> (
    lines: [RecognizedLine], reused: Int, read: Int, tilesChanged: Int, tilesTotal: Int
  ) {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: imagePath) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
      throw OcrError.badImage(imagePath)
    }

    guard let key = cacheKey, let thumb = ThumbnailBuilder.make(from: image, downscale: downscale) else {
      let lines = try recognize(image: image, level: level, offset: .zero)
      return (lines, 0, lines.count, 0, 0)
    }

    let currentThumb = ThumbnailBuilder.make(from: image, downscale: downscale) ?? thumb
    let grid = TileGrid(thumb: currentThumb, tileSizeThumb: tileSizeThumb, downscale: downscale)
    let previous = cache[key]

    var changed = TileDiff.changedTiles(
      current: currentThumb, previous: previous?.thumbnail, grid: grid, threshold: tileChangeThreshold
    )
    let changedFraction = grid.total > 0 ? Double(changed.count) / Double(grid.total) : 1.0
    let fullReread = previous == nil || changedFraction > fullRereadFraction
    if fullReread {
      changed = Set(0..<grid.total)
    }

    var newLines: [RecognizedLine] = []
    var reusedLines: [RecognizedLine] = []
    var reusedTileKeys: [[Int]] = []

    if fullReread {
      newLines = try recognize(image: image, level: level, offset: .zero)
    } else {
      let rects = TileDiff.mergedRects(
        changed: changed, grid: grid, imageW: image.width, imageH: image.height, marginPx: cropMarginPx
      )
      for rect in rects where rect.width > 0 && rect.height > 0 {
        guard let cropped = image.cropping(to: rect) else { continue }
        let cropLines = try recognize(image: cropped, level: level, offset: rect.origin)
        newLines.append(contentsOf: cropLines)
      }
      if let previous {
        for (index, line) in previous.lines.enumerated() {
          let tileKeys = previous.lineTileKeys[index]
          if tileKeys.allSatisfy({ !changed.contains($0) }) {
            reusedLines.append(line)
            reusedTileKeys.append(tileKeys)
          }
        }
      }
    }

    let newLineTileKeys = newLines.map { tileKeys(for: $0.rect, grid: grid) }
    let allLines = reusedLines + newLines
    let allTileKeys = reusedTileKeys + newLineTileKeys
    cache[key] = CacheEntry(thumbnail: currentThumb, lines: allLines, lineTileKeys: allTileKeys)

    return (allLines, reusedLines.count, newLines.count, changed.count, grid.total)
  }

  private func tileKeys(for rect: CGRect, grid: TileGrid) -> [Int] {
    let fullTile = tileSizeThumb * downscale
    guard fullTile > 0 else { return [] }
    let col0 = max(0, Int(rect.minX) / fullTile)
    let col1 = max(col0, Int(rect.maxX - 1) / fullTile)
    let row0 = max(0, Int(rect.minY) / fullTile)
    let row1 = max(row0, Int(rect.maxY - 1) / fullTile)
    var keys: [Int] = []
    for row in row0...min(row1, grid.rows - 1) {
      for col in col0...min(col1, grid.cols - 1) {
        keys.append(row * grid.cols + col)
      }
    }
    return keys
  }

  private func recognize(image: CGImage, level: String, offset: CGPoint) throws -> [RecognizedLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level == "accurate" ? .accurate : .fast
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let imageW = Double(image.width)
    let imageH = Double(image.height)
    var lines: [RecognizedLine] = []
    for observation in request.results ?? [] {
      guard let candidate = observation.topCandidates(1).first else { continue }
      let box = observation.boundingBox
      // Vision's boundingBox is normalized, origin bottom-left; convert to
      // top-left-origin full-resolution pixels, offset by the crop origin.
      let x = box.minX * imageW + offset.x
      let w = box.width * imageW
      let h = box.height * imageH
      let y = (1 - box.minY - box.height) * imageH + offset.y
      lines.append(
        RecognizedLine(
          text: candidate.string, rect: CGRect(x: x, y: y, width: w, height: h),
          confidence: Double(candidate.confidence)
        )
      )
    }
    return lines
  }
}

enum OcrError: Error, CustomStringConvertible {
  case badImage(String)

  var description: String {
    switch self {
    case .badImage(let path): return "could not load image at \(path)"
    }
  }
}
