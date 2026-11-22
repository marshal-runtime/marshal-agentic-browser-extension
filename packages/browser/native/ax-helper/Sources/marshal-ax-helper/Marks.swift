import AppKit
import CoreGraphics
import Foundation

/// One numbered box to draw: `ref` is the snapshot ref ("e12"), the frame is in screen points (the same space as the
/// snapshot's element frames).
struct Mark {
  let ref: String
  let frame: CGRect
}

/// Draws the marked screenshot: the window image, scaled to at most `width` pixels wide, with one coloured box and
/// ref tag per mark (the same look as the managed backend's page overlay), encoded as JPEG or PNG. Drawing happens
/// here because the extension bundle cannot load an image library.
enum Marks {
  private static let colors: [(CGFloat, CGFloat, CGFloat)] = [
    (0.902, 0.098, 0.294), (0.235, 0.706, 0.294), (0.263, 0.388, 0.847), (0.961, 0.510, 0.192),
    (0.569, 0.118, 0.706), (0.0, 0.502, 0.502), (0.941, 0.196, 0.902), (0.604, 0.388, 0.141),
  ]

  static func parse(_ raw: Any?) -> [Mark] {
    guard let list = raw as? [[String: Any]] else { return [] }
    return list.compactMap { item in
      guard let ref = item["ref"] as? String,
        let x = (item["x"] as? NSNumber)?.doubleValue, let y = (item["y"] as? NSNumber)?.doubleValue,
        let w = (item["w"] as? NSNumber)?.doubleValue, let h = (item["h"] as? NSNumber)?.doubleValue
      else { return nil }
      return Mark(ref: ref, frame: CGRect(x: x, y: y, width: w, height: h))
    }
  }

  /// Returns the encoded image and how many marks landed inside it.
  static func render(
    image: CGImage, originX: Double, originY: Double, scale: Double, marks: [Mark], width: Int?, jpeg: Bool,
    quality: Double
  ) throws -> (data: Data, w: Int, h: Int, drawn: Int) {
    let factor: CGFloat = {
      guard let width, width > 0, image.width > width else { return 1 }
      return CGFloat(width) / CGFloat(image.width)
    }()
    let outW = max(1, Int((CGFloat(image.width) * factor).rounded()))
    let outH = max(1, Int((CGFloat(image.height) * factor).rounded()))
    guard
      let context = CGContext(
        data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { throw ActionError.failed("could not create a drawing context") }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: outW, height: outH))

    // Screen points -> output pixels (top-left origin), then flip into CoreGraphics' bottom-left space.
    let k = CGFloat(scale) * factor
    let bounds = CGRect(x: 0, y: 0, width: outW, height: outH)
    var drawn = 0
    let previous = NSGraphicsContext.current
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    defer { NSGraphicsContext.current = previous }
    let font = NSFont.monospacedSystemFont(ofSize: max(9, 11 * k), weight: .bold)
    for (index, mark) in marks.enumerated() {
      let x = (mark.frame.minX - CGFloat(originX)) * k
      let yTop = (mark.frame.minY - CGFloat(originY)) * k
      let rect = CGRect(x: x, y: CGFloat(outH) - yTop - mark.frame.height * k, width: mark.frame.width * k, height: mark.frame.height * k)
      guard rect.width > 0, rect.height > 0, bounds.intersects(rect) else { continue }
      let (r, g, b) = colors[index % colors.count]
      let color = NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
      context.setStrokeColor(color.cgColor)
      context.setLineWidth(2)
      context.stroke(rect.insetBy(dx: 1, dy: 1))
      let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
      let text = NSAttributedString(string: mark.ref, attributes: attributes)
      let size = text.size()
      let tagH = size.height + 2
      // Above the box when there is room, else inside its top edge.
      let tagY = rect.maxY + tagH <= CGFloat(outH) ? rect.maxY : rect.maxY - tagH
      let tag = CGRect(x: max(0, rect.minX - 1), y: tagY, width: size.width + 6, height: tagH)
      context.setFillColor(color.cgColor)
      context.fill(tag)
      text.draw(at: CGPoint(x: tag.minX + 3, y: tag.minY + 1))
      drawn += 1
    }
    guard let out = context.makeImage() else { throw ActionError.failed("could not finish the image") }
    let rep = NSBitmapImageRep(cgImage: out)
    let data =
      jpeg
      ? rep.representation(using: .jpeg, properties: [.compressionFactor: NSNumber(value: min(1, max(0.05, quality)))])
      : rep.representation(using: .png, properties: [:])
    guard let data else { throw ActionError.failed("could not encode the image") }
    return (data, outW, outH, drawn)
  }
}
