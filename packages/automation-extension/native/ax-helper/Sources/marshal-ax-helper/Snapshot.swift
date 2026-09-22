import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

private let interactiveRoles: Set<String> = [
  "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXSecureTextField", "AXTextArea",
  "AXSlider", "AXTabGroup", "AXTab", "AXLink", "AXMenuItem", "AXMenuButton", "AXPopUpButton",
  "AXComboBox", "AXCell", "AXRow",
]
private let editableRoles: Set<String> = ["AXTextField", "AXSecureTextField", "AXTextArea", "AXComboBox"]
private let skipSubtreeRoles: Set<String> = ["AXMenu", "AXMenuBar"]
private let staticTextRoles: Set<String> = ["AXStaticText"]

private let maxNodesDefault = 4000
private let timeBudgetMsDefault = 600
private let maxOnScreenElements = 250
private let maxOffScreenElements = 60
private let textCharLimit = 6000
private let labelFanOutLimit = 8
private let minControlPoints: CGFloat = 4

struct SnapshotElement {
  let id: String
  let role: String
  let label: String
  var value: String?
  var enabled: Bool
  var editable: Bool
  var checked: Bool?
  var expanded: Bool?
  var selected: Bool?
  var frame: CGRect
  var offscreen: Bool
  var actions: [String]
  /// kAXSubroleAttribute, e.g. "AXCloseButton" - lets callers recognize and
  /// filter/label window-chrome controls distinctly from generic AXButtons.
  var subrole: String? = nil
}

/// Human-readable labels for window-chrome subroles whose AXTitle/AXDescription
/// is empty (traffic-light buttons on Chromium/Electron windows in particular).
/// More specific and less misleading than the generic `humanizedRole("AXButton")`
/// -> "button" fallback, which is how Jev previously picked a synthesized
/// "button" candidate and closed a live Claude Desktop window by accident.
private let chromeSubroleLabels: [String: String] = [
  "AXCloseButton": "Close window",
  "AXMinimizeButton": "Minimize window",
  "AXZoomButton": "Zoom window",
  "AXFullScreenButton": "Full screen",
]

private let debugTraceLimit = 60

struct WalkResult {
  var onScreen: [SnapshotElement] = []
  var offScreen: [SnapshotElement] = []
  var textParts: [(CGFloat, CGFloat, String)] = []
  var visitedNodes = 0
  var truncated = false
  /// First `debugTraceLimit` visited nodes in walk order, for `snapshot {debug:true}` - every node, not just interactive ones, so a caller can see exactly where/why the walk stops finding content.
  var debugTrace: [[String: Any]] = []
  /// Every AXWebArea found, for the "set AXManualAccessibility on the web area too" diagnostic path.
  var webAreas: [AXUIElement] = []
}

/// Real, interactable window subroles. Finder (and possibly other Cocoa
/// apps) also report a "desktop" pseudo-window via kAXWindows/kAXMainWindow
/// that is untitled, spans the union of all displays, and has an empty or
/// unrecognized subrole - excluded here so it never wins over a real window.
private let acceptableWindowSubroles: Set<String> = ["AXStandardWindow", "AXDialog", "AXSheet", "AXFloatingWindow"]

/// True for windows that should never be treated as "the" window: wrong
/// subrole, or a frame that covers/exceeds the union of all screens (the
/// desktop pseudo-window signature).
func windowPassesFilter(_ win: AXUIElement) -> Bool {
  let subrole = AXAttr.string(win, kAXSubroleAttribute as String) ?? ""
  guard acceptableWindowSubroles.contains(subrole) else { return false }
  let frame = AXAttr.frame(win) ?? .zero
  let screensUnion = NSScreen.screens.reduce(CGRect.zero) { $0.union($1.frame) }
  if screensUnion.width > 0, frame.width >= screensUnion.width, frame.height >= screensUnion.height {
    return false
  }
  return true
}

