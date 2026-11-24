import ApplicationServices
import Foundation

/// Scripted lookups for flows that know what they are looking for (the Chrome extension installer): find elements by
/// role, title, description, value or DOM id, in document order, without taking a snapshot. Matches go into the shared
/// cache, so `press` and `setValue` take their nodeIds. Every walk is depth-limited and every Accessibility call times
/// out after 3 s: an unscoped walk through a large web area once blocked an AXPress for over a minute.
enum Find {
  static let fields = ["role", "subrole", "title", "description", "domId", "value"]

  static func describe(_ element: AXUIElement) -> [String: String] {
    [
      "role": AXAttr.role(element),
      "subrole": AXAttr.string(element, kAXSubroleAttribute as String) ?? "",
      "title": AXAttr.string(element, kAXTitleAttribute as String) ?? "",
      "description": AXAttr.string(element, kAXDescriptionAttribute as String) ?? "",
      "domId": AXAttr.string(element, "AXDOMIdentifier") ?? "",
      "value": valueText(element),
    ]
  }

  /// The element's own text plus its static-text children's (a web group's label lives in its children).
  static func text(_ element: AXUIElement) -> String {
    var parts: [String] = []
    for child in AXAttr.children(element) where AXAttr.role(child) == "AXStaticText" {
      let value = valueText(child)
      if !value.isEmpty { parts.append(value) }
    }
    return parts.joined(separator: " ")
  }

  private static func valueText(_ element: AXUIElement) -> String {
    guard let raw = AXAttr.value(element, kAXValueAttribute as String) else { return "" }
    if let string = raw as? String { return string }
    if let number = raw as? NSNumber { return number.stringValue }
    return ""
  }

  static func prepare(pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 3.0)
    // Chromium and Electron build their web tree only for an assistive client that asks.
    _ = AXAttr.set(app, "AXManualAccessibility", kCFBooleanTrue)
    return app
  }

  static func handle(_ request: [String: Any], cache: ElementCache) -> [String: Any] {
    let id = request["id"]
    guard let pid = request["pid"] as? Int else { return errorResponse(id, "missing \"pid\"") }
    guard let queries = request["queries"] as? [[String: Any]], !queries.isEmpty else {
      return errorResponse(id, "missing \"queries\"")
    }
    let app = prepare(pid: pid_t(pid))
    var roots: [AXUIElement]
    if let within = request["within"] as? String {
      guard let element = cache.resolve(within) else { return errorResponse(id, "unknown element \(within)") }
      roots = [element]
    } else {
      roots = AXAttr.children(app).filter { AXAttr.role($0) == "AXWindow" }
      if roots.isEmpty, let windows = AXAttr.value(app, kAXWindowsAttribute as String) as? [AXUIElement] { roots = windows }
    }
    let maxDepth = request["maxDepth"] as? Int ?? 12
    let limit = request["limit"] as? Int ?? 200
    let skipRoles = Set(request["skipRoles"] as? [String] ?? [])
    var matches: [[String: Any]] = []

    func matchIndex(_ info: [String: String]) -> Int? {
      for (index, query) in queries.enumerated() {
        var all = !query.isEmpty
        for field in fields {
          guard let wanted = query[field] as? String else { continue }
          if info[field] != wanted { all = false; break }
        }
        if all { return index }
      }
      return nil
    }

    func walk(_ element: AXUIElement, depth: Int) {
      guard matches.count < limit else { return }
      let info = describe(element)
      if let index = matchIndex(info) {
        var entry: [String: Any] = info
        AXUIElementSetMessagingTimeout(element, 3.0)
        entry["nodeId"] = cache.register(element)
        entry["query"] = index
        entry["text"] = text(element)
        matches.append(entry)
      }
      guard depth < maxDepth, !skipRoles.contains(info["role"] ?? "") else { return }
      for child in AXAttr.children(element) { walk(child, depth: depth + 1) }
    }

    for root in roots { walk(root, depth: 0) }
    return okResponse(id, ["matches": matches])
  }

  static func read(_ request: [String: Any], cache: ElementCache) -> [String: Any] {
    let id = request["id"]
    guard let nodeId = request["nodeId"] as? String else { return errorResponse(id, "missing \"nodeId\"") }
    guard let element = cache.resolve(nodeId) else { return errorResponse(id, "unknown element \(nodeId)") }
    AXUIElementSetMessagingTimeout(element, 3.0)
    var out: [String: Any] = describe(element)
    out["text"] = text(element)
    return okResponse(id, out)
  }
}
