import ApplicationServices
import AppKit
import Foundation

func log(_ message: String) {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

nonisolated(unsafe) let cache = ElementCache()
/// Chromium/Electron apps only build their AX tree once an assistive client
/// announces itself; remembered per-pid so we only pay the one-time
/// activation attempts + settle wait on the first snapshot of each app.
nonisolated(unsafe) var manualAccessibilityEnabledPids = Set<Int>()

func axErrorName(_ err: AXError) -> String {
  switch err {
  case .success: return "success"
  case .attributeUnsupported: return "attributeUnsupported"
  case .illegalArgument: return "illegalArgument"
  case .invalidUIElement: return "invalidUIElement"
  case .cannotComplete: return "cannotComplete"
  case .notImplemented: return "notImplemented"
  case .noValue: return "noValue"
  case .apiDisabled: return "apiDisabled"
  default: return "other(\(err.rawValue))"
  }
}

/// Chromium/Electron opt into full-fidelity AX only after these are set;
/// harmless (no-ops) on native AppKit apps. Logs the raw AXError from each
/// call (to stderr) so a caller can tell "set but tree still empty" apart
/// from "the app rejected the attribute outright".
func setManualAccessibility(_ element: AXUIElement, label: String, pid: Int) {
  let manualErr = AXAttr.setDiagnostic(element, "AXManualAccessibility", kCFBooleanTrue)
  let enhancedErr = AXAttr.setDiagnostic(element, "AXEnhancedUserInterface", kCFBooleanTrue)
  log(
    "pid=\(pid) \(label): AXManualAccessibility=\(axErrorName(manualErr)) AXEnhancedUserInterface=\(axErrorName(enhancedErr))"
  )
}

func handleSnapshot(_ request: [String: Any]) -> [String: Any] {
  let id = request["id"]
  let pid = request["pid"] as? Int
  let maxNodes = request["maxNodes"] as? Int
  let timeBudgetMs = request["timeBudgetMs"] as? Int
  let debug = request["debug"] as? Bool ?? false

  guard let app = Apps.resolve(bundleId: nil, pid: pid) else {
    return errorResponse(id, "no frontmost application")
  }
  let resolvedPid = Int(app.processIdentifier)
  var appElement = AXUIElementCreateApplication(app.processIdentifier)
  let isFirstSnapshot = !manualAccessibilityEnabledPids.contains(resolvedPid)

  func walkOnce(_ app: AXUIElement) -> (WalkResult, (element: AXUIElement, title: String, frame: CGRect))? {
    guard let win = Snapshot.window(for: app) else { return nil }
    cache.reset()
    let result = Snapshot.take(
      appElement: app, window: win.element, windowFrame: win.frame, cache: cache,
      maxNodes: maxNodes ?? 4000, timeBudgetMs: timeBudgetMs ?? 600
    )
    return (result, win)
  }

  if isFirstSnapshot {
    manualAccessibilityEnabledPids.insert(resolvedPid)
    setManualAccessibility(appElement, label: "app (attempt 1)", pid: resolvedPid)
  }

  guard var current = walkOnce(appElement) else {
    // No focused/main/first window (e.g. all windows closed). The executor
    // still needs something actionable, so fall back to the app's menu bar
    // instead of hard-erroring - "File > New Window" etc. is always reachable.
    cache.reset()
    let menuElements = Snapshot.menuBar(appElement: appElement, cache: cache)
    func menuElementJson(_ e: SnapshotElement) -> [String: Any] {
      [
        "id": e.id, "role": e.role, "label": e.label,
        "x": Int(e.frame.origin.x), "y": Int(e.frame.origin.y),
        "w": Int(e.frame.width), "h": Int(e.frame.height),
        "offscreen": false, "enabled": e.enabled, "editable": false,
        "actions": e.actions, "where": "top",
      ]
    }
    let elements = menuElements.map(menuElementJson)
    let text = "No window is open for \(app.localizedName ?? app.bundleIdentifier ?? "app")"
    let markerList: [Any] = [
      app.bundleIdentifier ?? "", "(no window)", [0, 0, 0, 0], text,
      elements.map { ($0["id"] as! String) + "|" + ($0["role"] as! String) + "|" + ($0["label"] as! String) },
    ]
    let markerData = (try? JSONSerialization.data(withJSONObject: ["m": markerList])) ?? Data()
    let marker = String(data: markerData, encoding: .utf8) ?? ""
    return okResponse(id, [
      "app": ["bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "pid": Int(app.processIdentifier)],
      "window": NSNull(),
      "reason": "no-window",
      "focused": NSNull(),
      "text": text,
      "elements": elements,
      "marker": marker,
      "truncated": false,
      "visitedNodes": 0,
    ])
  }

  // Chromium builds its AX tree asynchronously after the attributes above
  // are set - and empirically a bare re-walk of the SAME AXUIElement isn't
  // always enough: recreating AXUIElementCreateApplication after a settle
  // delay, then also stamping the attribute onto the window and any
  // AXWebArea found so far, is tried before falling back to a longer poll.
  if isFirstSnapshot, current.0.onScreen.count + current.0.offScreen.count < 3 {
    Thread.sleep(forTimeInterval: 0.3)
    appElement = AXUIElementCreateApplication(app.processIdentifier)
    setManualAccessibility(appElement, label: "app (recreated)", pid: resolvedPid)
    if let recreated = walkOnce(appElement) { current = recreated }

    if current.0.onScreen.count + current.0.offScreen.count < 3 {
      setManualAccessibility(current.1.element, label: "window", pid: resolvedPid)
      for (index, webArea) in current.0.webAreas.enumerated() {
        setManualAccessibility(webArea, label: "webArea[\(index)]", pid: resolvedPid)
      }
      var elapsedMs = 0
      while current.0.onScreen.count + current.0.offScreen.count < 3, elapsedMs < 2_000 {
        Thread.sleep(forTimeInterval: 0.25)
        elapsedMs += 250
        if let polled = walkOnce(appElement) { current = polled }
      }
      log("pid=\(resolvedPid) poll done after \(elapsedMs)ms: elements=\(current.0.onScreen.count + current.0.offScreen.count) visitedNodes=\(current.0.visitedNodes)")
    }
  }

  let (result, win) = current
  let text = Snapshot.visibleText(result.textParts)
  let focused = Snapshot.focusedField(appElement: appElement)

  func elementJson(_ e: SnapshotElement) -> [String: Any] {
    var obj: [String: Any] = [
      "id": e.id, "role": e.role, "label": e.label,
      "x": Int(e.frame.origin.x), "y": Int(e.frame.origin.y),
      "w": Int(e.frame.width), "h": Int(e.frame.height),
      "offscreen": e.offscreen, "enabled": e.enabled, "editable": e.editable,
      "actions": e.actions,
      "where": region(of: e.frame, in: win.frame),
    ]
    if let v = e.value { obj["value"] = v }
    if let c = e.checked { obj["checked"] = c }
    if let ex = e.expanded { obj["expanded"] = ex }
    if let s = e.selected { obj["selected"] = s }
    if let sr = e.subrole { obj["subrole"] = sr }
    return obj
  }

  func menuElementJson(_ e: SnapshotElement) -> [String: Any] {
    [
      "id": e.id, "role": e.role, "label": e.label,
      "x": Int(e.frame.origin.x), "y": Int(e.frame.origin.y),
      "w": Int(e.frame.width), "h": Int(e.frame.height),
      "offscreen": false, "enabled": e.enabled, "editable": false,
      "actions": e.actions, "where": "top",
    ]
  }
  // Menu bar candidates are appended AFTER the final walkOnce's cache.reset(),
  // so their registered ids never collide with window-content element ids.
  let menuElements = Snapshot.menuBar(appElement: appElement, cache: cache).map(menuElementJson)
  let elements = result.onScreen.map(elementJson) + result.offScreen.map(elementJson) + menuElements
  let markerList: [Any] = [
    app.bundleIdentifier ?? "", win.title, [win.frame.minX, win.frame.minY, win.frame.width, win.frame.height],
    text,
    elements.map { ($0["id"] as! String) + "|" + ($0["role"] as! String) + "|" + ($0["label"] as! String) + "|" + (($0["value"] as? String) ?? "") },
  ]
  let markerData = (try? JSONSerialization.data(withJSONObject: ["m": markerList])) ?? Data()
  let marker = String(data: markerData, encoding: .utf8) ?? ""

  var payload: [String: Any] = [
    "app": ["bundleId": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "pid": Int(app.processIdentifier)],
    "window": ["title": win.title, "x": Int(win.frame.minX), "y": Int(win.frame.minY), "w": Int(win.frame.width), "h": Int(win.frame.height)],
    "focused": focused ?? NSNull(),
    "text": text,
    "elements": elements,
    "marker": marker,
    "truncated": result.truncated,
    "visitedNodes": result.visitedNodes,
  ]
  if debug {
    payload["rawTree"] = result.debugTrace
    payload["webAreaCount"] = result.webAreas.count
  }
  return okResponse(id, payload)
}

func region(of frame: CGRect, in windowFrame: CGRect) -> String {
  guard windowFrame.width > 0, windowFrame.height > 0 else { return "center" }
  if !windowFrame.intersects(frame) { return frame.minY < windowFrame.minY ? "above" : "below" }
  let relX = (frame.midX - windowFrame.minX) / windowFrame.width
  let relY = (frame.midY - windowFrame.minY) / windowFrame.height
  let col = relX < 0.33 ? "left" : (relX < 0.66 ? "" : "right")
  let row = relY < 0.33 ? "top" : (relY < 0.66 ? "" : "bottom")
  if row.isEmpty, col.isEmpty { return "center" }
  return [row, col].filter { !$0.isEmpty }.joined(separator: "-")
}

func handleRequest(_ request: [String: Any]) -> [String: Any] {
  let id = request["id"]
  guard let op = request["op"] as? String else {
    return errorResponse(id, "missing \"op\"")
  }
  switch op {
  case "permissions":
    return okResponse(id, Apps.permissions())
  case "apps":
    return okResponse(id, ["apps": Apps.list()])
  case "focus":
    let result = Apps.focusAndEnsureWindow(bundleId: request["bundleId"] as? String, pid: request["pid"] as? Int)
    guard result.ok else { return errorResponse(id, "could not focus app") }
    var payload: [String: Any] = ["reopened": result.reopened]
    if let w = result.window {
      payload["window"] = ["title": w.title, "x": w.x, "y": w.y, "w": w.w, "h": w.h]
    } else {
      payload["window"] = NSNull()
    }
    return okResponse(id, payload)
  case "snapshot":
    return handleSnapshot(request)
  case "press":
    guard let nodeId = request["nodeId"] as? String else {
      return errorResponse(id, "missing \"nodeId\"")
    }
    guard let element = cache.resolve(nodeId) else { return errorResponse(id, "unknown element \(nodeId)") }
    return Actions.press(element, cache: cache) ? okResponse(id) : errorResponse(id, "press failed")
  case "setValue":
    guard let nodeId = request["nodeId"] as? String, let text = request["text"] as? String else {
      return errorResponse(id, "missing \"nodeId\"/\"text\"")
    }
    guard let element = cache.resolve(nodeId) else { return errorResponse(id, "unknown element \(nodeId)") }
    return Actions.setValue(element, text: text) ? okResponse(id) : errorResponse(id, "setValue failed")
  case "click":
    guard let x = request["x"] as? Double, let y = request["y"] as? Double else {
      return errorResponse(id, "missing \"x\"/\"y\"")
    }
    let button = request["button"] as? String ?? "left"
    let count = request["count"] as? Int ?? 1
    return Actions.click(at: CGPoint(x: x, y: y), button: button, count: count) ? okResponse(id) : errorResponse(id, "click failed")
  case "type":
    guard let text = request["text"] as? String else { return errorResponse(id, "missing \"text\"") }
    return Actions.type(text) ? okResponse(id) : errorResponse(id, "type failed")
  case "key":
    guard let key = request["key"] as? String else { return errorResponse(id, "missing \"key\"") }
    let modifiers = request["modifiers"] as? [String] ?? []
    return Actions.key(name: key, modifiers: modifiers) ? okResponse(id) : errorResponse(id, "unknown key \(key)")
  case "scroll":
    guard let x = request["x"] as? Double, let y = request["y"] as? Double, let dy = request["dy"] as? Int else {
      return errorResponse(id, "missing \"x\"/\"y\"/\"dy\"")
    }
    return Actions.scroll(at: CGPoint(x: x, y: y), dy: dy) ? okResponse(id) : errorResponse(id, "scroll failed")
  case "screenshot":
    do {
      let shot = try Actions.screenshotFrontmostWindow(pid: request["pid"] as? Int)
      return okResponse(id, ["path": shot.path, "w": shot.w, "h": shot.h, "originX": shot.originX, "originY": shot.originY, "scale": shot.scale])
    } catch {
      return errorResponse(id, "\(error)")
    }
  default:
    return errorResponse(id, "unknown op \"\(op)\"")
  }
}

func runSelfTest() {
  let perms = Apps.permissions()
  print("permissions: \(perms)")
  guard perms["accessibility"] as? Bool == true else {
    print("Accessibility permission not granted; grant it to this binary (or its parent Terminal/Marshal process) in System Settings > Privacy & Security > Accessibility, then re-run --selftest.")
    exit(1)
  }
  let t0 = Date()
  let apps = Apps.list()
  print("apps (\(Int(Date().timeIntervalSince(t0) * 1000))ms): \(apps.count) running")

  let t1 = Date()
  let result = handleSnapshot(["id": "selftest"])
  let elapsedMs = Int(Date().timeIntervalSince(t1) * 1000)
  if let ok = result["ok"] as? Bool, ok {
    let elements = result["elements"] as? [[String: Any]] ?? []
    print("snapshot (\(elapsedMs)ms): app=\(result["app"] ?? "?") elements=\(elements.count)")
  } else {
    print("snapshot failed: \(result["error"] ?? "?")")
  }
}

if CommandLine.arguments.contains("--selftest") {
  runSelfTest()
  exit(0)
}

log("marshal-ax-helper started, pid=\(ProcessInfo.processInfo.processIdentifier)")
while let line = readLine(strippingNewline: true) {
  guard !line.isEmpty else { continue }
  guard let request = JSONValue.parseObject(line) else {
    print(JSONValue.serialize(errorResponse(nil, "invalid JSON line")))
    continue
  }
  let response = handleRequest(request)
  print(JSONValue.serialize(response))
  fflush(stdout)
}
