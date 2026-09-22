import ApplicationServices
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

private let namedKeyCodes: [String: CGKeyCode] = [
  "enter": 36, "return": 36, "escape": 53, "esc": 53, "tab": 48, "space": 49,
  "backspace": 51, "delete": 117, "left": 123, "right": 124, "down": 125, "up": 126,
]

enum ActionError: Error {
  case notFound(String)
  case failed(String)
}

enum Actions {
  static func press(_ element: AXUIElement, cache: ElementCache) -> Bool {
    if AXAttr.perform(element, action: kAXPressAction as String) { return true }
    guard let frame = AXAttr.frame(element) else { return false }
    let center = CGPoint(x: frame.midX, y: frame.midY)
    return click(at: center)
  }

  static func setValue(_ element: AXUIElement, text: String) -> Bool {
    AXAttr.perform(element, action: "AXFocus")
    if AXAttr.set(element, kAXValueAttribute as String, text as CFTypeRef) { return true }
    guard let frame = AXAttr.frame(element) else { return false }
    let center = CGPoint(x: frame.midX, y: frame.midY)
    _ = click(at: center)
    _ = key(name: "a", modifiers: ["cmd"])
    return type(text)
  }

  @discardableResult
  static func click(at point: CGPoint, button: String = "left", count: Int = 1) -> Bool {
    let cgButton: CGMouseButton = button == "right" ? .right : .left
    let downType: CGEventType = button == "right" ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = button == "right" ? .rightMouseUp : .leftMouseUp
    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton),
      let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton)
    else { return false }
    down.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, count)))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(max(1, count)))
    for _ in 0..<max(1, count) {
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    return true
  }

  @discardableResult
  static func type(_ text: String) -> Bool {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { return false }
    let utf16 = Array(text.utf16)
    down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    down.post(tap: .cghidEventTap)
    guard let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return true }
    up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
    up.post(tap: .cghidEventTap)
    return true
  }

  @discardableResult
  static func key(name: String, modifiers: [String]) -> Bool {
    let lower = name.lowercased()
    let keyCode: CGKeyCode
    if let named = namedKeyCodes[lower] {
      keyCode = named
    } else if lower.count == 1, let scalar = lower.unicodeScalars.first, let mapped = letterKeyCode(scalar) {
      keyCode = mapped
    } else {
      return false
    }
    var flags: CGEventFlags = []
    if modifiers.contains("cmd") { flags.insert(.maskCommand) }
    if modifiers.contains("shift") { flags.insert(.maskShift) }
    if modifiers.contains("option") || modifiers.contains("alt") { flags.insert(.maskAlternate) }
    if modifiers.contains("control") || modifiers.contains("ctrl") { flags.insert(.maskControl) }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
      let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
    else { return false }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return true
  }

  private static func letterKeyCode(_ scalar: Unicode.Scalar) -> CGKeyCode? {
    let letters: [Character: CGKeyCode] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
      "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
      "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31,
      "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    ]
    return letters[Character(scalar)]
  }

  @discardableResult
  static func scroll(at point: CGPoint, dy: Int) -> Bool {
    _ = click(at: point)
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(dy), wheel2: 0, wheel3: 0)
    else { return false }
    event.post(tap: .cghidEventTap)
    return true
  }

  static func screenshotFrontmostWindow(pid: Int?) throws -> (path: String, w: Int, h: Int, originX: Double, originY: Double, scale: Double) {
    let targetPid = pid ?? Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
    let windowInfoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    let candidates = windowInfoList.filter { ($0[kCGWindowOwnerPID as String] as? Int) == targetPid }
    // Same desktop-pseudo-window problem as Snapshot.window(for:): skip any
    // candidate whose bounds cover/exceed the union of all screens (e.g.
    // Finder's untitled desktop window) in favor of a real, smaller window.
    let screensUnion = NSScreen.screens.reduce(CGRect.zero) { $0.union($1.frame) }
    func spansAllScreens(_ info: [String: Any]) -> Bool {
      guard let bounds = (info[kCGWindowBounds as String] as? [String: Any]).flatMap({ CGRect(dictionaryRepresentation: $0 as CFDictionary) })
      else { return false }
      return screensUnion.width > 0 && bounds.width >= screensUnion.width && bounds.height >= screensUnion.height
    }
    guard
      let info = candidates.first(where: { !spansAllScreens($0) }) ?? candidates.first,
      let windowId = info[kCGWindowNumber as String] as? Int
    else {
      throw ActionError.notFound("no on-screen window for pid \(targetPid)")
    }
    let bounds = (info[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero

    let image: CGImage
    do {
      image = try captureWindowWithScreenCaptureKit(windowId: CGWindowID(windowId), frame: bounds)
    } catch {
      // ScreenCaptureKit is the primary path (CGWindowListCreateImage is
      // deprecated since macOS 14 and returns blank/black images for
      // layer-backed/GPU-composited windows - Electron, Chromium, and many
      // modern AppKit apps). Fall back only if SCK itself throws.
      log("screenshot pid=\(targetPid) windowId=\(windowId): ScreenCaptureKit failed: \(error) - falling back to CGWindowListCreateImage")
      guard let legacy = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(windowId), [.boundsIgnoreFraming]) else {
        throw ActionError.failed("ScreenCaptureKit failed (\(error)) and CGWindowListCreateImage also returned nil")
      }
      image = legacy
    }

    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else {
      throw ActionError.failed("PNG encoding failed")
    }
    let path = NSTemporaryDirectory() + "marshal-ax-\(UUID().uuidString).png"
    try data.write(to: URL(fileURLWithPath: path))
    let originX = bounds.origin.x
    let originY = bounds.origin.y
    let scale = bounds.width > 0 ? Double(image.width) / Double(bounds.width) : 1.0
    return (path, image.width, image.height, originX, originY, scale)
  }
}

