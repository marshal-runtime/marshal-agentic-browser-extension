import ApplicationServices
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

private let namedKeyCodes: [String: CGKeyCode] = [
  "enter": 36, "return": 36, "escape": 53, "esc": 53, "tab": 48, "space": 49,
  "backspace": 51, "delete": 117, "left": 123, "right": 124, "down": 125, "up": 126,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]

enum ActionError: Error {
  case notFound(String)
  case failed(String)
}

enum Actions {
  /// Outcome of an Accessibility action. `needsRealInput` means the element refused every Accessibility path and
  /// only a real mouse or keyboard event (which moves the pointer or needs the app in front) could do it; such an
  /// event is sent only when the caller allowed real input, and `realInput` then says it was.
  struct Outcome {
    var ok: Bool
    var realInput = false
    var needsRealInput = false
    var detail: String? = nil
  }

  /// How far a real-input path may go. Background input is posted to the app's own event queue (CGEvent.postToPid):
  /// the app stays where it is, the pointer does not move and the person keeps typing in their own app. Foreground
  /// input brings the app to the front and posts at the HID tap, which takes the screen: it needs its own opt-in.
  struct InputPolicy {
    var background: Bool
    var foreground: Bool
    static let none = InputPolicy(background: false, foreground: false)
  }

  static func press(_ element: AXUIElement, policy: InputPolicy, pid: pid_t) -> Outcome {
    let pressed = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if pressed == .success { return Outcome(ok: true) }
    // The press was delivered but the app did not answer within the messaging timeout: a press that opens a modal
    // (a confirm sheet, an open panel) blocks the app's reply until the modal closes. Pressing again, or falling back
    // to a click, would act twice.
    if pressed == .cannotComplete {
      return Outcome(ok: true, detail: "the app is busy after the press (it may have opened a dialog)")
    }
    // Rows, cells and tabs often take selection instead of AXPress.
    if AXAttr.isSettable(element, kAXSelectedAttribute as String),
      AXAttr.set(element, kAXSelectedAttribute as String, kCFBooleanTrue)
    {
      return Outcome(ok: true)
    }
    guard policy.background || policy.foreground else {
      return Outcome(ok: false, needsRealInput: true, detail: "the element takes no Accessibility press or selection")
    }
    guard let frame = AXAttr.frame(element) else { return Outcome(ok: false, detail: "no frame for a real click") }
    return clickOutcome(at: CGPoint(x: frame.midX, y: frame.midY), policy: policy, pid: pid)
  }

  /// A click at a screen point: in the background when allowed (a click there can't be read back, so it is taken as
  /// done), else in front only with the foreground opt-in.
  static func clickOutcome(at point: CGPoint, policy: InputPolicy, pid: pid_t) -> Outcome {
    if policy.background {
      return Outcome(ok: Background.click(pid: pid, at: point), realInput: true)
    }
    guard policy.foreground else {
      return Outcome(ok: false, needsRealInput: true, detail: "only a real click reaches this target")
    }
    activate(pid: pid)
    return Outcome(ok: click(at: point), realInput: true)
  }

