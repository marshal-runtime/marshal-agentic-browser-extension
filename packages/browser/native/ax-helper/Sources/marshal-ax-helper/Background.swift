import AppKit
import ApplicationServices
import CoreGraphics

/// Input posted straight to one app's event queue (CGEvent.postToPid), so the app is driven where it is: it is not
/// brought to the front, the pointer does not move, and the person's own typing in the front app is untouched. The
/// events come from a private event source, so modifier keys the person is holding never leak into them.
enum Background {
  private static func source() -> CGEventSource? { CGEventSource(stateID: .privateState) }

  static func frontmostBundleId() -> String {
    frontmostApplication()?.bundleIdentifier ?? ""
  }

  /// The front app as it is now. NSWorkspace updates its answer from notifications delivered on the run loop, and this
  /// helper's main thread sits in readLine, so without draining the run loop first a long-lived helper kept reporting
  /// an app that was no longer in front (48 of 108 samples wrong against `lsappinfo front`, live 2026-11-24).
  static func frontmostApplication() -> NSRunningApplication? {
    RunLoop.current.run(mode: .default, before: Date())
    return NSWorkspace.shared.frontmostApplication
  }

  /// After an action, watches briefly whether the target app came to the front. It is only reported (a bug to fix in
  /// the path that caused it): this helper never activates any app on its own, the person's included.
  static func targetCameForward(target: pid_t) -> Bool {
    var waited = 0
    while waited < 300 {
      if frontmostApplication()?.processIdentifier == target { return true }
      Thread.sleep(forTimeInterval: 0.1)
      waited += 100
    }
    return false
  }

  @discardableResult
  static func key(pid: pid_t, name: String, modifiers: [String]) -> Bool {
    guard let code = Actions.keyCode(for: name) else { return false }
    let src = source()
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
      let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    else { return false }
    let flags = Actions.flags(for: modifiers)
    down.flags = flags
    up.flags = flags
    down.postToPid(pid)
    up.postToPid(pid)
    usleep(25_000)
    return true
  }

  /// Types `text` one character at a time as unicode key events (no key code, so the keyboard layout doesn't matter).
  /// Newlines go as Return so a multi-line value lands the way a person would type it.
  @discardableResult
  static func type(pid: pid_t, text: String) -> Bool {
    let src = source()
    for character in text {
      if character == "\n" || character == "\r" {
        _ = key(pid: pid, name: "return", modifiers: [])
        continue
      }
      var units = Array(String(character).utf16)
      guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
      else { return false }
      down.flags = []
      up.flags = []
      down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      down.postToPid(pid)
      up.postToPid(pid)
      usleep(6_000)
    }
    return true
  }

  /// The app's own window under a screen point, so the event names the window it is for: an app that isn't in front
  /// routes a mouse event by that window number rather than by what is on top of the screen.
  static func windowNumber(pid: pid_t, at point: CGPoint) -> Int64? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    for info in list where (info[kCGWindowOwnerPID as String] as? Int) == Int(pid) {
      guard (info[kCGWindowLayer as String] as? Int ?? 0) == 0,
        let bounds = (info[kCGWindowBounds as String] as? [String: Any]).flatMap({ CGRect(dictionaryRepresentation: $0 as CFDictionary) }),
        bounds.contains(point),
        let number = info[kCGWindowNumber as String] as? Int
      else { continue }
      return Int64(number)
    }
    return nil
  }

  @discardableResult
  static func click(pid: pid_t, at point: CGPoint, right: Bool = false, count: Int = 1) -> Bool {
    let src = source()
    let button: CGMouseButton = right ? .right : .left
    let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let window = windowNumber(pid: pid, at: point)
    for clickIndex in 1...max(1, count) {
      guard let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
        let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
      else { return false }
      for event in [down, up] {
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
        if let window {
          event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: window)
          event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: window)
        }
      }
      down.postToPid(pid)
      usleep(30_000)
      up.postToPid(pid)
      usleep(30_000)
    }
    return true
  }

  @discardableResult
  static func wheel(pid: pid_t, at point: CGPoint, dy: Int) -> Bool {
    guard let event = CGEvent(scrollWheelEvent2Source: source(), units: .pixel, wheelCount: 1, wheel1: Int32(dy), wheel2: 0, wheel3: 0)
    else { return false }
    event.location = point
    if let window = windowNumber(pid: pid, at: point) {
      event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: window)
      event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: window)
    }
    event.postToPid(pid)
    return true
  }
}
