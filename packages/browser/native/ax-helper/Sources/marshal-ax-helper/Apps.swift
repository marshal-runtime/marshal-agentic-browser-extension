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
    // While the screen is locked macOS hands an Accessibility client only the bare application element (no window,
    // no controls), so the session state is part of readiness.
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    let locked = (session["CGSSessionScreenIsLocked"] as? Bool) ?? ((session["CGSSessionScreenIsLocked"] as? Int) == 1)
    return ["accessibility": accessibility, "screenRecording": screenRecording, "screenLocked": locked]
  }

  static func list() -> [[String: Any]] {
    let front = Background.frontmostApplication()?.processIdentifier
    return NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular }
      .compactMap { app -> [String: Any]? in
        guard let bundleId = app.bundleIdentifier, let name = app.localizedName else { return nil }
        return [
          "bundleId": bundleId,
          "name": name,
          "pid": Int(app.processIdentifier),
          "frontmost": app.processIdentifier == front,
          "automation": isAutomationInstance(app),
        ]
      }
  }

  /// Finds a running app by bundle id or name, else opens it WITHOUT activating it (it stays behind whatever is in
  /// front). `alreadyRunning` tells the caller the process was not started here, so it must not be quit here either.
  static func launch(bundleId: String?, name: String?) -> [String: Any] {
    let lowerName = name?.lowercased()
    let matching = NSWorkspace.shared.runningApplications.filter {
      (bundleId != nil && $0.bundleIdentifier == bundleId) || (lowerName != nil && $0.localizedName?.lowercased() == lowerName)
    }
    if let running = personInstance(among: matching) {
      return describe(running, alreadyRunning: true)
    }
    var url: URL? = bundleId.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }
    if url == nil, let name {
      for root in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities"] {
        let candidate = URL(fileURLWithPath: root).appendingPathComponent("\(name).app")
        if FileManager.default.fileExists(atPath: candidate.path) { url = candidate; break }
      }
    }
    guard let url else { return ["found": false] }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.addsToRecentItems = false
    let semaphore = DispatchSemaphore(value: 0)
    final class Box: @unchecked Sendable { var app: NSRunningApplication?; var error: String? }
    let box = Box()
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
      box.app = app
      box.error = error.map { "\($0)" }
      semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 15)
    guard let app = box.app else { return ["found": true, "error": box.error ?? "the app did not start"] }
    // Wait (bounded) for its first window so the first snapshot has something to read.
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    var waited = 0
    while Snapshot.window(for: appElement) == nil, waited < 5_000 {
      Thread.sleep(forTimeInterval: 0.2)
      waited += 200
    }
    return describe(app, alreadyRunning: false)
  }

  private static func describe(_ app: NSRunningApplication, alreadyRunning: Bool) -> [String: Any] {
    [
      "found": true, "alreadyRunning": alreadyRunning, "pid": Int(app.processIdentifier),
      "bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "",
      "frontmost": app.processIdentifier == Background.frontmostApplication()?.processIdentifier,
    ]
  }

  /// Asks the app to quit (the same as its Quit menu item: it may still ask to save).
  static func quit(pid: Int) -> (found: Bool, exited: Bool) {
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return (false, true) }
    _ = app.terminate()
    var waited = 0
    while !app.isTerminated, waited < 5_000 {
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
      waited += 100
    }
    return (true, app.isTerminated)
  }

  static func resolve(bundleId: String?, pid: Int?) -> NSRunningApplication? {
    if let pid {
      // A named pid never falls back to another app (the frontmost one) when it can't be found.
      // NSRunningApplication(processIdentifier:) returned nil for a running TextEdit the workspace list had (live
      // 2026-11-24), so the list is the fallback.
      return NSRunningApplication(processIdentifier: pid_t(pid))
        ?? NSWorkspace.shared.runningApplications.first { $0.processIdentifier == pid_t(pid) }
    }
    if let bundleId {
      return personInstance(among: NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleId })
    }
    return Background.frontmostApplication()
  }

  /// Among running copies of one app, the one the person uses. A browser automation layer (this extension's managed
  /// Chrome, a test runner's) starts extra copies of the same bundle: headless, or on a profile folder of its own.
  /// Those are never picked, so on:"app" with "Google Chrome" reaches the person's Chrome and not a headless one
  /// (live 2026-11-24: the headless agent Chrome was picked over the person's). Among the rest, one with an
  /// on-screen window wins.
  static func personInstance(among candidates: [NSRunningApplication]) -> NSRunningApplication? {
    let people = candidates.filter { !isAutomationInstance($0) }
    let onScreen = Set(
      (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? [])
        .filter { ($0[kCGWindowLayer as String] as? Int ?? 0) == 0 }
        .compactMap { $0[kCGWindowOwnerPID as String] as? Int })
    return people.first { onScreen.contains(Int($0.processIdentifier)) } ?? people.first
  }

  /// Chromium-based by the framework its bundle ships: Electron apps carry "Electron Framework.framework"; Chrome,
  /// Edge, Brave and Arc carry "<name> Framework.framework" with Chromium's helper apps in its Helpers folder.
  static func isChromiumBased(_ app: NSRunningApplication) -> Bool {
    guard let bundle = app.bundleURL else { return false }
    let frameworks = bundle.appendingPathComponent("Contents/Frameworks")
    let names = (try? FileManager.default.contentsOfDirectory(atPath: frameworks.path)) ?? []
    return names.contains { name in
      if name == "Electron Framework.framework" { return true }
      guard name.hasSuffix(" Framework.framework") else { return false }
      let framework = frameworks.appendingPathComponent(name)
      return FileManager.default.fileExists(atPath: framework.appendingPathComponent("Helpers").path)
        || FileManager.default.fileExists(atPath: framework.appendingPathComponent("Versions/Current/Helpers").path)
    }
  }

  static func isAutomationInstance(_ app: NSRunningApplication) -> Bool {
    if app.activationPolicy == .prohibited { return true }
    return isAutomationCommandLine(processArguments(pid: app.processIdentifier))
  }

  /// A command line that marks a copy started by automation: headless, driven over a debugging pipe or port, or on a
  /// profile folder under ~/.marshal/browser or a temporary marshal-browser-* folder.
  static func isAutomationCommandLine(_ args: [String]) -> Bool {
    let marshalBrowser = (NSHomeDirectory() as NSString).appendingPathComponent(".marshal/browser")
    for arg in args {
      if arg == "--headless" || arg.hasPrefix("--headless=") || arg == "--remote-debugging-pipe"
        || arg.hasPrefix("--remote-debugging-port")
      {
        return true
      }
      if arg.hasPrefix("--user-data-dir=") {
        let dir = String(arg.dropFirst("--user-data-dir=".count))
        if dir.hasPrefix(marshalBrowser) || (dir as NSString).lastPathComponent.hasPrefix("marshal-browser-") { return true }
      }
    }
    return false
  }

  /// argv of another process (KERN_PROCARGS2), or [] when it can't be read.
  static func processArguments(pid: pid_t) -> [String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return [] }
    var buffer = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0, size > 4 else { return [] }
    let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
    var index = 4
    // Executable path, then NUL padding, then argc NUL-terminated strings.
    while index < size, buffer[index] != 0 { index += 1 }
    while index < size, buffer[index] == 0 { index += 1 }
    var args: [String] = []
    while args.count < Int(argc), index < size {
      let start = index
      while index < size, buffer[index] != 0 { index += 1 }
      args.append(String(decoding: buffer[start..<index], as: UTF8.self))
      index += 1
    }
    return args
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