enum Snapshot {
  /// Finds the AXUIElement for the app's frontmost/focused window and its frame.
  /// Prefers the focused window, then the main window, then the first window
  /// in kAXWindowsAttribute - but only candidates that pass
  /// `windowPassesFilter`, so an untitled full-screen "desktop" pseudo-window
  /// (Finder) never gets treated as a real, interactable window.
  static func window(for appElement: AXUIElement) -> (element: AXUIElement, title: String, frame: CGRect)? {
    func asWindow(_ raw: AnyObject?) -> AXUIElement? { raw.map { $0 as! AXUIElement } }

    let windows = (AXAttr.value(appElement, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    let focused = asWindow(AXAttr.value(appElement, kAXFocusedWindowAttribute as String))
    let main = asWindow(AXAttr.value(appElement, kAXMainWindowAttribute as String))

    let candidate: AXUIElement?
    if let focused, windowPassesFilter(focused) {
      candidate = focused
    } else if let main, windowPassesFilter(main) {
      candidate = main
    } else if let firstPassing = windows.first(where: windowPassesFilter) {
      candidate = firstPassing
    } else {
      // Nothing in kAXWindows/kAXFocusedWindow/kAXMainWindow passed the
      // filter (e.g. only the untitled full-screen desktop pseudo-window
      // exists) - report no window rather than treating it as real.
      candidate = nil
    }
    guard let win = candidate else { return nil }
    let title = AXAttr.string(win, kAXTitleAttribute as String) ?? ""
    let frame = AXAttr.frame(win) ?? .zero
    return (win, title, frame)
  }

  static func take(
    appElement: AXUIElement,
    window: AXUIElement,
    windowFrame: CGRect,
    cache: ElementCache,
    maxNodes: Int = maxNodesDefault,
    timeBudgetMs: Int = timeBudgetMsDefault
  ) -> WalkResult {
    var result = WalkResult()
    let deadline = Date().addingTimeInterval(Double(timeBudgetMs) / 1000.0)
    let budget = min(maxNodes, maxNodesDefault)
    walk(window, cache: cache, windowFrame: windowFrame, deadline: deadline, budget: budget, result: &result)
    result.onScreen = order(result.onScreen)
    result.offScreen = Array(result.offScreen.prefix(maxOffScreenElements))
    if result.onScreen.count > maxOnScreenElements {
      result.onScreen = Array(result.onScreen.prefix(maxOnScreenElements))
    }
    return result
  }

  private static func walk(
    _ element: AXUIElement,
    cache: ElementCache,
    windowFrame: CGRect,
    deadline: Date,
    budget: Int,
    result: inout WalkResult
  ) {
    if result.visitedNodes >= budget {
      result.truncated = true
      return
    }
    if result.visitedNodes % 32 == 0, Date() > deadline {
      result.truncated = true
      return
    }
    result.visitedNodes += 1

    let role = AXAttr.role(element)

    if result.debugTrace.count < debugTraceLimit {
      let frame = AXAttr.frame(element)
      let title = AXAttr.string(element, kAXTitleAttribute as String) ?? AXAttr.string(element, kAXDescriptionAttribute as String) ?? ""
      result.debugTrace.append([
        "role": role,
        "title": title,
        "childCount": AXAttr.children(element).count,
        "frame": frame.map { [$0.origin.x, $0.origin.y, $0.width, $0.height] } ?? NSNull(),
      ])
    }
    if role == "AXWebArea" { result.webAreas.append(element) }

    if skipSubtreeRoles.contains(role) { return }

    if staticTextRoles.contains(role) {
      if let text = AXAttr.string(element, kAXValueAttribute as String) ?? AXAttr.string(element, kAXTitleAttribute as String),
        !text.isEmpty, let frame = AXAttr.frame(element)
      {
        result.textParts.append((frame.origin.y, frame.origin.x, text))
      }
    } else if interactiveRoles.contains(role) {
      if let node = build(element, role: role, cache: cache, windowFrame: windowFrame) {
        if node.offscreen, node.actions.contains("AXPress") || node.role == "AXButton" || node.role == "AXMenuItem" {
          if result.offScreen.count < maxOffScreenElements {
            result.offScreen.append(node)
          }
        } else if !node.offscreen {
          result.onScreen.append(node)
        }
      }
    } else if role == "AXGroup" {
      // Nameless groups are transparent: recurse but never emit themselves.
    }

    for child in AXAttr.children(element) {
      if result.visitedNodes >= budget || (result.visitedNodes % 32 == 0 && Date() > deadline) {
        result.truncated = true
        return
      }
      walk(child, cache: cache, windowFrame: windowFrame, deadline: deadline, budget: budget, result: &result)
    }
  }

  private static func build(_ element: AXUIElement, role: String, cache: ElementCache, windowFrame: CGRect) -> SnapshotElement? {
    guard let frame = AXAttr.frame(element) else { return nil }
    if frame.width < minControlPoints || frame.height < minControlPoints { return nil }

    let subrole = AXAttr.string(element, kAXSubroleAttribute as String)
    var label = AXAttr.label(element) ?? ""
    if label.isEmpty, role == "AXCell" || role == "AXRow" {
      label = shallowStaticTextLabel(element) ?? ""
    }
    // Icon-only controls (Chromium/Electron toolbar buttons with no
    // AXTitle/AXDescription - observed on Claude Desktop's window-chrome
    // buttons) are kept even with no accessible name: a synthesized,
    // human-readable label beats silently dropping a real, pressable
    // control. All roles reaching this point already passed the
    // `interactiveRoles` filter in `walk`, so this never fires for inert
    // wrapper elements. Window-chrome subroles (traffic lights) get a
    // specific, unambiguous label rather than the generic "button" - Jev
    // previously mistook an unlabeled traffic-light button for some other
    // control and closed a live window.
    if label.isEmpty {
      label = subrole.flatMap { chromeSubroleLabels[$0] } ?? humanizedRole(role)
    }
    if label.isEmpty { return nil }

    let id = cache.register(element)
    let enabled = AXAttr.bool(element, kAXEnabledAttribute as String) ?? true
    let editable = editableRoles.contains(role)
    let value = AXAttr.string(element, kAXValueAttribute as String)
    let checked: Bool? = (role == "AXCheckBox" || role == "AXRadioButton") ? (AXAttr.number(element, kAXValueAttribute as String) == 1) : nil
    let expanded = AXAttr.bool(element, "AXExpanded")
    let selected = AXAttr.bool(element, kAXSelectedAttribute as String)
    let actions = AXAttr.actionNames(element)
    let offscreen = windowFrame.width > 0 && windowFrame.height > 0 && !windowFrame.intersects(frame)

    return SnapshotElement(
      id: id, role: role, label: label, value: value, enabled: enabled, editable: editable,
      checked: checked, expanded: expanded, selected: selected, frame: frame, offscreen: offscreen,
      actions: actions, subrole: subrole
    )
  }

  private static func humanizedRole(_ role: String) -> String {
    let stripped = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
    var out = ""
    for ch in stripped {
      if ch.isUppercase, !out.isEmpty { out += " " }
      out.append(ch)
    }
    return out.lowercased()
  }

  /// Shallow BFS (<= 8 nodes visited) for a nearby AXStaticText descendant,
  /// used to label AXCell/AXRow elements that carry no title themselves.
  private static func shallowStaticTextLabel(_ element: AXUIElement) -> String? {
    var queue = AXAttr.children(element)
    var visited = 0
    while !queue.isEmpty, visited < labelFanOutLimit {
      let node = queue.removeFirst()
      visited += 1
      let role = AXAttr.role(node)
      if staticTextRoles.contains(role), let text = AXAttr.string(node, kAXValueAttribute as String), !text.isEmpty {
        return text
      }
      queue.append(contentsOf: AXAttr.children(node))
    }
    return nil
  }

  /// Reading order: bucket by row (10pt bands) then left-to-right.
  private static func order(_ elements: [SnapshotElement]) -> [SnapshotElement] {
    elements.sorted { a, b in
      let rowA = (a.frame.origin.y / 10).rounded(.down)
      let rowB = (b.frame.origin.y / 10).rounded(.down)
      if rowA != rowB { return rowA < rowB }
      return a.frame.origin.x < b.frame.origin.x
    }
  }

  /// The app's menu bar as click candidates: one AXMenuBarItem per top-level
  /// menu ("File", "Edit", ...), plus - when a menu bar item is currently
  /// open (AXSelected) - its enabled AXMenuItem children. Always available
  /// even when the app has no window, so a goal like "open a new window"
  /// has something to act on via File > New Window.
  static func menuBar(appElement: AXUIElement, cache: ElementCache) -> [SnapshotElement] {
    guard let menuBarRaw = AXAttr.value(appElement, kAXMenuBarAttribute as String) else { return [] }
    let menuBar = menuBarRaw as! AXUIElement
    var out: [SnapshotElement] = []

    for item in AXAttr.children(menuBar) where AXAttr.role(item) == "AXMenuBarItem" {
      guard let label = AXAttr.string(item, kAXTitleAttribute as String), !label.isEmpty else { continue }
      guard let frame = AXAttr.frame(item) else { continue }
      let enabled = AXAttr.bool(item, kAXEnabledAttribute as String) ?? true
      out.append(SnapshotElement(
        id: cache.register(item), role: "AXMenuBarItem", label: label, value: nil, enabled: enabled,
        editable: false, checked: nil, expanded: nil, selected: nil, frame: frame, offscreen: false,
        actions: AXAttr.actionNames(item)
      ))

      let isOpen = AXAttr.bool(item, kAXSelectedAttribute as String) ?? false
      guard isOpen else { continue }
      for menu in AXAttr.children(item) where AXAttr.role(menu) == "AXMenu" {
        for menuItem in AXAttr.children(menu) where AXAttr.role(menuItem) == "AXMenuItem" {
          guard let itemLabel = AXAttr.string(menuItem, kAXTitleAttribute as String), !itemLabel.isEmpty else { continue }
          guard AXAttr.bool(menuItem, kAXEnabledAttribute as String) ?? true else { continue }
          guard let itemFrame = AXAttr.frame(menuItem) else { continue }
          out.append(SnapshotElement(
            id: cache.register(menuItem), role: "AXMenuItem", label: itemLabel, value: nil, enabled: true,
            editable: false, checked: nil, expanded: nil, selected: nil, frame: itemFrame, offscreen: false,
            actions: AXAttr.actionNames(menuItem)
          ))
        }
      }
    }
    return out
  }

  static func focusedField(appElement: AXUIElement) -> [String: Any]? {
    guard let raw = AXAttr.value(appElement, kAXFocusedUIElementAttribute as String) else { return nil }
    let el = raw as! AXUIElement
    let role = AXAttr.role(el)
    let label = AXAttr.label(el) ?? ""
    var out: [String: Any] = ["role": role, "label": label]
    if let value = AXAttr.string(el, kAXValueAttribute as String) { out["value"] = value }
    if let placeholder = AXAttr.string(el, "AXPlaceholderValue") { out["placeholder"] = placeholder }
    return out
  }

  static func visibleText(_ parts: [(CGFloat, CGFloat, String)]) -> String {
    let ordered = parts.sorted { a, b in
      let rowA = (a.0 / 10).rounded(.down)
      let rowB = (b.0 / 10).rounded(.down)
      if rowA != rowB { return rowA < rowB }
      return a.1 < b.1
    }
    var text = ""
    for (_, _, part) in ordered {
      if text.count >= textCharLimit { break }
      if !text.isEmpty { text += "\n" }
      text += part
    }
    if text.count > textCharLimit { text = String(text.prefix(textCharLimit)) }
    return text
  }
}
