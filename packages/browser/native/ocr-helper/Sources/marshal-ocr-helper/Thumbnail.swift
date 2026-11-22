// Grayscale thumbnail + tile-diff support for the OCR cache: downsamples a
// CGImage to 1/8 scale, then compares per-tile mean intensity against a
// previous thumbnail to find which regions of the screen actually changed.
import CoreGraphics
import Foundation

struct Thumbnail {
  let width: Int
  let height: Int
  /// Row-major grayscale bytes, one per pixel.
  let pixels: [UInt8]
}

enum ThumbnailBuilder {
  static func make(from image: CGImage, downscale: Int) -> Thumbnail? {
    let width = max(1, image.width / downscale)
    let height = max(1, image.height / downscale)
    let colorSpace = CGColorSpaceCreateDeviceGray()
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
        space: colorSpace, bitmapInfo: CGImageAlphaInfo.none.rawValue
      )
    else { return nil }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let data = context.data else { return nil }
    let buffer = data.bindMemory(to: UInt8.self, capacity: width * height)
    return Thumbnail(width: width, height: height, pixels: Array(UnsafeBufferPointer(start: buffer, count: width * height)))
  }
}

/// A tile grid over the thumbnail; each tile's full-resolution rect is `tileSizeThumb * downscale` px.
struct TileGrid {
  let cols: Int
  let rows: Int
  let tileSizeThumb: Int
  let downscale: Int

  var total: Int { cols * rows }

  init(thumb: Thumbnail, tileSizeThumb: Int, downscale: Int) {
    self.tileSizeThumb = tileSizeThumb
    self.downscale = downscale
    self.cols = max(1, Int(ceil(Double(thumb.width) / Double(tileSizeThumb))))
    self.rows = max(1, Int(ceil(Double(thumb.height) / Double(tileSizeThumb))))
  }

  func meanIntensity(of thumb: Thumbnail, tileRow: Int, tileCol: Int) -> Double {
    let x0 = tileCol * tileSizeThumb
    let y0 = tileRow * tileSizeThumb
    let x1 = min(x0 + tileSizeThumb, thumb.width)
    let y1 = min(y0 + tileSizeThumb, thumb.height)
    guard x1 > x0, y1 > y0 else { return 0 }
    var sum = 0
    var count = 0
    for y in y0..<y1 {
      let rowBase = y * thumb.width
      for x in x0..<x1 {
        sum += Int(thumb.pixels[rowBase + x])
        count += 1
      }
    }
    return count > 0 ? Double(sum) / Double(count) : 0
  }

  /// Full-resolution pixel rect covered by tile (row, col), clamped to image bounds.
  func fullResRect(row: Int, col: Int, imageW: Int, imageH: Int) -> CGRect {
    let x0 = col * tileSizeThumb * downscale
    let y0 = row * tileSizeThumb * downscale
    let x1 = min((col + 1) * tileSizeThumb * downscale, imageW)
    let y1 = min((row + 1) * tileSizeThumb * downscale, imageH)
    return CGRect(x: x0, y: y0, width: max(0, x1 - x0), height: max(0, y1 - y0))
  }
}

enum TileDiff {
  /// Returns the set of changed tile (row, col) indices, comparing `current` against `previous`
  /// tile-by-tile using mean-abs-diff of grayscale intensity. Absent `previous` means every tile changed.
  static func changedTiles(current: Thumbnail, previous: Thumbnail?, grid: TileGrid, threshold: Double) -> Set<
    Int
  > {
    var changed = Set<Int>()
    for row in 0..<grid.rows {
      for col in 0..<grid.cols {
        let key = row * grid.cols + col
        guard let previous, previous.width == current.width, previous.height == current.height else {
          changed.insert(key)
          continue
        }
        let currentMean = grid.meanIntensity(of: current, tileRow: row, tileCol: col)
        let previousMean = grid.meanIntensity(of: previous, tileRow: row, tileCol: col)
        if abs(currentMean - previousMean) > threshold {
          changed.insert(key)
        }
      }
    }
    return changed
  }

  /// Merges changed tiles into per-row bounding rects (full row width across contiguous changed
  /// columns), grown by `marginPx` on every side and clamped to the image, so OCR crops don't cut
  /// a text line mid-word.
  static func mergedRects(changed: Set<Int>, grid: TileGrid, imageW: Int, imageH: Int, marginPx: Double)
    -> [CGRect]
  {
    var rowRanges: [Int: (minCol: Int, maxCol: Int)] = [:]
    for key in changed {
      let row = key / grid.cols
      let col = key % grid.cols
      if let existing = rowRanges[row] {
        rowRanges[row] = (min(existing.minCol, col), max(existing.maxCol, col))
      } else {
        rowRanges[row] = (col, col)
      }
    }
    var rects: [CGRect] = []
    for (row, range) in rowRanges {
      let left = grid.fullResRect(row: row, col: range.minCol, imageW: imageW, imageH: imageH)
      let right = grid.fullResRect(row: row, col: range.maxCol, imageW: imageW, imageH: imageH)
      let union = left.union(right)
      let grown = union.insetBy(dx: -marginPx, dy: -marginPx)
      rects.append(clamp(grown, imageW: imageW, imageH: imageH))
    }
    return mergeOverlapping(rects)
  }

  private static func clamp(_ rect: CGRect, imageW: Int, imageH: Int) -> CGRect {
    let x0 = max(0, rect.minX)
    let y0 = max(0, rect.minY)
    let x1 = min(Double(imageW), rect.maxX)
    let y1 = min(Double(imageH), rect.maxY)
    return CGRect(x: x0, y: y0, width: max(0, x1 - x0), height: max(0, y1 - y0))
  }

  private static func mergeOverlapping(_ rects: [CGRect]) -> [CGRect] {
    var result = rects
    var mergedAny = true
    while mergedAny {
      mergedAny = false
      var i = 0
      while i < result.count {
        var j = i + 1
        var didMerge = false
        while j < result.count {
          if result[i].intersects(result[j]) {
            result[i] = result[i].union(result[j])
            result.remove(at: j)
            mergedAny = true
            didMerge = true
          } else {
            j += 1
          }
        }
        i += didMerge ? 0 : 1
      }
    }
    return result
  }
}