  /// Sets a text value through Accessibility. A field that ignores the value set is typed into in the background
  /// (select all, then the text) and read back; only when that did not land and the caller opted into the foreground
  /// is the app brought to the front.
  static func setValue(_ element: AXUIElement, text: String, policy: InputPolicy, pid: pid_t) -> Outcome {
    // The value is set with no focus write first: a focus write is the only thing here that could move the app, so it
    // happens only right before typing, which needs the field focused for the keys to land in it.
    if AXAttr.set(element, kAXValueAttribute as String, text as CFTypeRef) {
      // Some fields accept the call and ignore it: read the value back. Chromium applies it a moment later, so the
      // read-back waits briefly before falling through to typing (typing over an applied value doubled it, live
      // 2026-11-24).
      for attempt in 0..<6 {
        if AXAttr.string(element, kAXValueAttribute as String) == text { return Outcome(ok: true) }
        if attempt < 5 { Thread.sleep(forTimeInterval: 0.05) }
      }
    }
    guard policy.background || policy.foreground else {
      return Outcome(ok: false, needsRealInput: true, detail: "the field does not take a value through Accessibility")
    }
    if policy.background {
      if AXAttr.bool(element, kAXFocusedAttribute as String) != true {
        _ = AXAttr.set(element, kAXFocusedAttribute as String, kCFBooleanTrue)
      }
      if let frame = AXAttr.frame(element), AXAttr.bool(element, kAXFocusedAttribute as String) != true {
        _ = Background.click(pid: pid, at: CGPoint(x: frame.midX, y: frame.midY))
      }
      _ = Background.key(pid: pid, name: "a", modifiers: ["cmd"])
      _ = Background.type(pid: pid, text: text)
      Thread.sleep(forTimeInterval: 0.1)
      let value = AXAttr.string(element, kAXValueAttribute as String)
      // A field that hides its value (or exposes none) can't be read back: the background typing is taken as done.
      if value == nil || value == text || !policy.foreground { return Outcome(ok: true, realInput: true) }
    }
    guard let frame = AXAttr.frame(element) else { return Outcome(ok: false, detail: "no frame for real typing") }
    activate(pid: pid)
    _ = AXAttr.set(element, kAXFocusedAttribute as String, kCFBooleanTrue)
    _ = click(at: CGPoint(x: frame.midX, y: frame.midY))
    _ = key(name: "a", modifiers: ["cmd"])
    return Outcome(ok: type(text), realInput: true)
  }

  /// "Press Enter" in a field: AXConfirm, else a Return key posted to the app in the background, else (foreground
  /// opt-in only) a real Return with the app in front.
  static func confirm(_ element: AXUIElement, policy: InputPolicy, pid: pid_t) -> Outcome {
    // A web page's field answers AXConfirm with success and does nothing (Chromium, live 2026-11-24): there Enter is
    // only ever a key, so the field is focused and Return goes to the app in the background.
    if isInWebArea(element) {
      guard policy.background || policy.foreground else {
        return Outcome(ok: false, needsRealInput: true, detail: "Enter in a web page field needs a real Return key")
      }
      _ = AXAttr.set(element, kAXFocusedAttribute as String, kCFBooleanTrue)
      Thread.sleep(forTimeInterval: 0.05)
      if policy.background {
        return Outcome(ok: Background.key(pid: pid, name: "return", modifiers: []), realInput: true)
      }
      activate(pid: pid)
      return Outcome(ok: key(name: "return", modifiers: []), realInput: true)
    }
    if AXAttr.perform(element, action: "AXConfirm") { return Outcome(ok: true) }
    guard policy.background || policy.foreground else {
      return Outcome(ok: false, needsRealInput: true, detail: "the field has no AXConfirm action")
    }
    _ = AXAttr.set(element, kAXFocusedAttribute as String, kCFBooleanTrue)
    if policy.background {
      return Outcome(ok: Background.key(pid: pid, name: "return", modifiers: []), realInput: true)
    }
    activate(pid: pid)
    return Outcome(ok: key(name: "return", modifiers: []), realInput: true)
  }

  /// Scrolls the first scroll area of `window` by moving its vertical scroll bar (Accessibility only), else a
  /// scroll-wheel event at the window's centre: posted to the app in the background, or in front with the
  /// foreground opt-in.
  static func scroll(window: AXUIElement, down: Bool, policy: InputPolicy, pid: pid_t) -> Outcome {
    if let bar = Snapshot.verticalScrollBar(in: window) {
      if AXAttr.perform(bar, action: down ? "AXIncrementPage" : "AXDecrementPage") { return Outcome(ok: true) }
      if let current = AXAttr.double(bar, kAXValueAttribute as String),
        AXAttr.set(bar, kAXValueAttribute as String, NSNumber(value: min(1, max(0, current + (down ? 0.25 : -0.25)))))
      {
        return Outcome(ok: true)
      }
    }
    guard policy.background || policy.foreground else {
      return Outcome(ok: false, needsRealInput: true, detail: "no scroll bar that takes an Accessibility scroll")
    }
    guard let frame = AXAttr.frame(window) else { return Outcome(ok: false, detail: "no window frame") }
    let centre = CGPoint(x: frame.midX, y: frame.midY)
    // Chromium drops wheel events posted to it while it is behind other apps, but takes Page Down / Page Up.
    if policy.background, Snapshot.containsWebArea(window) {
      return Outcome(ok: Background.key(pid: pid, name: down ? "pagedown" : "pageup", modifiers: []), realInput: true)
    }
    if policy.background {
      return Outcome(ok: Background.wheel(pid: pid, at: centre, dy: down ? -560 : 560), realInput: true)
    }
    activate(pid: pid)
    return Outcome(ok: wheel(at: centre, dy: down ? -560 : 560), realInput: true)
  }

