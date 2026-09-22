import AppKit
import ApplicationServices

enum Apps {
  static func permissions() -> [String: Any] {
    let accessibility = AXIsProcessTrusted()
    let screenRecording: Bool
    if #available(macOS 11.0, *) {
      screenRecording = CGPreflightScreenCaptureAccess()
    } else {
      screenRecording = true
    }
    return ["accessibility": accessibility, "screenRecording": screenRecording]
  }

  static func list() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .compactMap { app -> [String: Any]? in
        guard let bundleId = app.bundleIdentifier, let name = app.localizedName else { return nil }
        return [
          "bundleId": bundleId,
          "name": name,
          "pid": Int(app.processIdentifier),
          "frontmost": app.isActive,
        ]
      }
  }

  static func resolve(bundleId: String?, pid: Int?) -> NSRunningApplication? {
    if let pid, let app = NSRunningApplication(processIdentifier: pid_t(pid)) {
      return app
    }
    if let bundleId {
      return NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
    }
    return NSWorkspace.shared.frontmostApplication
  }

  @discardableResult
  static func focus(bundleId: String?, pid: Int?) -> Bool {
    guard let app = resolve(bundleId: bundleId, pid: pid) else { return false }
    return app.activate(options: [])
  }

  struct FocusResult {
    let ok: Bool
    /// nil when, even after the reopen/Window-menu fallbacks, no real
    /// on-screen window could be found.
    let window: (title: String, x: Int, y: Int, w: Int, h: Int)?
    /// True once the reopen-via-Dock-equivalent fallback was attempted
    /// (whether or not it ended up producing a window).
    let reopened: Bool
  }

  /// Focuses the app, then makes sure it actually has an on-screen window -
  /// some apps (Electron apps in particular) hide their window on close
  /// while staying running, so `activate` alone reactivates the app but
  /// brings no window back. Escalates: poll after activate -> reopen (Dock
  /// icon click equivalent) + poll -> Window menu's first enabled item + poll.
  static func focusAndEnsureWindow(bundleId: String?, pid: Int?) -> FocusResult {
    guard let app = resolve(bundleId: bundleId, pid: pid) else {
      return FocusResult(ok: false, window: nil, reopened: false)
    }
    _ = app.activate(options: [.activateAllWindows])

    func currentWindow() -> (element: AXUIElement, title: String, frame: CGRect)? {
      Snapshot.window(for: AXUIElementCreateApplication(app.processIdentifier))
    }

    func pollForWindow(maxMs: Int, stepMs: Int) -> (element: AXUIElement, title: String, frame: CGRect)? {
      var win = currentWindow()
      var elapsedMs = 0
      while win == nil, elapsedMs < maxMs {
        Thread.sleep(forTimeInterval: Double(stepMs) / 1000.0)
        elapsedMs += stepMs
        win = currentWindow()
      }
      return win
    }

    var win = pollForWindow(maxMs: 1_500, stepMs: 200)
    var reopened = false

    if win == nil, let bundleURL = app.bundleURL {
      reopened = true
      NSWorkspace.shared.openApplication(at: bundleURL, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
      win = pollForWindow(maxMs: 3_000, stepMs: 250)
    }

    if win == nil {
      let appElement = AXUIElementCreateApplication(app.processIdentifier)
      if pressFirstReopeningWindowMenuItem(appElement: appElement) {
        win = pollForWindow(maxMs: 1_500, stepMs: 250)
      }
    }

    guard let resolved = win else {
      return FocusResult(ok: true, window: nil, reopened: reopened)
    }
    return FocusResult(
      ok: true,
      window: (
        title: resolved.title, x: Int(resolved.frame.minX), y: Int(resolved.frame.minY),
        w: Int(resolved.frame.width), h: Int(resolved.frame.height)
      ),
      reopened: reopened
    )
  }

  /// Opens the app's "Window" menu and presses its first enabled, titled
  /// item - for apps without a working Dock-reopen handler, this is often
  /// still enough to bring a window back (e.g. "New Window"/a recent window
  /// entry). Cancels the menu and returns false if nothing usable is found.
  private static func pressFirstReopeningWindowMenuItem(appElement: AXUIElement) -> Bool {
    guard let menuBarRaw = AXAttr.value(appElement, kAXMenuBarAttribute as String) else { return false }
    let menuBar = menuBarRaw as! AXUIElement
    guard
      let windowMenuBarItem = AXAttr.children(menuBar).first(where: {
        AXAttr.string($0, kAXTitleAttribute as String) == "Window"
      })
    else { return false }

    AXAttr.perform(windowMenuBarItem, action: kAXPressAction as String)
    Thread.sleep(forTimeInterval: 0.2)
    guard let menu = AXAttr.children(windowMenuBarItem).first(where: { AXAttr.role($0) == "AXMenu" }) else {
      return false
    }
    let items = AXAttr.children(menu).filter { AXAttr.role($0) == "AXMenuItem" }
    guard
      let firstEnabled = items.first(where: {
        (AXAttr.bool($0, kAXEnabledAttribute as String) ?? true) && !(AXAttr.string($0, kAXTitleAttribute as String) ?? "").isEmpty
      })
    else {
      AXAttr.perform(windowMenuBarItem, action: "AXCancel")
      return false
    }
    return AXAttr.perform(firstEnabled, action: kAXPressAction as String)
  }
}
