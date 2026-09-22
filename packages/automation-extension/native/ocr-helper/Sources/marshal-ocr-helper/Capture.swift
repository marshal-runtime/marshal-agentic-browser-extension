// Frontmost-window screen capture, primarily via ScreenCaptureKit (see
// captureWindowWithScreenCaptureKit below - CGWindowListCreateImage is
// deprecated since macOS 14 and returns blank/black images for layer-backed/
// GPU-composited windows such as Electron/Chromium content), so callers have
// a pixel-space image plus the screen-point origin/scale needed to map OCR
// pixel boxes back to click coordinates.
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

enum CaptureError: Error, CustomStringConvertible {
  case noWindow(String)
  case imageFailed

  var description: String {
    switch self {
    case .noWindow(let detail): return "no matching window: \(detail)"
    case .imageFailed: return "CGWindowListCreateImage failed"
    }
  }
}

enum WindowCapture {
  /// Finds the frontmost on-screen window for the given pid (or any pid when nil),
  /// or an exact windowId when given, and returns its CGWindowID + screen-point frame.
  static func resolveWindow(windowId: Int?, pid: Int?) throws -> (id: CGWindowID, frame: CGRect) {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let infoList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: AnyObject]] else {
      throw CaptureError.noWindow("CGWindowListCopyWindowInfo returned nil")
    }
    for info in infoList {
      if let windowId, let num = info[kCGWindowNumber as String] as? Int, num != windowId { continue }
      if let pid, let ownerPid = info[kCGWindowOwnerPID as String] as? Int, ownerPid != pid { continue }
      guard let boundsDict = info[kCGWindowBounds as String] as? [String: CGFloat],
        let num = info[kCGWindowNumber as String] as? Int
      else { continue }
      let frame = CGRect(
        x: boundsDict["X"] ?? 0, y: boundsDict["Y"] ?? 0,
        width: boundsDict["Width"] ?? 0, height: boundsDict["Height"] ?? 0
      )
      if frame.width < 1 || frame.height < 1 { continue }
      return (CGWindowID(num), frame)
    }
    throw CaptureError.noWindow("windowId=\(String(describing: windowId)) pid=\(String(describing: pid))")
  }

  /// Captures the window to a temp PNG; returns path, pixel size, screen-point origin, and
  /// the pixel-per-point scale (>1 on Retina) so callers can map OCR pixel boxes to screen points.
  static func captureToTempFile(windowId: Int?, pid: Int?) throws -> (
    path: String, w: Int, h: Int, originX: Double, originY: Double, scale: Double
  ) {
    let (resolvedId, frame) = try resolveWindow(windowId: windowId, pid: pid)

    let image: CGImage
    do {
      image = try captureWindowWithScreenCaptureKit(windowId: resolvedId, frame: frame)
    } catch {
      guard
        let legacy = CGWindowListCreateImage(
          .null, .optionIncludingWindow, resolvedId, [.boundsIgnoreFraming, .bestResolution]
        )
      else {
        throw CaptureError.imageFailed
      }
      image = legacy
    }

    let scale = frame.width > 0 ? Double(image.width) / Double(frame.width) : 1.0
    let path = NSTemporaryDirectory() + "marshal-ocr-\(UUID().uuidString).png"
    let url = URL(fileURLWithPath: path)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
      throw CaptureError.imageFailed
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw CaptureError.imageFailed }
    return (path, image.width, image.height, Double(frame.origin.x), Double(frame.origin.y), scale)
  }
}

/// Best backing scale factor (1x/2x/...) for the display containing `point`,
/// matched via CGDirectDisplayID so it lines up with CGWindowListCopyWindowInfo's
/// top-left-origin/y-down coordinate space.
private func backingScale(forPointNear point: CGPoint) -> CGFloat {
  var displayCount: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &displayCount)
  var displayIDs = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
  CGGetActiveDisplayList(displayCount, &displayIDs, &displayCount)
  for displayID in displayIDs where CGDisplayBounds(displayID).contains(point) {
    for screen in NSScreen.screens {
      if let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
        CGDirectDisplayID(truncating: num) == displayID
      {
        return screen.backingScaleFactor
      }
    }
  }
  return NSScreen.main?.backingScaleFactor ?? 2.0
}

private final class CaptureOutcomeBox: @unchecked Sendable {
  var result: Result<CGImage, Error> = .failure(CaptureError.imageFailed)
}

/// Captures a specific on-screen window by CGWindowID via ScreenCaptureKit at
/// the containing display's native backing scale (2x on Retina).
private func captureWindowWithScreenCaptureKit(windowId: CGWindowID, frame: CGRect) throws -> CGImage {
  let scale = backingScale(forPointNear: CGPoint(x: frame.midX, y: frame.midY))
  let semaphore = DispatchSemaphore(value: 0)
  let box = CaptureOutcomeBox()
  Task {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let scWindow = content.windows.first(where: { $0.windowID == windowId }) else {
        box.result = .failure(CaptureError.noWindow("SCWindow not found for id \(windowId)"))
        semaphore.signal()
        return
      }
      let filter = SCContentFilter(desktopIndependentWindow: scWindow)
      let config = SCStreamConfiguration()
      config.width = max(1, Int((frame.width * scale).rounded()))
      config.height = max(1, Int((frame.height * scale).rounded()))
      config.showsCursor = false
      config.captureResolution = .best
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      box.result = .success(image)
    } catch {
      box.result = .failure(error)
    }
    semaphore.signal()
  }
  semaphore.wait()
  switch box.result {
  case .success(let image): return image
  case .failure(let error): throw error
  }
}