  /// True when the element sits inside a web page (an AXWebArea ancestor).
  static func isInWebArea(_ element: AXUIElement) -> Bool {
    var current = AXAttr.element(element, kAXParentAttribute as String)
    var depth = 0
    while let node = current, depth < 60 {
      let role = AXAttr.role(node)
      if role == "AXWebArea" { return true }
      if role == "AXWindow" || role == "AXApplication" { return false }
      current = AXAttr.element(node, kAXParentAttribute as String)
      depth += 1
    }
    return false
  }

  /// Brings the app to the front: only ever called on a foreground path the caller opted into.
  static func activate(pid: pid_t) {
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
    Thread.sleep(forTimeInterval: 0.15)
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

  static func keyCode(for name: String) -> CGKeyCode? {
    let lower = name.lowercased()
    if let named = namedKeyCodes[lower] { return named }
    if lower.count == 1, let scalar = lower.unicodeScalars.first { return letterKeyCode(scalar) }
    return nil
  }

  static func flags(for modifiers: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    if modifiers.contains("cmd") || modifiers.contains("command") { flags.insert(.maskCommand) }
    if modifiers.contains("shift") { flags.insert(.maskShift) }
    if modifiers.contains("option") || modifiers.contains("alt") { flags.insert(.maskAlternate) }
    if modifiers.contains("control") || modifiers.contains("ctrl") { flags.insert(.maskControl) }
    return flags
  }

  private static func letterKeyCode(_ scalar: Unicode.Scalar) -> CGKeyCode? {
    let letters: [Character: CGKeyCode] = [
      "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
      "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
      "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31,
      "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
      "=": 24, "-": 27, "]": 30, "[": 33, "'": 39, ";": 41, "\\": 42, ",": 43, "/": 44, ".": 47, "`": 50,
    ]
    return letters[Character(scalar)]
  }

  @discardableResult
  static func wheel(at point: CGPoint, dy: Int) -> Bool {
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(dy), wheel2: 0, wheel3: 0)
    else { return false }
    event.location = point
    event.post(tap: .cghidEventTap)
    return true
  }

  /// Captures the app's window (ScreenCaptureKit; it never raises the window) with the geometry needed to map screen
  /// points onto the image.
  static func captureWindow(pid: Int?) throws -> (image: CGImage, originX: Double, originY: Double, scale: Double) {
    let targetPid = pid ?? Int(Background.frontmostApplication()?.processIdentifier ?? 0)
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
    func boundsOf(_ info: [String: Any]) -> CGRect {
      (info[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
    }
    // Only normal-layer windows: a help tag ("Show History") or a menu the pointer happens to raise is a window of
    // the same pid at a higher layer, and capturing it gave a 468x101 image with marks off the controls (live run
    // 2026-11-22). Among them, the one whose bounds match the Accessibility window the snapshot reads.
    let normal = candidates.filter { ($0[kCGWindowLayer as String] as? Int ?? 0) == 0 && !spansAllScreens($0) }
    let axFrame = targetPid > 0 ? Snapshot.window(for: AXUIElementCreateApplication(pid_t(targetPid)))?.frame : nil
    func distance(_ info: [String: Any]) -> CGFloat {
      guard let axFrame else { return 0 }
      let b = boundsOf(info)
      return abs(b.minX - axFrame.minX) + abs(b.minY - axFrame.minY) + abs(b.width - axFrame.width) + abs(b.height - axFrame.height)
    }
    guard
      let info = normal.min(by: { distance($0) < distance($1) }) ?? candidates.first(where: { !spansAllScreens($0) }),
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

    let scale = bounds.width > 0 ? Double(image.width) / Double(bounds.width) : 1.0
    return (image, bounds.origin.x, bounds.origin.y, scale)
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