/// Best backing scale factor (1x/2x/...) for the display containing `point`,
/// matched via CGDirectDisplayID so it lines up with CGWindowListCopyWindowInfo's
/// top-left-origin/y-down coordinate space (NSScreen.frame uses a different,
/// bottom-left-origin/y-up space, so matching by point containment there would
/// be wrong on multi-display setups).
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

enum ScreenCaptureError: Error, CustomStringConvertible {
  case windowNotFound
  case captureFailed(String)

  var description: String {
    switch self {
    case .windowNotFound: return "SCWindow not found for CGWindowID"
    case .captureFailed(let detail): return "SCScreenshotManager.captureImage failed: \(detail)"
    }
  }
}

/// Captures a specific on-screen window by CGWindowID via ScreenCaptureKit at
/// the containing display's native backing scale (2x on Retina) - unlike
/// CGWindowListCreateImage, this reliably captures real pixel content for
/// layer-backed/GPU-composited windows on macOS 14+.
private final class CaptureOutcomeBox: @unchecked Sendable {
  var result: Result<CGImage, Error> = .failure(ScreenCaptureError.captureFailed("capture task did not run"))
}

private func captureWindowWithScreenCaptureKit(windowId: CGWindowID, frame: CGRect) throws -> CGImage {
  let scale = backingScale(forPointNear: CGPoint(x: frame.midX, y: frame.midY))
  let semaphore = DispatchSemaphore(value: 0)
  let box = CaptureOutcomeBox()
  Task {
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let scWindow = content.windows.first(where: { $0.windowID == windowId }) else {
        box.result = .failure(ScreenCaptureError.windowNotFound)
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
      box.result = .failure(ScreenCaptureError.captureFailed("\(error)"))
    }
    semaphore.signal()
  }
  semaphore.wait()
  switch box.result {
  case .success(let image): return image
  case .failure(let error): throw error
  }
}
