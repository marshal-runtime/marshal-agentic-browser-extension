import ApplicationServices
import CoreGraphics
import Foundation

/// Thin wrappers over `AXUIElementCopyAttributeValue` that never throw -
/// missing/unsupported attributes just come back `nil`.
enum AXAttr {
  static func value(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
    var out: AnyObject?
    let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &out)
    return err == .success ? out : nil
  }

  static func string(_ element: AXUIElement, _ attribute: String) -> String? {
    value(element, attribute) as? String
  }

  static func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
    value(element, attribute) as? Bool
  }

  static func number(_ element: AXUIElement, _ attribute: String) -> Int? {
    if let n = value(element, attribute) as? Int { return n }
    if let n = value(element, attribute) as? NSNumber { return n.intValue }
    return nil
  }

  static func children(_ element: AXUIElement) -> [AXUIElement] {
    guard let raw = value(element, kAXChildrenAttribute as String) else { return [] }
    return (raw as? [AXUIElement]) ?? []
  }

  static func position(_ element: AXUIElement) -> CGPoint? {
    guard let raw = value(element, kAXPositionAttribute as String) else { return nil }
    var point = CGPoint.zero
    guard AXValueGetType(raw as! AXValue) == .cgPoint,
      AXValueGetValue(raw as! AXValue, .cgPoint, &point)
    else { return nil }
    return point
  }

  static func size(_ element: AXUIElement) -> CGSize? {
    guard let raw = value(element, kAXSizeAttribute as String) else { return nil }
    var size = CGSize.zero
    guard AXValueGetType(raw as! AXValue) == .cgSize,
      AXValueGetValue(raw as! AXValue, .cgSize, &size)
    else { return nil }
    return size
  }

  static func frame(_ element: AXUIElement) -> CGRect? {
    guard let p = position(element), let s = size(element) else { return nil }
    return CGRect(origin: p, size: s)
  }

  /// Best-effort label: AXTitle, else AXDescription (Chrome/Electron expose
  /// labels this way), else AXValue when it is a short string, else nil.
  static func label(_ element: AXUIElement) -> String? {
    if let title = string(element, kAXTitleAttribute as String), !title.isEmpty { return title }
    if let desc = string(element, kAXDescriptionAttribute as String), !desc.isEmpty { return desc }
    if let v = string(element, kAXValueAttribute as String), !v.isEmpty, v.count <= 120 { return v }
    return nil
  }

  static func role(_ element: AXUIElement) -> String {
    string(element, kAXRoleAttribute as String) ?? "AXUnknown"
  }

  static func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyActionNames(element, &names)
    guard err == .success, let list = names as? [String] else { return [] }
    return list
  }

  @discardableResult
  static func perform(_ element: AXUIElement, action: String) -> Bool {
    AXUIElementPerformAction(element, action as CFString) == .success
  }

  @discardableResult
  static func set(_ element: AXUIElement, _ attribute: String, _ newValue: CFTypeRef) -> Bool {
    AXUIElementSetAttributeValue(element, attribute as CFString, newValue) == .success
  }

  /// Same as `set`, but returns the raw `AXError` for diagnostics (e.g. distinguishing
  /// `.attributeUnsupported`/`.illegalArgument` from `.success` on Chromium's
  /// AXManualAccessibility/AXEnhancedUserInterface attributes).
  @discardableResult
  static func setDiagnostic(_ element: AXUIElement, _ attribute: String, _ newValue: CFTypeRef) -> AXError {
    AXUIElementSetAttributeValue(element, attribute as CFString, newValue)
  }
}
